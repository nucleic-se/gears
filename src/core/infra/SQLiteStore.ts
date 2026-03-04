import Database from 'better-sqlite3';
import { IStore } from '../interfaces.js';
import { getDbPath } from '../utils/paths.js';

export class SQLiteStore implements IStore {
    private db: Database.Database;
    private prefix: string;
    private ownsDb: boolean;
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(dbOrPath: Database.Database | string = 'store.sqlite', prefix: string = '') {
        if (typeof dbOrPath === 'string') {
            const fullPath = getDbPath(dbOrPath);
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
        } catch (e) {
            // Self-repair: Delete corrupted entry
            this.db.prepare('DELETE FROM store WHERE key = ?').run(fk);
            return null;
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
        // Calculate the effective prefix for the DB query
        // If this store is namespaced 'ns', and we scan 'p', we look for 'ns:p%'
        // If this store is root, and we scan 'p', we look for 'p%'

        let searchPrefix = this.prefix;
        if (prefix) {
            searchPrefix = searchPrefix ? `${searchPrefix}:${prefix}` : prefix;
        }

        // Prepare SQL pattern (searchPrefix%)
        const pattern = searchPrefix ? `${searchPrefix}%` : '%';

        const stmt = this.db.prepare(`
            SELECT key, value, expires_at 
            FROM store 
            WHERE key LIKE ?
        `);

        const rows = stmt.all(pattern) as { key: string; value: string; expires_at: number | null }[];
        const result: Record<string, T> = {};

        for (const row of rows) {
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
                if (userKey.startsWith(this.prefix + ':')) {
                    userKey = userKey.substring(this.prefix.length + 1);
                } else if (userKey === this.prefix) {
                    // Exact match on namespace itself? unlikely given our key schema, but theoretically possible
                    userKey = '';
                }
            }

            // If user asked for scan('p'), we might want to strip 'p:' too?
            // Usually scan returns keys relative to the scan root (namespace), 
            // but the prefix argument is a filter. 
            // Standard convention: return keys relative to the namespace.
            // If I verify `namespace('a').scan('b')`, I expect keys starting with 'b...'.

            // Filter by prefix strictly (LIKE is case insensitive by default in some config, but good to check)
            if (prefix && !userKey.startsWith(prefix)) {
                continue;
            }

            try {
                result[userKey] = JSON.parse(row.value);
            } catch (e) {
                // Ignore corrupted
            }
        }

        return result;
    }

    /** Start periodic cleanup of expired keys (default: every 5 minutes, batch size: 1000) */
    startSweeper(intervalMs: number = 300_000, batchSize: number = 1000): void {
        if (this.sweepTimer || !this.ownsDb) return;
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
    }

    dispose(): void {
        this.close();
    }
}
