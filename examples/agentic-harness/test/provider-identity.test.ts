import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ILLMProvider, TurnResponse } from '@nucleic-se/agentic/llm';
import { StandaloneHarness } from '../src/standalone/host.js';

function provider(configurationIdentity?: string): ILLMProvider {
    return { configurationIdentity, capabilities: {
        contextWindowTokens: 50000, transport: 'test', toolBatching: true,
        outputLimit: 'enforced', automaticRetries: 0, continuation: 'none', requestObservation: 'none',
    }, structured: vi.fn(), turn: vi.fn(async (): Promise<TurnResponse> => ({
        message: { role: 'assistant', content: 'done' }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 },
    })) };
}

function persisted(dataDir: string) {
    const db = new DatabaseSync(join(dataDir, 'app.sqlite'), { readOnly: true });
    try { return db.prepare('SELECT state FROM harness_trees ORDER BY id').all(); }
    finally { db.close(); }
}

it('requires explicit ownership for unknown provider configuration before creating storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provider-identity-'));
    const dataDir = join(root, 'unopened');
    try {
        await expect(StandaloneHarness.open({ dataDir, provider: provider() })).rejects.toThrow('explicit composition identity');
        await expect(access(dataDir)).rejects.toThrow();
        for (const identity of ['', ' ', 12 as unknown as string])
            await expect(StandaloneHarness.open({ dataDir, provider: provider(identity), composition: 'custom-v1' })).rejects.toThrow('Provider configuration identity');
        await expect(StandaloneHarness.open({ dataDir, provider: provider(), composition: ' ' })).rejects.toThrow('Composition identity');
        await expect(access(dataDir)).rejects.toThrow();
        const first = await StandaloneHarness.open({ dataDir, provider: provider(), composition: 'custom-v1' });
        const identity = first.compositionId;
        await first.close();
        const same = await StandaloneHarness.open({ dataDir, provider: provider(), composition: 'custom-v1' });
        expect(same.compositionId).toBe(identity);
        await same.close();
        const changed = await StandaloneHarness.open({ dataDir, provider: provider(), composition: 'custom-v2' });
        expect(changed.compositionId).not.toBe(identity);
        await changed.close();
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects a known provider change before claiming active state even when capacity and caller label match', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'provider-reopen-'));
    const original = provider('model-A:low'), changed = provider('model-B:low');
    const first = await StandaloneHarness.open({ dataDir, provider: original, composition: 'application-v1', rootTools: [] });
    try {
        const tree = await first.store.create('Preserve this task', [], first.compositionId);
        await first.store.change(tree.id, 'fixture.paused', current => { current.tasks[tree.id].phase = 'paused'; });
        await first.close();
        const before = persisted(dataDir);
        await expect(StandaloneHarness.open({ dataDir, provider: changed, composition: 'application-v1', rootTools: [] })).rejects.toThrow('original composition');
        expect(persisted(dataDir)).toEqual(before);
        expect(changed.turn).not.toHaveBeenCalled();
        const reopened = await StandaloneHarness.open({ dataDir, provider: provider('model-A:low'), composition: 'application-v1', rootTools: [] });
        try {
            expect((await reopened.store.get(tree.id))!.tasks[tree.id].phase).toBe('paused');
            expect(reopened.compositionId).toBe(first.compositionId);
        } finally { await reopened.close(); }
    } finally { await first.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it('rejects follow-up to a completed tree after provider settings change without mutating history', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'provider-followup-'));
    const first = await StandaloneHarness.open({ dataDir, provider: provider('model-A:low'), rootTools: [] });
    try {
        const tree = await first.create('Complete the task');
        await vi.waitFor(async () => expect((await first.store.get(tree.id))!.tasks[tree.id].phase).toBe('completed'));
        await first.close();
        const changed = provider('model-A:medium');
        const reopened = await StandaloneHarness.open({ dataDir, provider: changed, rootTools: [] });
        try {
            const before = await reopened.store.get(tree.id);
            await expect(reopened.send(tree.id, tree.id, 'Follow up')).rejects.toThrow('original composition');
            expect(await reopened.store.get(tree.id)).toEqual(before);
            expect(changed.turn).not.toHaveBeenCalled();
        } finally { await reopened.close(); }
    } finally { await first.close(); await rm(dataDir, { recursive: true, force: true }); }
});
