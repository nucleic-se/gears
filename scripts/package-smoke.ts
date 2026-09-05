import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = process.cwd();
const temp = mkdtempSync(path.join(tmpdir(), 'gears-package-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run test:package');
function npm(args: string[], cwd: string) {
    return execFileSync(process.execPath, [npmCli!, ...args], { cwd, encoding: 'utf8', timeout: 180_000 });
}
try {
    const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], root))[0];
    for (const file of packed.files as { path: string }[]) {
        assert(!/^dist\/(examples|scripts)\//.test(file.path), `Unexpected packaged file: ${file.path}`);
    }
    writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    npm(['install', '--no-audit', '--no-fund', '--omit=dev', path.join(temp, packed.filename)], temp);
    const consumer = `
import assert from 'node:assert/strict';
import { boot, Container } from '@nucleic-se/gears';
import { TestContainer } from '@nucleic-se/gears/testing';
import { DatabaseServiceProvider } from '@nucleic-se/gears/database';
const app = await boot({ dataDir: process.cwd() + '/data' });
assert(app instanceof Container);
const provider = new DatabaseServiceProvider(app);
await provider.register();
await provider.boot();
const job = await app.make('IQueue').add('smoke', { value: 42 });
assert.equal((await app.make('IQueue').get(job.id))?.payload.value, 42);
await app.shutdown();
const test = new TestContainer();
await test.make('IStore').set('hello', 'world');
assert.equal(await test.make('IStore').get('hello'), 'world');
await test.shutdown();
`;
    // Run before installing consumer tooling: runtime cannot rely on dev dependencies.
    writeFileSync(path.join(temp, 'consumer.mjs'), consumer);
    execFileSync(process.execPath, ['consumer.mjs'], { cwd: temp, stdio: 'inherit', timeout: 15_000 });
    const cli = path.join(temp, 'node_modules', '.bin', 'gears');
    const version = execFileSync(cli, ['--version'], { cwd: temp, encoding: 'utf8', timeout: 10_000 });
    assert.equal(version.trim(), JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    npm(['install', '--no-audit', '--no-fund', '--save-dev', 'typescript@5.9.3', '@types/node@22'], temp);
    writeFileSync(path.join(temp, 'consumer.ts'), consumer);
    writeFileSync(path.join(temp, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true },
        files: ['consumer.ts'],
    }));
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { cwd: temp, stdio: 'inherit', timeout: 30_000 });
    console.log(`Package smoke passed on ${process.version}`);
} finally {
    rmSync(temp, { recursive: true, force: true });
}
