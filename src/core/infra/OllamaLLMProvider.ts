import { OllamaProvider } from '@nucleic-se/agentic/providers';
import type { ILLMProvider, StructuredRequest, StructuredResponse, TurnRequest, TurnResponse, TokenUsage } from '@nucleic-se/agentic/contracts';
import { IMetrics } from '../metrics/interfaces.js';

/**
 * Metrics-instrumented wrapper around agentic's OllamaProvider.
 * Delegates all LLM calls to the upstream provider (OpenAI-compatible /v1 endpoint)
 * and records latency / token usage via IMetrics.
 */
export class OllamaLLMProvider implements ILLMProvider {
    private provider: OllamaProvider;
    private model: string;
    private metrics?: IMetrics;

    constructor(
        baseUrl: string = process.env.OLLAMA_HOST || 'http://localhost:11434',
        defaultModel?: string,
        metrics?: IMetrics,
        embedModel?: string,
        apiKey: string = process.env.OLLAMA_API_KEY || '',
    ) {
        if (!defaultModel) {
            defaultModel = process.env.OLLAMA_MODEL ?? ''
            if (!defaultModel) throw new Error('OllamaLLMProvider: OLLAMA_MODEL is required')
        }
        if (!embedModel) {
            embedModel = process.env.OLLAMA_EMBED_MODEL ?? defaultModel
        }
        this.model = defaultModel;
        this.metrics = metrics;
        this.provider = new OllamaProvider({
            apiKey: apiKey || undefined,
            model: defaultModel,
            embeddingModel: embedModel,
            baseUrl: baseUrl.replace(/\/?$/, '/v1'),
        });
    }

    async structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>> {
        const start = Date.now();
        const result = await this.provider.structured<T>(request);
        this.recordMetrics(Date.now() - start, result.usage);
        return result;
    }

    async turn(request: TurnRequest): Promise<TurnResponse> {
        const start = Date.now();
        const result = await this.provider.turn(request);
        this.recordMetrics(Date.now() - start, result.usage);
        return result;
    }

    async embed(texts: string[]): Promise<number[][]> {
        return this.provider.embed(texts);
    }

    private recordMetrics(duration: number, usage: TokenUsage): void {
        if (!this.metrics) return;
        this.metrics.increment('llm.request', 1, { model: this.model });
        this.metrics.gauge('llm.latency', duration, { model: this.model });
        if (usage.inputTokens) this.metrics.increment('llm.tokens.input', usage.inputTokens, { model: this.model });
        if (usage.outputTokens) this.metrics.increment('llm.tokens.output', usage.outputTokens, { model: this.model });
    }
}
