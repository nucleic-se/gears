import Database from 'better-sqlite3';
import { getDbPath } from './paths.js';

/**
 * A shared SQLite connection for low-contention services (Store, Metrics, DurableEventBus).
 * Registered as a Container singleton; owns the connection lifecycle.
 */
export class SharedDatabase {
    public readonly db: Database.Database;

    constructor(dbPath: string = 'shared.sqlite') {
        const fullPath = getDbPath(dbPath);
        this.db = new Database(fullPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
    }

    close(): void {
        if (this.db.open) {
            this.db.close();
        }
    }

    dispose(): void {
        this.close();
    }
}
