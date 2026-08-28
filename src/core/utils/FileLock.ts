import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { ILogger } from '../interfaces.js';

interface LockOwner {
    pid: number;
    token?: string;
}

export class FileLock {
    private lockPath: string;
    private logger?: ILogger;
    private isAcquired: boolean = false;
    private ownerToken: string | null = null;

    constructor(filePath: string, options: { logger?: ILogger } = {}) {
        this.lockPath = `${filePath}.lock`;
        this.logger = options.logger;
    }

    /**
     * Acquire the lock. Throws if unable to acquire after retries.
     * Publishes complete owner metadata with an exclusive hard link.
     */
    async acquire(retries = 10, delayMs = 100): Promise<void> {
        const token = randomUUID();

        for (let i = 0; i < retries; i++) {
            try {
                await this.publishOwner({ pid: process.pid, token });
                this.isAcquired = true;
                this.ownerToken = token;
                return;
            } catch (e: any) {
                if (e.code === 'EEXIST') {
                    // Check for stale lock
                    const stale = await this.isStale();
                    if (stale) {
                        if (await this.moveStaleLock()) {
                            this.logger?.warn(`Removed stale lock file`, { path: this.lockPath });
                            i--; // Stale cleanup does not consume an acquisition attempt.
                            continue;
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
        if (!this.isAcquired || !this.ownerToken) {
            return;
        }

        try {
            const owner = await this.readOwner();
            if (owner?.token !== this.ownerToken) {
                this.isAcquired = false;
                this.ownerToken = null;
                return;
            }

            await fs.unlink(this.lockPath);
            this.isAcquired = false;
            this.ownerToken = null;
        } catch (e: any) {
            // Ignore if already gone (ENOENT)
            if (e.code === 'ENOENT') {
                this.isAcquired = false;
                this.ownerToken = null;
                return;
            }
            this.logger?.warn('Failed to release lock file', { path: this.lockPath, error: e.message });
        }
    }

    private async publishOwner(owner: LockOwner): Promise<void> {
        const tempPath = `${this.lockPath}.${owner.token}.tmp`;
        try {
            await fs.writeFile(tempPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
            // A hard link publishes the already-complete file and fails if the lock exists.
            await fs.link(tempPath, this.lockPath);
        } finally {
            await fs.rm(tempPath, { force: true });
        }
    }

    private async moveStaleLock(): Promise<boolean> {
        const stalePath = `${this.lockPath}.stale.${randomUUID()}`;
        try {
            await fs.rename(this.lockPath, stalePath);
            await fs.rm(stalePath, { force: true });
            return true;
        } catch (error: any) {
            if (error.code === 'ENOENT') return true;
            return false;
        }
    }

    private async readOwner(): Promise<LockOwner | null> {
        const raw = (await fs.readFile(this.lockPath, 'utf8')).trim();
        if (/^\d+$/.test(raw)) {
            return { pid: Number(raw) };
        }

        try {
            const owner = JSON.parse(raw) as Partial<LockOwner>;
            if (Number.isInteger(owner.pid) && owner.pid! > 0) {
                return {
                    pid: owner.pid!,
                    token: typeof owner.token === 'string' ? owner.token : undefined,
                };
            }
        } catch {
            // Invalid metadata is handled as a stale/corrupt lock.
        }
        return null;
    }

    /**
     * Check if the lock is stale.
     * A lock is stale if its metadata is corrupt or its owner process is gone.
     */
    private async isStale(): Promise<boolean> {
        try {
            const owner = await this.readOwner();
            if (!owner) {
                // Invalid content, assume stale/corrupt
                return true;
            }

            try {
                // Check if process exists.
                // process.kill(owner.pid, 0) throws if process does not exist.
                // It returns true (void) if it exists.
                process.kill(owner.pid, 0);
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
