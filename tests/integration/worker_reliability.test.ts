import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { Worker } from '../../src/core/queue/Worker.js';
import { Container } from '../../src/core/container/Container.js';
import { Job } from '../../src/core/queue/interfaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../../test-reliability.sqlite');

class MemoryLogger {
    logs: any[] = [];
    info(msg: string, meta?: any) { this.logs.push({ level: 'info', msg, meta }); }
    error(msg: string, meta?: any) { this.logs.push({ level: 'error', msg, meta }); }
    warn(msg: string, meta?: any) { this.logs.push({ level: 'warn', msg, meta }); }
    debug(msg: string, meta?: any) { this.logs.push({ level: 'debug', msg, meta }); }
}

describe('Worker Reliability', () => {
    let queue: SQLiteQueue;
    let worker: Worker;
    let container: Container;
    let logger: MemoryLogger;

    beforeEach(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            const p = DB_PATH + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        queue = new SQLiteQueue(DB_PATH);
        container = new Container();
        logger = new MemoryLogger();

        container.bind('ILogger', () => logger);
        container.bind('JobHandlers', () => new Map());
    });

    afterEach(async () => {
        if (worker) await worker.stop();
        try { await queue.close(); } catch { }
        await new Promise(r => setTimeout(r, 100));
        if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
        if (fs.existsSync(DB_PATH + '-wal')) fs.unlinkSync(DB_PATH + '-wal');
        if (fs.existsSync(DB_PATH + '-shm')) fs.unlinkSync(DB_PATH + '-shm');
    });

    it('should recover stuck processing jobs', async () => {
        // 1. Manually insert a "stuck" job (processing, old updated_at)
        await queue.add('stuck_job', { foo: 'bar' });
        const job = await queue.pop();
        expect(job?.status).toBe('processing');

        // Hack: Manually age the job in DB
        const db = (queue as any).db;
        const OLD_TIME = Date.now() - 600000; // 10 mins ago
        db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(OLD_TIME, job!.id);

        // 2. Start worker (recovery runs immediately)
        worker = new Worker(queue, container, { pollInterval: 50 });
        // @ts-ignore
        worker.start();

        // 3. Wait for recovery
        await new Promise(r => setTimeout(r, 500));

        // 4. Check status
        const recovered = db.prepare('SELECT * FROM jobs WHERE id = ?').get(job!.id);
        expect(recovered.status).toBe('pending');
    });

    it('should retry failed jobs with backoff', async () => {
        const handlers = new Map();
        let attempts = 0;

        handlers.set('fail_twice', async (job: Job) => {
            attempts++;
            console.log(`[Test] fail_twice called. Attempt: ${attempts}`);
            if (attempts <= 2) throw new Error('Temporary failure');
        });
        container.bind('JobHandlers', () => handlers);

        worker = new Worker(queue, container, { pollInterval: 50 });
        worker.start();

        // Add job with retries
        await queue.add('fail_twice', {}, { maxRetries: 3, backoffBase: 100 });

        // Wait for processing (initial + 2 retries = 3 attempts total)
        // 1st fail: delay 100ms
        // 2nd fail: delay 200ms
        // 3rd success
        await new Promise(r => setTimeout(r, 2000));

        const completedJob = (queue as any).db.prepare("SELECT * FROM jobs WHERE type='fail_twice'").get();
        if (completedJob.status !== 'completed') {
            console.log('Worker Logs:', JSON.stringify(logger.logs, null, 2));
        }
        expect(completedJob.status).toBe('completed');
        expect(completedJob.attempts).toBe(2);
        expect(attempts).toBe(3); // 1 initial + 2 retries
    });

    it('should fail permanently after max retries', async () => {
        const handlers = new Map();
        handlers.set('fail_always', async () => {
            throw new Error('Fatal error');
        });
        container.bind('JobHandlers', () => handlers);

        worker = new Worker(queue, container, { pollInterval: 50 });
        worker.start();

        await queue.add('fail_always', {}, { maxRetries: 2, backoffBase: 50 });

        // Wait for all retries to exhaust
        await new Promise(r => setTimeout(r, 1000));

        const failedJob = (queue as any).db.prepare("SELECT * FROM jobs WHERE type='fail_always'").get();
        expect(failedJob.status).toBe('failed');
        expect(failedJob.attempts).toBe(2);
        expect(failedJob.error).toBe('Fatal error');
    });
});
