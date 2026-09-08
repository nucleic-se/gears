import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { internalAction, internalDefinitions, validateInternal, childResults } from '../src/standalone/tools.js';
import { StandaloneHarness } from '../src/standalone/host.js';
import { newTask, type Tree } from '../src/standalone/state.js';

it('advertises and validates the same limits, reference alternatives and artifact names', () => {
    const schema = (name: string) => internalDefinitions.find(t => t.name === name)!.parameters;
    expect(schema('spawn_agent').properties?.maxCalls).toMatchObject({ minimum: 1, maximum: 30 });
    expect(schema('schedule_self').properties?.delaySeconds).toMatchObject({ minimum: 1, maximum: 604800 });
    expect(schema('save_progress').properties?.notes).toMatchObject({ minLength: 1, maxLength: 8000 });
    expect(schema('wait_agents').properties?.ids).toMatchObject({ minItems: 1, maxItems: 32 });
    expect(schema('read_tool_result').anyOf).toHaveLength(2);
    for (const [name, args] of [
        ['spawn_agent', { objective: 'child', tools: [], maxCalls: 31 }],
        ['schedule_self', { delaySeconds: 604801, reason: 'later' }],
        ['save_progress', { notes: 'x'.repeat(8001) }],
        ['wait_agents', { ids: [] }],
        ['save_artifact', { name: '../outside', content: 'x' }],
        ['read_tool_result', { callId: 'call', messageIndex: 1 }],
    ] as const) expect(() => validateInternal(name, args)).toThrow();
    expect(validateInternal('schedule_self', { delaySeconds: 1, reason: 'later' })).toEqual({ delaySeconds: 1, reason: 'later' });
});

it('pages complete child answers without exposing unrelated tasks or losing their tails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'child-answer-'));
    const host = await StandaloneHarness.open({ dataDir: root, provider: { structured: async () => { throw new Error('unused'); }, turn: async () => ({ message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }) } });
    try {
        const tree = await host.store.create('parent', internalDefinitions.map(t => t.name), host.compositionId);
        const answer = 'evidence '.repeat(3000) + 'CRITICAL_FINAL_CONCLUSION';
        await host.store.change(tree.id, 'fixture', draft => {
            draft.tasks.child = newTask('child', 'child', [], { parentId: tree.id, phase: 'completed', answer });
            draft.tasks[tree.id].children = ['child'];
            draft.tasks.unrelated = newTask('unrelated', 'other', [], { phase: 'completed', answer: 'private' });
        });
        const saved = (await host.store.get(tree.id))!;
        const parent = saved.tasks[tree.id];
        let offset = 0, complete = '';
        for (;;) {
            const [page] = JSON.parse(internalAction(saved, parent, 'wait_agents', validateInternal('wait_agents', { ids: ['child'], offset }), 'read'));
            expect(page.totalCharacters).toBe(answer.length);
            complete += page.answer;
            if (page.eof) break;
            expect(page.reference).toEqual({ tool: 'wait_agents', ids: ['child'], offset: page.nextOffset });
            offset = page.nextOffset;
        }
        expect(complete).toBe(answer);
        expect(() => internalAction(saved, parent, 'wait_agents', { ids: ['unrelated'] }, 'deny')).toThrow('direct child');
        expect(saved.tasks.child.answer).toBe(answer);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});

it('bounds the combined preview while retaining independent references for every child', () => {
    const tasks = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`child-${i}`, newTask(`child-${i}`, 'child', [], { phase: 'completed', answer: 'x'.repeat(20000) })]));
    const pages = JSON.parse(childResults({ tasks } as Tree, Object.keys(tasks)));
    expect(pages.reduce((sum: number, page: { answer: string }) => sum + page.answer.length, 0)).toBeLessThanOrEqual(8000);
    expect(pages.every((page: { eof: boolean; reference: unknown }) => !page.eof && page.reference)).toBe(true);
});

it('presents refreshed instructions and only relevant scheduling state in actual requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dynamic-instructions-'));
    let text = 'FIRST_INSTRUCTION', turns = 0;
    const host = await StandaloneHarness.open({ dataDir: root, composition: 'instruction-test',
        projectInstructions: async (_messages, signal) => { signal.throwIfAborted(); return '\n' + text; },
        provider: { structured: async () => { throw new Error('unused'); }, turn: async request => {
            expect(request.system).toContain(turns ? 'UPDATED_INSTRUCTION' : 'FIRST_INSTRUCTION');
            const state = JSON.parse(request.messages[request.messages.length - 1].content.split('\n').slice(1).join('\n'));
            expect(Date.parse(state.expiresAt)).toBeGreaterThan(Date.now());
            expect(state.remainingChildren).toBeGreaterThanOrEqual(0);
            expect(state.remainingDepth).toBeGreaterThanOrEqual(0);
            if (!turns++) { text = 'UPDATED_INSTRUCTION'; return { message: { role: 'assistant', content: '', toolCalls: [{ id: 'progress', name: 'save_progress', args: { notes: 'continue' } }] }, stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }; }
            return { message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
        } } });
    try {
        const tree = await host.create('task');
        await expect.poll(async () => (await host.store.get(tree.id))!.tasks[tree.id].answer).toBe('done');
        expect(turns).toBe(2);
    } finally { await host.close(); await rm(root, { recursive: true, force: true }); }
});
