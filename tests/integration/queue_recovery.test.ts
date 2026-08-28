import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB_PATH = path.resolve(__dirname, '../../test-queue-recovery.sqlite');

describe('Queue Recovery', () => {
    let queue: SQLiteQueue;

    beforeEach(async () => {
        try { await fs.unlink(TEST_DB_PATH); } catch { }
        queue = new SQLiteQueue(TEST_DB_PATH);
    });

    afterEach(async () => {
        try { await queue.close(); } catch { }
        await new Promise(r => setTimeout(r, 100));
        try { await fs.unlink(TEST_DB_PATH); } catch { }
        try { await fs.unlink(TEST_DB_PATH + '-wal'); } catch { }
        try { await fs.unlink(TEST_DB_PATH + '-shm'); } catch { }
    });

    it('should recover stuck processing jobs', async () => {
        // 1. Add jobs
        await queue.add('job-1', { id: 1 });
        await queue.add('job-2', { id: 2 });
        await queue.add('job-3', { id: 3 });

        // 2. Pop them to make them 'processing'
        const job1 = await queue.pop();
        const job2 = await queue.pop();

        expect(job1).toBeDefined();
        expect(job2).toBeDefined();

        // 3. Manually simulate "stuck" status by updating timestamp in DB directly
        // We'll use a raw query to backdate job1
        const now = Date.now();
        const oldTime = now - 60000; // 1 minute ago

        // We need access to DB strictly speaking, but SQLiteQueue exposes it? No private.
        // But we can just use the fact that pop updates updated_at to now.
        // Wait... we need to backdate it.
        // SQLiteQueue internals are private. 
        // We can re-open the DB with better-sqlite3 directly to mess with it?
        // Or we can add a helper/hack.

        // Let's use a separate DB connection to hack the data
        const Database = (await import('better-sqlite3')).default;
        const dbHack = new Database(TEST_DB_PATH);

        // Set job1 to be old
        dbHack.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(oldTime, job1!.id);

        // Set job2 to be recent (now)
        // (It already is)

        // 4. Run recovery with timeout of 30s. Job1 (60s old) should recover. Job2 (0s old) should stay.
        const recoveredCount = await queue.recover(30000);

        expect(recoveredCount).toBe(1);

        // 5. Verify: Job1 should be pending again. Job2 processing.
        const row1 = dbHack.prepare("SELECT status FROM jobs WHERE id = ?").get(job1!.id) as any;
        const row2 = dbHack.prepare("SELECT status FROM jobs WHERE id = ?").get(job2!.id) as any;

        expect(row1.status).toBe('pending');
        expect(row2.status).toBe('processing');

        dbHack.close();
    });

    it('bump: creates a new named delayed job', async () => {
        await queue.bump('flush:chat-1', 'memory.flush', { chatId: 'chat-1' }, 5000);
        const jobs = await queue.list('pending');
        expect(jobs).toHaveLength(1);
        expect(jobs[0].type).toBe('memory.flush');
    });

    it('bump: resets fire time on second call, no duplicate', async () => {
        await queue.bump('flush:chat-1', 'memory.flush', { chatId: 'chat-1' }, 5000);
        const first = await queue.list('pending');
        const firstScheduled = first[0].scheduled_at!;

        await new Promise(r => setTimeout(r, 10));
        await queue.bump('flush:chat-1', 'memory.flush', { chatId: 'chat-1' }, 5000);

        const all = await queue.list('pending');
        expect(all).toHaveLength(1); // still only one
        expect(all[0].scheduled_at!).toBeGreaterThan(firstScheduled); // fire time bumped
    });

    it('bump: leaves a processing job untouched', async () => {
        await queue.bump('flush:chat-1', 'memory.flush', { chatId: 'chat-1' }, 0);
        await queue.pop(); // moves to processing

        // bump again — should be a no-op (WHERE status = 'pending' not satisfied)
        await queue.bump('flush:chat-1', 'memory.flush', { chatId: 'chat-1' }, 5000);

        const processing = await queue.list('processing');
        expect(processing).toHaveLength(1); // still processing, not cancelled
    });

    it.each(['failed', 'completed'] as const)('bump: reactivates a %s named job', async (terminalStatus) => {
        await queue.bump('flush:chat-1', 'memory.flush', { version: 1 }, 0, {
            maxRetries: 3,
            priority: 1,
        });
        const original = await queue.pop();
        expect(original).toBeDefined();

        if (terminalStatus === 'failed') await queue.fail(original!.id, 'previous failure');
        else await queue.complete(original!.id);

        await queue.bump('flush:chat-1', 'memory.flush.v2', { version: 2 }, 5000, {
            maxRetries: 0,
            priority: 7,
        });

        const pending = await queue.list('pending');
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({
            id: original!.id,
            type: 'memory.flush.v2',
            payload: { version: 2 },
            status: 'pending',
            attempts: 0,
            priority: 7,
            error: null,
            options: { maxRetries: 0, priority: 7 },
        });
        expect(pending[0].scheduled_at).toBeGreaterThan(Date.now());
    });
});
