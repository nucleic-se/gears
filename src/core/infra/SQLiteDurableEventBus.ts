import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { IDurableEventBus, EventHandler } from '../events/interfaces.js';
import { getDbPath } from '../utils/paths.js';

interface EventRow {
    id: number;
    channel: string;
    payload: string;
    source: string;
}

export class SQLiteDurableEventBus implements IDurableEventBus {
    private db: Database.Database;
    private ownsDb: boolean;
    private sourceId = randomUUID();
    private cursor = 0;
    private handlers = new Map<string, EventHandler[]>();
    private pollTimer: NodeJS.Timeout | null = null;
    private retentionMs: number;
    private sweepCounter = 0;
    private sweepEvery = 60; // sweep every N poll cycles

    constructor(dbOrPath: Database.Database | string = 'events.sqlite', retentionMs: number = 3_600_000) {
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
        this.retentionMs = retentionMs;
        this.initSchema();
    }

    private initSchema(): void {

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                payload TEXT NOT NULL,
                source TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )
        `);

        this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_channel_id ON events(channel, id)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)');

        // Start cursor at current max — don't replay history on startup
        const row = this.db.prepare('SELECT MAX(id) as maxId FROM events').get() as { maxId: number | null } | undefined;
        this.cursor = row?.maxId ?? 0;
    }

    async emit<T = any>(event: string, payload: T): Promise<void> {
        this.db.prepare(
            'INSERT INTO events (channel, payload, source, created_at) VALUES (?, ?, ?, ?)'
        ).run(event, JSON.stringify(payload), this.sourceId, Date.now());

        // Fire local subscribers immediately (no waiting for poll)
        const handlers = this.handlers.get(event);
        if (handlers && handlers.length > 0) {
            const safe = [...handlers];
            await Promise.allSettled(safe.map(h => Promise.resolve().then(() => h(payload))));
        }
    }

    on<T = any>(event: string, handler: EventHandler<T>): () => void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);

        return () => this.off(event, handler);
    }

    off<T = any>(event: string, handler: EventHandler<T>): void {
        const eventHandlers = this.handlers.get(event);
        if (!eventHandlers) return;
        const index = eventHandlers.indexOf(handler);
        if (index !== -1) eventHandlers.splice(index, 1);
    }

    startPolling(intervalMs: number = 500): void {
        if (this.pollTimer) return;
        this.pollTimer = setInterval(() => this.poll(), intervalMs);
        this.pollTimer.unref();
    }

    stopPolling(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    private poll(): void {
        if (!this.db.open) return;

        const rows = this.db.prepare(
            'SELECT id, channel, payload, source FROM events WHERE id > ? ORDER BY id ASC'
        ).all(this.cursor) as EventRow[];

        if (rows.length === 0) return;

        // Advance cursor past everything we've seen
        this.cursor = rows[rows.length - 1].id;

        // Dispatch only cross-process events (local ones already fired in emit)
        for (const row of rows) {
            if (row.source === this.sourceId) continue;

            const handlers = this.handlers.get(row.channel);
            if (!handlers || handlers.length === 0) continue;

            let payload: any;
            try {
                payload = JSON.parse(row.payload);
            } catch {
                continue;
            }

            const safe = [...handlers];
            for (const handler of safe) {
                try {
                    handler(payload);
                } catch {
                    // Swallow — same fire-and-forget semantics as EventBus
                }
            }
        }

        // Periodic retention sweep
        this.sweepCounter++;
        if (this.sweepCounter >= this.sweepEvery) {
            this.sweepCounter = 0;
            this.sweep();
        }
    }

    /** Remove events older than retentionMs. Returns count of deleted rows. */
    sweep(): number {
        if (!this.db.open) return 0;
        const cutoff = Date.now() - this.retentionMs;
        const result = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff);
        return result.changes;
    }

    close(): void {
        this.stopPolling();
        if (this.ownsDb && this.db.open) {
            this.db.close();
        }
    }

    dispose(): void {
        this.close();
    }
}
