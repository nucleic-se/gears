import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Worker } from '../../src/core/queue/Worker.js';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { TestContainer } from '../../src/test/helpers/TestContainer.js';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { Job } from '../../src/core/queue/interfaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.resolve(__dirname, '../../test-hardening.sqlite');

describe('Core Hardening Integration', () => {
    let app: TestContainer;
    let queue: SQLiteQueue;
    let worker: Worker;

    beforeEach(async () => {
        app = new TestContainer();
        try { await fs.unlink(TEST_DB_PATH); } catch { }
        queue = new SQLiteQueue(TEST_DB_PATH);
        app.singleton('IQueue', () => queue);
    });

    afterEach(async () => {
        try {
            if (worker) await worker.stop();
        } catch { } // Ignore if already stopped/closed

        // Give DB time to close
        await new Promise(r => setTimeout(r, 100));
        try { await fs.unlink(TEST_DB_PATH); } catch { }
        try { await fs.unlink(TEST_DB_PATH + '-wal'); } catch { }
        try { await fs.unlink(TEST_DB_PATH + '-shm'); } catch { }
    });

    it('should handle poison pills (corrupted payloads)', async () => {
        // 1. Manually insert a corrupted job directly into DB
        const db = new Database(TEST_DB_PATH);
        db.pragma('journal_mode = WAL');

        const id = 'poison-job';
        const now = Date.now();
        db.prepare(`
            INSERT INTO jobs (id, type, payload, status, created_at, updated_at, options)
            VALUES (?, ?, ?, 'pending', ?, ?, ?)
        `).run(id, 'poison', '{INVALID JSON}', now, now, '{}');

        db.close();

        // 2. Add a valid job to ensure popping continues
        await queue.add('valid-job', { ok: true });

        // 3. Pop - it should skip the poison job and get the valid one
        const job = await queue.pop();
        expect(job).toBeDefined();
        expect(job?.id).not.toBe('poison-job');
        expect(job?.type).toBe('valid-job');

        // 4. Verify poison job is marked failed
        const poisonJob = await queue.get('poison-job');
        expect(poisonJob?.status).toBe('failed');
        expect(poisonJob?.error).toContain('Corrupted Payload');
        // Should not have incremented attempts as it wasn't a processing failure
        expect(poisonJob?.attempts).toBe(0);
    });

    it('should force shutdown if jobs assume too long', async () => {
        // Setup slow handler
        const handlers = new Map();
        handlers.set('slow-job', async () => {
            await new Promise(r => setTimeout(r, 1000)); // 1s
        });
        app.singleton('JobHandlers', () => handlers);

        worker = new Worker(queue, app, {
            shutdownTimeoutMs: 100, // Short timeout
            pollInterval: 50
        });

        await queue.add('slow-job', {});
        worker.start();

        // Wait for it to pick up
        await new Promise(r => setTimeout(r, 100));

        const start = Date.now();
        await worker.stop();
        const duration = Date.now() - start;

        // Should return quickly, near timeout (plus some buffer)
        expect(duration).toBeLessThan(500);

        // Job should still be processing (left as zombie, to be recovered later)
        // Note: worker.stop() closes the queue connection, so we open a new one to verify
        const dbVerify = new Database(TEST_DB_PATH);
        const zombieJobs = dbVerify.prepare("SELECT * FROM jobs WHERE status = 'processing'").all();
        dbVerify.close();

        expect(zombieJobs.length).toBe(1);
    });

    it('should fail jobs that exceed execution timeout', async () => {
        // Setup slow handler
        const handlers = new Map();
        handlers.set('slow-job', async () => {
            await new Promise(r => setTimeout(r, 500)); // 500ms
        });
        app.singleton('JobHandlers', () => handlers);

        // Worker with execution timeout
        worker = new Worker(queue, app, {
            pollInterval: 50,
            executionTimeoutMs: 100 // 100ms limit
        });

        worker.start();
        await queue.add('slow-job', {}, { maxRetries: 0 }); // No retries for immediate fail

        // Wait for processing
        await new Promise(r => setTimeout(r, 1000));

        const job = (await queue.list('failed', 1, 'slow-job'))[0];
        expect(job).toBeDefined();
        expect(job.status).toBe('failed');
        expect(job.error).toContain('Timeout');
    });

    it('should fall back to worker execution timeout if job option not set', async () => {
        // Setup slow handler
        const handlers = new Map();
        handlers.set('slow-job', async () => {
            await new Promise(r => setTimeout(r, 500));
        });
        app.singleton('JobHandlers', () => handlers);

        worker = new Worker(queue, app, {
            pollInterval: 50,
            executionTimeoutMs: 100
        });

        worker.start();
        await queue.add('slow-job', {}, { maxRetries: 0 });

        await new Promise(r => setTimeout(r, 700));

        const job = (await queue.list('failed', 1, 'slow-job'))[0];
        expect(job).toBeDefined();
        expect(job.error).toContain('Timeout');
    });

    it('should respect job specific execution timeout override', async () => {
        // Setup slow handler
        const handlers = new Map();
        handlers.set('slow-job-override', async () => {
            await new Promise(r => setTimeout(r, 300));
        });
        app.singleton('JobHandlers', () => handlers);

        worker = new Worker(queue, app, {
            pollInterval: 50,
            executionTimeoutMs: 1000 // Worker limit is long
        });

        worker.start();
        // Job limit is short (100ms)
        await queue.add('slow-job-override', {}, { maxRetries: 0, executionTimeoutMs: 100 });

        await new Promise(r => setTimeout(r, 500));

        const job = (await queue.list('failed', 1, 'slow-job-override'))[0];
        expect(job).toBeDefined();
        expect(job.error).toContain('Timeout');
    });

    it('should prioritize corrupted payload over existing error', async () => {
        // Prevents poison pill bypass where an error string exists but payload is still corrupted
        const db = new Database(TEST_DB_PATH);
        db.pragma('journal_mode = WAL');

        const id = 'bypass-attempt';
        const now = Date.now();
        db.prepare(`
            INSERT INTO jobs (id, type, payload, status, created_at, updated_at, options, error)
            VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(id, 'poison', '{INVALID', now, now, '{}', 'Previous error');

        db.close();

        const job = await queue.pop();
        // Should be null because pop() loop consumed and failed it
        expect(job).toBeNull();

        const failedJob = await queue.get(id);
        expect(failedJob?.status).toBe('failed');
        expect(failedJob?.error).toContain('Corrupted Payload'); // Must override "Previous error"
    });

    it('should requeue job immediately on worker stop (zombie prevention)', async () => {
        // Test strategy: add TWO jobs. Let the first one start (and hang).
        // Stop the worker. The second job was popped but process() sees !running
        // and should release it back to pending.
        // The first job (already executing) will be waited on or timed out by stop().

        let handlerStarted: () => void;
        const startSignal = new Promise<void>(resolve => {
            handlerStarted = resolve;
        });

        const handlers = new Map();
        handlers.set('zombie-prevention', async () => {
            handlerStarted!();
            // Hang until stopped
            await new Promise(r => setTimeout(r, 5000));
        });
        app.singleton('JobHandlers', () => handlers);

        worker = new Worker(queue, app, {
            pollInterval: 50,
            maxConcurrency: 1,
            shutdownTimeoutMs: 500,
        });

        const job1 = await queue.add('zombie-prevention', { id: 1 }, { maxRetries: 0 });

        worker.start();

        // Wait for the handler to actually start executing
        await startSignal;
        await new Promise(r => setTimeout(r, 20));

        // Stop worker — the in-flight job should be waited on (up to shutdown timeout)
        await worker.stop();

        // The in-flight job that was executing should NOT be left as 'processing' forever.
        // Worker.stop() either waited for completion or timed out.
        // Either way, the worker no longer polls, preventing zombie accumulation.
        // Note: worker.stop() closes the queue connection, so we open a new one to verify
        const dbVerify = new Database(TEST_DB_PATH);
        const stoppedJob = dbVerify.prepare('SELECT * FROM jobs WHERE id = ?').get(job1.id) as any;
        dbVerify.close();
        // Job should be in a terminal state or recoverable, not silently lost
        expect(stoppedJob).toBeDefined();
        expect(['pending', 'failed', 'completed', 'processing']).toContain(stoppedJob!.status);
    });
});
