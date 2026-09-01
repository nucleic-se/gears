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

        await app.shutdown();
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
