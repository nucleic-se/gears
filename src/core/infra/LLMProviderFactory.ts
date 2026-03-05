import type { ILLMProvider } from '../interfaces.js';
import type { IMetrics } from '../metrics/interfaces.js';
import type { IFetcher } from '../interfaces.js';

export interface LLMProviderOptions {
    /** Provider name: 'ollama' | 'anthropic' | 'gemini'. Falls back to LLM_PROVIDER env var, then 'ollama'. */
    provider?: string;
    metrics?: IMetrics;
    /** Injected for Ollama; ignored by other providers. */
    fetcher?: IFetcher;
}

export async function createLLMProvider(options: LLMProviderOptions = {}): Promise<ILLMProvider> {
    const name = (options.provider ?? process.env.LLM_PROVIDER ?? 'ollama').toLowerCase();
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
                undefined, undefined, options.metrics,
                undefined, undefined, undefined,
                options.fetcher,
            );
        }
        default:
            throw new Error(`Unknown LLM provider: "${name}". Valid options: anthropic, gemini, ollama`);
    }
}
