import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ILLMProvider } from '@nucleic-se/agentic/llm';
import { StandaloneHarness } from '../src/standalone/host.js';

function provider(): ILLMProvider {
    return { turn: vi.fn(), structured: vi.fn(), capabilities: {
        contextWindowTokens: 50000, transport: 'test', toolBatching: true,
        outputLimit: 'enforced', automaticRetries: 0, continuation: 'none', requestObservation: 'none',
    } };
}

it('resolves and fingerprints model capacity before opening the durable composition', async () => {
    const path = await mkdtemp(join(tmpdir(), 'model-capacity-'));
    const ids: string[] = [];
    try {
        for (const [index, contextTokens] of [undefined, 70000, 24000].entries()) {
            const model = provider();
            const host = await StandaloneHarness.open({ dataDir: join(path, String(index)), provider: model, contextTokens });
            try {
                expect(host.options.contextTokens).toBe(contextTokens === 24000 ? 24000 : 50000);
                ids.push(host.compositionId);
                expect(model.turn).not.toHaveBeenCalled();
            } finally { await host.close(); }
        }
        expect(ids[0]).toBe(ids[1]);
        expect(ids[0]).not.toBe(ids[2]);
    } finally { await rm(path, { recursive: true, force: true }); }
});

it('requires explicit capacity for an unknown provider before opening storage', async () => {
    const path = await mkdtemp(join(tmpdir(), 'unknown-capacity-'));
    const dataDir = join(path, 'unopened');
    const model = { turn: vi.fn(), structured: vi.fn() };
    try {
        await expect(StandaloneHarness.open({ dataDir, provider: model })).rejects.toThrow('capacity is unknown');
        await expect(access(dataDir)).rejects.toThrow();
        const host = await StandaloneHarness.open({ dataDir, provider: model, contextTokens: 16000 });
        try { expect(host.options.contextTokens).toBe(16000); } finally { await host.close(); }
    } finally { await rm(path, { recursive: true, force: true }); }
});
