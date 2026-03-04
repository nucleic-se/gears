import Database from 'better-sqlite3';
import { IQueue, Job, JobOptions } from './interfaces.js';
import { randomUUID } from 'crypto';
import { getDbPath } from '../utils/paths.js';
import { JobRegistry, JobValidationError } from './JobRegistry.js';

export class SQLiteQueue implements IQueue {
    private db: Database.Database;

    constructor(
        dbPath: string = 'jobs.sqlite',
        private jobRegistry?: JobRegistry
    ) {
        const fullPath = getDbPath(dbPath);
        this.db = new Database(fullPath);
        this.init();
    }

    private init() {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.migrate();
    }

    private migrate() {
        // 1. Ensure schema version table exists
        this.db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER)`);

        // 2. Get current version
        const row = this.db.prepare('SELECT version FROM _schema_version LIMIT 1').get() as { version: number } | undefined;
        let currentVersion = row ? row.version : 0;

        // 3. Define Migrations
        const migrations = [
            // Version 1: Baseline (Idempotent for successful adoption of existing DBs)
            (db: Database.Database) => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS jobs (
                        id TEXT PRIMARY KEY,
                        type TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        status TEXT DEFAULT 'pending',
                        created_at INTEGER,
                        updated_at INTEGER,
                        scheduled_at INTEGER,
                        attempts INTEGER DEFAULT 0,
                        options TEXT DEFAULT '{}',
                        stuck_timeout_ms INTEGER,
                        priority INTEGER DEFAULT 0,
                        error TEXT
                    )
                `);

                // Ensure columns exist (Idempotent)
                const addColumn = (sql: string) => { try { db.exec(sql); } catch (e) { } };

                addColumn('ALTER TABLE jobs ADD COLUMN scheduled_at INTEGER');
                addColumn('ALTER TABLE jobs ADD COLUMN attempts INTEGER DEFAULT 0');
                addColumn("ALTER TABLE jobs ADD COLUMN options TEXT DEFAULT '{}'");
                addColumn('ALTER TABLE jobs ADD COLUMN stuck_timeout_ms INTEGER');
                addColumn('ALTER TABLE jobs ADD COLUMN priority INTEGER DEFAULT 0');

                // Data fixups
                db.exec('UPDATE jobs SET attempts = 0 WHERE attempts IS NULL');

                // Indexes
                db.exec('CREATE INDEX IF NOT EXISTS idx_status_updated_at ON jobs(status, updated_at);');
                db.exec('CREATE INDEX IF NOT EXISTS idx_status_priority_scheduled ON jobs(status, priority DESC, scheduled_at ASC);');
            },
            // Version 2: Job TTL support
            (db: Database.Database) => {
                const addColumn = (sql: string) => { try { db.exec(sql); } catch (e) { } };
                addColumn('ALTER TABLE jobs ADD COLUMN expires_at INTEGER');
            }
        ];

        // 4. Run Migrations
        for (let i = currentVersion; i < migrations.length; i++) {
            const version = i + 1;
            const migration = migrations[i];

            this.db.transaction(() => {
                migration(this.db);
                this.db.prepare('DELETE FROM _schema_version').run();
                this.db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(version);
            })();

            // Log migration? this.logger.info(...) unfortunately we don't have logger here easily unless injected
        }
    }

    private rowToJob<T = any>(row: any): Job<T> {
        let payload: T;
        let options: JobOptions;
        let parseError: string | null = null;

        try {
            payload = row.payload ? JSON.parse(row.payload) : undefined;
        } catch (err) {
            payload = {} as T;
            parseError = "Corrupted Payload: JSON parse failed";
        }

        try {
            options = row.options ? JSON.parse(row.options) : {};
        } catch (err) {
            options = {};
            if (!parseError) parseError = "Corrupted Options: JSON parse failed";
        }

        return {
            ...row,
            payload,
            options,
            attempts: row.attempts ?? 0,
            // Critical fix: Parse error MUST take precedence over existing row error
            // Otherwise a job with row.error="foo" but corrupted payload will bypass poison checks
            error: parseError ?? row.error ?? null
        };
    }

    async add(type: string, payload: any, options: JobOptions = {}): Promise<Job> {
        if (!type || !type.trim()) {
            throw new Error('Job type cannot be empty');
        }
        if (payload === undefined) {
            // undefined becomes null in JSON, but let's be strict to avoid confusion
            throw new Error('Job payload cannot be undefined (use null)');
        }

        if (this.jobRegistry) {
            const { valid, error } = this.jobRegistry.validate(type, payload);
            if (!valid) {
                throw new Error(`Job validation failed for type '${type}': ${error}`);
            }
        }

        const stmt = this.db.prepare(`
      INSERT INTO jobs (id, type, payload, status, created_at, updated_at, scheduled_at, attempts, options, stuck_timeout_ms, priority, expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?, ?)
    `);
        const now = Date.now();
        const stuckTimeoutMs = options.stuckTimeoutMs ?? null;
        const priority = options.priority ?? 0;
        const expiresAt = options.ttlMs ? now + options.ttlMs : null;
        const id = randomUUID();
        stmt.run(id, type, JSON.stringify(payload), now, now, now, JSON.stringify(options), stuckTimeoutMs, priority, expiresAt);

        return {
            id,
            type,
            payload,
            status: 'pending',
            created_at: now,
            updated_at: now,
            scheduled_at: now,
            attempts: 0,
            options,
            priority,
            error: null
        };
    }

    async addDelayed(type: string, payload: any, delayMs: number, options: JobOptions = {}): Promise<Job> {
        if (!type || !type.trim()) {
            throw new Error('Job type cannot be empty');
        }
        if (payload === undefined) {
            throw new Error('Job payload cannot be undefined (use null)');
        }

        if (this.jobRegistry) {
            const { valid, error } = this.jobRegistry.validate(type, payload);
            if (!valid) {
                throw new Error(`Job validation failed for type '${type}': ${error}`);
            }
        }

        const stmt = this.db.prepare(`
      INSERT INTO jobs (id, type, payload, status, created_at, updated_at, scheduled_at, attempts, options, stuck_timeout_ms, priority, expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?, ?)
    `);
        const now = Date.now();
        const stuckTimeoutMs = options.stuckTimeoutMs ?? null;
        const priority = options.priority ?? 0;
        const expiresAt = options.ttlMs ? now + options.ttlMs : null;
        const id = randomUUID();
        const scheduled_at = now + delayMs;
        stmt.run(id, type, JSON.stringify(payload), now, now, scheduled_at, JSON.stringify(options), stuckTimeoutMs, priority, expiresAt);

        return {
            id,
            type,
            payload,
            status: 'pending',
            created_at: now,
            updated_at: now,
            scheduled_at,
            attempts: 0,
            options,
            priority,
            error: null
        };
    }

    async list(status: Job['status'], limit: number = 20, type?: string): Promise<Job[]> {
        const rows = type
            ? this.db.prepare(`
                SELECT * FROM jobs
                WHERE status = ? AND type = ?
                ORDER BY priority DESC, updated_at DESC, created_at DESC
                LIMIT ?
            `).all(status, type, limit)
            : this.db.prepare(`
                SELECT * FROM jobs
                WHERE status = ?
                ORDER BY priority DESC, updated_at DESC, created_at DESC
                LIMIT ?
            `).all(status, limit);

        return rows.map((row: any) => this.rowToJob(row));
    }

    async get(jobId: string): Promise<Job | null> {
        const row = this.db.prepare(`
            SELECT * FROM jobs WHERE id = ?
        `).get(jobId) as any;

        if (!row) return null;
        return this.rowToJob(row);
    }

    async delete(jobId: string): Promise<boolean> {
        const result = this.db.prepare(`
            DELETE FROM jobs WHERE id = ?
        `).run(jobId);
        return result.changes > 0;
    }

    async retryFailed(jobId: string): Promise<boolean> {
        const now = Date.now();
        const result = this.db.prepare(`
            UPDATE jobs
            SET status = 'pending', updated_at = ?, scheduled_at = ?, error = NULL
            WHERE id = ? AND status = 'failed'
        `).run(now, now, jobId);
        return result.changes > 0;
    }

    async retryAll(type?: string): Promise<number> {
        const now = Date.now();
        const result = type
            ? this.db.prepare(`
                UPDATE jobs
                SET status = 'pending', updated_at = ?, scheduled_at = ?, error = NULL
                WHERE status = 'failed' AND type = ?
            `).run(now, now, type)
            : this.db.prepare(`
                UPDATE jobs
                SET status = 'pending', updated_at = ?, scheduled_at = ?, error = NULL
                WHERE status = 'failed'
            `).run(now, now);
        return result.changes;
    }

    async retry(jobId: string, delayMs: number, lastError?: string): Promise<void> {
        const stmt = this.db.prepare(`
            UPDATE jobs 
            SET status = 'pending', 
                updated_at = ?,
                scheduled_at = ?, 
                attempts = COALESCE(attempts, 0) + 1,
                error = ?
            WHERE id = ? AND status = 'processing'
        `);
        const now = Date.now();
        stmt.run(now, now + delayMs, lastError || null, jobId);
    }

    async pop(): Promise<Job | null> {
        // Atomic pop using explicit transaction for safety.
        // 'IMMEDIATE' transaction ensures we get a write lock before reading.
        // We use a loop to handle "poison pills" (corrupted jobs) gracefully.

        const popTransaction = this.db.transaction(() => {
            const now = Date.now();
            let loops = 0;
            const maxLoops = 100; // Increase limit to handle larger bursts of corruption

            while (loops < maxLoops) {
                loops++;

                // 1. Get next candidate job
                // Updated for Priority: High priority first, then schedule, then create time
                const fetchStmt = this.db.prepare(`
                SELECT * FROM jobs 
                WHERE status = 'pending' 
                AND (scheduled_at IS NULL OR scheduled_at <= ?)
                ORDER BY priority DESC, scheduled_at ASC, created_at ASC 
                LIMIT 1
            `);

                const jobRecord = fetchStmt.get(now) as any;

                if (!jobRecord) return null; // No jobs available

                // 2. Try to parse safely
                const job = this.rowToJob(jobRecord);

                // 3. Check for corruption
                // rowToJob would have set payload to {} and error to "Corrupted..." if it failed.
                // We check if the DB record was clean but the parsed job has a NEW parse error.
                // Or simply: if parsed payload is empty and we have a parse error that wasn't there before.
                // Actually, strict check: if we failed to parse, we should have populated 'error'.

                // If it's corrupted, fail it and continue loop
                if (job.error && (job.error.startsWith("Corrupted Payload") || job.error.startsWith("Corrupted Options"))) {

                    // Mark as failed permanently, do NOT increment attempts
                    const failStmt = this.db.prepare(`
                        UPDATE jobs 
                        SET status = 'failed', updated_at = ?, error = ? 
                        WHERE id = ?
                    `);
                    failStmt.run(now, job.error, job.id);

                    // Continue loop to get next job
                    continue;
                }

                // 3b. Check for TTL expiration
                if (jobRecord.expires_at && now > jobRecord.expires_at) {
                    const failStmt = this.db.prepare(`
                        UPDATE jobs
                        SET status = 'failed', updated_at = ?, error = ?
                        WHERE id = ?
                    `);
                    failStmt.run(now, 'Job expired (TTL exceeded)', job.id);
                    continue;
                }

                // 4. Valid job found, lock it
                const updateStmt = this.db.prepare(`
                UPDATE jobs 
                SET status = 'processing', updated_at = ? 
                WHERE id = ?
            `);

                const processingTimestamp = Date.now();
                updateStmt.run(processingTimestamp, jobRecord.id);

                return {
                    ...job,
                    status: 'processing' as const,
                    updated_at: processingTimestamp
                };
            }

            return null; // Exceeded max loops (all poison?)
        });

        try {
            // Use better-sqlite3's .immediate() to start transaction with BEGIN IMMEDIATE
            return popTransaction.immediate();
        } catch (err) {
            // If locked, just return null (try again later)
            if (String(err).includes('SQLITE_BUSY')) return null;
            throw err;
        }
    }

    async release(jobId: string): Promise<void> {
        // Return a processing job to pending immediately (no backoff, no attempt increment)
        // Used for clean shutdown of popped-but-not-started jobs
        const stmt = this.db.prepare(`
            UPDATE jobs 
            SET status = 'pending', updated_at = ? 
            WHERE id = ? AND status = 'processing'
        `);
        stmt.run(Date.now(), jobId);
    }

    async complete(jobId: string): Promise<void> {
        const stmt = this.db.prepare(`
      UPDATE jobs 
      SET status = 'completed', updated_at = ? 
      WHERE id = ? AND status = 'processing'
    `);
        stmt.run(Date.now(), jobId);
    }

    async fail(jobId: string, error: string): Promise<void> {
        const stmt = this.db.prepare(`
        UPDATE jobs 
        SET status = 'failed', updated_at = ?, error = ?
        WHERE id = ? AND status = 'processing'
        `);
        stmt.run(Date.now(), error, jobId);
    }

    async heartbeat(jobId: string): Promise<void> {
        const stmt = this.db.prepare(`
        UPDATE jobs
        SET updated_at = ?
        WHERE id = ? AND status = 'processing'
        `);
        stmt.run(Date.now(), jobId);
    }

    async recover(timeoutMs: number): Promise<number> {
        const now = Date.now();

        // First, fail any expired processing jobs instead of requeueing them
        const failExpired = this.db.prepare(`
            UPDATE jobs
            SET status = 'failed', updated_at = ?, error = 'Job expired (TTL exceeded)'
            WHERE status = 'processing'
              AND expires_at IS NOT NULL
              AND expires_at < ?
        `);
        failExpired.run(now, now);

        // Also fail expired pending jobs while we're here
        const failExpiredPending = this.db.prepare(`
            UPDATE jobs
            SET status = 'failed', updated_at = ?, error = 'Job expired (TTL exceeded)'
            WHERE status = 'pending'
              AND expires_at IS NOT NULL
              AND expires_at < ?
        `);
        failExpiredPending.run(now, now);

        // Then requeue non-expired stuck jobs as before
        const stmt = this.db.prepare(`
            UPDATE jobs
            SET status = 'pending', updated_at = ?
            WHERE status = 'processing'
              AND updated_at < (? - COALESCE(stuck_timeout_ms, ?))
        `);
        const result = stmt.run(now, now, timeoutMs);
        return result.changes;
    }

    async clear(status: Job['status'], type?: string): Promise<number> {
        const result = type
            ? this.db.prepare(`
                DELETE FROM jobs
                WHERE status = ? AND type = ?
            `).run(status, type)
            : this.db.prepare(`
                DELETE FROM jobs
                WHERE status = ?
            `).run(status);
        return result.changes;
    }

    async stats(): Promise<{
        overview: Record<string, number>;
        breakdown: Record<string, Record<string, number>>;
    }> {
        const stmt = this.db.prepare(`
            SELECT type, status, COUNT(*) as count
            FROM jobs
            GROUP BY type, status
        `);
        const rows = stmt.all() as { type: string; status: string; count: number }[];

        const overview: Record<string, number> = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0
        };

        const breakdown: Record<string, Record<string, number>> = {};

        for (const row of rows) {
            // Aggregate overview
            overview[row.status] = (overview[row.status] || 0) + row.count;

            // Breakdown by type
            if (!breakdown[row.type]) {
                breakdown[row.type] = { pending: 0, processing: 0, completed: 0, failed: 0 };
            }
            breakdown[row.type][row.status] = row.count;
        }

        return { overview, breakdown };
    }

    async close(): Promise<void> {
        this.db.close();
    }
}
