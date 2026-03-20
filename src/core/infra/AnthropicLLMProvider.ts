import { AnthropicProvider } from '@nucleic-se/agentic/providers';
import type { ILLMProvider, StructuredRequest, StructuredResponse, TurnRequest, TurnResponse, TokenUsage } from '@nucleic-se/agentic/contracts';
import { IMetrics } from '../metrics/interfaces.js';

/**
 * Metrics-instrumented wrapper around agentic's AnthropicProvider.
 * Delegates all LLM calls to the upstream provider (raw HTTP, built-in rate limiting)
 * and records latency / token usage via IMetrics.
 */
export class AnthropicLLMProvider implements ILLMProvider {
    private provider: AnthropicProvider;
    private model: string;
    private metrics?: IMetrics;

    constructor(
        apiKey: string = process.env.ANTHROPIC_API_KEY || '',
        defaultModel: string = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        metrics?: IMetrics,
        maxTokens: number = Number(process.env.ANTHROPIC_MAX_TOKENS || 4096),
    ) {
        if (!apiKey) throw new Error('AnthropicLLMProvider: ANTHROPIC_API_KEY is required');
        this.model = defaultModel;
        this.metrics = metrics;
        this.provider = new AnthropicProvider({
            apiKey,
            model: defaultModel,
            maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
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
