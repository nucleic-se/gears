import { ServiceProvider } from '../container/ServiceProvider.js';
import { RateLimitedFetcher } from '../infra/RateLimitedFetcher.js';
import { BundleManager } from '../bundle/BundleManager.js';
import { SQLiteMutex } from '../infra/SQLiteMutex.js';
import { PinoLogger, PinoLoggerOptions } from '../infra/PinoLogger.js';
import { EventBus } from '../events/EventBus.js';
import { CheerioParser } from '../infra/CheerioParser.js';
import { SharedDatabase } from '../infra/SharedDatabase.js';

export class CoreServiceProvider extends ServiceProvider {
    register(): void {
        this.app.singleton('ILogger', (app) => {
            // Check if LoggerOptions were configured by CLI bootstrap
            const options = app.bound('LoggerOptions')
                ? app.make('LoggerOptions')
                : {};
            return new PinoLogger({ ...options, dataDir: app.make('DataPaths').ensureDataDir() });
        });

        this.app.singleton('IFetcher', () => {
            return new RateLimitedFetcher(1000);
        });

        // Shared SQLite connection for low-contention services
        this.app.singleton('SharedDatabase', (app) => new SharedDatabase(app.make('DataPaths').getDbPath('shared.sqlite')));

        this.app.singleton('IStore', (app) => {
            const shared = app.make('SharedDatabase');
            const store = shared.createStore();
            return store;
        });

        this.app.singleton('BundleManager', (app) => new BundleManager(app));

        this.app.singleton('IMutex', (app) => new SQLiteMutex('locks.sqlite', (file) => app.make('DataPaths').getDbPath(file)));
        this.app.singleton('IScheduler', (app) => {
            const timezone = process.env.GEARS_TIMEZONE || undefined;
            return app.make('SharedDatabase').createScheduler(app.make('IMutex'), app.make('ILogger'), timezone);
        });

        this.app.singleton('IEventBus', (app) => new EventBus(app));
        // Alias
        this.app.bind('events', (app) => app.make('IEventBus'));

        this.app.singleton('IDurableEventBus', (app) => {
            const shared = app.make('SharedDatabase');
            const bus = shared.createDurableEventBus();
            bus.startPolling();
            return bus;
        });

        // HTML Parser
        this.app.singleton('IHtmlParser', () => new CheerioParser());

        // Metrics
        this.app.singleton('IMetrics', (app) => {
            const shared = app.make('SharedDatabase');
            return shared.createMetrics();
        });
    }

    async boot(): Promise<void> {}
}
