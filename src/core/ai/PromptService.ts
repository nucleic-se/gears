/**
 * Container-aware AI prompt service.
 *
 * Thin wrapper that resolves ILLMProvider from the Container,
 * then delegates to the decoupled library AIPromptService.
 */

import { Container } from '../container/Container.js';
import { ILLMProvider } from '../interfaces.js';
import { IAIPromptService, IAIPromptBuilder, IAIPipeline } from './interfaces.js';
import { AIPromptService as LibAIPromptService } from '@nucleic-se/agentic/runtime';

export class AIPromptService implements IAIPromptService {
    private delegate: LibAIPromptService | null = null;

    constructor(private container: Container) {}

    /** Lazily resolve ILLMProvider so construction doesn't throw */
    private getDelegate(): LibAIPromptService {
        if (!this.delegate) {
            let llm: ILLMProvider;
            try {
                llm = this.container.make('ILLMProvider');
            } catch (error) {
                const provider = process.env.LLM_PROVIDER || 'ollama';
                throw new Error(
                    `LLM provider "${provider}" not configured. Ensure required environment variables are set and core services are booted.`,
                    { cause: error },
                );
            }
            this.delegate = new LibAIPromptService(llm);
        }
        return this.delegate;
    }

    use(model?: string): IAIPromptBuilder {
        return this.getDelegate().use(model);
    }

    pipeline<T>(start: T): IAIPipeline<T> {
        return this.getDelegate().pipeline(start);
    }
}
