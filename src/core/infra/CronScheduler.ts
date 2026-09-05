import Database from 'better-sqlite3';
import cron from 'node-cron';
import { IScheduler, IMutex, ILogger, IDisposable } from '../interfaces.js';

/**
 * A Distributed Cron Scheduler backed by a Mutex (e.g., SQLite/Redis).
 *
 * Concurrency Model:
 * - Distributed Locking: Uses a mutex to ensure a job only runs once across the cluster per scheduled interval (per second granularity).
 * - Single-Flight (Re-entrancy Guard): Within the same process, if a previous run of the same job is still active, the new run is skipped.
 *   This prevents overlapping executions of long-running jobs.
 *
 * Persistence and lazy activation:
 * - When a Database is provided, registered jobs are persisted to a `cron_jobs` table.
 * - On construction, persisted jobs are loaded as dormant: they appear in list() but do not tick.
 * - When the app calls schedule() with a matching jobName, the dormant entry is activated.
 *   This is the expected pattern — the app re-registers its callbacks on every boot, and the
 *   scheduler wakes them up automatically.
 * - Dormant jobs that are never re-registered within `orphanGraceMs` are logged as orphans.
 *   They remain in the DB catalog but will trigger a warning so the operator can clean them up.
 * - Explicit unschedule() removes the job from both the in-memory task map and the DB.
 */
export class CronScheduler implements IScheduler, IDisposable {
    private mutex: IMutex;
    private logger: ILogger;
    private tasks: Map<string, { task: cron.ScheduledTask; expression: string }> = new Map();
    private dormant: Map<string, { expression: string }> = new Map();
    private defaultLockTtlMs: number;
    private timezone?: string;
    private db?: Database.Database;
    private orphanTimer?: NodeJS.Timeout;

    constructor(
        mutex: IMutex,
        logger: ILogger,
        options?: { lockTtlMs?: number; timezone?: string; db?: Database.Database; orphanGraceMs?: number },
    ) {
        this.mutex = mutex;
        this.logger = logger;
        this.defaultLockTtlMs = options?.lockTtlMs ?? 10 * 60 * 1000;
        this.timezone = options?.timezone;
        this.db = options?.db;

        if (this.db) {
            this.initSchema();
            this.loadDormant();

            if (this.dormant.size > 0) {
                const graceMs = options?.orphanGraceMs ?? 60_000;
                this.orphanTimer = setTimeout(() => {
                    for (const [name, { expression }] of this.dormant) {
                        this.logger.warn('Orphaned cron job: persisted but never re-registered after restart', {
                            job: name,
                            expression,
                        });
                    }
                }, graceMs);
                this.orphanTimer.unref();
            }
        }
    }

    private initSchema(): void {
        this.db!.exec(`
            CREATE TABLE IF NOT EXISTS cron_jobs (
                name TEXT PRIMARY KEY,
                expression TEXT NOT NULL,
                registered_at INTEGER NOT NULL
            )
        `);
    }

    private loadDormant(): void {
        const rows = this.db!.prepare(
            'SELECT name, expression FROM cron_jobs ORDER BY registered_at ASC'
        ).all() as Array<{ name: string; expression: string }>;

        for (const row of rows) {
            this.dormant.set(row.name, { expression: row.expression });
        }

        if (rows.length > 0) {
            this.logger.info(`Loaded ${rows.length} persisted cron job(s) as dormant`, {
                jobs: rows.map((r) => r.name),
            });
        }
    }

    private runningJobs: Set<string> = new Set();
    private controllers = new Set<AbortController>();
    private disposed = false;

    schedule(
        expression: string,
        task: (context?: { signal: AbortSignal }) => void | Promise<void>,
        jobName: string,
        options?: { lockTtlMs?: number }
    ): void {
        if (this.disposed) throw new Error('Scheduler is disposed');
        if (!cron.validate(expression)) {
            throw new Error(`Invalid cron expression: ${expression}`);
        }

        if (this.tasks.has(jobName)) {
            this.logger.warn(`Overwriting existing task`, { job: jobName });
            this.tasks.get(jobName)?.task.stop();
        }

        const wasDormant = this.dormant.has(jobName);
        this.dormant.delete(jobName);

        const scheduledTask = cron.schedule(expression, async (tick) => {
            if (this.disposed) return;
            // 0. Check Single-Flight (Re-entrancy Guard)
            if (this.runningJobs.has(jobName)) {
                this.logger.debug(`Skipped (previous run still active)`, { job: jobName });
                return;
            }

            // 1. Generate a stable key for distributed mutual exclusion
            const lockKey = `job:${jobName}`;

            this.runningJobs.add(jobName);
            const controller = new AbortController();
            this.controllers.add(controller);

            // 2. Try to acquire lock (TTL 10 minutes default)
            try {
                const lockTtlMs = options?.lockTtlMs ?? this.defaultLockTtlMs;
                const acquired = await this.mutex.acquire(lockKey, lockTtlMs, (tick?.date ?? new Date()).getTime());

                if (acquired) {
                    this.logger.debug(`Acquired distributed lock`, { job: jobName });
                    const refreshIntervalMs = Math.max(1000, Math.floor(lockTtlMs / 2));
                    let refreshTimer: NodeJS.Timeout | null = null;
                    let refreshActive = true;

                    const scheduleRefresh = () => {
                        if (!refreshActive) {
                            return;
                        }
                        refreshTimer = setTimeout(async () => {
                            if (!refreshActive) {
                                return;
                            }
                            try {
                                const refreshed = await this.mutex.refresh(lockKey, lockTtlMs);
                                if (!refreshed) {
                                    this.logger.warn(`Lost distributed lock`, { job: jobName });
                                    refreshActive = false;
                                    controller.abort(new Error(`Distributed lock lost for ${jobName}`));
                                    return;
                                }
                            } catch (e) {
                                this.logger.error(`Failed to refresh lock`, { job: jobName, error: e });
                                refreshActive = false;
                                controller.abort(e);
                                return;
                            }
                            scheduleRefresh();
                        }, refreshIntervalMs);
                    };

                    scheduleRefresh();

                    try {
                        if (!controller.signal.aborted) await task({ signal: controller.signal });
                    } catch (e) {
                        this.logger.error(`Task failed`, { job: jobName, error: e });
                    } finally {
                        refreshActive = false;
                        if (refreshTimer) {
                            clearTimeout(refreshTimer);
                        }
                        await this.mutex.release(lockKey);
                        this.logger.debug(`Released distributed lock`, { job: jobName });
                    }
                } else {
                    this.logger.debug(`Skipped (locked by another worker)`, { job: jobName });
                }
            } catch (e) {
                this.logger.error(`Mutex error`, { job: jobName, error: e });
            } finally {
                this.runningJobs.delete(jobName);
                this.controllers.delete(controller);
            }
        }, { timezone: this.timezone });

        this.tasks.set(jobName, { task: scheduledTask, expression });

        if (this.db) {
            this.db.prepare(
                `INSERT INTO cron_jobs (name, expression, registered_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(name) DO UPDATE SET expression = excluded.expression, registered_at = excluded.registered_at`
            ).run(jobName, expression, Date.now());
        }

        if (wasDormant) {
            this.logger.info(`Activated dormant task`, { job: jobName, expression, timezone: this.timezone ?? 'UTC' });
        } else {
            this.logger.info(`Scheduled task`, { job: jobName, expression, timezone: this.timezone ?? 'UTC' });
        }
    }

    unschedule(jobName: string): void {
        const entry = this.tasks.get(jobName);
        const wasDormant = this.dormant.has(jobName);

        if (entry) {
            entry.task.stop();
            this.tasks.delete(jobName);
        }

        if (wasDormant) {
            this.dormant.delete(jobName);
        }

        if (this.db) {
            this.db.prepare('DELETE FROM cron_jobs WHERE name = ?').run(jobName);
        }

        if (entry || wasDormant) {
            this.logger.info(`Unscheduled task`, { job: jobName });
        } else {
            this.logger.warn(`Cannot unschedule, task not found`, { job: jobName });
        }
    }

    async list(): Promise<Array<{ name: string; expression: string; active: boolean }>> {
        if (this.db) {
            const rows = this.db.prepare(
                'SELECT name, expression FROM cron_jobs ORDER BY registered_at ASC'
            ).all() as Array<{ name: string; expression: string }>;
            return rows.map((row) => ({
                ...row,
                active: this.tasks.has(row.name),
            }));
        }
        return [...this.tasks.entries()].map(([name, entry]) => ({
            name,
            expression: entry.expression,
            active: true,
        }));
    }

    stopAll(): void {
        for (const [jobName, entry] of this.tasks.entries()) {
            entry.task.stop();
            this.logger.info(`Stopped task (shutdown)`, { job: jobName });
        }
        this.tasks.clear();
        // Locks are auto-released when tasks complete or fail in their execution loop
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        if (this.orphanTimer) {
            clearTimeout(this.orphanTimer);
        }

        this.stopAll();

        for (const controller of this.controllers) {
            controller.abort(new Error('Scheduler is stopping'));
        }
        const warning = setTimeout(() => {
            if (this.runningJobs.size > 0) {
                this.logger.warn(`Cron shutdown is waiting for ${this.runningJobs.size} jobs to settle`);
            }
        }, 5000);
        try {
            // A supervisor must terminate non-cooperative work; closing dependencies
            // while it is still running would release its locks and invalidate its IO.
            while (this.runningJobs.size > 0) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        } finally {
            clearTimeout(warning);
        }
    }
}
