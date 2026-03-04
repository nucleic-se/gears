import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { TestContainer } from '../../src/test/helpers/TestContainer.js';
import { getDbPath } from '../../src/core/utils/paths.js';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

describe('Job Priority', () => {
    let queue: SQLiteQueue;
    let app: TestContainer;
    let dbPath: string;

    beforeEach(async () => {
        dbPath = `test-priority-${randomUUID()}.sqlite`;
        queue = new SQLiteQueue(dbPath);
        app = new TestContainer();
        app.singleton('IQueue', () => queue);
    });

    afterEach(async () => {
        await queue.close();
        await new Promise(r => setTimeout(r, 100)); // wait for db close
        const fullPath = getDbPath(dbPath);
        try { await fs.unlink(fullPath); } catch { }
        try { await fs.unlink(fullPath + '-wal'); } catch { }
        try { await fs.unlink(fullPath + '-shm'); } catch { }
    });

    it('should pop high priority jobs first', async () => {
        await queue.add('low-prio', { id: 1 }, { priority: 0 });
        await queue.add('high-prio', { id: 2 }, { priority: 10 });
        await queue.add('med-prio', { id: 3 }, { priority: 5 });

        const job1 = await queue.pop();
        expect(job1?.type).toBe('high-prio');
        expect(job1?.priority).toBe(10);

        const job2 = await queue.pop();
        expect(job2?.type).toBe('med-prio');

        const job3 = await queue.pop();
        expect(job3?.type).toBe('low-prio');
    });

    it('should respect FIFO within same priority', async () => {
        const j1 = await queue.add('p5-first', {}, { priority: 5 });
        await new Promise(r => setTimeout(r, 10));
        const j2 = await queue.add('p5-second', {}, { priority: 5 });

        const job1 = await queue.pop();
        const job2 = await queue.pop();

        expect(job1?.id).toBe(j1.id);
        expect(job2?.id).toBe(j2.id);
    });

    it('should respect schedule over priority if schedule is in future', async () => {
        // High priority but delayed 10s
        await queue.addDelayed('high-delayed', {}, 10000, { priority: 100 });
        // Low priority but ready
        await queue.add('low-ready', {}, { priority: 0 });

        const job = await queue.pop();
        expect(job?.type).toBe('low-ready');
    });

    it('should respect priority among ready scheduled jobs', async () => {
        // Both scheduled in the past (ready)
        await queue.addDelayed('high-past', {}, -1000, { priority: 10 });
        await queue.addDelayed('low-past', {}, -1000, { priority: 0 });

        const job1 = await queue.pop();
        const job2 = await queue.pop();

        expect(job1?.type).toBe('high-past');
        expect(job2?.type).toBe('low-past');
    });
});
