import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { SubscriptionProvider } from '@nucleic-se/agentic/providers/subscription';
import { StandaloneHarness } from './host.js';
import { readProjectInstructions, projectInstructionText, projectInstructionTargets } from '@nucleic-se/agentic/harness';
import { attachWeb } from './web.js';
import { codingTools } from './coding.js';
import { realpathSync } from 'node:fs';
import { SqliteMemoryStore } from '@nucleic-se/agentic/runtime';
import { memoryTools } from './memory.js';
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
    const index = args.indexOf(name);
    if (index < 0)
        return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--'))
        throw new Error(`${name} requires a value`);
    return args[index + 1];
}
const dataDir = resolve(option('--data', '.data/standalone')), workspace = resolve(option('--workspace', process.cwd()));
const webEnabled = !args.includes('--no-web');
const token = webEnabled ? process.env.GEARS_AGENT_TOKEN ?? randomBytes(24).toString('hex') : undefined;
const hostname = option('--host', '127.0.0.1'), port = Number(option('--port', '4318'));
const model = option('--model', 'gpt-6-astra');
const modelTimeoutMs = Number(option('--model-timeout-ms', '300000'));
const coding = args.includes('--coding');
const memory = args.includes('--memory') ? await SqliteMemoryStore.open(resolve(dataDir, 'memory.sqlite'), realpathSync(workspace)) : undefined;
let host: StandaloneHarness;
try { host = await StandaloneHarness.open({ dataDir, modelTimeoutMs, provider: new SubscriptionProvider({ model, reasoningEffort: 'low' }),
    tools: [...codingTools(workspace, resolve(dataDir, 'outputs'), !coding), ...(memory ? memoryTools(memory, () => host) : [])],
    projectInstructions: async (messages, signal) => projectInstructionText(await readProjectInstructions(workspace, undefined, signal), projectInstructionTargets(messages, workspace)), composition: `default-v3:${workspace}:${model}`,
    extensions: webEnabled ? [{ id: 'ui.web', version: '1', apiVersion: 1, activate: async client => {
        const web = await attachWeb(client, { token: token!, port, hostname });
        return () => web.close();
    } }] : [],
}); } catch (error) { await memory?.close(); throw error; }
try {
    console.log(JSON.stringify({ type: 'ready', ...(webEnabled ? { url: `http://${hostname}:${port}`, token } : {}), workspace, dataDir, coding }));
    process.send?.({ type: 'ready' });
    process.on('message', async (message: {
        type: string;
        prompt?: string;
        id?: string;
    }) => {
        try {
            if (message.type === 'create') {
                const tree = await host.create(message.prompt!);
                process.send?.({ type: 'created', id: tree.id });
            }
            if (message.type === 'inspect') {
                const tree = await host.store.get(message.id!);
                process.send?.({ type: 'state', tree, queue: await host.app.make('IQueue').stats() });
            }
        }
        catch (error) {
            process.send?.({ type: 'error', error: String(error) });
        }
    });
    await new Promise<void>(resolve => { process.once('SIGINT', () => resolve()); process.once('SIGTERM', () => resolve()); });
}
finally {
    try { await host.close(); } finally { await memory?.close(); }
    if (process.connected) process.disconnect?.();
}
