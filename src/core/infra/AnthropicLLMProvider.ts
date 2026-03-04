import Anthropic from '@anthropic-ai/sdk';
import { IMetrics } from '../metrics/interfaces.js';
import { ILLMProvider, LLMRequest } from '../interfaces.js';

/**
 * AnthropicLLMProvider - Integration with Anthropic Claude API via @anthropic-ai/sdk
 * Uses tool_use with forced tool_choice for native structured JSON output.
 */
export class AnthropicLLMProvider implements ILLMProvider {
    private client: Anthropic;
    private defaultModel: string;
    private metrics?: IMetrics;
    private maxTokens: number;

    constructor(
        apiKey: string = process.env.ANTHROPIC_API_KEY || '',
        defaultModel: string = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        metrics?: IMetrics,
        maxTokens: number = Number(process.env.ANTHROPIC_MAX_TOKENS || 4096),
    ) {
        if (!apiKey) throw new Error('AnthropicLLMProvider: ANTHROPIC_API_KEY is required');
        this.client = new Anthropic({ apiKey });
        this.defaultModel = defaultModel;
        this.metrics = metrics;
        this.maxTokens = Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096;
    }

    async process<T = any>(request: LLMRequest<T>): Promise<T> {
        const model = request.model || this.defaultModel;
        const start = Date.now();

        const tools: Anthropic.Tool[] = [
            {
                name: 'output',
                description: 'Return the structured result.',
                input_schema: (request.schema as Anthropic.Tool['input_schema']) ?? { type: 'object' },
            },
        ];

        try {
            const response = await this.client.messages.create({
                model,
                max_tokens: this.maxTokens,
                temperature: request.temperature ?? 0,
                system: request.instructions,
                tools,
                tool_choice: { type: 'tool', name: 'output' },
                messages: [{ role: 'user', content: request.text }],
            });

            const duration = Date.now() - start;

            if (this.metrics) {
                this.metrics.increment('llm.request', 1, { model });
                this.metrics.gauge('llm.latency', duration, { model });
                if (response.usage?.input_tokens) {
                    this.metrics.increment('llm.tokens.input', response.usage.input_tokens, { model });
                }
                if (response.usage?.output_tokens) {
                    this.metrics.increment('llm.tokens.output', response.usage.output_tokens, { model });
                }
            }

            const toolUse = response.content.find((item) => item.type === 'tool_use');
            if (!toolUse || toolUse.type !== 'tool_use') {
                throw new Error('AnthropicLLMProvider: no tool_use block in response');
            }

            return toolUse.input as T;
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`AnthropicLLMProvider error: ${error.message}`, { cause: error });
            }
            throw error;
        }
    }

    async embed(_text: string): Promise<number[]> {
        throw new Error(
            'AnthropicLLMProvider embeddings are not supported. Use Ollama or Gemini provider for embeddings.',
        );
    }
}
