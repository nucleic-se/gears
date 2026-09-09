import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LLMProtocolError, type ILLMProvider, type TurnResponse, type ToolCall } from '@nucleic-se/agentic/llm';
import { StandaloneHarness, type HarnessOptions } from '../src/standalone/host.js';
import { attachWeb } from '../src/standalone/web.js';
import type { Phase, Tree } from '../src/standalone/state.js';

const hosts: StandaloneHarness[] = [], paths: string[] = [];
afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
const reply = (content: string, toolCalls?: ToolCall[]): TurnResponse => ({
    message: { role: 'assistant', content, ...(toolCalls ? { toolCalls } : {}) },
    stopReason: toolCalls?.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2 },
});
const provider = (turn: ILLMProvider['turn']): ILLMProvider => ({ configurationIdentity: 'recovery-test', turn, structured: vi.fn() });
async function open(model: ILLMProvider, options: Partial<HarnessOptions> = {}) {
    const dataDir = options.dataDir ?? await mkdtemp(join(tmpdir(), 'model-recovery-'));
    if (!paths.includes(dataDir)) paths.push(dataDir);
    const host = await StandaloneHarness.open({ contextTokens: 16000, rootTools: [], ...options, dataDir, provider: model });
    hosts.push(host); return host;
}
async function settled(host: StandaloneHarness, id: string, phase: Phase, taskId = id): Promise<Tree> {
    await vi.waitFor(async () => {
        expect((await host.store.get(id))!.tasks[taskId].phase).toBe(phase);
        expect((await host.app.make('IQueue').stats()).overview.processing).toBe(0);
    });
    return (await host.store.get(id))!;
}
async function acknowledge(host: StandaloneHarness, tree: Tree, taskId = tree.id) {
    return host.acknowledgeModel(tree.id, taskId, tree.tasks[taskId].operationId!, tree.revision);
}

it.each([false, true])('continues known tool history after unknown model output, known usage=%s', async knownUsage => {
    let calls = 0;
    const execute = vi.fn(async () => ({ ok: true, content: 'Exact durable source result' }));
    const turn = vi.fn<ILLMProvider['turn']>(async request => {
        if (++calls === 1) return reply('', [{ id: 'read-once', name: 'read_test', args: {} }]);
        if (calls === 2) throw knownUsage ? new LLMProtocolError('Malformed response', { usage: { inputTokens: 20, outputTokens: 3 } }) : new Error('Connection lost');
        expect(request.messages.some(m => m.role === 'tool_result' && m.content === 'Exact durable source result')).toBe(true);
        expect(request.messages.some(m => m.role === 'user' && m.content === 'Continue from saved evidence')).toBe(true);
        return reply('Recovered');
    });
    const tools = [{ effect: 'read' as const, definition: { name: 'read_test', description: 'Read evidence', parameters: { type: 'object' as const } }, validate: (args: Record<string, unknown>) => args, execute }];
    const first = await open(provider(turn), { tools, rootTools: ['read_test'] });
    const created = await first.create('Review source');
    const stopped = await settled(first, created.id, 'unknown');
    const operationId = stopped.tasks[created.id].operationId!;
    expect(operationId).toBeTruthy(); expect(stopped.tasks[created.id].reservation).toBeUndefined();
    if (knownUsage) expect(stopped.chargedTokens).toBe(35);
    else expect(stopped.chargedTokens).toBeGreaterThan(12);
    await first.close();
    const host = await open(provider(turn), { dataDir: first.options.dataDir, tools, rootTools: ['read_test'] });
    expect(turn).toHaveBeenCalledTimes(2);
    const before = (await host.store.get(created.id))!;
    const paused = await acknowledge(host, before);
    expect(paused.tasks[created.id]).toMatchObject({ phase: 'paused', messages: before.tasks[created.id].messages });
    expect(paused.tasks[created.id].operationId).toBeUndefined();
    expect(paused.chargedTokens).toBe(before.chargedTokens); expect(paused.usage).toEqual(before.usage);
    expect(paused.modelCalls).toBe(before.modelCalls); expect(paused.tasks[created.id].calls).toBe(2);
    expect(turn).toHaveBeenCalledTimes(2);
    await expect(host.acknowledgeModel(created.id, created.id, operationId, paused.revision)).rejects.toThrow('not an unknown model');
    expect(await host.store.get(created.id)).toEqual(paused);
    await host.send(created.id, created.id, 'Continue from saved evidence');
    const done = await settled(host, created.id, 'completed');
    expect(done.chargedTokens).toBe(before.chargedTokens + 12); expect(done.modelCalls).toBe(3);
    expect(done.tasks[created.id].operationId).toBeUndefined(); expect(execute).toHaveBeenCalledOnce();
    const events = await host.store.events(created.id);
    const intents = events.filter(e => e.type === 'model.intent').map(e => (e.data as { intent: { operationId: string } }).intent.operationId);
    expect(new Set(intents).size).toBe(3);
    expect(events.find(e => e.type === 'model.acknowledged')?.data).toEqual({ operationId });
});

it('rejects stale revisions, wrong operations, changed composition and tool ambiguity without mutation', async () => {
    const host = await open(provider(async () => { throw new Error('lost'); }));
    const tree = await host.create('Stop'); const before = await settled(host, tree.id, 'unknown');
    await expect(host.acknowledgeModel(tree.id, tree.id, before.tasks[tree.id].operationId!, before.revision - 1)).rejects.toThrow('revision');
    await expect(host.acknowledgeModel(tree.id, tree.id, 'wrong', before.revision)).rejects.toThrow('not an unknown model');
    expect(await host.store.get(tree.id)).toEqual(before);
    for (const field of ['activeTool', 'pending'] as const) {
        const changed = await host.store.change(tree.id, 'fixture.tool-uncertainty', current => {
            const call = { id: 'effect', name: 'write_test', args: {} };
            if (field === 'activeTool') current.tasks[tree.id].activeTool = call;
            else current.tasks[tree.id].pending = [call];
        });
        await expect(acknowledge(host, changed)).rejects.toThrow('not an unknown model');
        expect(await host.store.get(tree.id)).toEqual(changed);
    }
    await host.close();
    const changed = await open({ ...provider(vi.fn()), configurationIdentity: 'other-model' }, { dataDir: host.options.dataDir });
    const stored = (await changed.store.get(tree.id))!;
    await expect(acknowledge(changed, stored)).rejects.toThrow('original composition');
    expect(await changed.store.get(tree.id)).toEqual(stored);
});

it.each(['cancelled', 'failed', 'expired'] as const)('does not acknowledge %s work', async condition => {
    const host = await open(provider(async () => { throw new Error('lost'); }));
    const tree = await host.create('Stop'); await settled(host, tree.id, 'unknown');
    const before = await host.store.change(tree.id, 'fixture.stopped', current => {
        if (condition === 'expired') current.limits.expiresAt = Date.now() - 1;
        else current.tasks[tree.id].phase = condition;
    });
    await expect(acknowledge(host, before)).rejects.toThrow(condition === 'expired' ? 'expired' : 'not an unknown model');
    expect(await host.store.get(tree.id)).toEqual(before);
});

it('keeps call and spending limits exhausted after acknowledgement', async () => {
    for (const limit of ['calls', 'tokens']) {
        const turn = vi.fn(async () => { throw new Error('lost'); });
        const host = await open(provider(turn));
        const tree = await host.create('Bounded work'); await settled(host, tree.id, 'unknown');
        const before = await host.store.change(tree.id, 'fixture.exhausted', current => {
            if (limit === 'calls') current.limits.modelCalls = current.modelCalls;
            else current.limits.tokens = current.chargedTokens;
        });
        await acknowledge(host, before);
        await host.send(tree.id, tree.id, 'Continue');
        const after = await settled(host, tree.id, 'failed');
        expect(after.chargedTokens).toBe(before.chargedTokens); expect(after.modelCalls).toBe(before.modelCalls);
        expect(turn).toHaveBeenCalledOnce();
    }
});

it('waits for a committed unknown receipt to finish its active step before acknowledgement', async () => {
    const host = await open(provider(async () => { throw new Error('lost'); }));
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const change = host.store.change.bind(host.store);
    vi.spyOn(host.store, 'change').mockImplementation(async (...args) => {
        const result = await change(...args);
        if (args[1] === 'model.receipt') await gate;
        return result;
    });
    const tree = await host.create('Stop');
    try {
        await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].phase).toBe('unknown'));
        const before = (await host.store.get(tree.id))!;
        await expect(acknowledge(host, before)).rejects.toThrow('active step');
        expect(await host.store.get(tree.id)).toEqual(before);
    } finally { release(); }
    await acknowledge(host, await settled(host, tree.id, 'unknown'));
});

it('exposes revision-checked acknowledgement through the authenticated HTTP API', async () => {
    const host = await open(provider(async () => { throw new Error('lost'); }));
    const tree = await host.create('Stop'), before = await settled(host, tree.id, 'unknown');
    const web = await attachWeb(host, { token: 'recovery-test', port: 0 });
    try {
        const address = web.server.address() as { port: number }, url = `http://127.0.0.1:${address.port}/api/tasks/${tree.id}/acknowledge-model`;
        const body = JSON.stringify({ operationId: before.tasks[tree.id].operationId, expectedRevision: before.revision });
        expect((await fetch(url, { method: 'POST', body })).status).toBe(401);
        const response = await fetch(url, { method: 'POST', body, headers: { Authorization: 'Bearer recovery-test' } });
        expect(response.status).toBe(200); expect((await response.json() as Tree).tasks[tree.id].phase).toBe('paused');
        expect((await host.store.get(tree.id))!.modelCalls).toBe(1);
    } finally { await web.close(); }
});

it.each(['completed', 'waiting'] as const)('continues an unknown child with a %s parent without rewriting its history', async parentPhase => {
    let childCalls = 0, parentCalls = 0;
    const host = await open(provider(async request => {
        if (request.messages[0].content === 'Child review') {
            if (!childCalls++) throw new Error('Child response lost');
            return reply('Child recovered');
        }
        if (!parentCalls++) return reply('', [{ id: 'spawn', name: 'spawn_agent', args: { objective: 'Child review', tools: [], maxCalls: 5 } }]);
        const result = request.messages.find(m => m.role === 'tool_result' && m.toolCallId === 'spawn')!;
        if (parentCalls === 2) return reply('', [{ id: 'wait', name: 'wait_agents', args: { ids: [JSON.parse(result.content).id] } }]);
        return reply('Parent observed child result');
    }), { rootTools: ['spawn_agent', 'wait_agents'] });
    const created = await host.create('Parent review'); let before = await settled(host, created.id, 'completed');
    const childId = before.tasks[created.id].children[0]; expect(before.tasks[childId].phase).toBe('unknown');
    if (parentPhase === 'waiting') {
        // A persisted waiter can coexist with an unknown child before reconciliation runs.
        before = await host.store.change(created.id, 'fixture.waiting-parent', current => {
            current.tasks[created.id].phase = 'waiting'; current.tasks[created.id].waitFor = [childId];
        });
    }
    const paused = await acknowledge(host, before, childId);
    expect(paused.tasks[created.id]).toEqual(before.tasks[created.id]);
    await host.reconcile();
    expect((await host.store.get(created.id))!.tasks[created.id]).toEqual(before.tasks[created.id]);
    await host.send(created.id, childId, 'Continue child');
    await settled(host, created.id, 'completed', childId);
    const done = await settled(host, created.id, 'completed');
    expect(done.tasks[childId].answer).toBe('Child recovered');
    expect(done.tasks[created.id].messages.slice(0, before.tasks[created.id].messages.length)).toEqual(before.tasks[created.id].messages);
    if (parentPhase === 'completed') expect(done.tasks[created.id]).toEqual(before.tasks[created.id]);
    else expect(done.tasks[created.id].messages.some(m => m.content.includes('Child recovered'))).toBe(true);
});

it('retains the model identity and liability when persisting its receipt fails', async () => {
    const turn = vi.fn(async () => reply('Known remotely'));
    const host = await open(provider(turn)); const change = host.store.change.bind(host.store); let fail = true;
    vi.spyOn(host.store, 'change').mockImplementation(async (...args) => {
        if (args[1] === 'model.receipt' && fail) { fail = false; throw new Error('Storage unavailable'); }
        return change(...args);
    });
    const created = await host.create('Review'); const before = await settled(host, created.id, 'unknown');
    expect(before.tasks[created.id].operationId).toBeTruthy();
    expect(before.tasks[created.id].reservation).toBeGreaterThan(0);
    expect(before.tasks[created.id].messages).toHaveLength(1);
    const paused = await acknowledge(host, before);
    expect(paused.chargedTokens).toBe(before.chargedTokens);
    expect(paused.tasks[created.id].reservation).toBeUndefined();
    await host.send(created.id, created.id, 'Continue'); const done = await settled(host, created.id, 'completed');
    expect(done.chargedTokens).toBe(before.chargedTokens + 12); expect(turn).toHaveBeenCalledTimes(2);
});

it('commits only one of two concurrent acknowledgements', async () => {
    const host = await open(provider(async () => { throw new Error('lost'); }));
    const created = await host.create('Review'); const before = await settled(host, created.id, 'unknown');
    const results = await Promise.allSettled([acknowledge(host, before), acknowledge(host, before)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const after = (await host.store.get(created.id))!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.tasks[created.id].generation).toBe(before.tasks[created.id].generation + 1);
    expect(after.chargedTokens).toBe(before.chargedTokens); expect(after.modelCalls).toBe(before.modelCalls);
    expect((await host.store.events(created.id)).filter(e => e.type === 'model.acknowledged')).toHaveLength(1);
});
