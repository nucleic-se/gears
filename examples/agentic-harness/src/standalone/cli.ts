import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { CodexSubscriptionProvider } from '@nucleic-se/agentic/providers';
import { StandaloneHarness } from './host.js';
import { workspaceTools } from './tools.js';
import { attachWeb } from './web.js';
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
const host = await StandaloneHarness.open({ dataDir, provider: new CodexSubscriptionProvider({ model: option('--model', 'gpt-6-astra'), reasoningEffort: 'low' }),
    tools: await workspaceTools(workspace), composition: `default-v1:${workspace}` });
let web: Awaited<ReturnType<typeof attachWeb>> | undefined;
try {
    if (!args.includes('--no-web')) {
        const token = process.env.GEARS_AGENT_TOKEN ?? randomBytes(24).toString('hex');
        web = await attachWeb(host, { token, port: Number(option('--port', '4318')), hostname: option('--host', '127.0.0.1') });
        console.log(JSON.stringify({ type: 'ready', url: `http://${option('--host', '127.0.0.1')}:${option('--port', '4318')}`, token, workspace, dataDir }));
    }
    else
        console.log(JSON.stringify({ type: 'ready', workspace, dataDir }));
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
    await web?.close();
    await host.close();
    if (process.connected) process.disconnect?.();
}
