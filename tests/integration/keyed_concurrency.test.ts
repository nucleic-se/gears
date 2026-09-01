import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';

import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { getDbPath } from '../../src/core/utils/paths.js';

describe('keyed queue concurrency', () => {
    let queue: SQLiteQueue;
    let dbPath: string;

    beforeEach(() => {
        dbPath = `test-keyed-concurrency-${randomUUID()}.sqlite`;
        queue = new SQLiteQueue(dbPath);
    });

    afterEach(async () => {
        await queue.close();
        const fullPath = getDbPath(dbPath);
        await Promise.allSettled([
            fs.unlink(fullPath), fs.unlink(`${fullPath}-wal`), fs.unlink(`${fullPath}-shm`),
        ]);
    });

    it('keeps jobs with the same key pending until the active job completes', async () => {
        const first = await queue.add('script', { order: 1 }, { concurrencyKey: 'agent:mira:script' });
        const second = await queue.add('script', { order: 2 }, { concurrencyKey: 'agent:mira:script' });

        const claimedFirst = await queue.pop();
        expect(claimedFirst?.id).toBe(first.id);
        expect(await queue.pop()).toBeNull();
        expect((await queue.get(second.id))?.status).toBe('pending');

        await queue.complete(claimedFirst!.id, claimedFirst!.claimToken!);
        expect((await queue.pop())?.id).toBe(second.id);
    });

    it('does not let a blocked key prevent unrelated work', async () => {
        await queue.add('script', { order: 1 }, { concurrencyKey: 'agent:mira:script', priority: 10 });
        await queue.add('script', { order: 2 }, { concurrencyKey: 'agent:mira:script', priority: 10 });
        const unrelated = await queue.add('health', {}, { concurrencyKey: 'agent:nucleic:health' });

        await queue.pop();
        expect((await queue.pop())?.id).toBe(unrelated.id);
    });

    it('applies keyed serialization to distinct named jobs created with bump', async () => {
        const options = { concurrencyKey: 'agent:mira:script' };
        await queue.bump('script:first', 'script', { order: 1 }, 0, options);
        await queue.bump('script:second', 'script', { order: 2 }, 0, options);

        const first = await queue.pop();
        expect(first).not.toBeNull();
        expect(await queue.pop()).toBeNull();
        await queue.complete(first!.id, first!.claimToken!);
        expect(await queue.pop()).not.toBeNull();
    });

    it('rejects an empty concurrency key', async () => {
        await expect(queue.add('script', {}, { concurrencyKey: '  ' })).rejects.toThrow(/concurrencyKey/);
    });
});
