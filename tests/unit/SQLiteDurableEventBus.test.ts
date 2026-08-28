import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import { SQLiteDurableEventBus } from '../../src/core/infra/SQLiteDurableEventBus.js';
import { getDbPath } from '../../src/core/utils/paths.js';

const TEST_DB_NAME = 'test_durable_events.sqlite';

describe('SQLiteDurableEventBus', () => {
    const dbPath = getDbPath(TEST_DB_NAME);
    let producer: SQLiteDurableEventBus;
    let consumer: SQLiteDurableEventBus;

    beforeEach(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
        producer = new SQLiteDurableEventBus(TEST_DB_NAME);
        consumer = new SQLiteDurableEventBus(TEST_DB_NAME);
    });

    afterEach(() => {
        producer.close();
        consumer.close();
        for (const suffix of ['', '-wal', '-shm']) {
            if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
        }
    });

    it('observes rejected promises from cross-process handlers', async () => {
        let rejectionObserved = false;
        const rejectedThenable = {
            then(_resolve: () => void, reject: (error: Error) => void) {
                rejectionObserved = true;
                reject(new Error('handler failed'));
            },
        };

        consumer.on('probe', () => rejectedThenable as unknown as Promise<void>);
        await producer.emit('probe', { value: 1 });

        (consumer as any).poll();
        await new Promise(resolve => setImmediate(resolve));

        expect(rejectionObserved).toBe(true);
    });
});
