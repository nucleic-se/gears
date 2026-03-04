import cron from 'node-cron';
import { IScheduler, IMutex, ILogger, IDisposable } from '../interfaces.js';

/**
 * A Distributed Cron Scheduler backed by a Mutex (e.g., SQLite/Redis).
 *
 * Concurrency Model:
 * - Distributed Locking: Uses a mutex to ensure a job only runs once across the cluster per scheduled interval (per second granularity).
 * - Single-Flight (Re-entrancy Guard): Within the same process, if a previous run of the same job is still active, the new run is skipped.
 *   This prevents overlapping executions of long-running jobs.
 */
export class CronScheduler implements IScheduler, IDisposable {
    private mutex: IMutex;
    private logger: ILogger;
    private tasks: Map<string, cron.ScheduledTask> = new Map();
    private defaultLockTtlMs: number;

    private timezone?: string;

    constructor(mutex: IMutex, logger: ILogger, options?: { lockTtlMs?: number; timezone?: string }) {
        this.mutex = mutex;
        this.logger = logger;
        this.defaultLockTtlMs = options?.lockTtlMs ?? 10 * 60 * 1000;
        this.timezone = options?.timezone;
    }

    private runningJobs: Set<string> = new Set();

    schedule(
        expression: string,
        task: () => void | Promise<void>,
        jobName: string,
        options?: { lockTtlMs?: number }
    ): void {
        if (!cron.validate(expression)) {
            throw new Error(`Invalid cron expression: ${expression}`);
        }

        if (this.tasks.has(jobName)) {
            this.logger.warn(`Overwriting existing task`, { job: jobName });
            this.tasks.get(jobName)?.stop();
        }

        const scheduledTask = cron.schedule(expression, async () => {
            // 0. Check Single-Flight (Re-entrancy Guard)
            if (this.runningJobs.has(jobName)) {
                this.logger.debug(`Skipped (previous run still active)`, { job: jobName });
                return;
            }

            // 1. Generate a stable key for distributed mutual exclusion
            const lockKey = `job:${jobName}`;

            this.runningJobs.add(jobName);

            // 2. Try to acquire lock (TTL 10 minutes default)
            try {
                const lockTtlMs = options?.lockTtlMs ?? this.defaultLockTtlMs;
                const acquired = await this.mutex.acquire(lockKey, lockTtlMs);

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
                                    return;
                                }
                            } catch (e) {
                                this.logger.error(`Failed to refresh lock`, { job: jobName, error: e });
                            }
                            scheduleRefresh();
                        }, refreshIntervalMs);
                    };

                    scheduleRefresh();

                    try {
                        await task();
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
            }
        }, { timezone: this.timezone });

        this.tasks.set(jobName, scheduledTask);
        this.logger.info(`Scheduled task`, { job: jobName, expression, timezone: this.timezone ?? 'UTC' });
    }

    unschedule(jobName: string): void {
        const task = this.tasks.get(jobName);
        if (task) {
            task.stop();
            this.tasks.delete(jobName);
            this.logger.info(`Unscheduled task`, { job: jobName });
        } else {
            this.logger.warn(`Cannot unschedule, task not found`, { job: jobName });
        }
    }

    stopAll(): void {
        for (const [jobName, task] of this.tasks.entries()) {
            task.stop();
            this.logger.info(`Stopped task (shutdown)`, { job: jobName });
        }
        this.tasks.clear();
        // Locks are auto-released when tasks complete or fail in their execution loop
    }

    async dispose(): Promise<void> {
        this.stopAll();

        // Wait for running jobs to drain
        if (this.runningJobs.size > 0) {
            this.logger.info(`Waiting for ${this.runningJobs.size} cron jobs to finish...`);
            const start = Date.now();
            while (this.runningJobs.size > 0) {
                if (Date.now() - start > 5000) {
                    this.logger.warn(`Cron shutdown timed out, ${this.runningJobs.size} jobs still running`);
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
    }
}
