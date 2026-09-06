import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Tree } from './state.js';
const workspace = resolve(process.argv[2] ?? process.cwd()), dataDir = await mkdtemp(join(tmpdir(), 'gears-agent-dogfood-'));
const deadline = AbortSignal.timeout(300000);
let child: ChildProcess | undefined;
function message(type: string): Promise<any> {
    return new Promise((resolve, reject) => {
        const current = child!;
        const cleanup = () => { current.off('message', receive); current.off('exit', exit); deadline.removeEventListener('abort', abort); };
        const receive = (value: any) => {
            if (value.type === 'error') {
                cleanup();
                reject(new Error(value.error));
            }
            else if (value.type === type) {
                cleanup();
                resolve(value);
            }
        };
        const exit = () => { cleanup(); reject(new Error('Worker exited before response')); };
        const abort = () => { cleanup(); reject(deadline.reason); };
        current.on('message', receive);
        current.once('exit', exit);
        deadline.addEventListener('abort', abort, { once: true });
    });
}
async function start() { child = fork(fileURLToPath(new URL('./cli.js', import.meta.url)), ['--data', dataDir, '--workspace', workspace, '--no-web'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); await message('ready'); }
async function inspect(id: string) {
    const result = message('state');
    child!.send({ type: 'inspect', id });
    return await result as {
        tree: Tree;
        queue: {
            overview: Record<string, number>;
        };
    };
}
async function stop(signal: NodeJS.Signals) { const current = child!; const exited = new Promise<void>(r => current.once('exit', () => r())); current.kill(signal); await exited; child = undefined; }
const startedAt = Date.now();
let id = '', restarted = false;
let latestTree: Tree | undefined;
async function saveReport(passed: boolean, error?: unknown) {
    const children = Object.values(latestTree?.tasks ?? {}).filter(task => task.parentId === id);
    const report = {
        scenario: 'source-review-with-restart', passed, id, dataDir, restarted,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        modelCalls: latestTree?.modelCalls, usage: latestTree?.usage,
        children: children.map(task => ({ id: task.id, phase: task.phase, answer: task.answer, error: task.error })),
        artifacts: latestTree?.artifacts, answer: latestTree?.tasks[id]?.answer,
        // Preserve the last observation even when the worker can no longer answer IPC.
        tree: latestTree,
    };
    const output = resolve('.data/dogfood-report.json');
    await mkdir(resolve('.data'), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ stage: 'finished', passed, report: output, modelCalls: report.modelCalls, usage: report.usage }));
}

try {
    await start();
    const created = message('created');
    child!.send({ type: 'create', prompt: `Audit this standalone harness in src/standalone/host.ts, state.ts, tools.ts and web.ts. Identify concrete correctness risks and recommend three improvements with file references. Do not modify source files.
First delegate exactly two independent subtasks using spawn_agent. One child reviews persistence, budgets and recovery in host.ts/state.ts; the other reviews tools, delegation and web boundaries in tools.ts/web.ts. Give each child tools ["read_file","list_files","save_artifact","save_progress"] and maxCalls 16, and enough context. Limit the review to the named files; do not audit dependencies. Children must inspect actual files and save findings to distinct artifacts.
Wait for both using wait_agents. Read their findings, save_progress with a useful summary, then call schedule_self ONCE with delaySeconds 30 and reason "Resume after restart acceptance check". Do not finish before the scheduled continuation. After waking, synthesize the findings into artifact review.md and give a concise final answer. Assess child findings as evidence, not unquestioned truth.` });
    id = (await created).id;
    console.log(JSON.stringify({ stage: 'started', id, dataDir }));
    let last = '';
    while (true) {
        deadline.throwIfAborted();
        const { tree, queue } = await inspect(id), root = tree.tasks[id];
        latestTree = tree;
        const phases = Object.values(tree.tasks).map(t => `${t.parentId ? 'child' : 'parent'}:${t.phase}`).join(',');
        if (phases !== last) {
            console.log(JSON.stringify({ stage: 'progress', phases, modelCalls: tree.modelCalls }));
            last = phases;
        }
        if (!restarted && root.phase === 'sleeping' && !(queue.overview.processing > 0)) {
            await stop('SIGKILL');
            console.log(JSON.stringify({ stage: 'killed-after-checkpoint' }));
            await delay(16000, undefined, { signal: deadline });
            await start();
            restarted = true;
            console.log(JSON.stringify({ stage: 'restarted' }));
        }
        if (root.phase === 'completed') {
            const children = Object.values(tree.tasks).filter(t => t.parentId === id);
            const passed = restarted && children.length === 2 && children.every(t => t.phase === 'completed') && Boolean(tree.artifacts['review.md']);
            if (!passed)
                throw new Error('Acceptance criteria not met');
            await saveReport(true);
            break;
        }
        if (['failed', 'unknown', 'cancelled'].includes(root.phase))
            throw new Error(`Task ended ${root.phase}: ${root.error}`);
        await delay(250, undefined, { signal: deadline });
    }
}
catch (error) {
    await saveReport(false, error);
    throw error;
}
finally {
    if (child)
        await stop('SIGTERM');
}
