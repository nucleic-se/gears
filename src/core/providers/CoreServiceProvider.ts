import { ServiceProvider } from '../container/ServiceProvider.js';
import { RateLimitedFetcher } from '../infra/RateLimitedFetcher.js';
import { BundleManager } from '../bundle/BundleManager.js';
import { SQLiteMutex } from '../infra/SQLiteMutex.js';
import { CronScheduler } from '../infra/CronScheduler.js';
import { PinoLogger, PinoLoggerOptions } from '../infra/PinoLogger.js';
import { SQLiteStore } from '../infra/SQLiteStore.js';
import { SQLiteDurableEventBus } from '../infra/SQLiteDurableEventBus.js';
import { EventBus } from '../events/EventBus.js';
import { CheerioParser } from '../infra/CheerioParser.js';
import { createLLMProvider } from '../infra/LLMProviderFactory.js';
import { SQLiteMetrics } from '../metrics/SQLiteMetrics.js';
import { SharedDatabase } from '../utils/SharedDatabase.js';
import { AIPromptService } from '../ai/PromptService.js';
import { AIActionRegistry } from '../ai/AIActionRegistry.js';

export class CoreServiceProvider extends ServiceProvider {
    register(): void {
        this.app.singleton('ILogger', (app) => {
            // Check if LoggerOptions were configured by CLI bootstrap
            const options = app.bound('LoggerOptions')
                ? app.make('LoggerOptions')
                : {};
            return new PinoLogger(options);
        });

        this.app.singleton('IFetcher', () => {
            return new RateLimitedFetcher(1000);
        });

        // Shared SQLite connection for low-contention services
        this.app.singleton('SharedDatabase', () => new SharedDatabase());

        this.app.singleton('IStore', (app) => {
            const shared = app.make('SharedDatabase');
            const store = new SQLiteStore(shared.db);
            store.startSweeper();
            return store;
        });

        this.app.singleton('BundleManager', (app) => new BundleManager(app));

        this.app.singleton('IMutex', () => new SQLiteMutex());
        this.app.singleton('IScheduler', (app) => {
            const timezone = process.env.GEARS_TIMEZONE || undefined;
            return new CronScheduler(app.make('IMutex'), app.make('ILogger'), { timezone });
        });

        this.app.singleton('IEventBus', (app) => new EventBus(app));
        // Alias
        this.app.bind('events', (app) => app.make('IEventBus'));

        this.app.singleton('IDurableEventBus', (app) => {
            const shared = app.make('SharedDatabase');
            const bus = new SQLiteDurableEventBus(shared.db);
            bus.startPolling();
            return bus;
        });

        // HTML Parser
        this.app.singleton('IHtmlParser', () => new CheerioParser());

        // ILLMProvider is resolved asynchronously in boot() to support lazy provider loading.

        // Core AI abstractions built on top of ILLMProvider
        this.app.singleton('IAIPromptService', (app) => new AIPromptService(app));
        this.app.singleton('IAIActionRegistry', (app) => new AIActionRegistry(app));

        // Metrics
        this.app.singleton('IMetrics', (app) => {
            const shared = app.make('SharedDatabase');
            return new SQLiteMetrics(shared.db);
        });
    }

    async boot(): Promise<void> {
        // LLM Provider — switch via LLM_PROVIDER=anthropic|gemini|ollama (default: ollama)
        // Resolved here (async) so provider modules are only loaded when actually needed.
        const provider = await createLLMProvider({
            metrics: this.app.makeOrNull('IMetrics') ?? undefined,
            fetcher: this.app.make('IFetcher'),
        });
        this.app.singleton('ILLMProvider', () => provider);
    }
}
