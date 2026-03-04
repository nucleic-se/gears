import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStore } from '../../src/core/infra/SQLiteStore.js';
import { getDbPath } from '../../src/core/utils/paths.js';
import fs from 'fs';
import Database from 'better-sqlite3';

const TEST_DB_NAME = 'test_store.sqlite';

describe('SQLiteStore', () => {
    let store: SQLiteStore;
    let dbPath: string;

    beforeEach(() => {
        dbPath = getDbPath(TEST_DB_NAME);
        for (const suffix of ['', '-wal', '-shm']) {
            const p = dbPath + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        store = new SQLiteStore(TEST_DB_NAME);
    });

    afterEach(() => {
        store.close();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
        if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
        if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
    });

    it('should store and retrieve values', async () => {
        await store.set('foo', { bar: 'baz' });
        const val = await store.get('foo');
        expect(val).toEqual({ bar: 'baz' });
    });

    it('should return null for missing keys', async () => {
        const val = await store.get('missing');
        expect(val).toBeNull();
    });

    it('should handle corrupted JSON gracefully', async () => {
        // manually inject bad data
        const db = new Database(dbPath);
        db.exec("INSERT INTO store (key, value) VALUES ('corrupt', '{bad_json')");
        db.close();

        // Should not throw, should return null
        const val = await store.get('corrupt');
        expect(val).toBeNull();

        // Should have deleted the key
        const val2 = await store.get('corrupt');
        expect(val2).toBeNull();
    });
});
