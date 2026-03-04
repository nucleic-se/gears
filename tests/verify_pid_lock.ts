
import { spawn } from 'child_process';
import path from 'path';

async function verifyPidLock() {
    console.log('--- Verifying PID Locking ---');

    const cliPath = path.resolve(process.cwd(), 'src/cli/index.ts');
    // Using npx tsx to interpret typescript on the fly
    const command = 'npx';
    const args = ['tsx', cliPath, 'work', '--timeout', '10', '--concurrency', '1'];

    console.log('[Test] Spawning Worker A...');
    const workerA = spawn(command, args, { cwd: process.cwd() });

    let aStarted = false;

    // Use a promise to wait for Worker A to acquire lock
    await new Promise<void>((resolve, reject) => {
        workerA.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[Worker A] ${output.trim()}`);
            if (output.includes('Booting worker')) {
                aStarted = true;
                resolve();
            }
        });

        workerA.stderr.on('data', (data) => {
            console.error(`[Worker A Error] ${data.toString()}`);
        });

        workerA.on('exit', (code) => {
            if (!aStarted) {
                reject(new Error(`Worker A exited prematurely with code ${code}`));
            }
        });
    });

    console.log('[Test] Worker A started and holds lock.');

    console.log('[Test] Spawning Worker B (Effectively a second instance)...');
    const workerB = spawn(command, args, { cwd: process.cwd() });

    let bFailed = false;

    await new Promise<void>((resolve) => {
        workerB.stderr.on('data', (data) => {
            const output = data.toString();
            console.log(`[Worker B Error] ${output.trim()}`);
        });

        workerB.stdout.on('data', (data) => {
            const output = data.toString();
            console.log(`[Worker B] ${output.trim()}`);
            if (output.includes('Failed to start worker') && output.includes('Worker already running')) {
                bFailed = true;
            }
        });

        workerB.on('exit', (code) => {
            console.log(`[Worker B] Exited with code ${code}`);
            resolve();
        });
    });

    if (bFailed) {
        console.log('[PASS] Worker B failed to start as expected.');
    } else {
        console.error('[FAIL] Worker B did not fail with expected error.');
        workerA.kill();
        process.exit(1);
    }

    console.log('[Test] Killing Worker A...');
    workerA.kill('SIGINT');

    await new Promise<void>(resolve => workerA.on('exit', resolve));
    console.log('[Test] Worker A stopped.');

    // Test Stale Lock?
    // Hard to test stale lock accurately without forcefully killing process (SIGKILL) which might leave file.
    // But basic functional test passed.
}

verifyPidLock().catch(err => {
    console.error(err);
    process.exit(1);
});
