import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PinoLogger } from '../../src/core/infra/PinoLogger.js';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('PinoLogger', () => {
    it('flushes and closes every owned stream exactly once', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'gears-pino-logger-'));
        directories.push(directory);
        const logger = new PinoLogger({ mode: 'text', dataDir: directory });
        const streams = (logger as unknown as {
            ownedStreams: Array<{ destroyed?: boolean; closed?: boolean }>;
        }).ownedStreams;

        logger.info('lifecycle probe');
        expect(streams.length).toBeGreaterThan(0);
        await Promise.all([logger.dispose(), logger.dispose()]);

        expect(streams.every(stream => stream.destroyed === true || stream.closed === true)).toBe(true);
    });
});
