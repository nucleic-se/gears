import { GoogleGenAI } from '@google/genai';
import { IMetrics } from '../metrics/interfaces.js';
import { ILLMProvider, LLMRequest } from '../interfaces.js';
import { toGeminiSchema } from './llmUtils.js';

/**
 * GeminiLLMProvider - Integration with Google Gemini API via @google/genai
 * Uses native JSON mode (responseMimeType + responseSchema) for structured output.
 */
export class GeminiLLMProvider implements ILLMProvider {
    private client: GoogleGenAI;
    private defaultModel: string;
    private embedModel: string;
    private metrics?: IMetrics;
    private timeoutMs: number;

    constructor(
        apiKey: string = process.env.GEMINI_API_KEY || '',
        defaultModel: string = process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        metrics?: IMetrics,
        embedModel: string = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004',
        timeoutMs: number = Number(process.env.GEMINI_TIMEOUT_MS || '120000'),
    ) {
        if (!apiKey) throw new Error('GeminiLLMProvider: GEMINI_API_KEY is required');
        this.client = new GoogleGenAI({ apiKey });
        this.defaultModel = defaultModel;
        this.embedModel = embedModel;
        this.metrics = metrics;
        this.timeoutMs = timeoutMs;
    }

    async process<T = any>(request: LLMRequest<T>): Promise<T> {
        const model = request.model || this.defaultModel;
        const start = Date.now();

        const prompt = `${request.instructions}

INPUT:
${request.text}`;

        try {
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`GeminiLLMProvider: request timed out after ${this.timeoutMs}ms`)), this.timeoutMs),
            );
            const response = await Promise.race([
                this.client.models.generateContent({
                    model,
                    contents: prompt,
                    config: {
                        temperature: request.temperature ?? 0,
                        responseMimeType: 'application/json',
                        ...(request.schema ? { responseSchema: toGeminiSchema(request.schema as Record<string, unknown>) as any } : {}),
                    },
                }),
                timeout,
            ]);

            const duration = Date.now() - start;
            const text = response.text ?? '';
            const usageMeta = response.usageMetadata;

            if (this.metrics) {
                this.metrics.increment('llm.request', 1, { model });
                this.metrics.gauge('llm.latency', duration, { model });
                if (usageMeta?.promptTokenCount) {
                    this.metrics.increment('llm.tokens.input', usageMeta.promptTokenCount, { model });
                }
                if (usageMeta?.candidatesTokenCount) {
                    this.metrics.increment('llm.tokens.output', usageMeta.candidatesTokenCount, { model });
                }
            }

            if (!text) {
                throw new Error('GeminiLLMProvider: empty response from model');
            }

            try {
                return JSON.parse(text) as T;
            } catch {
                throw new Error(`GeminiLLMProvider: failed to parse response as JSON: ${text.substring(0, 20_000)}`);
            }
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`GeminiLLMProvider error: ${error.message}`, { cause: error });
            }
            throw error;
        }
    }

    async embed(text: string): Promise<number[]> {
        try {
            const response = await this.client.models.embedContent({
                model: this.embedModel,
                contents: text,
            });

            const values = response.embeddings?.[0]?.values;
            if (!values) throw new Error('GeminiLLMProvider: no embedding values in response');
            return values;
        } catch (error) {
            throw new Error(`GeminiLLMProvider embeddings failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
