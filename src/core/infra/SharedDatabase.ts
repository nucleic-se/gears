import Database from 'better-sqlite3';

import type { IDurableEventBus } from '../events/interfaces.js';
import type { ILogger, IMetrics, IMutex, IScheduler, IStore } from '../interfaces.js';
import { SQLiteMetrics } from '../metrics/SQLiteMetrics.js';
import { CronScheduler } from './CronScheduler.js';
import { SQLiteDurableEventBus } from './SQLiteDurableEventBus.js';
import { SQLiteStore } from './SQLiteStore.js';

/**
 * Owns Gears' low-contention shared SQLite connection. The connection never
 * crosses this infrastructure boundary; consumers receive narrow services.
 */
export class SharedDatabase {
    readonly #db: Database.Database;

    constructor(fullPath: string) {
        this.#db = new Database(fullPath);
        this.#db.pragma('journal_mode = WAL');
        this.#db.pragma('busy_timeout = 5000');
    }

    createStore(): IStore {
        const store = new SQLiteStore(this.#db);
        store.startSweeper();
        return store;
    }

    createScheduler(mutex: IMutex, logger: ILogger, timezone?: string): IScheduler {
        return new CronScheduler(mutex, logger, { timezone, db: this.#db });
    }

    createDurableEventBus(): IDurableEventBus { return new SQLiteDurableEventBus(this.#db); }
    createMetrics(): IMetrics { return new SQLiteMetrics(this.#db); }

    close(): void {
        if (this.#db.open) this.#db.close();
    }

    dispose(): void { this.close(); }
}
