import fs from 'fs';
import path from 'path';
import { getDbPath } from '../utils/paths.js';

export class PidLocker {
    private lockPath: string;

    constructor(lockFile: string = 'worker.pid', resolvePath: (file: string) => string = getDbPath) {
        this.lockPath = resolvePath(lockFile);
    }

    /**
     * Attempts to acquire the lock.
     * Throws if another active worker holds the lock.
     * Refuses stale locks; cleanup is an explicit stopped-service operation.
     */
    acquire(): void {
        const lockDir = path.dirname(this.lockPath);
        fs.mkdirSync(lockDir, { recursive: true });

        const payload = JSON.stringify({
            pid: process.pid,
            startedAt: Date.now()
        });

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const fd = fs.openSync(this.lockPath, 'wx', 0o600);
                try {
                    fs.writeFileSync(fd, payload, 'utf8');
                } finally {
                    fs.closeSync(fd);
                }
                return;
            } catch (e: any) {
                if (e.code !== 'EEXIST') {
                    throw e;
                }

                const existingPid = this.readPidFromLock();
                if (existingPid !== null && this.isPidRunning(existingPid)) {
                    throw new Error(`Worker already running (PID: ${existingPid})`);
                }

                throw new Error(`Stale worker lock requires explicit cleanup while the worker is stopped: ${this.lockPath}`);
            }
        }

        throw new Error('Unable to acquire worker lock');
    }

    /**
     * Releases the lock file.
     * Only removes if it matches our PID (to avoid removing a new worker's lock if we stalled)
     * Although acquire() would overwrite, checking is safer.
     */
    release(): void {
        try {
            if (fs.existsSync(this.lockPath)) {
                const pid = this.readPidFromLock();

                if (pid === process.pid) {
                    fs.unlinkSync(this.lockPath);
                }
            }
        } catch (e) {
            // Ignore errors during release (best effort)
        }
    }

    private readPidFromLock(): number | null {
        try {
            const raw = fs.readFileSync(this.lockPath, 'utf8').trim();
            if (!raw) return null;

            try {
                const data = JSON.parse(raw) as { pid?: number };
                if (typeof data.pid === 'number' && !Number.isNaN(data.pid)) {
                    return data.pid;
                }
            } catch {
                if (/^\d+$/.test(raw)) {
                    return parseInt(raw, 10);
                }
            }
        } catch {
            // Ignore read errors
        }
        return null;
    }

    private isPidRunning(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (e: any) {
            if (e.code === 'EPERM') return true;
            if (e.code === 'ESRCH') return false;
            return false;
        }
    }
}
