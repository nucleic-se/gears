import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStore, StoreCorruptionError } from '../../src/core/infra/SQLiteStore.js';
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

    it('quarantines corrupted JSON and fails visibly', async () => {
        // manually inject bad data
        const db = new Database(dbPath);
        db.exec("INSERT INTO store (key, value) VALUES ('corrupt', '{bad_json')");
        db.close();

        await expect(store.get('corrupt')).rejects.toBeInstanceOf(StoreCorruptionError);

        const verification = new Database(dbPath);
        expect(verification.prepare('SELECT key FROM store WHERE key = ?').get('corrupt')).toBeUndefined();
        expect(verification.prepare('SELECT key, value, error FROM store_corrupt WHERE key = ?').get('corrupt')).toEqual({
            key: 'corrupt', value: '{bad_json', error: 'JSON parse failed',
        });
        verification.close();
    });

    it('isolates scans at namespace boundaries', async () => {
        await store.namespace('a').set('inside', 1);
        await store.namespace('ab').set('outside', 2);

        expect(await store.namespace('a').scan()).toEqual({ inside: 1 });
    });

    it('treats scan prefixes as literal text', async () => {
        const namespaced = store.namespace('tenant%_');
        await namespaced.set('key%_', 'inside');
        await store.namespace('tenantXX').set('keyZZ', 'outside namespace');
        await namespaced.set('keyZZ', 'outside filter');

        expect(await namespaced.scan()).toEqual({
            'key%_': 'inside',
            keyZZ: 'outside filter',
        });
        expect(await namespaced.scan('key%_')).toEqual({ 'key%_': 'inside' });
    });
});
