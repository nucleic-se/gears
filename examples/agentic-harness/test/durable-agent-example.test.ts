import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ILLMProvider, TurnRequest, TurnResponse } from '@nucleic-se/agentic/llm';
import { openRequestReviewWorker } from '../src/standalone/durable-agent-example.js';
import type { StandaloneHarness } from '../src/standalone/host.js';

const paths: string[] = [];
const hosts: StandaloneHarness[] = [];
afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const directory of paths.splice(0)) await rm(directory, { recursive: true, force: true });
});
const answer = (content: string): TurnResponse => ({
    message: { role: 'assistant', content }, stopReason: 'end_turn',
    usage: { inputTokens: 30, outputTokens: 10 },
});

it('reviews a request, reopens durable results and continues without replaying the lookup', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'request-worker-')); paths.push(dataDir);
    const read = vi.fn(async () => 'Request R-42: invoice lists two charges for one order.');
    let calls = 0;
    const provider: ILLMProvider = {
        configurationIdentity: 'deterministic-request-review-v1',
        structured: async () => { throw new Error('Unused structured request'); },
        turn: vi.fn(async (request: TurnRequest): Promise<TurnResponse> => {
            expect(request.tools?.map(tool => tool.name)).toEqual(['read_request']);
            expect(request.system).toContain('Do not claim to have changed the request');
            if (!calls++) return {
                ...answer(''), stopReason: 'tool_use',
                message: { role: 'assistant', content: '', toolCalls: [{ id: 'lookup', name: 'read_request', args: { id: 'R-42' } }] },
            };
            expect(JSON.stringify(request.messages)).toContain('two charges for one order');
            return answer(calls === 2 ? 'Possible duplicate billing; verify the ledger.' : 'Next action: compare the two charge identifiers.');
        }),
    };
    const config = { dataDir, provider, requests: { identity: 'support-read-access-v1', read } };
    const first = await openRequestReviewWorker(config); hosts.push(first);
    const tree = await first.create('Review R-42');
    await vi.waitFor(async () => expect((await first.store.get(tree.id))!.tasks[tree.id].answer).toBe('Possible duplicate billing; verify the ledger.'));
    const original = await first.store.get(tree.id);
    const receipts = (await first.store.events(tree.id)).filter(event => event.type === 'tool.receipt');
    expect(receipts).toHaveLength(1);
    expect(read).toHaveBeenCalledExactlyOnceWith('R-42', expect.any(AbortSignal));
    await first.close();

    const reopened = await openRequestReviewWorker(config); hosts.push(reopened);
    expect(await reopened.store.get(tree.id)).toEqual(original);
    expect(provider.turn).toHaveBeenCalledTimes(2);
    await reopened.send(tree.id, tree.id, 'Give me one concrete next action.');
    await vi.waitFor(async () => expect((await reopened.store.get(tree.id))!.tasks[tree.id].answer).toBe('Next action: compare the two charge identifiers.'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(provider.turn).toHaveBeenCalledTimes(3);
    expect((await reopened.store.events(tree.id)).filter(event => event.type === 'tool.receipt')).toEqual(receipts);
});

it('retains an unknown provider outcome across reopen instead of retrying automatically', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'request-worker-')); paths.push(dataDir);
    const turn = vi.fn(async () => { throw new Error('Connection lost after dispatch'); });
    const read = vi.fn(async () => 'unused');
    const config = {
        dataDir,
        provider: { configurationIdentity: 'unknown-request-review-v1', turn, structured: async () => { throw new Error('unused'); } },
        requests: { identity: 'support-read-access-v1', read },
    };
    const first = await openRequestReviewWorker(config); hosts.push(first);
    const tree = await first.create('Review R-42');
    await vi.waitFor(async () => expect((await first.store.get(tree.id))!.tasks[tree.id].phase).toBe('unknown'));
    await first.close();
    const reopened = await openRequestReviewWorker(config); hosts.push(reopened);
    expect((await reopened.store.get(tree.id))!.tasks[tree.id].phase).toBe('unknown');
    await expect(reopened.send(tree.id, tree.id, 'Try again')).rejects.toThrow('Stopped or unknown execution requires review');
    expect(turn).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
});

it.each([undefined, '', '   '])('rejects opaque provider identity %j before creating host resources', async configurationIdentity => {
    const parent = await mkdtemp(join(tmpdir(), 'request-worker-identity-')); paths.push(parent);
    const dataDir = join(parent, 'not-created');
    const turn = vi.fn(async () => answer('unused'));
    const read = vi.fn(async () => 'unused');
    await expect(openRequestReviewWorker({
        dataDir,
        provider: { configurationIdentity, turn, structured: async () => { throw new Error('unused'); } },
        requests: { identity: 'support-read-access-v1', read },
    })).rejects.toThrow('Request review provider requires a nonempty configuration identity');
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(turn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
});
