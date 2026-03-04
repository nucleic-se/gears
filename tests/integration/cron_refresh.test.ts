import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CronScheduler } from '../../src/core/infra/CronScheduler.js';
import { IMutex, ILogger } from '../../src/core/interfaces.js';
import cron from 'node-cron';

vi.mock('node-cron', () => ({
    default: {
        validate: () => true,
        schedule: vi.fn((expr, task) => ({
            start: vi.fn(),
            stop: vi.fn(),
            _task: task
        }))
    }
}));

class MockLogger implements ILogger {
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
}

class MockMutex implements IMutex {
    acquire = vi.fn().mockResolvedValue(true);
    refresh = vi.fn().mockResolvedValue(true);
    release = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
}

describe('CronScheduler Refresh', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should refresh lock periodically while task is running', async () => {
        const mutex = new MockMutex();
        const logger = new MockLogger();
        const scheduler = new CronScheduler(mutex, logger);

        let finishTask: () => void;
        const taskRunning = new Promise<void>(r => finishTask = r);

        scheduler.schedule('* * * * *', async () => {
            await taskRunning;
        }, 'test-job');

        // Extract the raw callback passed to cron.schedule
        // @ts-ignore
        const cronCallback = cron.schedule.mock.calls[0][1];

        // Start the task (async)
        const runPromise = cronCallback();

        // 1. Assert Acquire
        await vi.advanceTimersByTimeAsync(1); // Tick microtasks
        expect(mutex.acquire).toHaveBeenCalledWith('job:test-job', 600000);

        // 2. Advance time by 300s (refresh interval)
        await vi.advanceTimersByTimeAsync(300000);
        expect(mutex.refresh).toHaveBeenCalledWith('job:test-job', 600000);
        expect(mutex.refresh).toHaveBeenCalledTimes(1);

        // 3. Advance another 300s
        await vi.advanceTimersByTimeAsync(300000);
        expect(mutex.refresh).toHaveBeenCalledTimes(2);

        // 4. Finish task
        finishTask!();
        await runPromise;

        // 5. Assert Release and No More Refreshes
        expect(mutex.release).toHaveBeenCalledWith('job:test-job');

        await vi.advanceTimersByTimeAsync(300000);
        expect(mutex.refresh).toHaveBeenCalledTimes(2); // Should not increase
    });

    it('should honor default and per-job lock TTLs', async () => {
        const mutex = new MockMutex();
        const logger = new MockLogger();
        const scheduler = new CronScheduler(mutex, logger, { lockTtlMs: 120000 });

        scheduler.schedule('* * * * *', async () => { }, 'default-ttl-job');

        // @ts-ignore
        const defaultCallback = cron.schedule.mock.calls[0][1];
        await defaultCallback();
        expect(mutex.acquire).toHaveBeenCalledWith('job:default-ttl-job', 120000);

        scheduler.schedule('* * * * *', async () => { }, 'override-ttl-job', { lockTtlMs: 30000 });

        // @ts-ignore
        const overrideCallback = cron.schedule.mock.calls[1][1];
        await overrideCallback();
        expect(mutex.acquire).toHaveBeenCalledWith('job:override-ttl-job', 30000);
    });

    it('should stop refreshing if lock is lost', async () => {
        const mutex = new MockMutex();
        mutex.refresh = vi.fn().mockResolvedValueOnce(false);
        const logger = new MockLogger();
        const scheduler = new CronScheduler(mutex, logger);

        let finishTask: () => void;
        const taskRunning = new Promise<void>(r => finishTask = r);

        scheduler.schedule('* * * * *', async () => {
            await taskRunning;
        }, 'lost-lock-job', { lockTtlMs: 2000 });

        // @ts-ignore
        const cronCallback = cron.schedule.mock.calls[0][1];
        const runPromise = cronCallback();

        await vi.advanceTimersByTimeAsync(1000);
        expect(mutex.refresh).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('Lost distributed lock', { job: 'lost-lock-job' });

        await vi.advanceTimersByTimeAsync(2000);
        expect(mutex.refresh).toHaveBeenCalledTimes(1);

        finishTask!();
        await runPromise;
    });

    it('should keep refreshing after transient refresh errors', async () => {
        const mutex = new MockMutex();
        let refreshCalls = 0;
        mutex.refresh = vi.fn().mockImplementation(async () => {
            refreshCalls += 1;
            if (refreshCalls === 1) {
                throw new Error('temporary failure');
            }
            return true;
        });

        const logger = new MockLogger();
        const scheduler = new CronScheduler(mutex, logger);

        let finishTask: () => void;
        const taskRunning = new Promise<void>(r => finishTask = r);

        scheduler.schedule('* * * * *', async () => {
            await taskRunning;
        }, 'refresh-error-job', { lockTtlMs: 2000 });

        // @ts-ignore
        const cronCallback = cron.schedule.mock.calls[0][1];
        const runPromise = cronCallback();

        await vi.advanceTimersByTimeAsync(1000);
        expect(mutex.refresh).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith('Failed to refresh lock', { job: 'refresh-error-job', error: expect.any(Error) });

        await vi.advanceTimersByTimeAsync(1000);
        expect(mutex.refresh).toHaveBeenCalledTimes(2);

        finishTask!();
        await runPromise;
    });

    it('should release lock if task fails', async () => {
        const mutex = new MockMutex();
        const logger = new MockLogger();
        const scheduler = new CronScheduler(mutex, logger);

        scheduler.schedule('* * * * *', async () => {
            throw new Error('Task Crash');
        }, 'failing-job');

        // @ts-ignore
        const cronCallback = cron.schedule.mock.calls[0][1];

        await cronCallback();

        expect(mutex.acquire).toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith('Task failed', expect.anything());
        expect(mutex.release).toHaveBeenCalledWith('job:failing-job');
    });

    it('should prevent re-entry if previous run is still active', async () => {
        const mutex = new MockMutex();
        const logger = new MockLogger();
        const scheduler = new CronScheduler(mutex, logger);

        let finishTask: () => void;
        const taskRunning = new Promise<void>(r => finishTask = r);

        scheduler.schedule('* * * * *', async () => {
            await taskRunning;
        }, 'slow-job');

        // @ts-ignore
        const cronCallback = cron.schedule.mock.calls[0][1];

        // 1. Run first time
        const run1 = cronCallback();

        // 2. Run second time immediately (first is still pending)
        const run2 = cronCallback();

        await vi.advanceTimersByTimeAsync(1); // tick

        // Only one acquisition attempt
        expect(mutex.acquire).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith('Skipped (previous run still active)', expect.anything());

        finishTask!();
        await run1;
        await run2;
    });
});
