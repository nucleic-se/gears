import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { boot } from '../../src/index.js';

describe('boot dataDir option', () => {
    const tempRoot = path.resolve(process.cwd(), '.tmp-test-gears-data');

    afterEach(async () => {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('uses the provided dataDir for runtime databases', async () => {
        const dataDir = path.join(tempRoot, 'custom-gears');
        const app = await boot({ dataDir });

        expect(app.make('DataPaths').getDbPath('jobs.sqlite')).toBe(path.join(dataDir, 'jobs.sqlite'));

        const queue = app.make('IQueue');
        await queue.add('test-job', { ok: true });

        expect(fs.existsSync(path.join(dataDir, 'jobs.sqlite'))).toBe(true);
        expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.join(dataDir, 'jobs.sqlite')).mode & 0o777).toBe(0o600);

        await app.shutdown();
    });

    it('rejects symlink and hard-link database aliases before opening SQLite', async () => {
        const symlinkRoot = path.join(tempRoot, 'symlink-root');
        const outside = path.join(tempRoot, 'outside.sqlite');
        fs.mkdirSync(symlinkRoot, { recursive: true });
        fs.writeFileSync(outside, 'outside');
        fs.symlinkSync(outside, path.join(symlinkRoot, 'jobs.sqlite'));
        const symlinkContainer = await boot({ dataDir: symlinkRoot });
        expect(() => symlinkContainer.make('IQueue')).toThrow(/non-symlink/);
        await symlinkContainer.shutdown();

        const hardlinkRoot = path.join(tempRoot, 'hardlink-root');
        fs.mkdirSync(hardlinkRoot, { recursive: true });
        fs.linkSync(outside, path.join(hardlinkRoot, 'jobs.sqlite'));
        const hardlinkContainer = await boot({ dataDir: hardlinkRoot });
        expect(() => hardlinkContainer.make('IQueue')).toThrow(/hard-link aliases/);
        await hardlinkContainer.shutdown();
    });

    it('keeps two containers on their own immutable data roots', async () => {
        const firstRoot = path.join(tempRoot, 'first');
        const secondRoot = path.join(tempRoot, 'second');
        const first = await boot({ dataDir: firstRoot });
        const second = await boot({ dataDir: secondRoot });

        await first.make('IQueue').add('first-job', { owner: 'first' });
        await second.make('IQueue').add('second-job', { owner: 'second' });
        expect((await first.make('IQueue').stats()).overview.pending).toBe(1);
        expect((await second.make('IQueue').stats()).overview.pending).toBe(1);
        expect(first.make('DataPaths').dataDir).toBe(firstRoot);
        expect(second.make('DataPaths').dataDir).toBe(secondRoot);
        expect((first.make('SharedDatabase') as unknown as Record<string, unknown>).db).toBeUndefined();

        await first.shutdown();
        await second.shutdown();
    });
});
