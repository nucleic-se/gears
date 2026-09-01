export * from './core/interfaces.js';
export * from './core/infra/RateLimitedFetcher.js';
export * from './core/container/Container.js';
export * from './core/container/ServiceProvider.js';
export * from './core/queue/interfaces.js';
export * from './core/events/interfaces.js';
export * from './core/schedule/interfaces.js';
export { ScheduledJobRegistrar } from './core/schedule/ScheduledJobRegistrar.js';
export { SQLiteDurableEventBus } from './core/infra/SQLiteDurableEventBus.js';

// --- Bundle API (for external bundle authors) ---
export type { Bundle } from './core/bundle/Bundle.js';
export type { ServiceMap, ServiceKey } from './core/services.js';

export { DataPaths, getDataDir, ensureDataDir, getDbPath } from './core/utils/paths.js';
export type { IDataPaths } from './core/utils/paths.js';

import { Container } from './core/container/Container.js';
import { CoreServiceProvider } from './core/providers/CoreServiceProvider.js';
import { QueueServiceProvider } from './core/providers/QueueServiceProvider.js';
import path from 'path';
import { DataPaths } from './core/utils/paths.js';

export interface BootOptions {
    dataDir?: string;
}

/**
 * Boot core services onto a container.
 * If no container is provided, a new one is created.
 */
export async function boot(options?: BootOptions): Promise<Container>;
export async function boot(container: Container, options?: BootOptions): Promise<Container>;
export async function boot(containerOrOptions?: Container | BootOptions, maybeOptions?: BootOptions): Promise<Container> {
    const app = containerOrOptions instanceof Container ? containerOrOptions : new Container();
    const options = containerOrOptions instanceof Container ? maybeOptions : containerOrOptions;

    const dataDir = path.resolve(options?.dataDir ?? process.env.GEARS_DATA_DIR ?? path.resolve(process.cwd(), '.gears'));
    app.singleton('DataPaths', () => new DataPaths(dataDir));

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
