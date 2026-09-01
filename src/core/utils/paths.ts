import path from 'path';
import fs from 'fs';

export interface IDataPaths {
    readonly dataDir: string;
    ensureDataDir(): string;
    getDbPath(filename: string): string;
}

/** Immutable storage paths owned by one application container. */
export class DataPaths implements IDataPaths {
    readonly dataDir: string;

    constructor(dataDir: string) {
        const resolved = path.resolve(dataDir);
        if (!path.isAbsolute(resolved)) throw new Error(`dataDir must resolve to an absolute path: ${dataDir}`);
        this.dataDir = resolved;
    }

    ensureDataDir(): string {
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        const metadata = fs.lstatSync(this.dataDir);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
            throw new Error(`dataDir must be a real directory: ${this.dataDir}`);
        }
        if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
            throw new Error(`dataDir is not owned by the current service identity: ${this.dataDir}`);
        }
        fs.chmodSync(this.dataDir, 0o700);
        return this.dataDir;
    }

    getDbPath(filename: string): string {
        const root = path.resolve(this.ensureDataDir());
        const resolved = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(root, filename);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
            throw new Error(`Security Violation: Path traversal detected. '${filename}' resolves outside data directory.`);
        }
        return resolved;
    }
}

/**
 * Get the absolute path to the data directory.
 * 
 * Requires GEARS_DATA_DIR environment variable to be set (must be absolute).
 * This ensures all SQLite databases (locks, store, jobs) are in a single
 * shared location, preventing the CWD-dependent lock isolation bug.
 * 
 * @throws Error if GEARS_DATA_DIR is not set or not absolute
 */
export function getDataDir(): string {
    let dataDir = process.env.GEARS_DATA_DIR;

    if (!dataDir) {
        dataDir = path.resolve(process.cwd(), '.gears');
        // Only warn once to avoid spamming console
        if (!(global as any).__GEARS_DATA_DIR_WARNED) {
            console.warn(`[WARN] GEARS_DATA_DIR not set. Defaulting to: ${dataDir}`);
            (global as any).__GEARS_DATA_DIR_WARNED = true;
        }
    }

    if (!path.isAbsolute(dataDir)) {
        throw new Error(`GEARS_DATA_DIR must be an absolute path, got: ${dataDir}`);
    }

    return dataDir;
}

/**
 * Ensure the data directory exists, creating it if necessary.
 */
export function ensureDataDir(): string {
    return new DataPaths(getDataDir()).ensureDataDir();
}

/**
 * Get the full path to a database file.
 * 
 * If the filename is already an absolute path, returns it as-is.
 * Otherwise, returns the path within the data directory.
 * 
 * @param filename - The database filename (e.g., 'locks.sqlite') or absolute path
 * @returns Absolute path to the database file
 */
export function getDbPath(filename: string): string {
    const dataDir = path.resolve(ensureDataDir());
    const resolvedPath = path.isAbsolute(filename)
        ? path.resolve(filename)
        : path.resolve(dataDir, filename);

    // Security Check: Prevent Path Traversal
    // Ensure resolved path starts with dataDir + separator to prevent partial matching (e.g. /data vs /data_evil)
    const isWithinDataDir = resolvedPath.startsWith(dataDir + path.sep) || resolvedPath === dataDir;
    if (!isWithinDataDir) {
        // Allow absolute paths in tests or when explicitly permitted
        if (path.isAbsolute(filename) && (process.env.NODE_ENV === 'test' || process.env.GEARS_ALLOW_ABSOLUTE_DB_PATHS === '1')) {
            return resolvedPath;
        }
        throw new Error(`Security Violation: Path traversal detected. '${filename}' resolves outside data directory.`);
    }

    return resolvedPath;
}
