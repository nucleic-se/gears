import { ServiceProvider } from '../container/ServiceProvider.js';
import { SQLiteQueue } from '../queue/SQLiteQueue.js';
import { Worker, WorkerOptions } from '../queue/Worker.js';
import { JobHandler } from '../queue/interfaces.js';
import { JobRegistry } from '../queue/JobRegistry.js';

export class QueueServiceProvider extends ServiceProvider {
    register(): void {
        const parseEnvInt = (value: string | undefined, fallback: number) => {
            if (value === undefined) return fallback;
            const parsed = Number.parseInt(value, 10);
            return Number.isNaN(parsed) ? fallback : parsed;
        };

        const defaultOptions = (): WorkerOptions => ({
            maxConcurrency: parseEnvInt(process.env.WORKER_CONCURRENCY, 5),
            pollInterval: parseEnvInt(process.env.WORKER_POLL_INTERVAL_MS, 1000),
            recoveryTimeoutMs: parseEnvInt(process.env.WORKER_RECOVERY_TIMEOUT_MS, 300000),
            recoveryCheckIntervalMs: parseEnvInt(process.env.WORKER_RECOVERY_CHECK_INTERVAL_MS, 60000),
            heartbeatIntervalMs: parseEnvInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS, 30000),
        });

        // Register Job Registry
        this.app.singleton('JobRegistry', (app) => {
            return new JobRegistry(app.make('ILogger'));
        });

        // Register Queue Backend
        this.app.singleton('IQueue', (app) => new SQLiteQueue('jobs.sqlite', app.make('JobRegistry')));

        // Register Worker factory

        this.app.singleton('Worker', (app) => {
            const options = app.make('WorkerOptions');
            return new Worker(app.make('IQueue'), app, { ...defaultOptions(), ...options });
        });

        // Default worker options (can be overridden before resolving Worker)
        this.app.singleton('WorkerOptions', () => defaultOptions());

        // Register Job Handler Registry
        // Handlers signature: (job: Job) => Promise<void>
        this.app.singleton('JobHandlers', () => new Map<string, JobHandler>());
    }
}
