export * from './core/interfaces.js';
export * from './core/infra/RateLimitedFetcher.js';
export * from './core/container/Container.js';
export * from './core/container/ServiceProvider.js';
export * from './core/queue/interfaces.js';
export * from './core/events/interfaces.js';
export { SQLiteDurableEventBus } from './core/infra/SQLiteDurableEventBus.js';

// --- Bundle API (for external bundle authors) ---
export type { Bundle } from './core/bundle/Bundle.js';
export type { ServiceMap, ServiceKey } from './core/services.js';

// --- AI types (for bundles that depend on AI services) ---
export type { IAIPromptService, IAIPromptBuilder, IAIPipeline, IAIActionRegistry, AIAction } from './core/ai/interfaces.js';
export { AIPromptService } from './core/ai/PromptService.js';
export { AIActionRegistry } from './core/ai/AIActionRegistry.js';
export { AIPipeline } from './core/ai/Pipeline.js';
export { OllamaLLMProvider } from './core/infra/OllamaLLMProvider.js';
export { getDataDir, ensureDataDir, getDbPath } from './core/utils/paths.js';

import { Container } from './core/container/Container.js';
import { CoreServiceProvider } from './core/providers/CoreServiceProvider.js';
import { QueueServiceProvider } from './core/providers/QueueServiceProvider.js';

/**
 * Boot core services onto a container.
 * If no container is provided, a new one is created.
 */
export async function boot(container?: Container): Promise<Container> {
    const app = container ?? new Container();

    const providers = [
        new CoreServiceProvider(app),
        new QueueServiceProvider(app),
    ];

    for (const provider of providers) {
        await provider.register();
    }

    for (const provider of providers) {
        await provider.boot();
    }

    return app;
}
