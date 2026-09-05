import path from 'node:path';
import { SQLiteQueue } from '../../src/core/queue/SQLiteQueue.js';
import { Worker } from '../../src/core/queue/Worker.js';
import { Container } from '../../src/core/container/Container.js';

const queue = new SQLiteQueue('jobs.sqlite', undefined, file => path.join(process.env.GEARS_DATA_DIR!, file));
const app = new Container();
app.singleton('ILogger', () => ({ info() {}, debug() {}, warn() {}, error() {} }));
app.singleton('JobHandlers', () => new Map([['probe', async job => {
    process.send?.({ event: 'started', attempts: job.attempts, claim: job.claimToken, payload: job.payload });
    if (process.env.PROBE_MODE === 'hang') await new Promise<void>(() => {});
}]]));
const worker = new Worker(queue, app, { pollInterval: 5, recoveryTimeoutMs: 60, recoveryCheckIntervalMs: 10, heartbeatIntervalMs: 10 });
worker.start();
process.on('message', async message => {
    if (message === 'stop') {
        await worker.stop();
        await queue.close();
        process.disconnect();
    }
});
