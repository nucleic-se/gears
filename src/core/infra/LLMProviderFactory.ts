import type { ILLMProvider } from '../interfaces.js';
import type { IMetrics } from '../metrics/interfaces.js';

export interface LLMProviderOptions {
    /** Provider name: 'ollama' | 'anthropic' | 'gemini'. Falls back to LLM_PROVIDER env var, then 'ollama'. */
    provider?: string;
    metrics?: IMetrics;
    /** Override the default model for this provider instance. For Ollama: overrides OLLAMA_MODEL env var. */
    model?: string;
}

export async function createLLMProvider(options: LLMProviderOptions = {}): Promise<ILLMProvider> {
    const name = (options.provider ?? process.env.LLM_PROVIDER ?? '').toLowerCase();
    if (!name) throw new Error('LLM_PROVIDER is required. Set it to: anthropic, gemini, or ollama');
    switch (name) {
        case 'anthropic': {
            const { AnthropicLLMProvider } = await import('./AnthropicLLMProvider.js');
            return new AnthropicLLMProvider(undefined, undefined, options.metrics);
        }
        case 'gemini': {
            const { GeminiLLMProvider } = await import('./GeminiLLMProvider.js');
            return new GeminiLLMProvider(undefined, undefined, options.metrics);
        }
        case 'ollama': {
            const { OllamaLLMProvider } = await import('./OllamaLLMProvider.js');
            return new OllamaLLMProvider(
                undefined, options.model, options.metrics,
            );
        }
        default:
            throw new Error(`Unknown LLM provider: "${name}". Valid options: anthropic, gemini, ollama`);
    }
}
