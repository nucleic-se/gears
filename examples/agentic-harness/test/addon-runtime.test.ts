import { loadSkills, skillToolRuntime, skillCatalogText } from '@nucleic-se/agentic/skills';
import { browserToolRuntime } from '@nucleic-se/agentic/browser';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IValidatedToolRuntime } from '@nucleic-se/agentic/tool-runtime';
import type { ILLMProvider, ToolCall, TurnResponse } from '@nucleic-se/agentic/llm';
import { StandaloneHarness } from '../src/standalone/host.js';
const paths: string[] = [], hosts: StandaloneHarness[] = [];
afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
const reply = (content: string, calls: ToolCall[] = []): TurnResponse => ({ message: { role: 'assistant', content, toolCalls: calls }, stopReason: calls.length ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
const model = (turn: ILLMProvider['turn']): ILLMProvider => ({ configurationIdentity: 'addon-test', turn, structured: async () => { throw new Error('unused'); } });
const definition = { name: 'load_skill', description: 'Load instructions', parameters: { type: 'object' as const } };
function runtime(overrides: Partial<IValidatedToolRuntime> = {}): IValidatedToolRuntime {
    return { tools: () => [definition], effectFor: () => 'read', validate: (_name, args) => ({ ok: true, args }),
        call: async () => ({ ok: true, content: 'Check requirements before completing.' }), close: vi.fn(async () => {}), ...overrides };
}
async function options(toolRuntime: IValidatedToolRuntime, provider = model(async () => reply('done'))) {
    const dataDir = await mkdtemp(join(tmpdir(), 'gears-addon-')); paths.push(dataDir);
    return { dataDir, provider, toolRuntime, composition: 'skills-v1', contextTokens: 16000 };
}
it('loads shared instructions through the queued host and closes its runtime once', async () => {
    let turns = 0;
    const addon = runtime();
    const host = await StandaloneHarness.open(await options(addon, model(async request => {
        if (!turns++) return reply('', [{ id: 'skill', name: 'load_skill', args: {} }]);
        expect(JSON.stringify(request.messages)).toContain('Check requirements before completing.');
        return reply('verified');
    }))); hosts.push(host);
    const tree = await host.create('use the skill');
    await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].answer).toBe('verified'));
    await Promise.all([host.close(), host.close()]);
    expect(addon.close).toHaveBeenCalledTimes(1);
});
it.each(['identity', 'effect', 'duplicate', 'startup'] as const)('closes supplied runtime on %s rejection', async failure => {
    const addon = runtime(failure === 'effect' ? { effectFor: undefined } : {});
    const config = await options(addon);
    await expect(StandaloneHarness.open({ ...config,
        ...(failure === 'identity' ? { composition: undefined } : {}),
        ...(failure === 'duplicate' ? { tools: [{ definition, effect: 'read' as const, validate: (args: Record<string, unknown>) => args, execute: async () => ({ ok: true, content: '' }) }] } : {}),
        ...(failure === 'startup' ? { extensions: [{ id: 'fail', version: '1', apiVersion: 1 as const, activate: async () => { throw new Error('startup failed'); } }] } : {}),
    })).rejects.toThrow();
    expect(addon.close).toHaveBeenCalledTimes(1);
    // Failed startup must release the database lease as well.
    if (failure === 'startup') {
        const host = await StandaloneHarness.open({ ...config, toolRuntime: runtime() }); hosts.push(host);
    }
});
it('persists unknown shared results and leaves later calls unexecuted', async () => {
    const call = vi.fn(async () => ({ ok: false, content: 'Confirmation lost', errorKind: 'unknown' as const }));
    const addon = runtime({ effectFor: () => 'write', call });
    const host = await StandaloneHarness.open(await options(addon, model(async () => reply('', [
        { id: 'first', name: 'load_skill', args: {} }, { id: 'second', name: 'load_skill', args: {} },
    ])))); hosts.push(host);
    const tree = await host.create('check unknown');
    await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].phase).toBe('unknown'));
    expect(call).toHaveBeenCalledTimes(1);
    expect((await host.store.get(tree.id))!.tasks[tree.id].pending.map(call => call.id)).toContain('second');
});
it('drains an admitted shared call before releasing its resources', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const drained = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const addon = runtime({ call: async (_name, _args, opts) => {
        entered();
        await new Promise<void>(resolve => opts!.signal!.addEventListener('abort', () => resolve(), { once: true }));
        await drained; order.push('receipt');
        return { ok: false, content: 'stopped', errorKind: 'cancelled' };
    }, close: vi.fn(async () => { order.push('close'); }) });
    const host = await StandaloneHarness.open(await options(addon, model(async () => reply('', [{ id: 'first', name: 'load_skill', args: {} }])))); hosts.push(host);
    await host.create('drain'); await started;
    const closing = host.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(addon.close).not.toHaveBeenCalled();
    release(); await closing;
    expect(order).toEqual(['receipt', 'close']);
});

it('uses the same frozen skills catalog and runtime as the local host', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gears-skills-')); paths.push(directory);
    await writeFile(join(directory, 'SKILL.md'), '---\nname: inspect-output\ndescription: Inspect finished work\n---\nVerify the cobalt requirement.');
    const catalog = await loadSkills({ directories: [directory] });
    await writeFile(join(directory, 'SKILL.md'), 'Changed after catalog creation');
    let turns = 0;
    const host = await StandaloneHarness.open({
        ...await options(skillToolRuntime(catalog), model(async request => {
            expect(request.system).toContain('inspect-output');
            expect(request.system).not.toContain('cobalt requirement');
            if (!turns++) return reply('', [{ id: 'skill', name: 'read_skill', args: { name: 'inspect-output' } }]);
            const result = request.messages.find(message => message.role === 'tool_result');
            expect(JSON.stringify(result)).toContain('Verify the cobalt requirement.');
            expect(JSON.stringify(result)).not.toContain('Changed after catalog creation');
            return reply('cobalt verified');
        })),
        composition: `skills:${catalog.identity}`,
        projectInstructions: [{ path: 'skills', directory: '.', content: skillCatalogText(catalog) }],
    }); hosts.push(host);
    const tree = await host.create('inspect output');
    await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].answer).toBe('cobalt verified'));
});
it('preserves native browser screenshot blocks through storage and model projection', async () => {
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const closeContext = vi.fn(async () => {}), closeBrowser = vi.fn(async () => {});
    const browser = browserToolRuntime({ browser: async () => ({
        close: closeBrowser,
        newContext: async () => ({ close: closeContext, newPage: async () => ({
            goto: async () => {},
            locator: () => ({ click: async () => {}, fill: async () => {}, ariaSnapshot: async () => 'page' }),
            screenshot: async () => png,
        }) }),
    }) });
    const image = { type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') };
    let turns = 0;
    const host = await StandaloneHarness.open({ ...await options(browser, model(async request => {
        if (!turns++) return reply('', [{ id: 'screenshot', name: 'browser_screenshot', args: {} }]);
        const result = request.messages.find(message => message.role === 'tool_result');
        expect(result).toMatchObject({ contentBlocks: expect.arrayContaining([image]) });
        return reply('image inspected');
    })), composition: 'browser-fixture-v1' }); hosts.push(host);
    const tree = await host.create('inspect browser');
    await vi.waitFor(async () => expect((await host.store.get(tree.id))!.tasks[tree.id].answer).toBe('image inspected'));
    const stored = (await host.store.get(tree.id))!.tasks[tree.id].messages.find(message => message.role === 'tool_result');
    expect(stored).toMatchObject({ contentBlocks: expect.arrayContaining([image]) });
    await host.close();
    expect(closeContext).toHaveBeenCalledTimes(1);
    expect(closeBrowser).toHaveBeenCalledTimes(1);
});

it('retries failed worker shutdown before closing a shared runtime', async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const drained = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const addon = runtime({ call: async () => {
        entered(); await drained; order.push('receipt');
        return { ok: true, content: 'done' };
    }, close: vi.fn(async () => { order.push('close'); }) });
    const host = await StandaloneHarness.open(await options(addon, model(async () => reply('', [{ id: 'first', name: 'load_skill', args: {} }]))));
    await host.create('drain after failure'); await started;
    const worker = host.app.make('Worker');
    vi.spyOn(worker, 'stop').mockRejectedValueOnce(new Error('stop failed once'));
    const closing = host.close();
    const rejected = expect(closing).rejects.toThrow('Harness shutdown failed');
    try {
        await new Promise(resolve => setTimeout(resolve, 30));
        expect(addon.close).not.toHaveBeenCalled();
    } finally { release(); await rejected; }
    expect(order).toEqual(['receipt', 'close']);
    expect(addon.close).toHaveBeenCalledTimes(1);
});
