import { reconciliationFixture } from './dogfood-fixture.js';
import { waitForWorkerMessage, stopWorker } from './dogfood-process.js';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { Tree } from './state.js';
const scenario = process.env.AGENTIC_DOGFOOD_SCENARIO ?? 'source-review-with-restart';
if (!['source-review-with-restart', 'reconciliation-with-restart'].includes(scenario)) throw new Error('Unknown dogfood scenario');
const dataDir = await mkdtemp(join(tmpdir(), 'gears-agent-dogfood-'));
const fixture = scenario === 'reconciliation-with-restart' ? reconciliationFixture() : undefined;
const workspace = fixture ? join(dataDir, 'fixture') : resolve(process.argv[2] ?? process.cwd());
if (fixture) {
    await mkdir(workspace);
    for (const [name, content] of Object.entries(fixture.files)) await writeFile(join(workspace, name), content);
}
const model = process.env.AGENTIC_EVAL_MODEL ?? 'gpt-5.6-terra';
const deadline = AbortSignal.timeout(900000);
let child: ChildProcess | undefined;
function message(type: string) { return waitForWorkerMessage(child!, type, deadline); }
async function start() { child = fork(fileURLToPath(new URL('./cli.js', import.meta.url)), ['--data', dataDir, '--workspace', workspace, '--model', model, '--no-web'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }); await message('ready'); }
async function inspect(id: string) {
    const result = message('state');
    child!.send({ type: 'inspect', id });
    return await result as unknown as {
        tree: Tree;
        queue: {
            overview: Record<string, number>;
        };
    };
}
async function stop(signal: NodeJS.Signals) { if (child) await stopWorker(child, signal); child = undefined; }
const startedAt = Date.now();
let id = '', restarted = false;
let latestTree: Tree | undefined;
async function saveReport(passed: boolean, error?: unknown) {
    const children = Object.values(latestTree?.tasks ?? {}).filter(task => task.parentId === id);
    const report = {
        scenario, expected: fixture?.expected, model, passed, id, dataDir, restarted,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
        modelCalls: latestTree?.modelCalls, usage: latestTree?.usage,
        children: children.map(task => ({ id: task.id, phase: task.phase, answer: task.answer, error: task.error })),
        artifacts: latestTree?.artifacts, answer: latestTree?.tasks[id]?.answer,
        // Preserve the last observation even when the worker can no longer answer IPC.
        tree: latestTree,
    };
    const directory = resolve('.data/dogfood');
    const output = join(directory, basename(dataDir) + '.json');
    await mkdir(directory, { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ stage: 'finished', passed, report: output, modelCalls: report.modelCalls, usage: report.usage }));
}

try {
    await start();
    const created = message('created');
    child!.send({ type: 'create', prompt: fixture?.prompt ?? `Audit this standalone harness in src/standalone/host.ts, state.ts, tools.ts and web.ts. Identify concrete correctness risks and recommend three improvements with file references. Do not modify source files.
First delegate exactly two independent subtasks using spawn_agent. One child reviews persistence, budgets and recovery in host.ts/state.ts; the other reviews tools, delegation and web boundaries in tools.ts/web.ts. Give each child tools ["fs_read","fs_list","save_artifact","save_progress"] and maxCalls 16, and enough context. Limit the review to the named files; do not audit dependencies. Children must inspect actual files and save findings to distinct artifacts.
Wait for both using wait_agents. Read their findings, save_progress with a useful summary, then call schedule_self ONCE with delaySeconds 30 and reason "Resume after restart acceptance check". Do not finish before the scheduled continuation. After waking, synthesize the findings into artifact review.md and give a concise final answer. Assess child findings as evidence, not unquestioned truth.` });
    const createdId = (await created).id;
    if (typeof createdId !== 'string' || !createdId) throw new Error('Worker returned an invalid task ID');
    id = createdId;
    console.log(JSON.stringify({ stage: 'started', model, id, dataDir }));
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
            const passed = restarted && children.length === 2 && children.every(t => t.phase === 'completed') && Boolean(tree.artifacts['review.md']) && (!fixture || (tree.artifacts['review.md'].trim() === fixture.expected && root.answer?.trim() === fixture.expected));
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
