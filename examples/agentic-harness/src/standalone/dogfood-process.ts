import type { ChildProcess } from 'node:child_process';

/** Sequential controller IPC. Always settles on cancellation, process exit or spawn failure. */
export function waitForWorkerMessage(child: ChildProcess, type: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            child.off('message', receive); child.off('exit', exited); child.off('error', failed);
            signal.removeEventListener('abort', aborted);
        };
        const failed = (error: unknown) => { cleanup(); reject(error); };
        const exited = () => failed(new Error('Worker exited before response'));
        const aborted = () => failed(signal.reason);
        const receive = (value: unknown) => {
            if (!value || typeof value !== 'object' || !('type' in value)) return;
            const message = value as Record<string, unknown>;
            if (message.type === 'error') failed(new Error(String(message.error)));
            else if (message.type === type) { cleanup(); resolve(message); }
        };
        if (signal.aborted) { reject(signal.reason); return; }
        if (child.exitCode !== null || child.signalCode !== null) { reject(new Error('Worker already exited')); return; }
        child.on('message', receive); child.once('exit', exited); child.once('error', failed);
        signal.addEventListener('abort', aborted, { once: true });
    });
}

/** Owns only the disposable dogfood child. Escalate an unresponsive shutdown to SIGKILL. */
export function stopWorker(child: ChildProcess, signal: NodeJS.Signals, graceMs = 15000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        const cleanup = () => { clearTimeout(timer); child.off('exit', exited); child.off('error', failed); };
        const exited = () => { cleanup(); resolve(); };
        const failed = (error: Error) => { cleanup(); reject(error); };
        child.once('exit', exited); child.once('error', failed);
        child.kill(signal);
    });
}
