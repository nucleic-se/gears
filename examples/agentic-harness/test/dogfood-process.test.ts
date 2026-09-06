import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { stopWorker, waitForWorkerMessage } from '../src/standalone/dogfood-process.js';
const children: ChildProcess[] = [];
function worker(code = "process.send({type:'ready'});setInterval(()=>{},1000)") {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); children.push(child); return child;
}
afterEach(async () => { for (const child of children.splice(0)) await stopWorker(child, 'SIGKILL'); });
it('rejects already-aborted waits without leaving listeners', async () => {
    const child = worker();
    await expect(waitForWorkerMessage(child, 'ready', AbortSignal.abort(new Error('expired')))).rejects.toThrow('expired');
    expect(child.listenerCount('message')).toBe(0);
});
it('rejects an in-flight wait on deadline and removes listeners', async () => {
    const child = worker();
    await expect(waitForWorkerMessage(child, 'never', AbortSignal.timeout(30))).rejects.toThrow();
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
});
it('handles a worker that exits before inspection or shutdown', async () => {
    const child = worker('process.exit(0)');
    await once(child, 'exit');
    await expect(waitForWorkerMessage(child, 'state', AbortSignal.timeout(1000))).rejects.toThrow('already exited');
    await stopWorker(child, 'SIGTERM');
});
it('escalates a disposable worker that ignores graceful shutdown', async () => {
    const child = worker("process.on('SIGTERM',()=>{});process.send({type:'ready'});setInterval(()=>{},1000)");
    await waitForWorkerMessage(child, 'ready', AbortSignal.timeout(1000));
    await stopWorker(child, 'SIGTERM', 30);
    expect(child.signalCode).toBe('SIGKILL');
});
it('settles spawn errors without an unhandled child error', async () => {
    const child = spawn('/this-dogfood-executable-does-not-exist', [], { stdio: 'ignore' });
    await expect(waitForWorkerMessage(child, 'ready', AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'ENOENT' });
});
