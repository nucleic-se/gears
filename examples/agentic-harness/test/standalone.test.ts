import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ILLMProvider, TurnResponse, TurnRequest, ToolCall } from '@nucleic-se/agentic/llm';
import { StandaloneHarness } from '../src/standalone/host.js';
import type { Tree } from '../src/standalone/state.js';
const paths: string[] = [], hosts: StandaloneHarness[] = [];
afterEach(async () => { for (const h of hosts.splice(0))
    await h.close(); for (const p of paths.splice(0))
    await rm(p, { recursive: true, force: true }); });
async function open(provider: ILLMProvider, path?: string) { path ??= await mkdtemp(join(tmpdir(), 'standalone-test-')); if (!paths.includes(path))
    paths.push(path); const h = await StandaloneHarness.open({ dataDir: path, provider }); hosts.push(h); return h; }
const reply = (content: string, calls: ToolCall[] = []): TurnResponse => ({ message: { role: 'assistant', content, ...(calls.length ? { toolCalls: calls } : {}) }, stopReason: calls.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 100, outputTokens: 20 } });
const tool = (name: string, args: Record<string, unknown>, id = name): ToolCall => ({ id, name, args });
const model = (turn: ILLMProvider['turn']): ILLMProvider => ({ turn, structured: async () => { throw new Error('unused'); } });
async function state(host: StandaloneHarness, id: string, check: (t: Tree) => void) { await vi.waitFor(async () => check((await host.store.get(id))!), { timeout: 10000, interval: 20 }); }
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
        expect(request.system).toContain('Both children collected');
        expect(JSON.stringify(request.messages)).toContain('result child A');
        expect(JSON.stringify(request.messages)).toContain('result child B');
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
});
it('shares a hard model-call admission budget across children', async () => {
    const turn = vi.fn(async () => reply('', [tool('spawn_agent', { objective: 'child', tools: [], maxCalls: 2 })]));
    const h = await open(model(turn)), tree = await h.create('parent', { modelCalls: 1 });
    await state(h, tree.id, t => expect(Object.values(t.tasks).every(s => s.phase === 'failed')).toBe(true));
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
        expect(JSON.stringify(request.messages)).toContain('urgent correction');
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
    const { workspaceTools } = await import('../src/standalone/tools.js');
    const { writeFile } = await import('node:fs/promises');
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-'));
    paths.push(path);
    const content = 'a'.repeat(15999) + '🌿rest';
    await writeFile(join(path, '..notes'), content);
    const tools = await workspaceTools(path), read = tools.find(t => t.definition.name === 'read_file')!, signal = new AbortController().signal;
    const first = JSON.parse((await read.execute({ path: '..notes', offset: 0 }, signal)).content);
    const second = JSON.parse((await read.execute({ path: '..notes', offset: first.nextOffset }, signal)).content);
    expect(first.content + second.content).toBe(content);
    expect(second.eof).toBe(true);
    await Promise.all(Array.from({ length: 205 }, (_, i) => writeFile(join(path, `file${i}`), '')));
    const listing = JSON.parse((await tools.find(t => t.definition.name === 'list_files')!.execute({ path: '.' }, signal)).content);
    expect(listing.entries).toHaveLength(200);
    expect(listing.truncated).toBe(true);
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
    const { execFileSync } = await import('node:child_process'), { workspaceTools } = await import('../src/standalone/tools.js');
    const path = await mkdtemp(join(tmpdir(), 'standalone-test-'));
    paths.push(path);
    execFileSync('mkfifo', [join(path, 'pipe')]);
    const tools = await workspaceTools(path);
    await expect(tools.find(t => t.definition.name === 'read_file')!.execute({ path: 'pipe', offset: 0 }, new AbortController().signal)).rejects.toThrow('regular file');
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
