import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ILLMProvider } from '@nucleic-se/agentic/llm';
import type { IScheduler, Job } from '@nucleic-se/gears';
import { JOB_TYPE, openQueuedAgent } from '../src/runtime.js';

const directories: string[] = [];
const runtimes: Awaited<ReturnType<typeof openQueuedAgent>>[] = [];
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
    await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const response = { message: { role: 'assistant' as const, content: 'GEARS_OK' }, stopReason: 'end_turn' as const, usage: { inputTokens: 5, outputTokens: 2 } };
function provider(turn = vi.fn(async () => structuredClone(response))): ILLMProvider { return { turn, structured: async () => { throw new Error('unused'); } }; }
async function directory() { const path = await mkdtemp(join(tmpdir(), 'gears-agentic-test-')); directories.push(path); return path; }
async function open(path: string, model = provider(), options = {}) { const runtime = await openQueuedAgent(path, model, options); runtimes.push(runtime); return runtime; }
async function completed(runtime: Awaited<ReturnType<typeof openQueuedAgent>>, id: string) {
    await vi.waitFor(async () => expect((await runtime.app.make('IQueue').get(id))?.status).toBe('completed'));
}
describe('independent Gears agent harness', () => {
    it('dispatches once when both deliveries observe ready before claiming', async () => {
        const model = provider();
        const runtime = await open(await directory(), model, { startWorker: false });
        const job = await runtime.enqueue('race');
        const create = runtime.journal.create.bind(runtime.journal);
        let arrivals = 0, release!: () => void;
        const barrier = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(runtime.journal, 'create').mockImplementation(async (id, prompt) => {
            const state = await create(id, prompt);
            expect(state.status).toBe('ready');
            if (++arrivals === 2) release();
            await barrier;
            return state;
        });
        const deliver = () => runtime.agent.handle(job, { signal: new AbortController().signal });
        const results = await Promise.allSettled([deliver(), deliver()]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(model.turn).toHaveBeenCalledOnce();
        expect((await runtime.journal.get(job.id))?.status).toBe('completed');
        expect((await runtime.journal.events(job.id)).map(event => event.type)).toEqual(['model.intent', 'model.receipt']);
    });
    it('executes through the real worker and durably retains the model receipt across reopen/redelivery', async () => {
        const path = await directory(), model = provider();
        const first = await open(path, model);
        const job = await first.enqueue('Say GEARS_OK'); await completed(first, job.id);
        expect(await first.journal.get(job.id)).toMatchObject({ status: 'completed', response });
        expect((await first.journal.events(job.id)).map(e => e.type)).toEqual(['model.intent','model.receipt']);
        runtimes.splice(runtimes.indexOf(first), 1); await first.close();
        const second = await open(path, model, { startWorker: false });
        await second.agent.handle(job, { signal: new AbortController().signal });
        expect(model.turn).toHaveBeenCalledOnce();
        expect((await second.journal.get(job.id))?.response?.usage).toEqual(response.usage);
    });
    it('keeps uncertain delivery blocked instead of automatically making another model request', async () => {
        const model = provider(vi.fn(async () => { throw new Error('connection lost'); }));
        const runtime = await open(await directory(), model, { startWorker: false });
        const job = await runtime.enqueue('uncertain');
        await expect(runtime.agent.handle(job, { signal: new AbortController().signal })).rejects.toThrow('connection lost');
        expect((await runtime.journal.get(job.id))?.status).toBe('unknown');
        await expect(runtime.agent.handle(job, { signal: new AbortController().signal })).rejects.toThrow('needs review');
        expect(model.turn).toHaveBeenCalledOnce();
    });
    it('fences concurrent deliveries and propagates cancellation to the provider', async () => {
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const turn: ILLMProvider['turn'] = vi.fn(async (_request, options) => {
            entered();
            return new Promise<never>((_resolve, reject) => {
                options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
                if (options?.signal?.aborted) reject(options.signal.reason);
            });
        });
        const runtime = await open(await directory(), { turn, structured: async () => { throw new Error('unused'); } }, { startWorker: false });
        const job = await runtime.enqueue('block'), controller = new AbortController();
        const first = runtime.agent.handle(job, { signal: controller.signal });
        const rejected = expect(first).rejects.toThrow('cancelled');
        await started;
        try { await expect(runtime.agent.handle(job, { signal: new AbortController().signal })).rejects.toThrow('needs review'); }
        finally { controller.abort(new Error('cancelled')); }
        await rejected; expect(turn).toHaveBeenCalledOnce();
    });
    it('uses the Gears scheduled-job envelope as a stable deduplication identity', async () => {
        let tick: (() => void | Promise<void>) | undefined;
        const scheduler: IScheduler = {
            schedule(_cron, task) { tick = () => task({ signal: new AbortController().signal }); },
            unschedule() {}, list: async () => [], stopAll() {}, dispose: async () => {},
        };
        const model = provider(), runtime = await open(await directory(), model, { scheduler });
        runtime.schedule('daily-probe', '0 8 * * *', 'Say GEARS_OK');
        await tick!();
        await vi.waitFor(async () => expect(await runtime.app.make('IQueue').list('completed')).toHaveLength(1));
        const job = (await runtime.app.make('IQueue').list('completed'))[0] as Job<{ occurrence: { occurrenceId: string }; payload: { prompt: string } }>;
        expect(job.type).toBe(JOB_TYPE);
        expect((await runtime.journal.get(job.payload.occurrence.occurrenceId))?.status).toBe('completed');
        await runtime.agent.handle({ ...job, id: 'duplicate-delivery' } as never, { signal: new AbortController().signal });
        expect(model.turn).toHaveBeenCalledOnce();
    });
    it('atomically commits state and event with exactly one winner for a stale revision', async () => {
        const runtime = await open(await directory(), provider(), { startWorker: false });
        const state = await runtime.journal.create('cas', 'test');
        const commit = (type: string) => runtime.journal.commit('cas', 0, { ...state, revision: 1 }, { workId: 'cas', sequence: 1, type });
        const results = await Promise.allSettled([commit('one'), commit('two')]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect((await runtime.journal.get('cas'))?.revision).toBe(1);
        expect(await runtime.journal.events('cas')).toHaveLength(1);
    });
});
