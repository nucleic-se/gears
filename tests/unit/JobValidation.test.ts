import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { JobRegistry } from '../../src/core/queue/JobRegistry.js';
import { getDbPath } from '../../src/core/utils/paths.js';
import fs from 'fs';
import { z } from 'zod';
import { ILogger } from '../../src/core/interfaces.js';

const dbPath = 'job_validation_test.sqlite';
const fullPath = getDbPath(dbPath);

const mockLogger: ILogger = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
};

describe('Job Validation', () => {
    let queue: SQLiteQueue;
    let registry: JobRegistry;

    beforeEach(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            const p = fullPath + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        registry = new JobRegistry(mockLogger);
        queue = new SQLiteQueue(dbPath, registry);
    });

    afterEach(async () => {
        await queue.close();
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        if (fs.existsSync(fullPath + '-wal')) fs.unlinkSync(fullPath + '-wal');
        if (fs.existsSync(fullPath + '-shm')) fs.unlinkSync(fullPath + '-shm');
    });

    it('should allow jobs without a registered schema', async () => {
        const job = await queue.add('unknown-type', { foo: 'bar' });
        expect(job.id).toBeDefined();
    });

    it('should allow valid payloads for registered schema', async () => {
        registry.register('test-job', z.object({
            count: z.number(),
            name: z.string()
        }));

        const job = await queue.add('test-job', { count: 1, name: 'test' });
        expect(job.id).toBeDefined();
    });

    it('should reject invalid payloads for registered schema', async () => {
        registry.register('test-job', z.object({
            count: z.number(),
            name: z.string()
        }));

        await expect(queue.add('test-job', { count: '1', name: 'test' })) // string instead of number
            .rejects
            .toThrow(/Job validation failed/);
    });
});
