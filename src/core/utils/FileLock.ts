import fs from 'fs/promises';
import { ILogger } from '../interfaces.js';

export class FileLock {
    private lockPath: string;
    private logger?: ILogger;
    private isAcquired: boolean = false;

    constructor(filePath: string, options: { logger?: ILogger } = {}) {
        this.lockPath = `${filePath}.lock`;
        this.logger = options.logger;
    }

    /**
     * Acquire the lock. Throws if unable to acquire after retries.
     * Uses O_EXCL for atomic creation.
     */
    async acquire(retries = 10, delayMs = 100): Promise<void> {
        for (let i = 0; i < retries; i++) {
            try {
                // 'wx' = Open for writing, fail if exists (Atomic)
                // We use 'wx' flag with writeFile, or open with 'wx'
                const fileHandle = await fs.open(this.lockPath, 'wx');
                try {
                    await fileHandle.write(String(process.pid));
                } finally {
                    await fileHandle.close();
                }

                this.isAcquired = true;
                return;
            } catch (e: any) {
                if (e.code === 'EEXIST') {
                    // Check for stale lock
                    const stale = await this.isStale();
                    if (stale) {
                        try {
                            await fs.unlink(this.lockPath);
                            if (this.logger) this.logger.warn(`Removed stale lock file`, { path: this.lockPath });
                            // Retry immediately
                            i--;
                            continue;
                        } catch (unlinkErr: any) {
                            // Race condition: someone else removed it or acquired it?
                            // If ENOENT, it's gone, good. 
                            // If EPERM, we can't remove it (maybe Windows), just wait.
                        }
                    }

                    // Wait and retry
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                } else {
                    throw e;
                }
            }
        }
        throw new Error(`Failed to acquire lock for ${this.lockPath} after ${retries} attempts`);
    }

    /**
     * Release the lock. 
     * Only deletes the file if we successfully acquired it.
     */
    async release(): Promise<void> {
        if (!this.isAcquired) {
            return;
        }

        try {
            await fs.unlink(this.lockPath);
            this.isAcquired = false;
        } catch (e: any) {
            // Ignore if already gone (ENOENT)
            if (e.code !== 'ENOENT') {
                this.logger?.warn('Failed to release lock file', { path: this.lockPath, error: e.message });
            }
        }
    }

    /**
     * Check if the lock is stale.
     * A lock is stale ONLY if the process that created it is no longer running.
     */
    private async isStale(): Promise<boolean> {
        try {
            const pidStr = await fs.readFile(this.lockPath, 'utf-8');
            const pid = parseInt(pidStr.trim(), 10);

            if (isNaN(pid)) {
                // Invalid content, assume stale/corrupt
                return true;
            }

            try {
                // Check if process exists. 
                // process.kill(pid, 0) throws if process does not exist.
                // It returns true (void) if it exists.
                process.kill(pid, 0);
                return false; // Process is alive, lock is valid
            } catch (e: any) {
                if (e.code === 'ESRCH') {
                    return true; // Process not found, lock is stale
                }
                // EPERM means process exists but we can't signal it (owned by another user).
                // In that case, we assume it's alive.
                return false;
            }

        } catch (e: any) {
            // If file doesn't exist (ENOENT), it's not stale (it's free).
            if (e.code === 'ENOENT') return false;
            // If we can't read it due to permission, assume it's alive (safety).
            if (e.code === 'EACCES' || e.code === 'EPERM') return false;

            // For other read errors (e.g. EISDIR, EINVAL, EIO), treat as corrupt/stale
            // so we don't deadlock forever on a bad file.
            return true;
        }
    }
}
