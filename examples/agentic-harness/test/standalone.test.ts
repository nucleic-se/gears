import { checkpointContextLifecycle, referenceContextLifecycle, budgetedContext, type CheckpointContextState } from '@nucleic-se/agentic/harness';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ILLMProvider, TurnResponse, TurnRequest, ToolCall } from '@nucleic-se/agentic/llm';
import { StandaloneHarness, type HarnessOptions } from '../src/standalone/host.js';
import type { Tree } from '../src/standalone/state.js';
const contextState = (task: { contextState?: unknown }): CheckpointContextState => (task.contextState as CheckpointContextState | undefined) ?? { kind: 'checkpoint' };
const paths: string[] = [], hosts: StandaloneHarness[] = [];
afterEach(async () => { for (const h of hosts.splice(0))
    await h.close(); for (const p of paths.splice(0))
    await rm(p, { recursive: true, force: true }); });
async function open(provider: ILLMProvider, path?: string, options: Partial<HarnessOptions> = {}) { path ??= await mkdtemp(join(tmpdir(), 'standalone-test-')); if (!paths.includes(path))
    paths.push(path); const h = await StandaloneHarness.open({ ...options, dataDir: path, provider }); hosts.push(h); return h; }
const reply = (content: string, calls: ToolCall[] = []): TurnResponse => ({ message: { role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) }, stopReason: calls.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } });
const tool = (name: string, args: Record<string, unknown>, id = name): ToolCall => ({ id, name, args });
const model = (turn: ILLMProvider['turn']): ILLMProvider => ({ turn, structured: async () => { throw new Error('unused'); } });
async function state(host: StandaloneHarness, id: string, check: (t: Tree) => void) { await vi.waitFor(async () => check((await host.store.get(id))!), { timeout: 10000, interval: 20 }); }
it('snapshots project instructions into the exact task request and composition identity', async () => {
    const instructions = [{ path: 'AGENTS.md', directory: '.', content: 'Run node --test before completion.' }];
    const host = await open(model(async request => {
        expect(request.system).toContain('Source: AGENTS.md');
        expect(request.system).toContain('Run node --test before completion.');
        expect(request.system).not.toContain('Changed after opening');
        return reply('done');
    }), undefined, { projectInstructions: instructions });
    instructions[0].content = 'Changed after opening';
    const tree = await host.create('Fix parser');
    await state(host, tree.id, current => expect(current.tasks[tree.id].answer).toBe('done'));
    const other = await open(model(async () => reply('unused')), undefined, { projectInstructions: instructions });
    expect(other.compositionId).not.toBe(host.compositionId);
});
it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid output allowance %s before opening storage', async outputTokens => {
    const path = await mkdtemp(join(tmpdir(), 'invalid-output-')); paths.push(path);
    const provider = model(vi.fn());
    await expect(StandaloneHarness.open({ dataDir: path, provider, outputTokens })).rejects.toThrow('outputTokens must be a positive safe integer');
    const host = await open(provider, path);
    expect(await host.store.list()).toEqual([]);
    expect(provider.turn).not.toHaveBeenCalled();
});
it('presents fresh evidence intact when the context has room', async () => {
    const evidence = 'header\n' + 'source evidence '.repeat(220) + '\nunique decision: approve';
    let turns = 0;
    const provider = model(async request => {
        if (!turns++) return reply('', [tool('read_test', {})]);
        const result = request.messages.find(message => message.role === 'tool_result');
        expect(result?.content).toBe(evidence);
        return reply('verified');
    });
    const host = await open(provider, undefined, { tools: [{ effect: 'read', definition: { name: 'read_test', description: 'Read evidence', parameters: { type: 'object' } }, validate: args => args, execute: async () => ({ ok: true, content: evidence }) }] });
    const tree = await host.create('review');
    await state(host, tree.id, t => expect(t.tasks[t.id].answer).toBe('verified'));
    const intents = (await host.store.events(tree.id)).filter(event => event.type === 'model.intent');
    expect(intents).toHaveLength(2);
});
it('rejects the whole batch before an earlier valid effect when later arguments are invalid', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: 'written' }));
    const validate = vi.fn((args: Record<string, unknown>) => {
        if (typeof args.value !== 'string') throw new Error('Expected string');
        return args;
    });
    let turns = 0;
    const host = await open(model(async () => turns++ ? reply('done') : reply('', [
        tool('write_test', { value: 'valid' }, 'first'), tool('write_test', { value: 42 }, 'second'),
    ])), undefined, { tools: [{ effect: 'write', definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' } }, validate, execute }] });
    const tree = await host.create('write');
    await state(host, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    const events = await host.store.events(tree.id);
    const receipts = events.filter(event => event.type === 'tool.receipt');
    expect(receipts).toHaveLength(2);
    expect(receipts[0].data).toMatchObject({ execution: { status: 'skipped', dispatched: false } });
    expect(receipts[1].data).toMatchObject({ execution: { status: 'runtime_failure', dispatched: false } });
    expect(events.some(event => event.type === 'tool.intent')).toBe(false);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
});
it('enforces the shared per-turn call ceiling before any effect', async () => {
    const execute = vi.fn(async () => ({ ok: true as const, content: 'written' }));
    const host = await open(model(async () => reply('', Array.from({ length: 17 }, (_, i) => tool('write_test', {}, String(i))))), undefined,
        { tools: [{ effect: 'write', definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' } }, validate: args => args, execute }] });
    const tree = await host.create('write');
    await state(host, tree.id, t => {
        expect(t.tasks[t.id].phase).toBe('failed');
        expect(t.tasks[t.id].error).toContain('maximum is 16');
    });
    expect(execute).not.toHaveBeenCalled();
});
it('resumes the unexecuted batch suffix after shutdown without replaying committed effects', async () => {
    let turns = 0, signal!: AbortSignal, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async (_args: Record<string, unknown>, currentSignal: AbortSignal) => {
        signal = currentSignal; return { ok: true as const, content: 'written' };
    });
    const tools = [{ effect: 'write' as const, definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' as const } }, validate: (args: Record<string, unknown>) => args, execute }];
    const provider = model(async () => turns++ ? reply('done') : reply('', [tool('write_test', {}, 'first'), tool('write_test', {}, 'second')]));
    const first = await open(provider, undefined, { tools });
    const change = first.store.change.bind(first.store);
    vi.spyOn(first.store, 'change').mockImplementation(async (...args) => {
        const result = await change(...args);
        if (args[1] === 'tool.receipt') await gate;
        return result;
    });
    const tree = await first.create('write');
    await state(first, tree.id, t => expect(t.tasks[t.id].pending.map(call => call.id)).toEqual(['second']));
    const closing = first.close();
    try { await vi.waitFor(() => expect(signal.aborted).toBe(true)); }
    finally { release(); await closing; }
    hosts.splice(hosts.indexOf(first), 1);
    const second = await open(provider, first.options.dataDir, { tools });
    await state(second, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    expect(execute).toHaveBeenCalledTimes(2);
    const results = (await second.store.get(tree.id))!.tasks[tree.id].messages.filter(message => message.role === 'tool_result');
    expect(results.map(result => result.toolCallId)).toEqual(['first', 'second']);
    expect(results.every(result => !result.isError)).toBe(true);
});
it('refunds the reservation when cancellation occurs after intent and before dispatch', async () => {
    const provider = model(vi.fn(async () => reply('unused')));
    const host = await open(provider);
    const change = host.store.change.bind(host.store);
    vi.spyOn(host.store, 'change').mockImplementation(async (...args) => {
        const result = await change(...args);
        if (args[1] === 'model.intent') await host.cancel(args[0]);
        return result;
    });
    const tree = await host.create('cancel before dispatch');
    await vi.waitFor(async () => expect((await host.store.events(tree.id)).find(e => e.type === 'model.receipt')?.data).toMatchObject({ dispatched: false }));
    const current = (await host.store.get(tree.id))!;
    expect(current.chargedTokens).toBe(0);
    expect(current.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(current.tasks[tree.id].reservation).toBeUndefined();
    expect(provider.turn).not.toHaveBeenCalled();
});
it('keeps the reservation when provider dispatch has an unknown outcome', async () => {
    const host = await open(model(async () => { throw new Error('Connection lost'); }));
    const tree = await host.create('unknown dispatch');
    await state(host, tree.id, t => expect(t.tasks[t.id].phase).toBe('unknown'));
    const current = (await host.store.get(tree.id))!;
    expect(current.chargedTokens).toBeGreaterThan(0);
    expect(current.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect((await host.store.events(tree.id)).find(e => e.type === 'model.receipt')?.data).toMatchObject({ dispatched: true });
});
it('delegates recoverable read context without requiring the model to grant archive plumbing', async () => {
    const evidence = 'source '.repeat(1900) + 'exact ending';
    let childTurns = 0;
    const host = await open(model(async request => {
        if (request.messages[0].content === 'child') {
            expect(request.tools?.map(t => t.name).sort()).toEqual(['read_test', 'read_tool_result']);
            if (childTurns++ === 0) return reply('', [tool('read_test', {}, 'source-a'), tool('read_test', {}, 'source-b')]);
            if (childTurns === 2) {
                expect(request.messages.some(m => m.content.includes('Tool output preview; exact saved text:'))).toBe(true);
                return reply('', [tool('read_tool_result', { callId: 'source-a', offset: 12000 })]);
            }
            const saved = [...request.messages].reverse().find(m => m.role === 'tool_result' && m.toolName === 'read_tool_result');
            expect(JSON.parse(saved!.content).content).toBe(evidence.slice(12000));
            return reply('child verified');
        }
        const spawned = request.messages.find(m => m.role === 'tool_result' && m.toolName === 'spawn_agent');
        if (!spawned) return reply('', [tool('spawn_agent', { objective: 'child', tools: ['read_test'], maxCalls: 4 })]);
        if (!request.messages.some(m => m.role === 'tool_result' && m.toolName === 'wait_agents'))
            return reply('', [tool('wait_agents', { ids: [JSON.parse(spawned.content).id] })]);
        return reply('done');
    }), undefined, { contextTokens: 6000, outputTokens: 200, checkpointing: false,
        tools: [{ effect: 'read', definition: { name: 'read_test', description: 'Read source', parameters: { type: 'object' } },
            validate: args => args, execute: async () => ({ ok: true, content: evidence }) }] });
    const tree = await host.create('parent');
    await state(host, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    const stored = (await host.store.get(tree.id))!;
    const child = stored.tasks[stored.tasks[tree.id].children[0]];
    expect(child.answer).toBe('child verified');
    expect(child.messages.find(m => m.role === 'tool_result' && m.toolCallId === 'source-a')?.content).toBe(evidence);
    expect(childTurns).toBe(3);
    const { internalAction } = await import('../src/standalone/tools.js');
    expect(() => internalAction(stored, child, 'read_tool_result', { callId: 'spawn_agent' }, 'parent-receipt'))
        .toThrow('missing or ambiguous');
    const parent = stored.tasks[tree.id];
    expect(() => internalAction(stored, parent, 'spawn_agent', { objective: 'invalid', tools: ['unavailable'], maxCalls: 1 }, 'invalid'))
        .toThrow('subset');
    const args = { objective: 'restricted', tools: ['read_test'], maxCalls: 1 };
    const restricted = JSON.parse(internalAction(stored, { ...parent, tools: ['read_test'] }, 'spawn_agent', args, 'restricted'));
    expect(stored.tasks[restricted.id].tools).toEqual(['read_test']);
    expect(args.tools).toEqual(['read_test']);
});

it('delegates two children, collects results, sleeps without a worker and resumes after reopen', async () => {
    const provider = model(vi.fn(async (request: TurnRequest) => {
        const objective = request.messages[0].content;
        if (objective.startsWith('child'))
            return reply(`result ${objective}`);
        const turns = request.messages.filter(m => m.role === 'assistant').length;
        if (turns === 0)
            return reply('', [tool('spawn_agent', { objective: 'child A', tools: [], maxCalls: 2 }, 'a'), tool('spawn_agent', { objective: 'child B', tools: [], maxCalls: 2 }, 'b')]);
        if (turns === 1) {
            const ids = request.messages.filter(m => m.role === 'tool_result' && m.toolName === 'spawn_agent').map(m => JSON.parse(m.content).id);
            return reply('', [tool('wait_agents', { ids })]);
        }
        if (turns === 2)
            return reply('', [tool('save_progress', { notes: 'Both children collected; finish after wake.' }), tool('schedule_self', { delaySeconds: 2, reason: 'restart proof' })]);
        expect(request.messages.at(-1)?.content).toContain('Both children collected');
        expect(JSON.stringify(request.messages)).toContain('result child A');
        expect(JSON.stringify(request.messages)).toContain('result child B');
        expect(request.messages.find(m => m.content.startsWith('Scheduled continuation'))?.provenance).toBe('deterministic');
        return reply('DONE');
    }));
    const first = await open(provider), tree = await first.create('parent');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('sleeping'));
    expect((await first.app.make('IQueue').stats()).overview.processing ?? 0).toBeLessThanOrEqual(1);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = await open(provider, first.options.dataDir);
    await state(second, tree.id, t => expect(t.tasks[t.id].answer).toBe('DONE'));
    const result = (await second.store.get(tree.id))!;
    expect(Object.keys(result.tasks)).toHaveLength(3);
    expect(result.modelCalls).toBe(6);
    expect(result.usage).toEqual({ inputTokens: 600, outputTokens: 120 });
    const intents = (await second.store.events(tree.id, 0)).filter(event => event.type === 'model.intent');
    expect(intents).toHaveLength(6);
    for (const event of intents) {
        const request = (event.data as { intent: { request: TurnRequest } }).intent.request;
        expect(request.cacheScope).toBe(`${second.compositionId}:${event.taskId}`);
    }
});
it('shares a hard model-call admission budget across children', async () => {
    const turn = vi.fn(async () => reply('', [tool('spawn_agent', { objective: 'child', tools: [], maxCalls: 2 })]));
    const h = await open(model(turn)), tree = await h.create('parent', { modelCalls: 1 });
    await state(h, tree.id, t => expect(Object.values(t.tasks).every(s => s.phase === 'failed')).toBe(true));
    expect(turn).toHaveBeenCalledOnce();
    expect(Object.values((await h.store.get(tree.id))!.tasks).some(task => task.error === 'Shared model-call budget exhausted')).toBe(true);
});
it('settles usage above the reservation and blocks further admission after reopen', async () => {
    const turn = vi.fn(async () => ({ ...reply('', [tool('save_progress', { notes: 'Known work saved' })]),
        usage: { inputTokens: 100, outputTokens: 4000 } }));
    const first = await open(model(turn));
    const tree = await first.store.create('Continue after saving progress', ['save_progress'], first.compositionId, { tokens: 3000 });
    await first.reconcile();
    await state(first, tree.id, current => expect(current.tasks[tree.id].phase).toBe('failed'));
    const saved = (await first.store.get(tree.id))!;
    expect(saved.chargedTokens).toBe(4100);
    expect(saved.usage).toEqual({ inputTokens: 100, outputTokens: 4000 });
    expect(saved.tasks[tree.id].error).toContain('Shared token budget exhausted');
    expect(saved.tasks[tree.id].reservation).toBeUndefined();
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    const second = await open(model(turn), first.options.dataDir);
    await second.reconcile();
    expect((await second.store.get(tree.id))!.chargedTokens).toBe(4100);
    expect(turn).toHaveBeenCalledOnce();
});

it('does not replay an ambiguous provider request after reopen', async () => {
    const turn = vi.fn(async () => { throw new Error('transport lost'); });
    const first = await open(model(turn)), tree = await first.create('parent');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('unknown'));
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = await open(model(turn), first.options.dataDir);
    await second.reconcile();
    expect(turn).toHaveBeenCalledOnce();
    expect((await second.store.get(tree.id))!.tasks[tree.id].error).toBe('transport lost');
    await expect(second.send(tree.id, tree.id, 'retry')).rejects.toThrow('requires review');
});
it('rejects a second active host using the Gears mutex', async () => {
    const h = await open(model(async () => reply('ok')));
    await expect(StandaloneHarness.open(h.options)).rejects.toThrow('active harness');
});
it('cancels an active model request and persists the cancellation', async () => {
    let start!: () => void;
    const entered = new Promise<void>(r => { start = r; });
    const h = await open(model(async (_request, options) => { start(); return new Promise<never>((_r, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })); }));
    const tree = await h.create('block');
    await entered;
    await h.cancel(tree.id);
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('cancelled'));
});
it('treats a denied read-only tool as recoverable model feedback', async () => {
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-'));
    paths.push(path);
    const provider = model(async (request) => request.messages.some(m => m.role === 'tool_result') ? reply('recovered') : reply('', [tool('read_test', {})]));
    const h = await StandaloneHarness.open({ dataDir: path, provider, tools: [{ effect: 'read', definition: { name: 'read_test', description: 'Read test', parameters: { type: 'object' } }, validate: args => args, execute: async () => { throw new Error('Path denied'); } }] });
    hosts.push(h);
    const tree = await h.create('read');
    await state(h, tree.id, t => expect(t.tasks[t.id].answer).toBe('recovered'));
});
it('never replays an uncertain effectful extension', async () => {
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-'));
    paths.push(path);
    const execute = vi.fn(async () => { throw new Error('ack lost'); });
    const h = await StandaloneHarness.open({ dataDir: path, provider: model(async () => reply('', [tool('write_test', {})])), tools: [{ effect: 'write', definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' } }, validate: args => args, execute }] });
    hosts.push(h);
    const tree = await h.create('write');
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('unknown'));
    await h.reconcile();
    expect(execute).toHaveBeenCalledOnce();
});
it.each(['unknown', 'timeout', 'cancelled'] as const)('stops after a dispatched %s tool receipt, including after reopen', async errorKind => {
    const turn = vi.fn(async () => reply('', [tool('write_test', {}, 'first'), tool('write_test', {}, 'second')]));
    const execute = vi.fn(async () => ({ ok: false as const, content: 'Acknowledgement missing', errorKind }));
    const tools = [{ effect: 'write' as const, definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' as const } }, validate: (args: Record<string, unknown>) => args, execute }];
    const first = await open(model(turn), undefined, { tools }), tree = await first.create('write');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('unknown'));
    const stopped = (await first.store.get(tree.id))!;
    expect(stopped.tasks[tree.id].error).toContain('Acknowledgement missing');
    expect(stopped.tasks[tree.id].pending.map(call => call.id)).toEqual(['second']);
    const receipts = (await first.store.events(tree.id)).filter(event => event.type === 'tool.receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].data).toMatchObject({ execution: { status: errorKind, dispatched: true } });
    expect(stopped.revision).toBe(receipts[0].sequence);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = await open(model(turn), first.options.dataDir, { tools });
    await second.reconcile();
    expect((await second.store.get(tree.id))!.tasks[tree.id].phase).toBe('unknown');
    await expect(second.send(tree.id, tree.id, 'continue')).rejects.toThrow('requires review');
    expect(turn).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
});
it('rejects incompatible completed-task continuation before claiming or mutating state', async () => {
    const turn = vi.fn(async () => reply('done'));
    const first = await open(model(turn), undefined, { composition: 'original' }), tree = await first.create('test');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    const before = await first.store.get(tree.id), events = await first.store.events(tree.id);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const incompatible = await open(model(turn), first.options.dataDir, { composition: 'changed' });
    await expect(incompatible.send(tree.id, tree.id, 'follow up')).rejects.toThrow('original composition');
    expect(await incompatible.store.get(tree.id)).toEqual(before);
    expect(await incompatible.store.events(tree.id)).toEqual(events);
    await incompatible.close();
    hosts.splice(hosts.indexOf(incompatible), 1);
    const restored = await open(model(turn), first.options.dataDir, { composition: 'original' });
    await restored.send(tree.id, tree.id, 'follow up');
    await state(restored, tree.id, t => {
        expect(t.tasks[t.id].phase).toBe('completed');
        expect(t.tasks[t.id].calls).toBe(2);
    });
    expect(turn).toHaveBeenCalledTimes(2);
});

it('records an uncertain tool outcome after reopen and resumes only its unexecuted suffix', async () => {
    const executed: string[] = [];
    const tools = [{ effect: 'write' as const, definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' as const } },
        validate: (args: Record<string, unknown>) => args,
        execute: async (args: Record<string, unknown>) => {
            executed.push(args.step as string);
            return args.step === 'first' ? { ok: false, content: 'Acknowledgement lost', errorKind: 'unknown' as const } : { ok: true, content: 'Second step completed' };
        } }];
    const turn = vi.fn(async (request: TurnRequest) => {
        if (!request.messages.some(message => message.role === 'tool_result'))
            return reply('', [tool('write_test', { step: 'first' }, 'first'), tool('write_test', { step: 'second' }, 'second')]);
        expect(request.messages.some(message => message.content.includes('Verified tool outcome recorded'))).toBe(true);
        return reply('recovered');
    });
    const first = await open(model(turn), undefined, { tools }), tree = await first.create('two steps');
    await state(first, tree.id, current => expect(current.tasks[tree.id].phase).toBe('unknown'));
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    const second = await open(model(turn), first.options.dataDir, { tools });
    const stopped = (await second.store.get(tree.id))!;
    const resolution = { expectedRevision: stopped.revision, evidence: 'Inspected the external record: first step completed', result: { ok: true, content: 'First step verified' } };
    await expect(second.resolveTool(tree.id, tree.id, 'first', { ...resolution, expectedRevision: stopped.revision - 1 })).rejects.toThrow('revision');
    expect(await second.store.get(tree.id)).toEqual(stopped);
    const resolved = await second.resolveTool(tree.id, tree.id, 'first', resolution);
    expect(resolved.tasks[tree.id].phase).toBe('paused');
    expect(resolved.tasks[tree.id].messages).toEqual(stopped.tasks[tree.id].messages);
    await second.reconcile();
    expect(executed).toEqual(['first']);
    await expect(second.resolveTool(tree.id, tree.id, 'first', { ...resolution, expectedRevision: resolved.revision })).rejects.toThrow('unresolved');
    await second.send(tree.id, tree.id, 'Continue with the verified outcome');
    await state(second, tree.id, current => expect(current.tasks[tree.id].answer).toBe('recovered'));
    expect(executed).toEqual(['first', 'second']);
    const events = await second.store.events(tree.id);
    expect(events.find(event => event.type === 'tool.resolved')?.data).toEqual({ callId: 'first', resolution });
});

it('keeps a live model call beyond the recovery window while worker heartbeats advance', async () => {
    const turn = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 17000));
        return reply('completed once');
    });
    const host = await open(model(turn)), tree = await host.create('wait for a live call');
    await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].answer).toBe('completed once'), { timeout: 22000, interval: 100 });
    expect(turn).toHaveBeenCalledOnce();
}, 25000);
it('preserves cancellation before tool dispatch without marking the outcome unknown', async () => {
    const turn = vi.fn(async () => reply('', [tool('write_test', {})]));
    const execute = vi.fn(async () => ({ ok: true as const, content: 'written' }));
    const h = await open(model(turn), undefined, { tools: [{ effect: 'write', definition: { name: 'write_test', description: 'Write test', parameters: { type: 'object' } }, validate: args => args, execute }] });
    const change = h.store.change.bind(h.store);
    vi.spyOn(h.store, 'change').mockImplementation(async (...args) => {
        const result = await change(...args);
        if (args[1] === 'tool.intent') await h.cancel(args[0]);
        return result;
    });
    const tree = await h.create('write');
    await vi.waitFor(async () => {
        const receipt = (await h.store.events(tree.id)).find(event => event.type === 'tool.receipt');
        expect(receipt?.data).toMatchObject({ execution: { status: 'cancelled', dispatched: false } });
    });
    expect((await h.store.get(tree.id))!.tasks[tree.id].phase).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(turn).toHaveBeenCalledOnce();
});
it('web extension requires authentication and exposes durable task state', async () => {
    const { attachWeb } = await import('../src/standalone/web.js');
    const h = await open(model(async () => reply('WEB_OK')));
    const web = await attachWeb(h, { token: 'test-token', port: 0 });
    const address = web.server.address();
    if (!address || typeof address === 'string')
        throw new Error('No port');
    const url = `http://127.0.0.1:${address.port}`;
    try {
        expect((await fetch(url + '/api/tasks')).status).toBe(401);
        expect((await fetch(url)).status).toBe(200);
        const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
        const created = await fetch(url + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'web test' }) });
        expect(created.status).toBe(200);
        const tree = await created.json() as Tree;
        await state(h, tree.id, t => expect(t.tasks[t.id].answer).toBe('WEB_OK'));
        const list = await (await fetch(url + '/api/tasks', { headers })).json() as any[];
        expect(list[0].tasks[0].answer).toBe('WEB_OK');
        expect((await fetch(url + '/api/tasks', { method: 'POST', headers, body: '[]' })).status).toBe(400);
    }
    finally {
        await web.close();
    }
});
it('fences stale hosts at the tree transaction boundary', async () => {
    const h = await open(model(async () => reply('done'))), tree = await h.create('ownership');
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    const { TreeStore } = await import('../src/standalone/state.js');
    const newer = new TreeStore(h.app.make('db') as never);
    await newer.claim((await newer.get(tree.id))!);
    await expect(h.store.change(tree.id, 'stale', t => { t.tasks[t.id].notes = 'stale write'; })).rejects.toThrow('ownership lost');
    expect((await newer.get(tree.id))?.tasks[tree.id].notes).toBe('');
});
it('an inbox message arriving during a model call prevents a later sleep from stranding it', async () => {
    let start!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { start = r; }), barrier = new Promise<void>(r => { release = r; });
    let calls = 0;
    const h = await open(model(async (request) => {
        if (calls++ === 0) {
            start();
            await barrier;
            return reply('', [tool('schedule_self', { delaySeconds: 3600, reason: 'wait' })]);
        }
        expect(request.messages.find(m => m.content === 'urgent correction')?.provenance).toBe('human');
        return reply('corrected');
    }));
    const tree = await h.create('initial');
    await entered;
    await h.send(tree.id, tree.id, 'urgent correction');
    release();
    await state(h, tree.id, t => expect(t.tasks[t.id].answer).toBe('corrected'));
});
it('requires a nonempty UI token', async () => {
    const { attachWeb } = await import('../src/standalone/web.js');
    const h = await open(model(async () => reply('ok')));
    await expect(attachWeb(h, { token: '', port: 0 })).rejects.toThrow('nonempty');
});
it('reads UTF-8 chunks without corruption and bounds directory enumeration', async () => {
    const { codingTools } = await import('../src/standalone/coding.js');
    const { writeFile } = await import('node:fs/promises');
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-'));
    paths.push(path);
    const content = 'a'.repeat(15999) + '🌿rest';
    await writeFile(join(path, '..notes'), content);
    const tools = codingTools(path, join(path, 'outputs'), true), read = tools.find(t => t.definition.name === 'fs_read')!, signal = new AbortController().signal;
    const first = JSON.parse((await read.execute({ mode: 'bytes', path: '..notes', offset: 0 }, signal)).content);
    const second = JSON.parse((await read.execute({ mode: 'bytes', path: '..notes', offset: first.nextOffset }, signal)).content);
    expect(first.content + second.content).toBe(content);
    expect(second.eof).toBe(true);
    await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(path, `file${i}`), '')));
    const listing = await tools.find(t => t.definition.name === 'fs_list')!.execute({ path: '.' }, signal);
    expect(listing.data).toMatchObject({ count: 200, truncated: true });
});
it('reserves shared token budget before concurrent child dispatch', async () => {
    let release!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const turn = vi.fn(async () => { await barrier; return reply('done'); });
    const h = await open(model(turn)), { newTask } = await import('../src/standalone/state.js');
    const tree = await h.store.create('root', [], h.compositionId, { tokens: 3000 });
    await h.store.change(tree.id, 'fixture.children', t => { t.tasks[t.id].phase = 'completed'; t.tasks[t.id].children = ['left', 'right']; for (const id of ['left', 'right'])
        t.tasks[id] = newTask(id, id, [], { parentId: t.id, depth: 1 }); });
    try {
        await h.reconcile();
        await state(h, tree.id, t => expect(['left', 'right'].filter(id => t.tasks[id].phase === 'failed')).toHaveLength(1));
        const blocked = Object.values((await h.store.get(tree.id))!.tasks).find(task => task.phase === 'failed');
        expect(blocked?.error).toMatch(/Shared token budget exhausted: request needs \d+, remaining \d+/);
        expect(turn).toHaveBeenCalledOnce();
    }
    finally {
        release();
    }
});
it('does not scan completed trees during background reconciliation and can reopen a completed conversation', async () => {
    const provider = model(async () => reply('done')), first = await open(provider), tree = await first.create('first');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    expect(await first.store.list(true)).toHaveLength(0);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    const second = await open(provider, first.options.dataDir);
    await second.send(tree.id, tree.id, 'next turn');
    await state(second, tree.id, t => expect(t.modelCalls).toBe(2));
});
it('rejects a FIFO without blocking its read tool', async () => {
    if (process.platform === 'win32')
        return;
    const { execFileSync } = await import('node:child_process'), { codingTools } = await import('../src/standalone/coding.js');
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-'));
    paths.push(path);
    execFileSync('mkfifo', [join(path, 'pipe')]);
    const tools = codingTools(path, join(path, 'outputs'), true);
    expect(await tools.find(t => t.definition.name === 'fs_read')!.execute({ path: 'pipe' }, new AbortController().signal)).toMatchObject({ ok: false, content: expect.stringContaining('regular file') });
});
it('refuses incompatible startup without destroying resumable work', async () => {
    const provider = model(async () => reply('resumed')), first = await open(provider);
    const tree = await first.store.create('preserve me', [], first.compositionId);
    await first.close();
    hosts.splice(hosts.indexOf(first), 1);
    await expect(StandaloneHarness.open({ ...first.options, composition: 'wrong' })).rejects.toThrow('original composition');
    const corrected = await open(provider, first.options.dataDir);
    await state(corrected, tree.id, t => expect(t.tasks[t.id].answer).toBe('resumed'));
    expect((await corrected.store.get(tree.id))?.modelCalls).toBe(1);
});
it('a paused startup cannot claim a tree snapshot already claimed by a newer owner', async () => {
    const h = await open(model(async () => reply('done'))), tree = await h.create('claim');
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    const snapshot = (await h.store.get(tree.id))!, { TreeStore } = await import('../src/standalone/state.js');
    const newer = new TreeStore(h.app.make('db') as never);
    await newer.claim(snapshot);
    await expect(h.store.claim(snapshot)).rejects.toThrow('Stale tree revision');
    expect((await newer.get(tree.id))?.ownerEpoch).toBe(newer.epoch);
});

it('exposes exact in-flight requests through authenticated inspection and preserves them after reopen', async () => {
    const { attachWeb } = await import('../src/standalone/web.js');
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let request: TurnRequest | undefined;
    const turn = vi.fn(async (input: TurnRequest) => { request = structuredClone(input); entered(); await gate; return reply('done'); });
    const first = await open(model(turn));
    const web = await attachWeb(first, { token: 'inspection-test', port: 0 });
    try {
        const tree = await first.create('Inspect this exact objective');
        await started;
        const address = web.server.address() as { port: number };
        const url = `http://127.0.0.1:${address.port}/api/tasks/${tree.id}/inspect`;
        expect((await fetch(url)).status).toBe(401);
        const response = await fetch(url, { headers: { Authorization: 'Bearer inspection-test' } });
        expect(response.status).toBe(200);
        const snapshot = await response.json();
        const intent = snapshot.events.find((event: { type: string }) => event.type === 'model.intent');
        expect(intent.data.intent.request).toEqual(request);
        expect(intent.data.context.usage.reservedOutputTokens).toBe(1800);
        expect(snapshot.state.tasks[tree.id].phase).toBe('model');
        await first.inspect(tree.id);
        expect(turn).toHaveBeenCalledOnce();
        release();
        await state(first, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
        await first.close(); hosts.splice(hosts.indexOf(first), 1);
        const second = await open(model(turn), first.options.dataDir);
        const recovered = await second.inspect(tree.id);
        expect(recovered.events.find(event => event.type === 'model.intent')?.data).toEqual(intent.data);
    } finally { release(); await web.close(); }
});

it('counts inherited artifact names as new entries and preserves own entries after storage reload', async () => {
    const { internalAction } = await import('../src/standalone/tools.js');
    const { attachWeb } = await import('../src/standalone/web.js');
    const h = await open(model(async () => reply('done')));
    const tree = await h.create('artifact lookup');
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    const web = await attachWeb(h, { token: 'artifact-test', port: 0 });
    const port = (web.server.address() as { port: number }).port;
    const read = (name: string) => fetch(`http://127.0.0.1:${port}/api/tasks/${tree.id}/artifact?name=${name}`, { headers: { Authorization: 'Bearer artifact-test' } });
    try {
        const snapshot = (await h.store.get(tree.id))!;
        for (const name of ['constructor', 'toString', '__proto__']) {
            expect(() => internalAction(snapshot, snapshot.tasks[tree.id], 'read_artifact', { name, offset: 0 }, 'read')).toThrow('does not exist');
            expect((await read(name)).status).toBe(404);
        }
        await h.store.change(tree.id, 'fixture.artifacts', current => {
            internalAction(current, current.tasks[tree.id], 'save_artifact', { name: 'constructor', content: 'actual saved text' }, 'save');
            for (let index = 1; index < 32; index++)
                internalAction(current, current.tasks[tree.id], 'save_artifact', { name: `file-${index}`, content: 'text' }, `save-${index}`);
        });
        const loaded = (await h.store.get(tree.id))!;
        expect(JSON.parse(internalAction(loaded, loaded.tasks[tree.id], 'read_artifact', { name: 'constructor', offset: 0 }, 'read')).content).toBe('actual saved text');
        expect(await (await read('constructor')).json()).toEqual({ content: 'actual saved text' });
        expect(() => internalAction(loaded, loaded.tasks[tree.id], 'save_artifact', { name: 'toString', content: 'new' }, 'new')).toThrow('count limit');
        expect(() => internalAction(loaded, loaded.tasks[tree.id], 'save_artifact', { name: 'constructor', content: 'replacement' }, 'replace')).not.toThrow();
        expect(Object.keys(loaded.artifacts)).toHaveLength(32);
    } finally { await web.close(); }
});

it('paginates artifacts with exact UTF-16 offsets and rejects offsets beyond their end', async () => {
    const { internalAction, validateInternal } = await import('../src/standalone/tools.js');
    const h = await open(model(async () => reply('done'))), tree = await h.create('artifact pagination');
    await state(h, tree.id, current => expect(current.tasks[current.id].phase).toBe('completed'));
    const content = 'a'.repeat(11999) + '😀' + 'tail';
    await h.store.change(tree.id, 'fixture.artifact-pages', current => {
        current.artifacts.paged = content;
        current.artifacts.empty = '';
    });
    const saved = (await h.store.get(tree.id))!, task = saved.tasks[tree.id];
    const first = JSON.parse(internalAction(saved, task, 'read_artifact', { name: 'paged', offset: 0 }, 'page-1'));
    const second = JSON.parse(internalAction(saved, task, 'read_artifact', { name: 'paged', offset: first.nextOffset }, 'page-2'));
    expect(first).toMatchObject({ totalCharacters: content.length, offset: 0, nextOffset: 12000, eof: false });
    expect(first.content.length).toBe(12000);
    expect(first.content + second.content).toBe(content);
    expect(second).toMatchObject({ offset: 12000, nextOffset: content.length, eof: true });
    const eof = JSON.parse(internalAction(saved, task, 'read_artifact', { name: 'paged', offset: content.length }, 'eof'));
    expect(eof).toEqual({ totalCharacters: content.length, offset: content.length, nextOffset: content.length, eof: true, content: '' });
    const empty = JSON.parse(internalAction(saved, task, 'read_artifact', { name: 'empty', offset: 0 }, 'empty'));
    expect(empty).toEqual({ totalCharacters: 0, offset: 0, nextOffset: 0, eof: true, content: '' });
    expect(() => internalAction(saved, task, 'read_artifact', { name: 'paged', offset: content.length + 1 }, 'past-end')).toThrow('Offset exceeds saved artifact');
    expect(() => validateInternal('read_artifact', { name: 'paged', offset: -1 })).toThrow();
});

it('keeps instructions stable and projects fresh budget state without accumulating it in history', async () => {
    const requests: TurnRequest[] = [];
    const h = await open(model(async request => {
        requests.push(structuredClone(request));
        return requests.length === 1
            ? reply('', [tool('save_progress', { notes: 'Keep the source reference for the final answer.' })])
            : reply('done');
    }));
    const tree = await h.create('stable objective');
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    expect(requests).toHaveLength(2);
    expect(requests[0].system).toBe(requests[1].system);
    const stateMessage = (request: TurnRequest) => request.messages.filter(message => message.provenance === 'deterministic');
    expect(stateMessage(requests[0])).toHaveLength(1);
    expect(stateMessage(requests[1])).toHaveLength(1);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'user', sticky: true, provenance: 'deterministic' });
    const first = JSON.parse(stateMessage(requests[0])[0].content.split('\n')[1]);
    const second = JSON.parse(stateMessage(requests[1])[0].content.split('\n')[1]);
    expect(first.remainingSharedTokensBeforeThisRequest).toBe(tree.limits.tokens);
    expect(second.remainingSharedTokensBeforeThisRequest).toBe(tree.limits.tokens - 120);
    expect(second.remainingTaskCallsIncludingThisTurn).toBe(first.remainingTaskCallsIncludingThisTurn - 1);
    expect(second.progressNotes).toBe('Keep the source reference for the final answer.');
    const persisted = (await h.store.get(tree.id))!;
    expect(persisted.tasks[tree.id].messages.some(message => message.provenance === 'deterministic')).toBe(false);
    expect(persisted.tasks[tree.id].messages[0].content).toBe('stable objective');
    const intents = (await h.inspect(tree.id)).events.filter(event => event.type === 'model.intent');
    for (let index = 0; index < requests.length; index++) {
        const data = intents[index].data as { intent: { request: TurnRequest }; context: { usage: { messageTokens: number } } };
        expect(data.intent.request).toEqual(requests[index]);
        expect(data.context.usage.messageTokens).toBeGreaterThan(0);
    }
});

it('recovers referenced evidence from durable history without rerunning the source tool', async () => {
    const { estimateContextTokens } = await import('@nucleic-se/agentic/runtime');
    const { internalDefinitions: manifest } = await import('../src/standalone/tools.js');
    // Keep the evidence allowance stable when truthful tool schemas gain detail.
    const contextTokens = 6400 + estimateContextTokens({ messages: [], tools: manifest }).toolTokens;
    const evidence = 'Original evidence\n' + 'x'.repeat(10000) + '\nEXACT TAIL';
    const read = vi.fn(async () => ({ ok: true, content: evidence }));
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-')); paths.push(path);
    let calls = 0;
    const h = await StandaloneHarness.open({ dataDir: path, contextTokens, checkpointing: false,
        tools: [{ definition: { name: 'evidence', description: 'Read evidence', parameters: { type: 'object', properties: {} } }, effect: 'read', validate: () => ({}), execute: read }],
        provider: model(async request => {
            switch (calls++) {
                case 0: return reply('', [tool('evidence', {})]);
                case 1:
                    expect(request.messages.find(message => message.role === 'tool_result')?.content).toBe(evidence);
                    return reply('', [tool('save_progress', { notes: 'Verify the exact end of the earlier evidence.' })]);
                case 2:
                    expect(request.messages.find(message => message.role === 'tool_result')?.content).toBe(evidence);
                    // Grow protected state; the saved source must remain retrievable after it is no longer recent.
                    return reply('', [tool('save_progress', { notes: 'Now recover the saved tail. ' + 'n'.repeat(7000) }, 'progress-again')]);
                case 3:
                    expect(request.messages.find(message => message.role === 'tool_result')?.content).toContain('read_tool_result({"callId":"evidence","offset":0})');
                    return reply('', [tool('read_tool_result', { callId: 'evidence', offset: 8000 })]);
                default: {
                    const retrieved = request.messages.filter(message => message.role === 'tool_result' && message.toolName === 'read_tool_result').at(-1)!;
                    expect(JSON.parse(retrieved.content)).toMatchObject({ content: evidence.slice(8000), eof: true, nextOffset: evidence.length });
                    return reply('verified');
                }
            }
        }),
    }); hosts.push(h);
    const tree = await h.create('Recover exact evidence');
    await state(h, tree.id, current => expect(current.tasks[tree.id].answer).toBe('verified'));
    expect(read).toHaveBeenCalledOnce();
    const snapshots = await h.inspect(tree.id);
    expect(JSON.stringify(snapshots.events)).toContain('originalCharacters');
    expect(snapshots.state.tasks[tree.id].messages[2].content).toBe(evidence);
    await h.close(); hosts.splice(hosts.indexOf(h), 1);
    const reopened = await StandaloneHarness.open(h.options); hosts.push(reopened);
    const saved = (await reopened.store.get(tree.id))!;
    const { internalAction, validateInternal } = await import('../src/standalone/tools.js');
    const task = saved.tasks[tree.id];
    const first = JSON.parse(internalAction(saved, task, 'read_tool_result', { messageIndex: 2, offset: 0 }, 'recover'));
    expect(first).toMatchObject({ messageIndex: 2, callId: 'evidence' });
    const last = JSON.parse(internalAction(saved, task, 'read_tool_result', { messageIndex: 2, offset: first.nextOffset }, 'recover-next'));
    expect(first.content + last.content).toBe(evidence);
    expect(first.content.length).toBe(8000);
    expect(() => internalAction(saved, task, 'read_tool_result', { messageIndex: 0, offset: 0 }, 'invalid')).toThrow('does not exist');
    expect(() => validateInternal('read_tool_result', { messageIndex: -1 })).toThrow();
    expect(() => internalAction(saved, task, 'read_tool_result', { messageIndex: 2, offset: evidence.length + 1 }, 'offset')).toThrow('Offset exceeds');
    const other = await reopened.store.create('Other task', [], reopened.compositionId);
    expect(() => internalAction(other, other.tasks[other.id], 'read_tool_result', { messageIndex: 2, offset: 0 }, 'isolated')).toThrow('does not exist');
    task.contextState = { kind: 'checkpoint', checkpoint: { through: task.messages.length, text: 'Evidence saved.' } };
    expect(JSON.parse(internalAction(saved, task, 'read_tool_result', { callId: 'evidence', offset: 0 }, 'stable')).content).toBe(first.content);
    expect(() => internalAction(other, other.tasks[other.id], 'read_tool_result', { callId: 'evidence', offset: 0 }, 'isolated-call')).toThrow('missing or ambiguous');
    expect(() => validateInternal('read_tool_result', { messageIndex: 2, callId: 'evidence' })).toThrow('exactly one');
    task.messages.push(structuredClone(task.messages[2]));
    expect(() => internalAction(saved, task, 'read_tool_result', { callId: 'evidence', offset: 0 }, 'duplicate')).toThrow('ambiguous');
    expect(read).toHaveBeenCalledOnce();
});

it.each([{ suffix: [0xff] }, { suffix: [0xe2, 0x82] }, { suffix: [0xc0, 0xaf] }])('rejects malformed UTF-8 at EOF rather than returning a shortened success: $suffix', async ({ suffix }) => {
    const { codingTools } = await import('../src/standalone/coding.js');
    const { writeFile } = await import('node:fs/promises');
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-')); paths.push(path);
    await writeFile(join(path, 'invalid'), Buffer.concat([Buffer.from('valid prefix'), Buffer.from(suffix)]));
    const read = (codingTools(path, join(path, 'outputs'), true)).find(tool => tool.definition.name === 'fs_read')!;
    for (const mode of ['lines', 'bytes']) expect(await read.execute({ path: 'invalid', mode }, new AbortController().signal)).toMatchObject({ ok: false });
});


it.each([0, -1, 1.5, NaN, Infinity, 2147453648])('rejects invalid model timeout %s before opening resources', async modelTimeoutMs => {
    await expect(StandaloneHarness.open({ dataDir: '/unused', provider: model(async () => reply('unused')), modelTimeoutMs })).rejects.toThrow('modelTimeoutMs');
});
it('derives queue headroom, records deadlines and runs tools in a separate queue step', async () => {
    const turn = vi.fn(async (request: TurnRequest) => request.messages.some(m => m.role === 'tool_result') ? reply('done') : reply('', [tool('save_progress', { notes: 'saved' })]));
    const h = await open(model(turn));
    const bump = vi.spyOn(h.app.make('IQueue'), 'bump');
    const tree = await h.create('deadline metadata');
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('completed'));
    const timeouts = bump.mock.calls.map(call => call[4]?.executionTimeoutMs);
    expect(timeouts).toContain(330000);
    expect(timeouts).toContain(120000);
    const data = (await h.store.events(tree.id)).find(event => event.type === 'model.intent')!.data as { deadline: number; modelTimeoutMs: number; intent: { startedAt: number } };
    expect(data.modelTimeoutMs).toBe(300000);
    expect(data.deadline - data.intent.startedAt).toBeGreaterThan(290000);
    expect(data.deadline - data.intent.startedAt).toBeLessThanOrEqual(300000);
});
it('aborts at the configured model deadline and never replays the uncertain call on reopen', async () => {
    const turn = vi.fn(async (_request: TurnRequest, options: Parameters<ILLMProvider['turn']>[1]) => new Promise<never>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    }));
    const first = await open(model(turn), undefined, { modelTimeoutMs: 100 });
    const tree = await first.create('timeout');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('unknown'));
    const events = await first.store.events(tree.id);
    expect(events.find(event => event.type === 'model.receipt')!.data).toMatchObject({ outcome: 'aborted', dispatched: true, failure: { kind: 'abort' } });
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    const second = await open(model(turn), first.options.dataDir, { modelTimeoutMs: 100 });
    await second.reconcile();
    expect(turn).toHaveBeenCalledOnce();
});
it('caps a live model call by tree expiry and records its receipt without completing expired work', async () => {
    let actualDeadline = 0;
    const h = await open(model(async (_request, options) => {
        actualDeadline = options!.deadline!;
        return new Promise<never>((_resolve, reject) => options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true }));
    }));
    const expiresAt = Date.now() + 300;
    const tree = await h.create('expire', { expiresAt });
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('cancelled'));
    expect(actualDeadline).toBe(expiresAt);
    expect((await h.store.events(tree.id)).find(event => event.type === 'model.receipt')!.data).toMatchObject({ outcome: 'aborted' });
});
it('aborts an in-flight tool at tree expiry', async () => {
    let aborted = false;
    const h = await open(model(async () => reply('', [tool('slow_read', {})])), undefined, { tools: [{ effect: 'read',
        definition: { name: 'slow_read', description: 'Slow read', parameters: { type: 'object' } }, validate: args => args,
        execute: async (_args, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true })),
    }] });
    const tree = await h.create('expire tool', { expiresAt: Date.now() + 400 });
    await state(h, tree.id, t => expect(t.tasks[t.id].phase).toBe('cancelled'));
    expect(aborted).toBe(true);
    expect((await h.store.events(tree.id)).some(event => event.type === 'tool.receipt')).toBe(true);
});

it('refuses a timeout-policy change for a persisted active composition', async () => {
    const provider = model(async () => reply('', [tool('schedule_self', { delaySeconds: 3600, reason: 'persist' })]));
    const first = await open(provider, undefined, { modelTimeoutMs: 1000 });
    const tree = await first.create('sleep');
    await state(first, tree.id, t => expect(t.tasks[t.id].phase).toBe('sleeping'));
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    await expect(StandaloneHarness.open({ ...first.options, modelTimeoutMs: 2000 })).rejects.toThrow('original composition');
    const second = await open(provider, first.options.dataDir, { modelTimeoutMs: 1000 });
    expect((await second.store.get(tree.id))!.tasks[tree.id].phase).toBe('sleeping');
});


it('honors requested byte limits and continues across UTF-8 boundaries', async () => {
    const { codingTools } = await import('../src/standalone/coding.js');
    const { writeFile } = await import('node:fs/promises');
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-')); paths.push(path);
    await writeFile(join(path, 'text'), 'abc😀tail');
    const read = (codingTools(path, join(path, 'outputs'), true)).find(tool => tool.definition.name === 'fs_read')!;
    const signal = new AbortController().signal;
    const first = JSON.parse((await read.execute(read.validate({ mode: 'bytes', path: 'text', limit: 5 }), signal)).content);
    expect(first).toMatchObject({ content: 'abc', bytesRead: 3, nextOffset: 3, eof: false });
    const second = JSON.parse((await read.execute(read.validate({ mode: 'bytes', path: 'text', offset: first.nextOffset, limit: 4 }), signal)).content);
    expect(second).toMatchObject({ content: '😀', bytesRead: 4, nextOffset: 7, eof: false });
    const last = JSON.parse((await read.execute(read.validate({ mode: 'bytes', path: 'text', offset: second.nextOffset, limit: 4 }), signal)).content);
    expect(last).toMatchObject({ content: 'tail', bytesRead: 4, nextOffset: 11, eof: true });
    expect(await read.execute(read.validate({ mode: 'bytes', path: 'text', offset: 3, limit: 1 }), signal)).toMatchObject({ ok: false, content: expect.stringContaining('increase limit') });
    for (const limit of [0, -1, 1.5, 16001]) expect(() => read.validate({ mode: 'bytes', path: 'text', limit })).toThrow();
    expect(JSON.parse((await read.execute(read.validate({ mode: 'bytes', path: 'text' }), signal)).content)).toMatchObject({ content: 'abc😀tail', eof: true });
});

it('presents recent diagnostics within context while retaining exact retrievable evidence', async () => {
    const diagnostic = 'Assertion failed at test.ts:12\n' + 'x'.repeat(37000) + '\nExit code: 1';
    let turn = 0;
    const h = await open(model(async request => {
        if (turn++ === 0) return reply('', [tool('diagnostic', {})]);
        if (turn === 2) {
            const result = request.messages.find(m => m.role === 'tool_result' && m.toolName === 'diagnostic')!;
            expect(result.content.length).toBeLessThanOrEqual(4000);
            expect(result.content).toContain('Assertion failed at test.ts:12');
            expect(result.content).toContain('Exit code: 1');
            expect(result.content).toContain('read_tool_result');
            expect(result).toMatchObject({ isError: true });
            return reply('', [tool('read_tool_result', { messageIndex: 2, offset: 30000 })]);
        }
        const recovered = request.messages.find(m => m.role === 'tool_result' && m.toolName === 'read_tool_result')!;
        expect(JSON.parse(recovered.content).content).toBe(diagnostic.slice(30000, 38000));
        return reply('diagnostic recovered');
    }), undefined, { contextTokens: 8000, tools: [{
        definition: { name: 'diagnostic', description: 'Return test failure evidence', parameters: { type: 'object', properties: {} } },
        effect: 'read', validate: args => args,
        execute: async () => ({ ok: false, errorKind: 'runtime', content: diagnostic }),
    }] });
    const tree = await h.create('repair');
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    const snapshot = await h.inspect(tree.id);
    expect(snapshot.state.tasks[tree.id].messages[2].content).toBe(diagnostic);
    expect(JSON.stringify(snapshot.events.filter(e => e.type === 'model.intent'))).toContain('originalCharacters');
});

it('retrieves spilled coding output after reopen without projecting the retrieval or rerunning the command', async () => {
    const { codingToolRuntime } = await import('@nucleic-se/agentic/harness');
    const { writeFile, readFile } = await import('node:fs/promises');
    const workspace = await mkdtemp(join(tmpdir(), 'gears-output-')); paths.push(workspace);
    const source = 'a'.repeat(70000) + '"'.repeat(4000);
    await writeFile(join(workspace, 'run.cjs'), `require('node:fs').appendFileSync('runs','1'); process.stdout.write(${JSON.stringify(source)});`);
    const makeTools = () => {
        const runtime = codingToolRuntime(workspace, { outputDirectory: join(workspace, 'output') });
        return runtime.tools().filter(t => ['shell_run', 'read_output'].includes(t.name)).map(definition => ({
            definition, effect: definition.name === 'read_output' ? 'read' as const : 'write' as const,
            validate(args: Record<string, unknown>) { const checked = runtime.validate(definition.name, args); if (!checked.ok) throw new Error(checked.result.content); return checked.args; },
            execute: (args: Record<string, unknown>, signal: AbortSignal) => runtime.call(definition.name, args, { signal, authorizedArgs: args }),
        }));
    };
    let outputId = '', turn = 0;
    const provider = model(async request => {
        if (turn++ === 0) return reply('', [tool('shell_run', { command: 'node run.cjs' })]);
        if (turn === 2) {
            const output = request.messages.find(m => m.role === 'tool_result' && m.toolName === 'shell_run')!;
            outputId = output.content.match(/"id":"([^"]+)"/)![1];
            return reply('saved output');
        }
        if (turn === 3) return reply('', [tool('read_output', { id: outputId, offset: 70000 })]);
        const output = request.messages.filter(m => m.role === 'tool_result' && m.toolName === 'read_output').at(-1)!;
        expect(JSON.parse(output.content)).toMatchObject({ content: '"'.repeat(4000), eof: true });
        return reply('retrieved exact output');
    });
    const first = await open(provider, undefined, { tools: makeTools(), composition: 'output-recovery-test' });
    const tree = await first.create('run');
    await state(first, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    const second = await open(provider, first.options.dataDir, { tools: makeTools(), composition: 'output-recovery-test' });
    await second.send(tree.id, tree.id, 'retrieve');
    await state(second, tree.id, current => expect(current.tasks[tree.id].answer).toBe('retrieved exact output'));
    expect(await readFile(join(workspace, 'runs'), 'utf8')).toBe('1');
});

it.each([false, true])('journals automatic checkpoints atomically (partial=%s)', async partial => {
    const { internalDefinitions } = await import('../src/standalone/tools.js');
    let maintenanceCalls = 0;
    const h = await open(model(async request => {
        if (/^(Maintain a concise working checkpoint|Repair a rejected working checkpoint)/.test(request.system ?? '')) {
            maintenanceCalls++;
            expect(request.tools).toEqual([]);
            expect(request.messages[0].content).toContain('recorded detail');
            return { ...reply('Completed inspections are recorded. Continue remaining work.'), stopReason: partial ? 'max_tokens' : 'end_turn' };
        }
        expect(request.messages.some(m => m.content.startsWith('Working checkpoint'))).toBe(true);
        return reply('done');
    }), undefined, { contextTokens: 2000, outputTokens: 64 });
    const tree = await h.store.create('audit', internalDefinitions.map(t => t.name), h.compositionId);
    await h.store.change(tree.id, 'fixture.history', current => {
        const task = current.tasks[tree.id];
        task.messages.push(...Array.from({ length: 20 }, (_, index) => ({ role: 'assistant' as const, content: `recorded detail ${index}: ${'evidence '.repeat(28)}` })), { role: 'user', provenance: 'human', content: 'Finish the remaining audit.' });
        task.notes = 'Existing notes';
    });
    const original = structuredClone((await h.store.get(tree.id))!.tasks[tree.id].messages);
    await h.reconcile();
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe(partial ? 'failed' : 'completed'));
    const saved = (await h.store.get(tree.id))!;
    expect(maintenanceCalls).toBeGreaterThan(0);
    expect(saved.tasks[tree.id].messages.slice(0, original.length)).toEqual(original);
    expect(saved.usage.inputTokens).toBeGreaterThan(0);
    if (partial) {
        expect(contextState(saved.tasks[tree.id]).checkpoint).toBeUndefined();
        expect(saved.tasks[tree.id].notes).toBe('Existing notes');
    } else {
        const checkpoint = contextState(saved.tasks[tree.id]).checkpoint;
        expect(checkpoint?.through).toBeGreaterThan(0);
        const events = await h.store.events(tree.id, 0);
        expect(events.some(e => e.type === 'model.intent' && (e.data as { purpose?: string }).purpose === 'context')).toBe(true);
        await h.close(); hosts.splice(hosts.indexOf(h), 1);
        const reopened = await open(h.options.provider, h.options.dataDir, { contextTokens: 2000, outputTokens: 64 });
        expect(contextState((await reopened.store.get(tree.id))!.tasks[tree.id]).checkpoint).toEqual(checkpoint);
    }
});

it('checkpoints at the reported context threshold before dropping or shortening history', async () => {
    const { budgetedContext } = await import('@nucleic-se/agentic/harness');
    const { internalDefinitions } = await import('../src/standalone/tools.js');
    const context = budgetedContext('', 6000, { minRecentGroups: 3 });
    let inspected = false, maintenance = 0;
    const h = await open(model(async request => {
        if (/^(Maintain a concise working checkpoint|Repair a rejected working checkpoint)/.test(request.system ?? '')) {
            maintenance++;
            expect(request.messages[0].content).toContain('recorded detail');
            return reply('Earlier observations preserved. Finish the audit.');
        }
        expect(request.messages.some(m => m.content.startsWith('Working checkpoint'))).toBe(true);
        return reply('done');
    }), undefined, { contextTokens: 6000, outputTokens: 64, composition: 'early-checkpoint-test', context: {
        lifecycle: checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8 }),
        async assemble(messages, signal, options) {
            const selected = await context.assemble(messages, signal, options);
            if (!inspected && options?.system?.startsWith('You are a standalone')) {
                inspected = true;
                expect(selected.report!.tokenBudget).toBe(6000);
                expect(selected.report!.usage.totalTokens).toBeGreaterThanOrEqual(4800);
                expect(selected.report!.decisions.every(d => d.action === 'kept')).toBe(true);
            }
            return selected;
        },
    } });
    const tree = await h.store.create('audit', internalDefinitions.map(t => t.name), h.compositionId);
    await h.store.change(tree.id, 'fixture.history', current => {
        current.tasks[tree.id].messages.push(...Array.from({ length: 14 }, () => ({ role: 'assistant' as const, content: 'recorded detail'.padEnd(1100, 'x') })));
    });
    const original = structuredClone((await h.store.get(tree.id))!.tasks[tree.id].messages);
    await h.reconcile();
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    expect(maintenance).toBe(1);
    expect((await h.store.get(tree.id))!.tasks[tree.id].messages.slice(0, original.length)).toEqual(original);
});

it('preserves rich tool results in the next request and after reopening', async () => {
    const blocks = [{ type: 'text' as const, text: 'Visible detail' }, { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' }];
    let calls = 0;
    const provider = model(async request => {
        if (calls++ === 0) return reply('', [tool('image_evidence', {})]);
        expect(request.messages.find(m => m.role === 'tool_result' && m.toolName === 'image_evidence')).toMatchObject({ contentBlocks: blocks });
        return reply('Image received');
    });
    const h = await open(provider, undefined, { tools: [{ definition: { name: 'image_evidence', description: 'Read image evidence', parameters: { type: 'object', properties: {} } }, effect: 'read', validate: args => args,
        execute: async () => ({ ok: true, content: 'Image attached', contentBlocks: blocks }) }] });
    const tree = await h.create('Read the image');
    await state(h, tree.id, current => expect(current.tasks[tree.id].answer).toBe('Image received'));
    const expected = structuredClone(blocks);
    blocks[0].text = 'Changed external buffer';
    await h.close(); hosts.splice(hosts.indexOf(h), 1);
    const reopened = await open(provider, h.options.dataDir, h.options);
    const saved = (await reopened.store.get(tree.id))!.tasks[tree.id];
    expect(saved.messages.find(m => m.role === 'tool_result' && m.toolName === 'image_evidence')).toMatchObject({ contentBlocks: expected });
});

it.each([false, true])('continues a persisted partial source checkpoint atomically (incomplete response=%s)', async incomplete => {
    const giant = 'saved evidence '.repeat(8000);
    let chunks = 0;
    const provider = model(async request => {
        if (/^(Maintain a concise working checkpoint|Repair a rejected working checkpoint)/.test(request.system ?? '')) {
            const evidence = JSON.parse(request.messages[0].content);
            if (evidence.sourceChunk) {
                chunks++;
                expect(evidence.sourceChunk.offset).toBeGreaterThanOrEqual(20);
                expect(evidence.sourceChunk.endOffset).toBeGreaterThan(evidence.sourceChunk.offset);
            }
            return { ...reply('Covered evidence is retained.'), stopReason: incomplete ? 'max_tokens' : 'end_turn' };
        }
        return reply('done');
    });
    const first = await open(provider, undefined, { contextTokens: 4000, outputTokens: 64 });
    const tree = await first.store.create('Task', ['read_tool_result'], first.compositionId);
    await first.store.change(tree.id, 'fixture.partial', current => {
        const task = current.tasks[tree.id];
        task.messages.push({ role: 'assistant', content: '', toolCalls: [tool('read', {}, 'large')] }, { role: 'tool_result', toolName: 'read', toolCallId: 'large', content: giant });
        task.contextState = { kind: 'checkpoint', checkpoint: { through: 1, text: 'First source fragment covered.', partial: { end: 3, offset: 20 } } };
        task.notes = 'Preserve these notes';
        task.phase = 'completed';
    });
    const before = (await first.store.get(tree.id))!.tasks[tree.id];
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    const reopened = await open(provider, first.options.dataDir, first.options);
    await reopened.send(tree.id, tree.id, 'Finish using saved evidence');
    await state(reopened, tree.id, current => expect(current.tasks[tree.id].phase).toBe(incomplete ? 'failed' : 'completed'));
    const after = (await reopened.store.get(tree.id))!.tasks[tree.id];
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
    expect(chunks).toBeGreaterThan(0);
    if (incomplete) {
        expect(contextState(after).checkpoint).toEqual(contextState(before).checkpoint);
        expect(after.notes).toBe(before.notes);
    } else {
        expect(contextState(after).checkpoint!.through).toBeGreaterThanOrEqual(3);
        expect(contextState(after).checkpoint!.partial).toBeUndefined();
    }
    const intents = (await reopened.store.events(tree.id, 0)).filter(e => e.type === 'model.intent');
    expect(JSON.stringify(intents)).toContain('endOffset');
});

it.each([false, true])('bounds rejected checkpoint retries and preserves source history (always reject=%s)', async alwaysReject => {
    const { internalDefinitions } = await import('../src/standalone/tools.js');
    let rejected = false;
    let retries = 0;
    const h = await open(model(async request => {
        if (!/^(Maintain a concise working checkpoint|Repair a rejected working checkpoint)/.test(request.system ?? '')) return reply('done');
        const evidence = JSON.parse(request.messages[0].content);
        expect(evidence.output.targetTokens).toBe(evidence.rejectedDraft ? 32 : 64);
        if (evidence.rejectedDraft) {
            expect(evidence.rejectedDraft).toBe('too_large');
            expect(evidence.draft).toBe('x'.repeat(8591));
            expect(evidence.sources).toBeUndefined();
            retries++;
        }
        if (!rejected || alwaysReject) { rejected = true; return reply('x'.repeat(8591)); }
        return reply('Inspections recorded. Verification remains unfinished.');
    }), undefined, { contextTokens: 3000, outputTokens: 64 });
    const tree = await h.store.create('audit', internalDefinitions.map(t => t.name), h.compositionId);
    await h.store.change(tree.id, 'fixture.history', current => {
        const task = current.tasks[tree.id];
        task.messages.push(...Array.from({ length: 40 }, (_, index) => ({ role: 'assistant' as const, content: `recorded detail ${index}: ${'evidence '.repeat(28)}` })), { role: 'user', content: 'Finish the audit.' });
        task.contextState = { kind: 'checkpoint', checkpoint: { through: 1, text: 'Prior valid checkpoint' } };
        task.notes = 'Verification remains unfinished';
    });
    const original = structuredClone((await h.store.get(tree.id))!.tasks[tree.id]);
    await h.reconcile();
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe(alwaysReject ? 'failed' : 'completed'));
    const saved = (await h.store.get(tree.id))!;
    expect(retries).toBe(1);
    expect(saved.tasks[tree.id].messages.slice(0, original.messages.length)).toEqual(original.messages);
    const events = await h.store.events(tree.id, 0);
    const decisions = events.filter(e => e.type === 'model.receipt').map(e => (e.data as { contextDecision?: { accepted: boolean; attempt?: number } }).contextDecision).filter(Boolean);
    expect(decisions[0]).toEqual({ pending: true, attempt: 1 });
    expect(saved.usage.inputTokens).toBe(saved.modelCalls * 100);
    if (alwaysReject) {
        expect(saved.modelCalls).toBe(2);
        expect(contextState(saved.tasks[tree.id]).checkpoint).toEqual(contextState(original).checkpoint);
        expect(saved.tasks[tree.id].notes).toBe(original.notes);
        expect(saved.tasks[tree.id].error).toContain('after two attempts');
        expect(decisions[1]).toEqual({ pending: true, attempt: 2 });
    } else expect(contextState(saved.tasks[tree.id]).rejected).toBeUndefined();
});

it('retains a complete checkpoint candidate across reopen without renewing its retry allowance', async () => {
    const { internalDefinitions } = await import('../src/standalone/tools.js');
    let calls = 0;
    const provider = model(async request => {
        expect(request.system).toContain(calls ? 'Repair a rejected working checkpoint' : 'Maintain a concise working checkpoint');
        const input = JSON.parse(request.messages[0].content);
        expect(input.rejectedDraft).toBe(calls++ ? 'too_large' : undefined);
        if (calls === 2) expect(input.draft).toBe('x'.repeat(8591));
        return reply('x'.repeat(8591));
    });
    const options = { contextTokens: 3000, outputTokens: 64 };
    const h = await open(provider, undefined, options);
    // Pause at the committed candidate boundary, before another worker turn can start.
    const change = h.store.change.bind(h.store);
    const stopAtBoundary = vi.spyOn(h.store, 'change').mockImplementation((id, type, update, taskId, data) =>
        change(id, type, current => {
            update(current);
            if (type === 'model.receipt' && taskId && contextState(current.tasks[taskId]).candidate)
                current.tasks[taskId].phase = 'paused';
        }, taskId, data));
    const tree = await h.store.create('audit', internalDefinitions.map(t => t.name), h.compositionId);
    await h.store.change(tree.id, 'fixture.history', current => {
        current.tasks[tree.id].messages.push(...Array.from({ length: 40 }, (_, index) => ({ role: 'assistant' as const, content: `recorded detail ${index}: ${'evidence '.repeat(28)}` })));
        current.tasks[tree.id].contextState = { kind: 'checkpoint', checkpoint: { through: 1, text: 'Original checkpoint' } };
    });
    await h.reconcile();
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('paused'));
    const before = (await h.store.get(tree.id))!;
    expect(contextState(before.tasks[tree.id]).candidate).toMatchObject({ text: 'x'.repeat(8591), attempt: 1 });
    expect(calls).toBe(1);
    stopAtBoundary.mockRestore();
    await h.close(); hosts.splice(hosts.indexOf(h), 1);
    const reopened = await open(provider, h.options.dataDir, options);
    expect(contextState((await reopened.store.get(tree.id))!.tasks[tree.id]).candidate).toEqual(contextState(before.tasks[tree.id]).candidate);
    await reopened.send(tree.id, tree.id, 'Continue');
    await state(reopened, tree.id, current => expect(current.tasks[tree.id].phase).toBe('failed'));
    const after = (await reopened.store.get(tree.id))!;
    expect(calls).toBe(2);
    expect(contextState(after.tasks[tree.id]).checkpoint).toEqual(contextState(before.tasks[tree.id]).checkpoint);
    expect(after.tasks[tree.id].messages.slice(0, before.tasks[tree.id].messages.length)).toEqual(before.tasks[tree.id].messages);
    expect(after.tasks[tree.id].error).toContain('after two attempts');
    expect(after.modelCalls).toBe(2);
});

it('replaces generated checkpoints with direct source selection without queued driver changes', async () => {
    let calls = 0;
    const context = { ...budgetedContext('', 3000), lifecycle: {
        async prepare(input: import('@nucleic-se/agentic/harness').ContextLifecycleInput, execution: import('@nucleic-se/agentic/harness').ContextPreparation) {
            const step = await referenceContextLifecycle().prepare(input, execution);
            return { ...step, reduce: () => ({ state: { observed: true }, decision: 'recorded with task receipt' }) };
        },
    } };
    const provider = model(async request => {
        calls++;
        expect(request.messages.some(m => m.content.startsWith('Working checkpoint'))).toBe(false);
        expect(request.messages.some(m => m.content === 'Do not release before security verification.')).toBe(true);
        expect(request.messages.at(-1)?.content).toContain('Current harness state');
        return reply('Security verification remains unfinished.');
    });
    const h = await open(provider, undefined, { context, composition: 'direct-context-test', outputTokens: 64 });
    const tree = await h.store.create('Do not release before security verification.', [], h.compositionId);
    await h.store.change(tree.id, 'fixture.history', current => {
        current.tasks[tree.id].messages.push(...Array.from({ length: 40 }, (_, i) => ({ role: 'assistant' as const, content: `Evidence ${i}: ${'detail '.repeat(80)}` })));
    });
    const original = structuredClone((await h.store.get(tree.id))!.tasks[tree.id].messages);
    await h.reconcile();
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    expect(calls).toBe(1);
    expect((await h.store.get(tree.id))!.tasks[tree.id].messages.slice(0, original.length)).toEqual(original);
    await h.close(); hosts.splice(hosts.indexOf(h), 1);
    const reopened = await open(provider, h.options.dataDir, { context, composition: 'direct-context-test', outputTokens: 64 });
    expect((await reopened.store.get(tree.id))!.tasks[tree.id].contextState).toEqual({ observed: true });
    expect((await reopened.store.get(tree.id))!.tasks[tree.id].messages.slice(0, original.length)).toEqual(original);
});

it('records the charged provider receipt when a context reducer fails', async () => {
    const h = await open(model(async () => reply('derived')), undefined, {
        composition: 'bad-context-reducer', outputTokens: 64, context: { ...budgetedContext('', 3000), lifecycle: {
            async prepare(input, execution) {
                return { kind: 'maintenance', prepared: await execution.prepareModel({ messages: [], system: 'derive', maxTokens: 64 }),
                    metadata: { purpose: 'test' }, reduce() { throw new Error('Reducer failed'); } };
            },
        } },
    });
    const tree = await h.create('Inspect sources', { modelCalls: 2, tokens: 10000 });
    await state(h, tree.id, current => expect(current.tasks[tree.id].phase).toBe('failed'));
    const saved = (await h.store.get(tree.id))!;
    expect(saved.tasks[tree.id].error).toBe('Reducer failed');
    expect(saved.usage.inputTokens).toBe(100);
    expect(saved.chargedTokens).toBe(120);
    expect(saved.tasks[tree.id].contextState).toBeUndefined();
    expect((await h.store.events(tree.id, 0)).some(e => e.type === 'model.receipt')).toBe(true);
});

it('admits a fitting persisted checkpoint candidate without maintenance in the queued host', async () => {
    const { internalDefinitions } = await import('../src/standalone/tools.js');
    const draft = 'Verified observation. '.repeat(450);
    let calls = 0;
    const provider = model(async request => {
        calls++;
        expect(request.system).not.toMatch(/^(Maintain|Repair)/);
        expect(request.messages.some(m => m.content.endsWith(draft.trim()))).toBe(true);
        expect(request.messages.some(m => m.content === 'Keep the original task intent.')).toBe(true);
        return reply('done');
    });
    const options = { contextTokens: 16000, outputTokens: 64 };
    const h = await open(provider, undefined, options);
    const tree = await h.store.create('Keep the original task intent.', internalDefinitions.map(t => t.name), h.compositionId);
    await h.store.change(tree.id, 'fixture.candidate', current => {
        const task = current.tasks[tree.id];
        task.messages.push({ role: 'assistant', content: 'Original source evidence.' });
        task.contextState = { kind: 'checkpoint', checkpoint: { through: 1, text: 'Prior evidence.' }, candidate: {
            through: task.messages.length, text: draft.trim(), sourceRange: { start: 1, end: task.messages.length }, attempt: 1,
        } };
    });
    const original = (await h.store.get(tree.id))!.tasks[tree.id].messages;
    await h.close(); hosts.splice(hosts.indexOf(h), 1);
    const reopened = await open(provider, h.options.dataDir, options);
    await reopened.reconcile();
    await state(reopened, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    const saved = (await reopened.store.get(tree.id))!;
    expect(calls).toBe(1);
    expect(saved.usage.inputTokens).toBe(100);
    expect(contextState(saved.tasks[tree.id]).checkpoint?.text).toBe(draft.trim());
    expect(contextState(saved.tasks[tree.id]).candidate).toBeUndefined();
    expect(saved.tasks[tree.id].messages.slice(0, original.length)).toEqual(original);
    const receipts = (await reopened.store.events(tree.id)).filter(e => e.type === 'model.receipt');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].data).toHaveProperty('contextDecision.accepted', true);
});

it('uses structured checkpoint formats without tool dispatch and restores their state after reopening', async () => {
    const context = { ...budgetedContext('', 3000), lifecycle: checkpointContextLifecycle({ maxTokens: 64, triggerRatio: 0.8, format: {
        instructions: 'Return checkpoint_state with remaining work.',
        tools: [{ name: 'checkpoint_state', description: '', parameters: { type: 'object' as const, properties: { remaining: { type: 'string' as const } }, required: ['remaining'], additionalProperties: false } }],
        decode(response) {
            const calls = response.message.toolCalls ?? [];
            return calls.length === 1 && calls[0].name === 'checkpoint_state' && typeof calls[0].args.remaining === 'string'
                ? { ok: true, text: JSON.stringify(calls[0].args) } : { ok: false, reason: 'invalid_format' };
        },
    } }) };
    const provider = model(async request => {
        if (request.tools?.some(tool => tool.name === 'checkpoint_state'))
            return reply('', [tool('checkpoint_state', { remaining: 'Security verification.' }, 'derived-state')]);
        expect(request.messages.some(message => message.content.includes('"remaining":"Security verification."'))).toBe(true);
        expect(request.messages.some(message => message.content === 'Do not release before security verification.')).toBe(true);
        return reply('Security verification remains unfinished.');
    });
    const options = { context, composition: 'structured-checkpoint-test', outputTokens: 64 };
    const host = await open(provider, undefined, options);
    const tree = await host.store.create('Do not release before security verification.', [], host.compositionId);
    await host.store.change(tree.id, 'fixture.history', current => {
        current.tasks[tree.id].messages.push(...Array.from({ length: 40 }, (_, i) => ({ role: 'assistant' as const, content: `Evidence ${i}: ${'detail '.repeat(45)}` })));
    });
    const original = structuredClone((await host.store.get(tree.id))!.tasks[tree.id].messages);
    await host.reconcile();
    await state(host, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    const saved = (await host.store.get(tree.id))!;
    expect(JSON.parse(contextState(saved.tasks[tree.id]).checkpoint!.text)).toEqual({ remaining: 'Security verification.' });
    expect(saved.tasks[tree.id].messages.slice(0, original.length)).toEqual(original);
    expect(saved.tasks[tree.id].messages.some(message => message.role === 'assistant' && message.toolCalls?.some(call => call.name === 'checkpoint_state'))).toBe(false);
    const events = await host.store.events(tree.id);
    expect(events.some(event => event.type === 'tool.intent')).toBe(false);
    expect(events.filter(event => event.type === 'model.receipt')).toHaveLength(2);
    expect(saved.modelCalls).toBe(2);
    await host.close(); hosts.splice(hosts.indexOf(host), 1);
    const reopened = await open(provider, host.options.dataDir, options);
    expect(contextState((await reopened.store.get(tree.id))!.tasks[tree.id])).toEqual(contextState(saved.tasks[tree.id]));
});

it('uses the configured root allowance across continuation and reopen without resetting shared usage', async () => {
    let calls = 0;
    const provider = model(async () => ++calls <= 30
        ? reply('', [tool('save_progress', { notes: `Step ${calls} inspected.` }, `progress-${calls}`)])
        : reply('Review stage complete.'));
    const options = { checkpointing: false, contextTokens: 64000 };
    const first = await open(provider, undefined, options);
    const tree = await first.create('Review in stages.', { modelCalls: 32, tokens: 1000000 });
    expect(tree.tasks[tree.id].maxCalls).toBe(32);
    await state(first, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    expect(calls).toBe(31);
    await first.close(); hosts.splice(hosts.indexOf(first), 1);
    const reopened = await open(provider, first.options.dataDir, options);
    await reopened.send(tree.id, tree.id, 'Continue the review.');
    await state(reopened, tree.id, current => expect(current.tasks[tree.id].phase).toBe('completed'));
    expect(calls).toBe(32);
    expect((await reopened.store.get(tree.id))!.modelCalls).toBe(32);
    await reopened.send(tree.id, tree.id, 'Another stage.');
    await state(reopened, tree.id, current => expect(current.tasks[tree.id].phase).toBe('failed'));
    expect((await reopened.store.get(tree.id))!.tasks[tree.id].error).toBe('Shared model-call budget exhausted');
    expect(calls).toBe(32);
});

it('commits an invalid read receipt and still executes an independent source read', async () => {
    const { codingToolRuntime } = await import('@nucleic-se/agentic/harness');
    const { runtimeTools } = await import('../src/standalone/coding.js');
    const { writeFile } = await import('node:fs/promises');
    const workspace = await mkdtemp(join(tmpdir(), 'read-recovery-')); paths.push(workspace);
    await writeFile(join(workspace, 'source'), 'verified evidence');
    const coding = runtimeTools(codingToolRuntime(workspace, { readOnly: true }), () => 'read');
    let turns = 0;
    const h = await open(model(async request => {
        if (!turns++) return reply('', [
            tool('search_grep', { pattern: 'x', max_results: 150 }, 'bad'),
            tool('fs_read', { path: 'source' }, 'good'),
        ]);
        const results = request.messages.filter(m => m.role === 'tool_result');
        expect(results).toHaveLength(2);
        expect(results[0]).toMatchObject({ toolCallId: 'bad', isError: true });
        expect(results[1].content).toContain('verified evidence');
        return reply('done');
    }), undefined, { tools: coding });
    const tree = await h.create('Read the source');
    await state(h, tree.id, t => expect(t.tasks[tree.id].phase).toBe('completed'));
    const events = await h.store.events(tree.id);
    const intents = events.filter(e => e.type === 'tool.intent');
    expect(intents).toHaveLength(1);
    expect(JSON.stringify(intents[0])).toContain('good');
    expect(turns).toBe(2);
});
