import Anthropic from '@anthropic-ai/sdk';
import { IMetrics } from '../metrics/interfaces.js';
import { ILLMProvider, LLMRequest } from '../interfaces.js';

function extractJsonCandidate(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        return fenced[1].trim();
    }

    const startIndex = trimmed.search(/[\[{]/);
    if (startIndex === -1) return null;

    const startChar = trimmed[startIndex];
    const endChar = startChar === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = startIndex; i < trimmed.length; i++) {
        const ch = trimmed[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === startChar) depth += 1;
        if (ch === endChar) {
            depth -= 1;
            if (depth === 0) {
                return trimmed.slice(startIndex, i + 1);
            }
        }
    }

    return null;
}

/**
 * AnthropicLLMProvider - Integration with Anthropic Claude API via @anthropic-ai/sdk
 * Uses strict prompt instructions and JSON extraction/parsing for structured output.
 */
export class AnthropicLLMProvider implements ILLMProvider {
    private client: Anthropic;
    private defaultModel: string;
    private metrics?: IMetrics;
    private maxTokens: number;

    constructor(
        apiKey: string = process.env.ANTHROPIC_API_KEY || '',
        defaultModel: string = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
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
        const schemaStr = JSON.stringify(request.schema ?? {}, null, 2);

        const prompt = `${request.instructions}

INPUT:
${request.text}

IMPORTANT:
- Respond ONLY with valid JSON.
- Do not include markdown fences.
- JSON must match this schema:
${schemaStr}`;

        try {
            const response = await this.client.messages.create({
                model,
                max_tokens: this.maxTokens,
                temperature: request.temperature ?? 0.7,
                messages: [{ role: 'user', content: prompt }],
            });

            const duration = Date.now() - start;
            const text = response.content
                .filter((item) => item.type === 'text')
                .map((item) => item.text)
                .join('\n')
                .trim();

            if (this.metrics) {
                this.metrics.increment('llm.request', 1, { model });
                this.metrics.gauge('llm.latency', duration, { model });
                if (response.usage?.output_tokens) {
                    this.metrics.increment('llm.tokens.output', response.usage.output_tokens, { model });
                }
            }

            if (!text) {
                throw new Error('AnthropicLLMProvider: empty response from model');
            }

            try {
                return JSON.parse(text) as T;
            } catch {
                const extracted = extractJsonCandidate(text);
                if (extracted) return JSON.parse(extracted) as T;
                throw new Error(`AnthropicLLMProvider: failed to parse response as JSON: ${text.substring(0, 20_000)}`);
            }
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`AnthropicLLMProvider error: ${error.message}`);
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
