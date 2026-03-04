import fs from 'fs';
import path from 'path';
import { getDbPath } from '../utils/paths.js';

export class PidLocker {
    private lockPath: string;

    constructor(lockFile: string = 'worker.pid') {
        this.lockPath = getDbPath(lockFile);
    }

    /**
     * Attempts to acquire the lock.
     * Throws if another active worker holds the lock.
     * Cleans up stale locks.
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
                const fd = fs.openSync(this.lockPath, 'wx');
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

                // Stale lock: atomically rename it out of the way instead of unlinking.
                // This prevents a TOCTOU race where two processes both see the same stale PID,
                // both unlink, and both successfully create a new lock via O_EXCL.
                // With rename, only one process moves the stale file; the other's rename
                // fails with ENOENT, and its subsequent O_EXCL attempt correctly loses the race.
                const stalePath = `${this.lockPath}.stale.${process.pid}`;
                try {
                    fs.renameSync(this.lockPath, stalePath);
                    // Clean up the renamed stale file
                    try { fs.unlinkSync(stalePath); } catch { /* best effort */ }
                } catch (renameErr: any) {
                    if (renameErr.code === 'ENOENT') {
                        // Another process already cleaned up the stale lock — retry O_EXCL
                        continue;
                    }
                    throw new Error('Unable to clear stale worker lock');
                }
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
