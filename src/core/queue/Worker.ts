import { Container } from '../container/Container.js';
import { IQueue, Job, JobHandler } from './interfaces.js';
import { JobValidationError } from './JobRegistry.js';
import { ILogger } from '../interfaces.js';

export interface WorkerOptions {
    maxConcurrency?: number;
    pollInterval?: number;
    recoveryTimeoutMs?: number;
    recoveryCheckIntervalMs?: number;
    heartbeatIntervalMs?: number;
    shutdownTimeoutMs?: number;
    executionTimeoutMs?: number;
}

export class Worker {
    private queue: IQueue;
    private app: Container;
    private logger: ILogger;
    private running: boolean = false;
    private recoveryInterval: NodeJS.Timeout | null = null;
    private recoveryCheckIntervalMs: number;
    private recoveryTimeoutMs: number;
    private pollTimer: NodeJS.Timeout | null = null;
    private maxConcurrency: number;
    private pollIntervalMs: number;
    private heartbeatIntervalMs: number;
    private shutdownTimeoutMs: number;
    private defaultExecutionTimeoutMs: number;
    private activeJobs: number = 0;
    private activePromises: Set<Promise<void>> = new Set();
    private activeJobMap: Map<string, Job> = new Map(); // Track active job objects
    private metrics?: any; // IMetrics
    private metricsInterval: NodeJS.Timeout | null = null;
    private options: WorkerOptions;
    private jobRegistry?: any;

    constructor(queue: IQueue, app: Container, options: WorkerOptions = {}) {
        this.queue = queue;
        this.app = app;
        this.options = options;
        this.logger = app.make('ILogger');
        this.jobRegistry = app.makeOrNull('JobRegistry');
        // Resolve metrics if available (it should be)
        if (app.bound('IMetrics')) {
            this.metrics = app.make('IMetrics');
        }

        this.maxConcurrency = options.maxConcurrency ?? 5;
        this.pollIntervalMs = options.pollInterval ?? 1000;
        this.recoveryCheckIntervalMs = options.recoveryCheckIntervalMs ?? 60000;
        this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? 300000;
        this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30000;
        this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30000;
        this.defaultExecutionTimeoutMs = options.executionTimeoutMs ?? 300_000; // Default 5 minutes
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.logger.info(`Worker started polling`, { concurrency: this.maxConcurrency });

        this.startRecoveryLoop();
        this.startMetricsLoop();

        const loop = async () => {
            if (!this.running) return;

            try {
                // Fill up to maxConcurrency slots
                while (this.running && this.activeJobs < this.maxConcurrency) {
                    const job = await this.queue.pop();
                    if (!job) break;

                    this.activeJobs++;
                    const jobPromise = this.process(job).finally(() => {
                        this.activeJobs--;
                        this.activePromises.delete(jobPromise);
                        if (this.running) setImmediate(loop);
                    });
                    this.activePromises.add(jobPromise);
                }

                if (this.activeJobs < this.maxConcurrency) {
                    this.pollTimer = setTimeout(loop, this.pollIntervalMs);
                }
            } catch (err) {
                this.logger.error('Worker poll error', err as Error);
                this.pollTimer = setTimeout(loop, 5000);
            }
        };

        loop();
    }

    private startRecoveryLoop() {
        if (this.recoveryInterval) clearInterval(this.recoveryInterval);

        const recover = async () => {
            if (!this.running) return;
            try {
                const count = await this.queue.recover(this.recoveryTimeoutMs);
                if (count > 0) {
                    this.logger.warn(`Recovered stuck jobs`, { count });
                    this.metrics?.increment('job.recovered', count);
                }
            } catch (e: any) {
                this.logger.error(`Recovery failed`, { error: e.message });
            }
        };

        recover();
        this.recoveryInterval = setInterval(recover, this.recoveryCheckIntervalMs);
    }

    private startMetricsLoop() {
        if (this.metricsInterval) clearInterval(this.metricsInterval);

        const updateMetrics = async () => {
            if (!this.running || !this.metrics) return;
            try {
                const stats = await this.queue.stats();

                // Overall gauges
                await this.metrics.gauge('queue.depth.pending', stats.overview.pending || 0);
                await this.metrics.gauge('queue.depth.processing', stats.overview.processing || 0);
                await this.metrics.gauge('queue.depth.failed', stats.overview.failed || 0);

                // Per-type gauges (only if significant? let's do top 5 types or all?)
                // For now, logging all might be heavy if many types. Let's just do totals.
            } catch (e) {
                // ignore metrics errors
            }
        };

        // Update immediately and then every 5 seconds
        updateMetrics();
        this.metricsInterval = setInterval(updateMetrics, 5000);
    }

    async stop(): Promise<void> {
        this.running = false;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.recoveryInterval) clearInterval(this.recoveryInterval);
        if (this.metricsInterval) clearInterval(this.metricsInterval);
        this.logger.info(`Worker stopping`, { activeJobs: this.activePromises.size });

        let forced = false;
        let timeoutTimer: NodeJS.Timeout;

        const drainPromise = Promise.allSettled(this.activePromises);
        const timeoutPromise = new Promise<void>(resolve => {
            timeoutTimer = setTimeout(() => {
                forced = true;
                resolve();
            }, this.shutdownTimeoutMs);
        });

        // Wait for drain OR timeout
        await Promise.race([drainPromise, timeoutPromise]);
        clearTimeout(timeoutTimer!);

        if (forced) {
            this.logger.warn(`Worker shutdown timed out`, {
                timeoutMs: this.shutdownTimeoutMs,
                remainingJobs: this.activeJobMap.size
            });
        }

        // Queue lifecycle is owned by the Container (IQueue singleton).
        // Container's LIFO shutdown closes it after Worker.dispose().
    }

    /** Called by Container shutdown (LIFO) — stops the worker before queue is closed. */
    async dispose(): Promise<void> {
        await this.stop();
    }

    private async process(job: Job) {
        if (!this.running) {
            try {
                await this.queue.release(job.id);
            } catch (e) {
                // Ignore
            }
            return;
        }

        this.activeJobMap.set(job.id, job); // Track active job

        this.logger.debug(`Processing job`, { jobId: job.id, type: job.type });
        const startTime = Date.now();
        const heartbeatIntervalMs = job.options?.heartbeatIntervalMs ?? this.heartbeatIntervalMs;
        const stuckTimeoutMs = job.options?.stuckTimeoutMs ?? this.recoveryTimeoutMs;
        const executionTimeoutMs = job.options?.executionTimeoutMs ?? this.defaultExecutionTimeoutMs;

        let heartbeatTimer: NodeJS.Timeout | null = null;
        let executionTimer: NodeJS.Timeout | null = null; // Track timer to clear it

        if (heartbeatIntervalMs >= stuckTimeoutMs) {
            this.logger.warn(`Heartbeat interval is >= stuck timeout`, {
                jobId: job.id,
                heartbeatIntervalMs,
                stuckTimeoutMs
            });
        }

        if (heartbeatIntervalMs > 0) {
            heartbeatTimer = setInterval(async () => {
                try {
                    await this.queue.heartbeat(job.id);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    this.logger.warn(`Heartbeat failed`, { jobId: job.id, error: message });
                }
            }, heartbeatIntervalMs);
        }

        try {
            const handlers = this.app.make('JobHandlers');
            const handler = handlers.get(job.type);

            if (this.jobRegistry) {
                const { valid, error } = this.jobRegistry.validate(job.type, job.payload);
                if (!valid) {
                    throw new JobValidationError(`Validation Error: ${error}`);
                }
            }

            if (!handler) {
                throw new Error(`No handler found for job type: ${job.type}`);
            }

            // Execute handler with optional timeout
            // Default to 5 minutes if not specified (0 in options means disabled, but we enforce a global default here for safety)
            const effectiveTimeoutMs = executionTimeoutMs > 0 ? executionTimeoutMs : 300_000;

            if (effectiveTimeoutMs > 0) {
                await Promise.race([
                    handler(job),
                    new Promise((_, reject) => {
                        executionTimer = setTimeout(() => reject(new Error(`Timeout: Job exceeded ${effectiveTimeoutMs}ms`)), effectiveTimeoutMs);
                    })
                ]);
            } else {
                // Should not happen with default, but fallback
                await handler(job);
            }

            try {
                await this.queue.complete(job.id);
                const duration = Date.now() - startTime;
                this.logger.debug(`Job completed`, { jobId: job.id, durationMs: duration });
                this.metrics?.increment('job.completed', 1, { type: job.type });
                this.metrics?.gauge('job.duration', duration, { type: job.type });
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                this.logger.error(`Failed to complete job`, { jobId: job.id, error: message });
            }

        } catch (err: any) {
            const msg = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : undefined;

            const maxRetries = job.options?.maxRetries ?? 3;
            const backoff = job.options?.backoffBase ?? 1000;

            if (job.attempts < maxRetries && !(err instanceof JobValidationError)) {
                const delay = backoff * Math.pow(2, job.attempts);
                this.logger.warn(`Job failed, retrying`, {
                    jobId: job.id,
                    type: job.type,
                    attempt: job.attempts + 1,
                    max: maxRetries,
                    delay,
                    error: msg
                });
                this.metrics?.increment('job.retried', 1, { type: job.type });
                try {
                    await this.queue.retry(job.id, delay, msg);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    this.logger.error(`Failed to retry job`, { jobId: job.id, error: message });
                }
            } else {
                const duration = Date.now() - startTime;
                this.logger.error(`Job failed permanently`, {
                    jobId: job.id,
                    type: job.type,
                    attempts: job.attempts,
                    error: msg,
                    stack,
                    durationMs: duration
                });
                this.metrics?.increment('job.failed', 1, { type: job.type });
                try {
                    await this.queue.fail(job.id, msg);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    this.logger.error(`Failed to mark job failed`, { jobId: job.id, error: message });
                }
            }
        } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            if (executionTimer) clearTimeout(executionTimer);
            this.activeJobMap.delete(job.id); // Remove from tracking
        }
    }
}
