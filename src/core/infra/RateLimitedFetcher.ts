import { IFetcher, FetchOptions, FetchResponse } from '../interfaces.js';
import { fetch, Agent } from 'undici';

/**
 * A fetcher wrapper that enforces rate limits and serializes requests per domain.
 * Uses undici internally for granular timeout control (connect/headers/body).
 *
 * Concurrency Model:
 * - Single Process: This class assumes it is running in a single process (or that serialization is only needed within the process).
 * - Domain Serialization: All requests to the same hostname are queued (Promise Queue) and executed sequentially.
 * - Single Flight: Only one request per domain is "in flight" at a time to ensure accurate rate limiting.
 * - Multi-Process: If multiple processes use this, they will independently rate limit, potentially exceeding the target rate.
 */
export class RateLimitedFetcher implements IFetcher {
    private queues: Map<string, Promise<void>> = new Map();
    private minDelayMs: number;
    private maxEntries: number;
    private pendingCounts: Map<string, number> = new Map();
    private dispatcher: Agent;

    constructor(minDelayMs: number = 1000, options: { maxEntries?: number } = {}) {
        this.minDelayMs = minDelayMs;
        this.maxEntries = options.maxEntries ?? 1000;
        // Safety-net timeouts — per-request AbortSignal.timeout takes precedence
        this.dispatcher = new Agent({
            connect: { timeout: 300_000 },
            headersTimeout: 300_000,
            bodyTimeout: 300_000,
        });
    }

    async get(url: string, options?: FetchOptions): Promise<FetchResponse> {
        return this._request(url, 'GET', undefined, options);
    }

    async post(url: string, body: string | Buffer, options?: FetchOptions): Promise<FetchResponse> {
        return this._request(url, 'POST', body, options);
    }

    /**
     * Shared request handler — domain serialization, throttling, retry with backoff.
     */
    private async _request(
        url: string,
        method: 'GET' | 'POST',
        body: string | Buffer | undefined,
        options?: FetchOptions,
    ): Promise<FetchResponse> {
        const domain = new URL(url).hostname;
        const maxRetries = options?.retries ?? 0;

        const result = await this.schedule(domain, async () => {
            let lastError: any;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    await this.throttle(domain);

                    const reqHeaders: Record<string, string> = { ...options?.headers };
                    if (method === 'POST' && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
                        reqHeaders['Content-Type'] = 'application/json';
                    }

                    const response = await fetch(url, {
                        method,
                        headers: reqHeaders,
                        body: body ?? undefined,
                        signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
                        dispatcher: this.dispatcher,
                    });

                    // Retry on 429 or 5xx with exponential backoff
                    if (response.status === 429 || response.status >= 500) {
                        if (attempt < maxRetries) {
                            let delayMs = 1000 * Math.pow(2, attempt);

                            const retryAfter = response.headers.get('retry-after');
                            if (retryAfter) {
                                if (/^\d+$/.test(retryAfter)) {
                                    delayMs = parseInt(retryAfter, 10) * 1000;
                                } else {
                                    const date = Date.parse(retryAfter);
                                    if (!isNaN(date)) {
                                        delayMs = Math.max(0, date - Date.now());
                                    }
                                }
                            }

                            delayMs = Math.min(delayMs, 30000);
                            await new Promise(r => setTimeout(r, delayMs));
                            continue;
                        }
                    }

                    const respBody = await response.text();
                    const headers: Record<string, string> = {};
                    response.headers.forEach((value, key) => {
                        headers[key] = value;
                    });

                    return {
                        body: respBody,
                        status: response.status,
                        headers,
                        contentType: response.headers.get('content-type') || '',
                    };

                } catch (e) {
                    lastError = e;
                    if (attempt < maxRetries) {
                        const delayMs = Math.min(1000 * Math.pow(2, attempt), 10000);
                        await new Promise(r => setTimeout(r, delayMs));
                        continue;
                    }
                    throw e;
                } finally {
                    this.updateLastFetchTime(domain);
                }
            }
            throw lastError || new Error('Fetch failed');
        });

        return result;
    }

    /**
     * Close the underlying undici Agent. Call when shutting down.
     */
    async close(): Promise<void> {
        await this.dispatcher.close();
    }

    private lastFetchTimes: Map<string, number> = new Map();

    private schedule<T>(domain: string, action: () => Promise<T>): Promise<T> {
        const previousTask = this.queues.get(domain) || Promise.resolve();
        this.incrementPending(domain);

        // We want to run immediately after previousTask settles (fulfilled or rejected)
        const taskWithResult = previousTask
            .catch(() => { }) // Ignore previous error to ensure we run
            .then(action);   // Run our action

        const finalizedTask = taskWithResult.finally(() => {
            this.decrementPending(domain);
        });

        // Update the queue pointer. We want the queue to wait for THIS task to finish.
        // We catch errors here so the NEXT task doesn't get skipped if THIS one fails.
        // Also we explicitly map to void to satisfy the Map type.
        const nextQueueEntry = finalizedTask.then(() => { }, () => { });
        this.queues.set(domain, nextQueueEntry);

        return taskWithResult;
    }

    private async throttle(domain: string): Promise<void> {
        const lastFetch = this.lastFetchTimes.get(domain) || 0;
        const now = Date.now();
        const timeSinceLast = now - lastFetch;

        if (timeSinceLast < this.minDelayMs) {
            const waitTime = this.minDelayMs - timeSinceLast;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
    }

    private updateLastFetchTime(domain: string) {
        if (this.lastFetchTimes.has(domain)) {
            this.lastFetchTimes.delete(domain);
        }
        this.lastFetchTimes.set(domain, Date.now());

        this.evictIfNeeded();
    }

    private incrementPending(domain: string) {
        const current = this.pendingCounts.get(domain) || 0;
        this.pendingCounts.set(domain, current + 1);
    }

    private decrementPending(domain: string) {
        const current = this.pendingCounts.get(domain) || 0;
        const next = current - 1;
        if (next <= 0) {
            this.pendingCounts.delete(domain);
        } else {
            this.pendingCounts.set(domain, next);
        }
        this.evictIfNeeded();
    }

    private evictIfNeeded() {
        if (this.lastFetchTimes.size <= this.maxEntries) {
            return;
        }

        while (this.lastFetchTimes.size > this.maxEntries) {
            let evicted = false;
            for (const domain of this.lastFetchTimes.keys()) {
                if ((this.pendingCounts.get(domain) || 0) > 0) {
                    continue;
                }
                this.lastFetchTimes.delete(domain);
                this.queues.delete(domain);
                evicted = true;
                break;
            }
            if (!evicted) {
                break;
            }
        }
    }
}
