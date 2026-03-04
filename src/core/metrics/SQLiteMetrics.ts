import Database from 'better-sqlite3';
import { IMetrics, MetricSnapshot } from './interfaces.js';
import { getDbPath } from '../utils/paths.js';

export class SQLiteMetrics implements IMetrics {
    private db: Database.Database;
    private ownsDb: boolean;

    constructor(dbOrPath: Database.Database | string) {
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
        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS metrics (
                name TEXT NOT NULL,
                tags TEXT NOT NULL,
                type TEXT NOT NULL,
                value REAL NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (name, tags)
            )
        `);
    }

    private serializeTags(tags?: Record<string, string>): string {
        if (!tags) return '{}';
        // Sort keys for consistent ID
        return JSON.stringify(tags, Object.keys(tags).sort());
    }

    async increment(name: string, value: number = 1, tags?: Record<string, string>): Promise<void> {
        try {
            const tagStr = this.serializeTags(tags);
            const now = Date.now();

            // Upsert counter
            const stmt = this.db.prepare(`
                INSERT INTO metrics (name, tags, type, value, updated_at)
                VALUES (?, ?, 'counter', ?, ?)
                ON CONFLICT(name, tags) DO UPDATE SET
                    value = value + excluded.value,
                    updated_at = excluded.updated_at
            `);
            stmt.run(name, tagStr, value, now);
        } catch {
            // Metrics are best-effort — never crash the caller
        }
    }

    async gauge(name: string, value: number, tags?: Record<string, string>): Promise<void> {
        try {
            const tagStr = this.serializeTags(tags);
            const now = Date.now();

            const stmt = this.db.prepare(`
                INSERT INTO metrics (name, tags, type, value, updated_at)
                VALUES (?, ?, 'gauge', ?, ?)
                ON CONFLICT(name, tags) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
            `);
            stmt.run(name, tagStr, value, now);
        } catch {
            // Metrics are best-effort — never crash the caller
        }
    }

    async snapshot(): Promise<MetricSnapshot[]> {
        const rows = this.db.prepare('SELECT * FROM metrics').all() as any[];
        return rows.map(row => ({
            name: row.name,
            value: row.value,
            type: row.type as 'counter' | 'gauge',
            tags: JSON.parse(row.tags),
            updatedAt: row.updated_at
        }));
    }

    close(): void {
        if (this.ownsDb && this.db.open) {
            this.db.close();
        }
    }

    dispose(): void {
        this.close();
    }
}
