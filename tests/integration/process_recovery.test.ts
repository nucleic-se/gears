import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';

const fixture = fileURLToPath(new URL('../fixtures/crash_worker.ts', import.meta.url));
const children: ChildProcess[] = [];
function start(dir: string, mode: string) {
    const child = fork(fixture, [], {
        execArgv: ['--loader', 'ts-node/esm'],
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', GEARS_DATA_DIR: dir, PROBE_MODE: mode },
        silent: true,
    });
    children.push(child);
    return child;
}
async function kill(child: ChildProcess) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
}
afterEach(async () => { for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await kill(child); });

it('recovers a killed worker with the original payload and a new fenced claim, and persists completion', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-crash-'));
    const queue = new SQLiteQueue('jobs.sqlite', undefined, file => path.join(dir, file));
    try {
        const job = await queue.add('probe', { durable: 'payload' }, { maxRetries: 1 });
        const first = start(dir, 'hang');
        const [initial] = await once(first, 'message');
        expect(initial.attempts).toBe(0);
        await kill(first);
        const second = start(dir, 'complete');
        const [recovered] = await once(second, 'message');
        expect(recovered.attempts).toBe(1);
        expect(recovered.payload).toEqual({ durable: 'payload' });
        expect(recovered.claim).not.toBe(initial.claim);
        await expect(queue.complete(job.id, initial.claim)).rejects.toThrow('Queue claim lost');
        await expect.poll(async () => (await queue.get(job.id))?.status).toBe('completed');
        const exit = once(second, 'exit'); second.send('stop'); await exit;
        const restarted = new SQLiteQueue('jobs.sqlite', undefined, file => path.join(dir, file));
        expect((await restarted.get(job.id))?.status).toBe('completed');
        await restarted.close();
    } finally { await queue.close(); await rm(dir, { recursive: true, force: true }); }
}, 20_000);

it('exhausts the retry budget after repeated worker kills', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-budget-'));
    const queue = new SQLiteQueue('jobs.sqlite', undefined, file => path.join(dir, file));
    try {
        const job = await queue.add('probe', {}, { maxRetries: 1 });
        for (const attempts of [0, 1]) {
            const child = start(dir, 'hang');
            const [message] = await once(child, 'message');
            expect(message.attempts).toBe(attempts);
            await kill(child);
        }
        const final = start(dir, 'complete');
        let invoked = false;
        final.on('message', () => { invoked = true; });
        await expect.poll(async () => (await queue.get(job.id))?.status, { timeout: 8000 }).toBe('failed');
        expect(invoked).toBe(false);
        expect((await queue.get(job.id))?.attempts).toBe(1);
        expect((await queue.get(job.id))?.error).toContain('retry budget is exhausted');
        const exit = once(final, 'exit'); final.send('stop'); await exit;
    } finally { await queue.close(); await rm(dir, { recursive: true, force: true }); }
}, 30_000);
