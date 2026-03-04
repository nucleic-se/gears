import fs from 'fs/promises';
import { FileLock } from './FileLock.js';
import { ILogger } from '../interfaces.js';

/**
 * Atomic, lock-protected read/modify/write for a JSON config file.
 * Handles corrupt files, missing files, temp-write + rename, and Windows rename quirks.
 */
export class JsonConfigFile {
    private filePath: string;
    private logger: ILogger;

    constructor(filePath: string, logger: ILogger) {
        this.filePath = filePath;
        this.logger = logger;
    }

    /**
     * Atomically read-modify-write the config file under a file lock.
     * The `mutate` callback receives the current data (or `defaultValue` if the file
     * is missing/corrupt). Return the modified object to write, or `undefined` to skip writing.
     */
    async update<T>(mutate: (data: T) => T | undefined | Promise<T | undefined>, defaultValue: T): Promise<void> {
        const lock = new FileLock(this.filePath, { logger: this.logger });

        try {
            await lock.acquire(50, 100);
            const data = await this.read(defaultValue);
            const result = await mutate(data);
            if (result !== undefined) {
                await this.atomicWrite(result);
            }
        } finally {
            await lock.release();
        }
    }

    private async read<T>(defaultValue: T): Promise<T> {
        try {
            const raw = await fs.readFile(this.filePath, 'utf-8');
            try {
                return JSON.parse(raw);
            } catch (parseErr: any) {
                this.logger.error(`Invalid JSON in ${this.filePath}`, { error: parseErr.message });
                const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
                try {
                    await fs.rename(this.filePath, corruptPath);
                    this.logger.warn(`Backed up corrupt file`, { path: corruptPath });
                } catch (backupErr: any) {
                    this.logger.warn(`Failed to backup corrupt file`, { error: backupErr.message });
                }
                return defaultValue;
            }
        } catch (e: any) {
            if (e.code !== 'ENOENT') {
                this.logger.warn(`Could not read ${this.filePath}`, { error: e.message });
            }
            return defaultValue;
        }
    }

    private async atomicWrite(data: unknown): Promise<void> {
        const tempPath = `${this.filePath}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
        try {
            await fs.rename(tempPath, this.filePath);
        } catch (e: any) {
            if (e.code === 'EPERM' || e.code === 'EEXIST') {
                // Windows: target exists/locked — move target to backup first
                const backupPath = `${this.filePath}.bak`;
                await fs.unlink(backupPath).catch(() => {});
                try {
                    await fs.rename(this.filePath, backupPath);
                    await fs.rename(tempPath, this.filePath);
                    await fs.unlink(backupPath).catch(() => {});
                } catch (renameErr) {
                    await fs.rename(backupPath, this.filePath).catch(() => {});
                    throw renameErr;
                }
            } else {
                throw e;
            }
        }
    }
}
