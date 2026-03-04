import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CronScheduler } from '../../src/core/infra/CronScheduler.js';
import { TestContainer } from '../../src/test/helpers/TestContainer.js';
import { SQLiteMutex } from '../../src/core/infra/SQLiteMutex.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_LOCK_DB = path.resolve(__dirname, '../../test-locks.sqlite');

describe('Cron Locking', () => {
    let app: TestContainer;
    let mutex: SQLiteMutex;
    let scheduler: CronScheduler;

    beforeEach(async () => {
        app = new TestContainer();
        try { await fs.unlink(TEST_LOCK_DB); } catch { }
        mutex = new SQLiteMutex(TEST_LOCK_DB);
        scheduler = new CronScheduler(mutex, app.logger);
    });

    afterEach(async () => {
        try { await mutex.close(); } catch { }
        await new Promise(r => setTimeout(r, 100));
        try { await fs.unlink(TEST_LOCK_DB); } catch { }
        try { await fs.unlink(TEST_LOCK_DB + '-wal'); } catch { }
        try { await fs.unlink(TEST_LOCK_DB + '-shm'); } catch { }
    });

    it('should acquire lock and run task', async () => {
        return new Promise<void>(resolve => {
            scheduler.schedule('* * * * * *', async () => {
                // If we're here, the scheduler acquired the lock and ran the task.
                // Verify the lock lifecycle was logged.
                expect(app.logger.hasLog('debug', 'Acquired distributed lock')).toBe(true);
                scheduler.unschedule('test-job');
                resolve();
            }, 'test-job');
        });
    });

    it('should skip execution if lock is held by another process', async () => {
        // 1. Manually acquire lock for 'job:skipped-job'
        await mutex.acquire('job:skipped-job', 10000);

        // 2. Schedule task
        // We need to wait enough time for cron to trigger (1s).
        // Using vi.useFakeTimers might be better but node-cron is tricky with fake timers.
        // Integration test with 1s wait is acceptable for now.

        // Wait for next tick?
        // Actually, let's just assert that after ~1.1s, the task has NOT run.

        let runCount = 0;
        scheduler.schedule('* * * * * *', async () => {
            runCount++;
        }, 'skipped-job');

        await new Promise(resolve => setTimeout(resolve, 1500));

        expect(runCount).toBe(0);
        expect(app.logger.hasLog('debug', 'Skipped (locked by another worker)')).toBe(true);

        scheduler.unschedule('skipped-job');
    });
});
