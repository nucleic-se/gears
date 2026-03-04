import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Worker } from '../../src/core/queue/Worker.js';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { TestContainer } from '../../src/test/helpers/TestContainer.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.resolve(__dirname, '../../test-queue.sqlite');

describe('Worker & Queue Integration', () => {
    let app: TestContainer;
    let queue: SQLiteQueue;
    let worker: Worker;

    beforeEach(async () => {
        app = new TestContainer();

        // Ensure clean DB (including WAL/SHM from prior crashed runs)
        for (const suffix of ['', '-wal', '-shm']) {
            try { await fs.unlink(TEST_DB_PATH + suffix); } catch { }
        }

        // Setup Queue with test DB
        // We need to inject this config or just instantiate Queue manually
        // Since we are testing integration, we can manually bind IQueue

        queue = new SQLiteQueue(TEST_DB_PATH);
        app.singleton('IQueue', () => queue);

        // Mock Job Handlers
        const handlers = new Map();
        handlers.set('test-job', async (job: any) => {
            app.logger.info(`Processed job: ${job.payload.message}`);
        });
        app.singleton('JobHandlers', () => handlers);

        worker = new Worker(queue, app);
    });

    afterEach(async () => {
        if (worker) {
            await worker.stop();
        }

        try { await queue.close(); } catch { }
        await new Promise(resolve => setTimeout(resolve, 100));

        try { await fs.unlink(TEST_DB_PATH); } catch { }
        try { await fs.unlink(TEST_DB_PATH + '-wal'); } catch { }
        try { await fs.unlink(TEST_DB_PATH + '-shm'); } catch { }
    });

    it('should process a queued job', async () => {
        // 1. Add job to queue
        await queue.add('test-job', { message: 'Hello World' });

        // 2. Start worker
        worker.start();

        // 3. Wait for processing (poll logger)
        await new Promise<void>((resolve, reject) => {
            const start = Date.now();
            const interval = setInterval(() => {
                if (app.logger.hasLog('info', 'Processed job: Hello World')) {
                    clearInterval(interval);
                    resolve();
                }
                if (Date.now() - start > 2000) {
                    clearInterval(interval);
                    reject(new Error('Timeout waiting for job processing'));
                }
            }, 50);
        });

        expect(app.logger.hasLog('info', 'Processed job: Hello World')).toBe(true);
    });
});
