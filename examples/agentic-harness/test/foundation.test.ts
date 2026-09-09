import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHarnessBoundaryConformance } from '@nucleic-se/agentic/testing';
import { StandaloneHarness } from '../src/standalone/host.js';
import { terminal } from '../src/standalone/state.js';

it('ownership claims persist the transition timestamp with their event', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gears-claim-'));
    const host = await StandaloneHarness.open({ contextTokens: 16000, dataDir, provider: { configurationIdentity: 'test-provider', turn: vi.fn(), structured: vi.fn() } });
    try {
        const tree = await host.store.create('unstarted', [], host.compositionId);
        const timestamp = tree.updatedAt + 1000;
        const clock = vi.spyOn(Date, 'now').mockReturnValue(timestamp);
        try { await host.store.claim(tree); } finally { clock.mockRestore(); }
        const claimed = (await host.store.get(tree.id))!;
        const event = (await host.store.events(tree.id)).at(-1)!;
        expect(claimed.updatedAt).toBe(timestamp);
        expect(claimed.revision).toBe(tree.revision + 1);
        expect(event).toMatchObject({ type: 'host.claimed', at: timestamp, sequence: claimed.revision });
    } finally { await host.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it('the queued Gears composition satisfies the same request boundary as the local driver', async () => {
    const report = await assertHarnessBoundaryConformance(async ({ provider, context }) => {
        const dataDir = await mkdtemp(join(tmpdir(), 'gears-foundation-'));
        const host = await StandaloneHarness.open({ dataDir, provider, context, composition: 'boundary-fixture' });
        return { async run(input) {
            const tree = await host.create(input);
            await vi.waitFor(async () => expect(terminal((await host.store.get(tree.id))!.tasks[tree.id].phase)).toBe(true));
            return (await host.store.get(tree.id))!.tasks[tree.id].messages;
        }, async close() { await host.close(); await rm(dataDir, { recursive: true, force: true }); } };
    });
    expect(report.passed).toBe(true);
});

it('composition activation failure releases the Gears host so the same directory can reopen', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gears-foundation-'));
    const provider = { configurationIdentity: 'test-provider', turn: vi.fn(), structured: vi.fn() };
    try {
        await expect(StandaloneHarness.open({ contextTokens: 16000, dataDir, provider, extensions: [
            { id: 'broken', version: '1', apiVersion: 1, activate: async () => { throw new Error('activation failed'); } },
        ] })).rejects.toThrow('activation failed');
        const host = await StandaloneHarness.open({ contextTokens: 16000, dataDir, provider });
        await host.close();
        expect(provider.turn).not.toHaveBeenCalled();
    } finally { await rm(dataDir, { recursive: true, force: true }); }
});

it('context configuration changes invalidate resumable work before it is claimed', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gears-foundation-'));
    const provider = { configurationIdentity: 'test-provider', turn: vi.fn(), structured: vi.fn() };
    const first = await StandaloneHarness.open({ contextTokens: 16000, dataDir, provider });
    try {
        await first.store.create('preserve input', [], first.compositionId);
        await first.close();
        await expect(StandaloneHarness.open({ dataDir, provider, contextTokens: 32000 })).rejects.toThrow('original composition');
        expect(provider.turn).not.toHaveBeenCalled();
    } finally { await first.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it('shutdown closes admission, drains accepted commands and disposes extensions before storage', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'gears-foundation-'));
    const provider = { configurationIdentity: 'test-provider', turn: vi.fn(), structured: vi.fn() };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let storedAtCleanup = 0;
    const host = await StandaloneHarness.open({ contextTokens: 16000, dataDir, provider, extensions: [{ id: 'observer', version: '1', apiVersion: 1,
        activate: async client => async () => { storedAtCleanup = (await client.store.list()).length; },
    }] });
    const create = host.store.create.bind(host.store);
    vi.spyOn(host.store, 'create').mockImplementation(async (...args) => { entered(); await gate; return create(...args); });
    const creating = host.create('accepted before shutdown');
    await started;
    const closing = host.close();
    try {
        expect(host.close()).toBe(closing);
        await expect(host.create('too late')).rejects.toThrow('shutting down');
        expect(storedAtCleanup).toBe(0);
    } finally {
        release();
        await creating; await closing;
        await rm(dataDir, { recursive: true, force: true });
    }
    expect(storedAtCleanup).toBe(1);
    expect(provider.turn).not.toHaveBeenCalled();
});
