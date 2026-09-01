import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { JobClaimLostError } from '../../src/core/queue/interfaces.js';
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

    it('rejects a stale claim after recovery and a newer pop', async () => {
        const added = await queue.add('claim-probe', { version: 1 });
        const firstClaim = await queue.pop();

        if (!firstClaim?.claimToken) throw new Error('first claim token missing');
        expect(firstClaim.id).toBe(added.id);
        expect(firstClaim.claimToken).toEqual(expect.any(String));

        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        db.prepare('UPDATE jobs SET updated_at = 0 WHERE id = ?').run(firstClaim.id);
        db.close();

        expect(await queue.recover(1)).toBe(1);
        const secondClaim = await queue.pop();

        if (!secondClaim?.claimToken) throw new Error('second claim token missing');
        expect(secondClaim.claimToken).toEqual(expect.any(String));
        expect(secondClaim.claimToken).not.toBe(firstClaim.claimToken);

        const beforeStaleHeartbeat = (await queue.get(secondClaim.id))?.updated_at;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await expect(queue.heartbeat(secondClaim.id, firstClaim.claimToken))
            .rejects.toBeInstanceOf(JobClaimLostError);
        expect((await queue.get(secondClaim.id))?.updated_at).toBe(beforeStaleHeartbeat);

        await expect(queue.retry(secondClaim.id, 0, 'stale retry', firstClaim.claimToken))
            .rejects.toBeInstanceOf(JobClaimLostError);
        expect((await queue.get(secondClaim.id))?.status).toBe('processing');
        await expect(queue.fail(secondClaim.id, 'stale failure', firstClaim.claimToken))
            .rejects.toBeInstanceOf(JobClaimLostError);
        expect((await queue.get(secondClaim.id))?.status).toBe('processing');
        await expect(queue.release(secondClaim.id, firstClaim.claimToken))
            .rejects.toBeInstanceOf(JobClaimLostError);
        expect((await queue.get(secondClaim.id))?.status).toBe('processing');
        await expect(queue.complete(secondClaim.id, firstClaim.claimToken))
            .rejects.toBeInstanceOf(JobClaimLostError);
        expect((await queue.get(secondClaim.id))?.status).toBe('processing');

        await queue.complete(secondClaim.id, secondClaim.claimToken);
        expect((await queue.get(secondClaim.id))?.status).toBe('completed');
    });

    it('charges crash recovery to retry budget and eventually fails', async () => {
        const added = await queue.add('crash-loop', {}, { maxRetries: 1 });
        const first = await queue.pop();
        expect(first?.id).toBe(added.id);

        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        db.prepare('UPDATE jobs SET updated_at = 0 WHERE id = ?').run(added.id);
        expect(await queue.recover(1)).toBe(1);
        expect((await queue.get(added.id))?.attempts).toBe(1);

        await queue.pop();
        db.prepare('UPDATE jobs SET updated_at = 0 WHERE id = ?').run(added.id);
        expect(await queue.recover(1)).toBe(0);
        const exhausted = await queue.get(added.id);
        expect(exhausted?.status).toBe('failed');
        expect(exhausted?.attempts).toBe(1);
        db.close();
    });

    it('refuses a queue database created by a newer schema', async () => {
        await queue.close();
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        db.prepare('UPDATE _schema_version SET version = 999').run();
        db.close();

        expect(() => new SQLiteQueue(TEST_DB_PATH)).toThrow('newer than supported');
    });

    it('migrates a version 3 queue schema with a nullable claim token', async () => {
        await queue.close();
        const Database = (await import('better-sqlite3')).default;
        const db = new Database(TEST_DB_PATH);
        db.exec('ALTER TABLE jobs DROP COLUMN claim_token');
        db.prepare('UPDATE _schema_version SET version = 3').run();
        db.close();

        queue = new SQLiteQueue(TEST_DB_PATH);
        const migrated = new Database(TEST_DB_PATH);
        const version = migrated.prepare('SELECT version FROM _schema_version').pluck().get();
        const columns = migrated.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;

        expect(version).toBe(5);
        expect(columns.map(({ name }) => name)).toContain('claim_token');
        expect(columns.map(({ name }) => name)).toContain('concurrency_key');
        migrated.close();
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
