import Database from 'better-sqlite3';
import { IStore } from '../interfaces.js';
import { getDbPath } from '../utils/paths.js';
import { hardenPrivateDatabaseFiles, validatePrivateDatabasePath } from './private-sqlite.js';

export class StoreCorruptionError extends Error {
    constructor(readonly key: string) {
        super(`Durable store record is corrupt and was quarantined: ${key}`);
        this.name = 'StoreCorruptionError';
    }
}

export class SQLiteStore implements IStore {
    private db: Database.Database;
    private prefix: string;
    private ownsDb: boolean;
    private databasePath?: string;
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(dbOrPath: Database.Database | string = 'store.sqlite', prefix: string = '') {
        if (typeof dbOrPath === 'string') {
            const fullPath = getDbPath(dbOrPath);
            validatePrivateDatabasePath(fullPath);
            this.databasePath = fullPath;
            this.db = new Database(fullPath);
            this.ownsDb = true;
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('busy_timeout = 5000');
        } else {
            this.db = dbOrPath;
            this.ownsDb = false;
        }
        this.prefix = prefix;
        this.initSchema();
        if (this.databasePath) hardenPrivateDatabaseFiles(this.databasePath);
    }

    /** Internal constructor for namespaced views (shares DB connection) */
    private static fromParent(db: Database.Database, prefix: string): SQLiteStore {
        const store = Object.create(SQLiteStore.prototype);
        store.db = db;
        store.prefix = prefix;
        store.ownsDb = false;
        return store;
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS store (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                expires_at INTEGER
            )
            ;
            CREATE TABLE IF NOT EXISTS store_corrupt (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                expires_at INTEGER,
                detected_at INTEGER NOT NULL,
                error TEXT NOT NULL
            )
        `);
    }

    private fullKey(key: string): string {
        return this.prefix ? `${this.prefix}:${key}` : key;
    }

    async get<T = any>(key: string): Promise<T | null> {
        const fk = this.fullKey(key);
        const now = Date.now();

        // Clean up if expired
        const row = this.db.prepare(
            'SELECT value, expires_at FROM store WHERE key = ?'
        ).get(fk) as { value: string; expires_at: number | null } | undefined;

        if (!row) return null;

        if (row.expires_at && row.expires_at < now) {
            this.db.prepare('DELETE FROM store WHERE key = ?').run(fk);
            return null;
        }

        try {
            return JSON.parse(row.value) as T;
        } catch {
            this.quarantine(fk, row.value, row.expires_at, 'JSON parse failed');
            throw new StoreCorruptionError(fk);
        }
    }

    async set<T = any>(key: string, value: T, ttlMs?: number): Promise<void> {
        const fk = this.fullKey(key);
        const expiresAt = ttlMs ? Date.now() + ttlMs : null;

        this.db.prepare(`
            INSERT INTO store (key, value, expires_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
        `).run(fk, JSON.stringify(value), expiresAt);
    }

    async setIfNotExists<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean> {
        const fk = this.fullKey(key);
        const now = Date.now();
        const expiresAt = ttlMs ? now + ttlMs : null;

        const insertTransaction = this.db.transaction(() => {
            // Clean up expired entry first (so expired keys don't block new inserts)
            this.db.prepare('DELETE FROM store WHERE key = ? AND expires_at IS NOT NULL AND expires_at < ?').run(fk, now);

            // Try to insert (will fail if key exists due to PRIMARY KEY constraint)
            this.db.prepare(`
                INSERT INTO store (key, value, expires_at) VALUES (?, ?, ?)
            `).run(fk, JSON.stringify(value), expiresAt);
        });

        try {
            insertTransaction();
            return true;
        } catch (err: any) {
            if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                return false; // Key already exists
            }
            throw err;
        }
    }

    async delete(key: string): Promise<boolean> {
        const fk = this.fullKey(key);
        const result = this.db.prepare('DELETE FROM store WHERE key = ?').run(fk);
        return result.changes > 0;
    }

    async has(key: string): Promise<boolean> {
        const value = await this.get(key);
        return value !== null;
    }

    namespace(prefix: string): IStore {
        const newPrefix = this.prefix ? `${this.prefix}:${prefix}` : prefix;
        return SQLiteStore.fromParent(this.db, newPrefix);
    }

    async scan<T = any>(prefix?: string): Promise<Record<string, T>> {
        const now = Date.now();
        const scopePrefix = this.prefix ? `${this.prefix}:` : '';
        const filterPrefix = prefix ? `${scopePrefix}${prefix}` : scopePrefix;
        const rows = filterPrefix
            ? this.db.prepare(`
                SELECT key, value, expires_at
                FROM store
                WHERE substr(key, 1, length(?)) = ?
            `).all(filterPrefix, filterPrefix)
            : this.db.prepare(`
                SELECT key, value, expires_at
                FROM store
            `).all();
        const result: Record<string, T> = {};

        for (const row of rows as { key: string; value: string; expires_at: number | null }[]) {
            // Lazy expiration check
            if (row.expires_at && row.expires_at < now) {
                // Don't modify DB during scan for speed, just omit from result
                // (or trigger cleanup later)
                continue;
            }

            // Remove internal prefix from key for the user
            // e.g. internal 'ns:key', user sees 'key'
            let userKey = row.key;
            if (this.prefix) {
                userKey = userKey.substring(scopePrefix.length);
            }

            try {
                result[userKey] = JSON.parse(row.value);
            } catch {
                this.quarantine(row.key, row.value, row.expires_at, 'JSON parse failed during scan');
                throw new StoreCorruptionError(row.key);
            }
        }

        return result;
    }

    private quarantine(key: string, value: string, expiresAt: number | null, error: string): void {
        this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO store_corrupt (key, value, expires_at, detected_at, error)
                SELECT key, value, expires_at, ?, ? FROM store WHERE key = ? AND value = ?
            `).run(Date.now(), error, key, value);
            this.db.prepare('DELETE FROM store WHERE key = ? AND value = ?').run(key, value);
        }).immediate();
    }

    /** Start periodic cleanup of expired keys (default: every 5 minutes, batch size: 1000) */
    startSweeper(intervalMs: number = 300_000, batchSize: number = 1000): void {
        if (this.sweepTimer) return;
        this.sweepTimer = setInterval(() => this.sweep(batchSize), intervalMs);
        this.sweepTimer.unref(); // Don't prevent process exit
    }

    /** Remove expired keys in a single batch. Returns the number of keys removed. */
    sweep(batchSize: number = 1000): number {
        if (!this.db.open) return 0;
        const limit = Math.max(1, Math.floor(batchSize));
        const result = this.db.prepare(
            'DELETE FROM store WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ?'
        ).run(Date.now(), limit);
        return result.changes;
    }

    close(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
        }
        if (this.ownsDb && this.db.open) {
            this.db.close();
        }
        if (this.databasePath) hardenPrivateDatabaseFiles(this.databasePath);
    }

    dispose(): void {
        this.close();
    }
}
