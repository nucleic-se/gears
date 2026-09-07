import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteMemoryStore } from '@nucleic-se/agentic/runtime';
import type { ILLMProvider, ToolCall } from '@nucleic-se/agentic/llm';
import { StandaloneHarness } from '../src/standalone/host.js';
import { memoryTools } from '../src/standalone/memory.js';

it('uses shared note capture and recalls source evidence in another task after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gears-recall-'));
    const reply = (calls: ToolCall[] = []) => ({ message: { role: 'assistant' as const, content: calls.length ? '' : 'done', toolCalls: calls },
        stopReason: calls.length ? 'tool_use' as const : 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } });
    let learning = true;
    const provider: ILLMProvider = { structured: async () => { throw new Error('unused'); }, turn: async request => {
        const results = request.messages.filter(message => message.role === 'tool_result');
        if (learning) return results.length ? reply() : reply([
            { id: 'source', name: 'read_build', args: {} },
            { id: 'save', name: 'memory_save', args: { key: 'build', note: 'Use npm run verify', callId: 'source', limit: 20 } },
        ]);
        if (!results.length) return reply([{ id: 'search', name: 'memory_search', args: { text: 'build' } }]);
        if (results.length === 1) {
            expect(results[0].content).toMatch(/^\{"toolCallId":/);
            const [hit] = JSON.parse(results[0].content.slice(results[0].content.indexOf('\n') + 1));
            return reply([{ id: 'read', name: 'memory_read', args: { id: hit.id, version: hit.version } }]);
        }
        const value = JSON.parse(results.at(-1)!.content.slice(results.at(-1)!.content.indexOf('\n') + 1));
        if (value.eof === true) return reply();
        const [hit] = JSON.parse(results[0].content.slice(results[0].content.indexOf('\n') + 1));
        return reply([{ id: `page-${results.length}`, name: 'memory_read', args: { id: hit.id, version: hit.version, sourceOffset: value.nextOffset ?? 0 } }]);
    } };
    let host: StandaloneHarness | undefined, memory: SqliteMemoryStore | undefined;
    const open = async () => {
        memory = await SqliteMemoryStore.open(join(root, 'notes.sqlite'), root);
        host = await StandaloneHarness.open({ dataDir: root, provider, tools: [
            { definition: { name: 'read_build', description: 'Read recorded build instructions', parameters: { type: 'object', properties: {} } },
                effect: 'read', validate: args => args, execute: async () => ({ ok: true, content: 'Use npm run verify\n' + 'x'.repeat(8500) + '\noriginal tail' }) },
            ...memoryTools(memory, () => host!),
        ] });
    };
    const complete = async (id: string) => { await vi.waitFor(async () => expect((await host!.store.get(id))!.tasks[id].phase).toBe('completed'), { timeout: 10000, interval: 20 }); };
    try {
        await open();
        const first = await host!.create('learn'); await complete(first.id);
        expect((await memory!.query({ text: 'build', limit: 1 })).length).toBe(1);
        await host!.close(); host = undefined; await memory!.close(); memory = undefined;
        learning = false; await open();
        const second = await host!.create('recall'); await complete(second.id);
        const messages = (await host!.store.get(second.id))!.tasks[second.id].messages;
        const read = messages.find(message => message.role === 'tool_result' && message.toolName === 'memory_read');
        const note = JSON.parse(read!.content);
        expect(note.source).toContain(`tree/${first.id}/task/${first.id}/message/`);
        expect(note.value.evidence.content).toHaveLength(20);
        expect(note.value.evidence.isError).toBe(false);
        const pages = messages.filter(message => message.role === 'tool_result' && message.toolName === 'memory_read')
            .slice(1).map(message => JSON.parse(message.content));
        expect(pages.map(page => page.content).join('')).toBe('Use npm run verify\n' + 'x'.repeat(8500) + '\noriginal tail');
        expect(pages.at(-1).eof).toBe(true);
    } finally { await host?.close(); await memory?.close(); await rm(root, { recursive: true, force: true }); }
});
