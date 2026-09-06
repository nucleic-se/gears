import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SubscriptionProvider } from '@nucleic-se/agentic/providers/subscription';
import type { ILLMProvider } from '@nucleic-se/agentic/llm';
import { openQueuedAgent } from './runtime.js';

const args = process.argv.slice(2), dataIndex = args.indexOf('--data');
if (dataIndex >= 0 && !args[dataIndex + 1]) throw new Error('--data needs a directory');
const temporary = dataIndex < 0;
const directory = temporary ? await mkdtemp(join(tmpdir(), 'gears-agentic-demo-')) : resolve(args[dataIndex + 1]);
const live = args.includes('--live');
const provider: ILLMProvider = live ? new SubscriptionProvider({ model: 'gpt-6-astra', reasoningEffort: 'low' }) : {
    async turn() { return { message: { role: 'assistant', content: 'GEARS_OK' }, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }; },
    async structured() { throw new Error('This example uses text turns'); },
};
const runtime = await openQueuedAgent(directory, provider);
try {
    const job = await runtime.enqueue('Respond with exactly GEARS_OK.');
    const signal = AbortSignal.timeout(45000);
    let state;
    while (true) {
        signal.throwIfAborted();
        const queued = await runtime.app.make('IQueue').get(job.id);
        if (queued?.status === 'failed') throw new Error(queued.error ?? 'Agent job failed');
        if (queued?.status === 'completed') { state = await runtime.journal.get(job.id); break; }
        await delay(10, undefined, { signal });
    }
    if (state?.response?.message.content.trim() !== 'GEARS_OK') throw new Error('Unexpected model answer');
    console.log(JSON.stringify({ passed: true, live, jobStatus: 'completed', modelStatus: state.status,
        answer: state.response.message.content, usage: state.response.usage, events: (await runtime.journal.events(job.id)).map(event => event.type) }));
} finally { await runtime.close(); if (temporary) await rm(directory, { recursive: true, force: true }); }
