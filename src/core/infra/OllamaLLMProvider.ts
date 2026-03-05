import { IMetrics } from '../metrics/interfaces.js';
import { ILLMProvider, LLMRequest, IFetcher } from '../interfaces.js';
import { extractJsonCandidate } from './llmUtils.js';

/**
 * OllamaLLMProvider - Direct integration with Ollama API
 * Uses the /api/generate endpoint with JSON mode for structured output
 */
export class OllamaLLMProvider implements ILLMProvider {
    private baseUrl: string;
    private embedBaseUrl: string;
    private fetcher: IFetcher;
    private defaultModel: string;
    private embedModel: string;
    private metrics?: IMetrics;
    private apiKey?: string;

    constructor(
        baseUrl: string = process.env.OLLAMA_HOST || 'http://localhost:11434',
        defaultModel: string = process.env.OLLAMA_MODEL || 'llama3.1:8b',
        metrics?: IMetrics,
        embedModel: string = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text:latest',
        apiKey: string = process.env.OLLAMA_API_KEY || '',
        embedBaseUrl: string = process.env.OLLAMA_EMBED_HOST || '',
        fetcher?: IFetcher,
    ) {
        this.baseUrl = baseUrl;
        this.embedBaseUrl = embedBaseUrl || baseUrl;
        this.defaultModel = defaultModel;
        this.embedModel = embedModel;
        this.metrics = metrics;
        this.apiKey = apiKey || undefined;
        // If no fetcher provided, create a minimal one (no rate limiting, just undici transport).
        // In production, inject the shared RateLimitedFetcher for retry + backoff on 5xx.
        this.fetcher = fetcher ?? createMinimalFetcher();
    }

    async process<T = any>(request: LLMRequest<T>): Promise<T> {
        const model = request.model || this.defaultModel;

        // Build prompt with schema instruction
        // Note: /no_think prefix does NOT work for qwen3-next models on Ollama cloud —
        // the model still enters thinking mode. We instead use a higher num_predict
        // to give room for both thinking tokens and response tokens.
        const schemaStr = JSON.stringify(request.schema ?? {}, null, 2);
        const prompt = `${request.instructions}

INPUT:
${request.text}

IMPORTANT: Respond ONLY with valid JSON matching this exact schema:
${schemaStr}

JSON Response:`;

        // Note: Ollama supports `format: <schema>` for grammar-constrained output,
        // but it fails with open-ended schemas (e.g. `params: { type: 'object' }`
        // without defined properties) — returns empty strings. Using `format: 'json'`
        // ensures valid JSON syntax; schema compliance is enforced via prompt + validation.
        //
        // num_predict is set to 16384 because thinking models (qwen3-next) use the
        // token budget for both internal reasoning and response generation. With 8192,
        // complex synthesis prompts can exhaust the budget mid-response, producing
        // truncated JSON that fails parsing.
        const payload = {
            model,
            prompt,
            stream: false,
            format: 'json',
            options: {
                temperature: request.temperature ?? 0,
                num_ctx: 32768,
                num_predict: 16384,
            }
        };

        const start = Date.now();

        try {
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

            const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || '120000');
            const retries   = Number(process.env.OLLAMA_RETRIES   || '0');
            const resp = await this.fetcher.post(
                `${this.baseUrl}/api/generate`,
                JSON.stringify(payload),
                { headers, timeout: timeoutMs, retries },
            );

            if (resp.status >= 400) {
                throw new Error(`Ollama API failed with status ${resp.status}: ${typeof resp.body === 'string' ? resp.body.slice(0, 500) : resp.body.toString('utf-8').slice(0, 500)}`);
            }

            const raw = typeof resp.body === 'string' ? resp.body : resp.body.toString('utf-8');
            const data = JSON.parse(raw) as {
                response: string;
                thinking?: string;
                prompt_eval_count?: number;
                eval_count?: number;
                eval_duration?: number;
            };
            const duration = Date.now() - start;

            if (this.metrics) {
                this.metrics.increment('llm.request', 1, { model });
                this.metrics.gauge('llm.latency', duration, { model });
                if (data.prompt_eval_count) {
                    this.metrics.increment('llm.tokens.input', data.prompt_eval_count, { model });
                }
                if (data.eval_count) {
                    this.metrics.increment('llm.tokens.output', data.eval_count, { model });
                }
            }

            // Parse the JSON response from the model.
            // Thinking models (qwen3-next) may put all output in the `thinking` field
            // and leave `response` empty if the token budget was exhausted during
            // reasoning. In that case, attempt to extract JSON from the thinking.
            let jsonStr = data.response.trim();

            // Fallback: if response is empty but thinking contains content,
            // try to extract JSON from the thinking output
            if (!jsonStr && data.thinking) {
                const thinkingExtracted = extractJsonCandidate(data.thinking);
                if (thinkingExtracted) {
                    jsonStr = thinkingExtracted;
                }
            }

            if (!jsonStr) {
                throw new Error(
                    `Ollama returned empty response (eval_count=${data.eval_count}, ` +
                    `thinking_len=${data.thinking?.length ?? 0}). ` +
                    `The model may have exhausted its token budget on reasoning.`
                );
            }

            try {
                return JSON.parse(jsonStr) as T;
            } catch (parseError) {
                const extracted = extractJsonCandidate(jsonStr);
                if (extracted) return JSON.parse(extracted) as T;
                // Include full raw response (up to 20K) so callers can attempt salvage.
                // Previously truncated to 200 chars, breaking downstream JSON recovery.
                throw new Error(`Failed to parse Ollama response as JSON: ${jsonStr.substring(0, 20_000)}`);
            }
        } catch (error) {
            if (error instanceof Error) {
                if (error.name === 'AbortError' || error.message.includes('timed out')) {
                    throw new Error('OllamaLLMProvider error: Request timed out after 5 minutes');
                }
                throw new Error(`OllamaLLMProvider error: ${error.message}`, { cause: error });
            }
            throw error;
        }
    }
    async embed(text: string): Promise<number[]> {
        const payload = {
            model: this.embedModel,
            input: text
        };

        try {
            const embedHeaders: Record<string, string> = {
                'Content-Type': 'application/json',
            };
            if (this.apiKey) embedHeaders['Authorization'] = `Bearer ${this.apiKey}`;

            const resp = await this.fetcher.post(
                `${this.embedBaseUrl}/api/embed`,
                JSON.stringify(payload),
                { headers: embedHeaders, timeout: 30_000, retries: 1 },
            );

            if (resp.status >= 400) {
                const errText = typeof resp.body === 'string' ? resp.body : resp.body.toString('utf-8');
                throw new Error(`Ollama Embeddings API failed with status ${resp.status}: ${errText.slice(0, 500)}`);
            }

            const raw = typeof resp.body === 'string' ? resp.body : resp.body.toString('utf-8');
            const data = JSON.parse(raw) as { embeddings: number[][] };
            const values = data.embeddings?.[0];
            if (!values) throw new Error('OllamaLLMProvider: no embedding values in response');
            return values;

        } catch (error) {
            if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('timed out'))) {
                throw new Error('Ollama embeddings request timed out');
            }
            throw new Error(`Ollama embeddings failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

// ─── Minimal fallback fetcher (no rate limiting) ────────────────

import { fetch, Agent } from 'undici';

const defaultAgent = new Agent({
    connect: { timeout: 300_000 },
    headersTimeout: 300_000,
    bodyTimeout: 300_000,
});

/** Bare-bones IFetcher for when no shared fetcher is injected */
function createMinimalFetcher(): IFetcher {
    return {
        async get(url, options) {
            const resp = await fetch(url, {
                headers: options?.headers,
                signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
                dispatcher: defaultAgent,
            });
            const body = await resp.text();
            const headers: Record<string, string> = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            return { body, status: resp.status, headers, contentType: resp.headers.get('content-type') || '' };
        },
        async post(url, body, options) {
            const resp = await fetch(url, {
                method: 'POST',
                headers: options?.headers,
                body: body ?? undefined,
                signal: options?.timeout ? AbortSignal.timeout(options.timeout) : undefined,
                dispatcher: defaultAgent,
            });
            const respBody = await resp.text();
            const headers: Record<string, string> = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            return { body: respBody, status: resp.status, headers, contentType: resp.headers.get('content-type') || '' };
        },
    };
}
