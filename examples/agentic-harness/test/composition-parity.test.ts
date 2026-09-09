import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, defaultAgentExtensions, codingAgentContext, codingToolRuntime, codingToolEffect } from '@nucleic-se/agentic/harness';
import type { ILLMProvider, Message, TurnRequest, TurnResponse } from '@nucleic-se/agentic/llm';
import { StandaloneHarness } from '../src/standalone/host.js';
import { runtimeTools } from '../src/standalone/coding.js';

it('shares coding requests across local and queued drivers, including images and a resumed follow-up', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'composition-parity-'));
    try {
        await writeFile(join(workspace, 'AGENTS.md'), 'Verify changes before reporting completion.');
        await writeFile(join(workspace, 'evidence.txt'), 'Exact source evidence.');
        await writeFile(join(workspace, 'capture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nqAAAAAASUVORK5CYII=', 'base64'));
        const requests: Record<string, TurnRequest[]> = { local: [], queued: [] };
        const provider = (engine: string): ILLMProvider => ({ configurationIdentity: 'shared-coding-fixture', structured: async () => { throw new Error('unused'); }, turn: async request => {
            requests[engine].push(structuredClone(request));
            const first = requests[engine].length === 1;
            return { message: { role: 'assistant', content: first ? '' : 'Verified.', ...(first ? { toolCalls: [
                { id: 'text', name: 'fs_read', args: { path: 'evidence.txt' } },
                { id: 'image', name: 'fs_read', args: { path: 'capture.png' } },
            ] } : {}) }, stopReason: first ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 2 } } satisfies TurnResponse;
        } });
        const localProvider = provider('local'), queuedProvider = provider('queued');
        const extensions = async () => [
            ...(await defaultAgentExtensions({ workspace, database: join(workspace, 'local.sqlite'), tokenBudget: 16000, outputTokens: 100 })).filter(e => !e.roles?.provider),
            { id: 'test.provider', version: '1', apiVersion: 1 as const, roles: { provider: () => localProvider } },
        ];
        let client = await createHarness().compose({ extensions: await extensions() });
        let id: string;
        try { id = (await client.create()).id; await client.submit(id, 'Inspect evidence and image.', { commandId: 'first' }); expect((await client.wait(id)).status).toBe('idle'); }
        finally { await client.close(); }
        client = await createHarness().compose({ extensions: await extensions() });
        try { await client.submit(id!, 'Continue from those observations.', { commandId: 'follow-up' }); expect((await client.wait(id!)).status).toBe('idle'); }
        finally { await client.close(); }
        const tools = runtimeTools(codingToolRuntime(workspace), name => codingToolEffect(name)!);
        const options = { dataDir: join(workspace, 'queued'), provider: queuedProvider, tools,
            rootTools: [...tools.map(tool => tool.definition.name), 'read_tool_result'], outputTokens: 100,
            context: codingAgentContext({ workspace, tokenBudget: 16000 }), composition: 'shared-coding-fixture' };
        let host = await StandaloneHarness.open(options);
        let treeId: string;
        const done = async () => { await expect.poll(async () => (await host.store.get(treeId))!.tasks[treeId].phase).toBe('completed'); };
        try { treeId = (await host.create('Inspect evidence and image.')).id; await done(); }
        finally { await host.close(); }
        host = await StandaloneHarness.open(options);
        try { await host.send(treeId!, treeId!, 'Continue from those observations.'); await done(); }
        finally { await host.close(); }
        expect(requests.local).toHaveLength(3);
        expect(requests.queued).toHaveLength(3);
        const content = (messages: Message[]) => messages.map(message => {
            if (message.role === 'user') { const { provenance, sticky, ...rest } = message; return rest; }
            const { provenance, ...rest } = message; return rest;
        });
        for (let turn = 0; turn < 3; turn++) {
            const local = requests.local[turn], queued = requests.queued[turn];
            expect(queued.system).toBe(local.system);
            expect(queued.tools).toEqual(local.tools);
            expect(queued.maxTokens).toBe(local.maxTokens);
            expect(content(queued.messages)).toEqual(content(local.messages));
        }
        const image = requests.queued[2].messages.find(message => message.role === 'tool_result' && message.toolCallId === 'image');
        expect(image).toMatchObject({ contentBlocks: expect.arrayContaining([expect.objectContaining({ type: 'image', mimeType: 'image/png' })]) });
    } finally { await rm(workspace, { recursive: true, force: true }); }
});
