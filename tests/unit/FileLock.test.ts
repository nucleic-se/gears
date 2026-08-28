import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import { FileLock } from '../../src/core/utils/FileLock.js';
import { getDbPath } from '../../src/core/utils/paths.js';

const targetPath = getDbPath('test-file-lock.json');
const lockPath = `${targetPath}.lock`;

describe('FileLock', () => {
    beforeEach(async () => {
        await fs.rm(lockPath, { force: true });
    });

    afterEach(async () => {
        await fs.rm(lockPath, { force: true });
    });

    it('publishes complete owner metadata', async () => {
        const lock = new FileLock(targetPath);
        await lock.acquire();

        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        expect(owner).toEqual({
            pid: process.pid,
            token: expect.any(String),
        });

        await lock.release();
    });

    it('does not remove a lock whose ownership token changed', async () => {
        const lock = new FileLock(targetPath);
        await lock.acquire();
        await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, token: 'new-owner' }));

        await lock.release();

        await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain('new-owner');
    });

    it('replaces a stale legacy PID-only lock', async () => {
        await fs.writeFile(lockPath, '2147483647');
        const lock = new FileLock(targetPath);

        await lock.acquire(1, 0);

        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
        expect(owner.pid).toBe(process.pid);
        expect(owner.token).toEqual(expect.any(String));
        await lock.release();
    });
});
