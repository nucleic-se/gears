import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { boot, getDbPath, setDataDir } from '../../src/index.js';

describe('boot dataDir option', () => {
    const tempRoot = path.resolve(process.cwd(), '.tmp-test-gears-data');

    afterEach(async () => {
        setDataDir(undefined);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    it('uses the provided dataDir for runtime databases', async () => {
        const dataDir = path.join(tempRoot, 'custom-gears');
        const app = await boot({ dataDir });

        expect(getDbPath('jobs.sqlite')).toBe(path.join(dataDir, 'jobs.sqlite'));

        const queue = app.make('IQueue');
        await queue.add('test-job', { ok: true });

        expect(fs.existsSync(path.join(dataDir, 'jobs.sqlite'))).toBe(true);

        await app.shutdown();
    });
});
