
import { SQLiteMutex } from '../src/core/infra/SQLiteMutex';
import { fork } from 'child_process';
import path from 'path';

// Worker logic
if (process.argv[2] === 'worker') {
    const id = process.argv[3];
    const mutex = new SQLiteMutex(path.resolve(process.cwd(), 'test-locks.sqlite'));

    (async () => {
        console.log(`[Worker ${id}] Attempting to acquire lock...`);
        const acquired = await mutex.acquire('test-lock', 5000);
        if (acquired) {
            console.log(`[Worker ${id}] ACQUIRED lock. Holding for 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            await mutex.release('test-lock');
            console.log(`[Worker ${id}] RELEASED lock.`);
            process.exit(0);
        } else {
            console.log(`[Worker ${id}] FAILED to acquire lock.`);
            process.exit(1);
        }
    })();
}
// Orchestrator logic
else {
    (async () => {
        console.log('--- Starting Mutex Concurrency Test ---');
        const { fileURLToPath } = await import('url');
        const scriptPath = fileURLToPath(import.meta.url);

        // Start Worker A
        const p1 = fork(scriptPath, ['worker', 'A']);

        // Wait small bit to ensure A gets head start
        await new Promise(r => setTimeout(r, 500));

        // Start Worker B - should fail to acquire
        const p2 = fork(scriptPath, ['worker', 'B']);

        const p1Promise = new Promise(resolve => p1.on('exit', resolve));
        const p2Promise = new Promise(resolve => p2.on('exit', resolve));

        await Promise.all([p1Promise, p2Promise]);

        console.log('--- Test Complete ---');
    })();
}
