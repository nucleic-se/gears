import { beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { Container } from '../../src/core/container/Container.js';
import { BundleManager } from '../../src/core/bundle/BundleManager.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = path.join(root, 'dist/src/cli/index.js');
// The runtime loads index.js bundles; compile TypeScript fixtures to that entrypoint.
async function fixture(dir: string, name: string, requires: string[] = []) {
    const folder = path.join(dir, name);
    await mkdir(folder);
    const source = (await readFile(new URL('../fixtures/lifecycle_bundle.ts', import.meta.url), 'utf8'))
        .replace('__NAME__', name).replace('[] as string[]', JSON.stringify(requires));
    await writeFile(path.join(folder, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(folder, 'index.js'), ts.transpileModule(source, { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
    } }).outputText);
    return folder;
}
function harness(configPath: string) {
    const app = new Container();
    app.singleton('ILogger', () => ({ info() {}, warn() {}, debug() {}, error() {} }));
    return { app, manager: new BundleManager(app, { configPath }) };
}
beforeAll(async () => { await exec(process.execPath, ['node_modules/typescript/bin/tsc'], { cwd: root }); });

it('cleans up partial provider boot and supports repeated load/unload', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-lifecycle-'));
    const { app, manager } = harness(path.join(dir, 'bundles.json'));
    try {
        const folder = await fixture(dir, 'probe');
        const module = await import(pathToFileURL(path.join(folder, 'index.js')).href);
        module.setFailBoot(true);
        await expect(manager.load(folder, { boot: true })).rejects.toThrow('probe boot failed');
        expect(app.bound('probe')).toBe(false);
        expect(module.events).toEqual(['opened', 'closed']);
        module.setFailBoot(false);
        for (let i = 0; i < 3; i++) {
            await manager.load(folder, { boot: true });
            expect(app.bound('probe')).toBe(true);
            await manager.unload('probe', { persist: false });
            expect(app.bound('probe')).toBe(false);
        }
        expect(module.events.filter((event: string) => event === 'closed')).toHaveLength(4);
    } finally { await manager.close(); await app.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

it('removes dependent bundles before their dependencies in a single config reload', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-dependents-'));
    const config = path.join(dir, 'bundles.json');
    const { app, manager } = harness(config);
    try {
        const base = await fixture(dir, 'base');
        const dependent = await fixture(dir, 'dependent', ['base']);
        await writeFile(config, JSON.stringify({ bundles: [base, dependent] }));
        await manager.restore({ watch: true, boot: true });
        expect(app.bound('base')).toBe(true);
        await writeFile(config, '{"bundles":[]}');
        await manager.restore({ watch: true, boot: true });
        expect(manager.getLoadedBundles()).toEqual([]);
        expect(app.bound('base')).toBe(false);
        expect(app.bound('dependent')).toBe(false);
    } finally { await manager.close(); await app.shutdown(); await rm(dir, { recursive: true, force: true }); }
});

it.each(['command', 'boot'])('CLI disposes services and exits after %s failure', async failure => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-cli-'));
    try {
        const folder = await fixture(dir, 'probe');
        const marker = path.join(dir, 'closed.txt');
        await writeFile(path.join(dir, 'bundles.json'), JSON.stringify({ bundles: [folder] }));
        const result = await exec(process.execPath, [cli, 'probe', 'fail'], {
            cwd: dir, timeout: 5000,
            env: { ...process.env, GEARS_DATA_DIR: path.join(dir, '.gears'), PROBE_MARKER: marker, PROBE_FAIL_BOOT: failure === 'boot' ? '1' : '0' },
        }).catch(error => error);
        expect(result.code).toBe(1);
        expect(result.killed).not.toBe(true);
        expect(result.stderr).toContain(`probe ${failure} failed`);
        expect(await readFile(marker, 'utf8')).toBe('closed\n');
    } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(['0', '1oops', '0.5'])('rejects timeout %s before acquiring the worker lock', async timeout => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-options-'));
    try {
        const result = await exec(process.execPath, [cli, 'work', '--timeout', timeout], {
            cwd: dir, timeout: 3000, env: { ...process.env, GEARS_DATA_DIR: path.join(dir, '.gears') },
        }).catch(error => error);
        expect(result.code).toBe(1);
        expect(result.killed).not.toBe(true);
        await expect(access(path.join(dir, '.gears', 'worker.pid'))).rejects.toThrow();
        await expect(access(path.join(dir, '.gears', 'jobs.sqlite'))).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
});

it('clears a future worker timeout when shutdown is triggered by a signal', async () => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const dir = await mkdtemp(path.join(tmpdir(), 'gears-signal-'));
    const child = spawn(process.execPath, [cli, '--output', 'text', 'work', '--timeout', '3600'], {
        cwd: dir, env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', GEARS_DATA_DIR: path.join(dir, '.gears') },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exit = once(child, 'exit');
    try {
        await expect.poll(() => output, { timeout: 3000 }).toContain('Worker started polling');
        child.kill('SIGTERM');
        await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 3000 }).toBe(true);
        expect(child.exitCode, output).toBe(0);
        await exit;
        await expect(access(path.join(dir, '.gears', 'worker.pid'))).rejects.toThrow();
    } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
        await rm(dir, { recursive: true, force: true });
    }
});
