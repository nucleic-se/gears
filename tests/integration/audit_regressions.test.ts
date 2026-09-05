import { afterEach, describe, expect, it, vi } from 'vitest';
import cron, { type TaskFn } from 'node-cron';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SQLiteMutex } from '../../src/core/infra/SQLiteMutex.js';
import { CronScheduler } from '../../src/core/infra/CronScheduler.js';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { Worker } from '../../src/core/queue/Worker.js';
import { Container } from '../../src/core/container/Container.js';
import { BundleManager } from '../../src/core/bundle/BundleManager.js';
import { JsonConfigFile } from '../../src/core/utils/JsonConfigFile.js';
import type { JobHandler } from '../../src/core/queue/interfaces.js';

vi.mock('node-cron', () => ({ default: {
    validate: () => true,
    schedule: vi.fn(() => ({ stop: vi.fn() })),
} }));

const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
const tick = (date: Date) => ({ date, dateLocalIso: date.toISOString(), triggeredAt: new Date() });
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
};

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('audit regressions', () => {
    it.each([1, 2])('retains timeout claims and slots with concurrency %s', async maxConcurrency => {
        vi.useFakeTimers();
        const queue = new SQLiteQueue(':memory:', undefined, p => p);
        const app = new Container();
        const finish = deferred();
        let starts = 0;
        const handler: JobHandler = async () => { starts++; if (starts === 1) await finish.promise; };
        app.singleton('ILogger', () => logger);
        app.singleton('JobHandlers', () => new Map([['slow', handler]]));
        const worker = new Worker(queue, app, { maxConcurrency, pollInterval: 5, heartbeatIntervalMs: 5 });
        const concurrencyKey = maxConcurrency === 1 ? undefined : 'same';
        const first = await queue.add('slow', {}, { executionTimeoutMs: 20, concurrencyKey });
        const second = await queue.add('slow', {}, { concurrencyKey });
        worker.start();
        try {
            await vi.advanceTimersByTimeAsync(60);
            expect(starts).toBe(1);
            expect((await queue.get(first.id))?.status).toBe('processing');
            expect((await queue.get(second.id))?.status).toBe('pending');
            // Another worker cannot claim the key while the timed-out handler drains.
            if (concurrencyKey) expect(await queue.pop()).toBeNull();
            expect(await queue.recover(20)).toBe(0);
            finish.resolve();
            await vi.advanceTimersByTimeAsync(20);
            expect((await queue.get(first.id))?.status).toBe('failed');
            expect((await queue.get(first.id))?.error).toContain('Timeout');
            expect((await queue.get(second.id))?.status).toBe('completed');
        } finally {
            finish.resolve();
            await worker.stop();
            await queue.close();
        }
    });

    it('deduplicates cron occurrences across connections and restarts but allows the next tick', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'gears-cron-'));
        const file = path.join(dir, 'locks.sqlite');
        const first = new SQLiteMutex(file, p => p);
        let second = new SQLiteMutex(file, p => p);
        const a = new CronScheduler(first, logger);
        const b = new CronScheduler(second, logger);
        const work = vi.fn();
        a.schedule('* * * * * *', work, 'same');
        b.schedule('* * * * * *', work, 'same');
        const callbacks = vi.mocked(cron.schedule).mock.calls.map(call => call[1] as TaskFn);
        const date = new Date('2026-09-05T12:00:00Z');
        try {
            await callbacks[0](tick(date));
            await callbacks[1](tick(date));
            expect(work).toHaveBeenCalledTimes(1);
            await second.close();
            second = new SQLiteMutex(file, p => p);
            expect(await second.acquire('job:same', 1000, date.getTime())).toBe(false);
            expect(await second.acquire('job:same', 1000, date.getTime() - 1000)).toBe(false);
            await callbacks[0](tick(new Date(date.getTime() + 1000)));
            expect(work).toHaveBeenCalledTimes(2);
        } finally {
            await a.dispose(); await b.dispose();
            await first.close(); await second.close();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('claims occurrences only after acquiring a lock and retains claims after expiry', async () => {
        vi.useFakeTimers();
        const mutex = new SQLiteMutex(':memory:', p => p);
        const occurrence = Date.now();
        try {
            expect(await mutex.acquire('job', 10)).toBe(true);
            expect(await mutex.acquire('job', 10, occurrence)).toBe(false);
            await mutex.release('job');
            expect(await mutex.acquire('job', 10, occurrence)).toBe(true);
            await vi.advanceTimersByTimeAsync(11);
            expect(await mutex.acquire('job', 10, occurrence)).toBe(false);
            expect(await mutex.acquire('job', 10, occurrence + 1000)).toBe(true);
        } finally {
            await mutex.close();
        }
    });

    it('aborts cron work and waits beyond five seconds before releasing its dependencies', async () => {
        vi.useFakeTimers();
        const mutex = new SQLiteMutex(':memory:', p => p);
        const scheduler = new CronScheduler(mutex, logger);
        const finish = deferred();
        let signal: AbortSignal | undefined;
        scheduler.schedule('* * * * * *', async context => {
            signal = context?.signal;
            await finish.promise;
        }, 'slow');
        const callback = vi.mocked(cron.schedule).mock.calls[0][1] as TaskFn;
        const run = callback(tick(new Date()));
        await vi.advanceTimersByTimeAsync(1);
        let disposed = false;
        const shutdown = scheduler.dispose().then(async () => { await mutex.close(); disposed = true; });
        try {
            await vi.advanceTimersByTimeAsync(6000);
            expect(signal?.aborted).toBe(true);
            expect(disposed).toBe(false);
            expect(await mutex.acquire('job:slow', 1000)).toBe(false);
        } finally {
            finish.resolve();
            await run;
            await vi.advanceTimersByTimeAsync(20);
            await shutdown;
        }
        expect(disposed).toBe(true);
    });

    it('reloads after consecutive atomic replacements of a custom config filename', async () => {
        const dir = await mkdtemp(path.join(tmpdir(), 'gears-watch-'));
        const file = path.join(dir, 'custom.json');
        await writeFile(file, '{"bundles":[]}');
        const app = new Container();
        app.singleton('ILogger', () => logger);
        const manager = new BundleManager(app, { configPath: file });
        const config = new JsonConfigFile(file, logger);
        try {
            await manager.restore({ watch: true, boot: true });
            await vi.waitFor(() => expect(logger.debug).toHaveBeenCalledWith('Watching for config changes', { path: file }));
            const restore = vi.spyOn(manager, 'restore');
            await config.update(data => ({ ...data, revision: 1 }), { bundles: [] });
            await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1), { timeout: 2000 });
            await config.update(data => ({ ...data, revision: 2 }), { bundles: [] });
            await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(2), { timeout: 2000 });
        } finally {
            await manager.close(); await app.shutdown();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
