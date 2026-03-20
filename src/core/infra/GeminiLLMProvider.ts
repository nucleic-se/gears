import { IMetrics } from '../metrics/interfaces.js';
import { ILLMProvider } from '../interfaces.js';
import type {
    Message,
    StopReason,
    StructuredRequest,
    StructuredResponse,
    TokenUsage,
    ToolDefinition,
    TurnRequest,
    TurnResponse,
} from '@nucleic-se/agentic/contracts';
import { extractJsonCandidate, toGeminiSchema } from './llmUtils.js';

interface GeminiPart {
    text?: string;
    functionCall?: {
        id?: string;
        name?: string;
        args?: Record<string, unknown>;
    };
    functionResponse?: {
        id?: string;
        name?: string;
        response?: Record<string, unknown>;
    };
}

interface GeminiCandidate {
    content?: {
        parts?: GeminiPart[];
    };
    finishReason?: string;
}

interface GeminiGenerateResponse {
    candidates?: GeminiCandidate[];
    usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
    };
}

interface GeminiEmbedResponse {
    embedding?: {
        values?: number[];
    };
}

/**
 * GeminiLLMProvider - Direct HTTP integration with Gemini's Generative Language API.
 * Implements the agentic v2 turn/structured/embed contract without relying on the SDK.
 */
export class GeminiLLMProvider implements ILLMProvider {
    private apiKey: string;
    private defaultModel: string;
    private embedModel: string;
    private metrics?: IMetrics;
    private timeoutMs: number;
    private baseUrl: string;

    constructor(
        apiKey: string = process.env.GEMINI_API_KEY || '',
        defaultModel: string = process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        metrics?: IMetrics,
        embedModel: string = process.env.GEMINI_EMBED_MODEL || 'text-embedding-004',
        timeoutMs: number = Number(process.env.GEMINI_TIMEOUT_MS || '120000'),
        baseUrl: string = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta',
    ) {
        if (!apiKey) throw new Error('GeminiLLMProvider: GEMINI_API_KEY is required');
        this.apiKey = apiKey;
        this.defaultModel = defaultModel;
        this.embedModel = embedModel;
        this.metrics = metrics;
        this.timeoutMs = timeoutMs;
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    async structured<T>(request: StructuredRequest): Promise<StructuredResponse<T>> {
        const model = this.defaultModel;
        const start = Date.now();

        try {
            const response = await this.generateContent(model, {
                systemInstruction: this.toSystemInstruction(request.system),
                contents: this.toGeminiContents(request.messages),
                generationConfig: {
                    temperature: 0,
                    responseMimeType: 'application/json',
                    responseSchema: toGeminiSchema(request.schema as Record<string, unknown>),
                },
            });

            const duration = Date.now() - start;
            const usage = this.recordUsage(model, duration, response.usageMetadata);
            const text = this.getResponseText(response);

            try {
                return { value: JSON.parse(text) as T, usage };
            } catch {
                const extracted = extractJsonCandidate(text);
                if (extracted) {
                    return { value: JSON.parse(extracted) as T, usage };
                }
                throw new Error(`GeminiLLMProvider: failed to parse response as JSON: ${text.substring(0, 20_000)}`);
            }
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`GeminiLLMProvider error: ${error.message}`, { cause: error });
            }
            throw error;
        }
    }

    async turn(request: TurnRequest): Promise<TurnResponse> {
        const model = this.defaultModel;
        const start = Date.now();

        try {
            const response = await this.generateContent(model, {
                systemInstruction: this.toSystemInstruction(request.system),
                contents: this.toGeminiContents(request.messages),
                ...(request.tools?.length
                    ? {
                        tools: [{ functionDeclarations: this.toFunctionDeclarations(request.tools) }],
                        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
                    }
                    : {}),
                generationConfig: {
                    ...(request.stopSequences?.length ? { stopSequences: request.stopSequences } : {}),
                    ...(request.maxTokens != null ? { maxOutputTokens: request.maxTokens } : {}),
                },
            });

            const duration = Date.now() - start;
            const usage = this.recordUsage(model, duration, response.usageMetadata);
            const candidate = response.candidates?.[0];
            const parts = candidate?.content?.parts ?? [];
            const text = parts
                .map(part => part.text ?? '')
                .join('');
            const toolCalls = parts
                .filter((part): part is GeminiPart & { functionCall: NonNullable<GeminiPart['functionCall']> } => !!part.functionCall?.name)
                .map((part, index) => ({
                    id: part.functionCall.id ?? `gemini-tool-call-${index}`,
                    name: part.functionCall.name as string,
                    args: part.functionCall.args ?? {},
                }));

            return {
                message: {
                    role: 'assistant',
                    content: text,
                    ...(toolCalls.length ? { toolCalls } : {}),
                },
                stopReason: this.toStopReason(candidate?.finishReason, toolCalls.length > 0),
                usage,
            };
        } catch (error) {
            if (error instanceof Error) {
                throw new Error(`GeminiLLMProvider error: ${error.message}`, { cause: error });
            }
            throw error;
        }
    }

    async embed(texts: string[]): Promise<number[][]> {
        try {
            const results: number[][] = [];
            for (const text of texts) {
                const response = await this.post<GeminiEmbedResponse>(`${this.modelPath(this.embedModel)}:embedContent`, {
                    content: {
                        role: 'user',
                        parts: [{ text }],
                    },
                });
                const values = response.embedding?.values;
                if (!values) throw new Error('GeminiLLMProvider: no embedding values in response');
                results.push(values);
            }
            return results;
        } catch (error) {
            throw new Error(`GeminiLLMProvider embeddings failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async generateContent(model: string, body: Record<string, unknown>): Promise<GeminiGenerateResponse> {
        return this.post<GeminiGenerateResponse>(`${this.modelPath(model)}:generateContent`, body);
    }

    private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
        const response = await fetch(`${this.baseUrl}/${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.apiKey,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => '(no body)');
            throw new Error(`Gemini API failed with status ${response.status}: ${errorText.substring(0, 2_000)}`);
        }

        return response.json() as Promise<T>;
    }

    private modelPath(model: string): string {
        return `models/${encodeURIComponent(model)}`;
    }

    private toSystemInstruction(system?: string): { parts: Array<{ text: string }> } | undefined {
        if (!system) return undefined;
        return { parts: [{ text: system }] };
    }

    private toGeminiContents(messages: Message[]): Array<{ role: string; parts: GeminiPart[] }> {
        const toolNames = new Map<string, string>();
        const contents: Array<{ role: string; parts: GeminiPart[] }> = [];

        for (const message of messages) {
            if (message.role === 'user') {
                contents.push({
                    role: 'user',
                    parts: [{ text: message.content }],
                });
                continue;
            }

            if (message.role === 'assistant') {
                const parts: GeminiPart[] = [];
                if (message.content) {
                    parts.push({ text: message.content });
                }
                for (const toolCall of message.toolCalls ?? []) {
                    toolNames.set(toolCall.id, toolCall.name);
                    parts.push({
                        functionCall: {
                            id: toolCall.id,
                            name: toolCall.name,
                            args: toolCall.args,
                        },
                    });
                }
                if (parts.length) {
                    contents.push({ role: 'model', parts });
                }
                continue;
            }

            const toolName = toolNames.get(message.toolCallId);
            if (!toolName) {
                contents.push({
                    role: 'user',
                    parts: [{ text: message.content }],
                });
                continue;
            }

            contents.push({
                role: 'user',
                parts: [{
                    functionResponse: {
                        id: message.toolCallId,
                        name: toolName,
                        response: {
                            content: message.content,
                            ...(message.isError ? { isError: true } : {}),
                        },
                    },
                }],
            });
        }

        return contents;
    }

    private toFunctionDeclarations(tools: ToolDefinition[]): Array<Record<string, unknown>> {
        return tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
        }));
    }

    private getResponseText(response: GeminiGenerateResponse): string {
        const text = response.candidates?.[0]?.content?.parts
            ?.map(part => part.text ?? '')
            .join('')
            .trim();

        if (!text) {
            throw new Error('GeminiLLMProvider: empty response from model');
        }

        return text;
    }

    private toStopReason(finishReason?: string, hasToolCalls: boolean = false): StopReason {
        if (hasToolCalls) return 'tool_use';
        switch (finishReason) {
            case 'MAX_TOKENS':
                return 'max_tokens';
            case 'STOP':
                return 'end_turn';
            case 'STOP_SEQUENCE':
                return 'stop_sequence';
            default:
                return 'end_turn';
        }
    }

    private recordUsage(
        model: string,
        duration: number,
        usageMeta?: { promptTokenCount?: number; candidatesTokenCount?: number },
    ): TokenUsage {
        const usage: TokenUsage = {
            inputTokens: usageMeta?.promptTokenCount ?? 0,
            outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        };
        if (this.metrics) {
            this.metrics.increment('llm.request', 1, { model });
            this.metrics.gauge('llm.latency', duration, { model });
            if (usage.inputTokens) this.metrics.increment('llm.tokens.input', usage.inputTokens, { model });
            if (usage.outputTokens) this.metrics.increment('llm.tokens.output', usage.outputTokens, { model });
        }
        return usage;
    }
}
