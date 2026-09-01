import fs from 'node:fs';

export function validatePrivateDatabasePath(file: string): void {
    if (fs.existsSync(file)) {
        validateOwnedRegularFile(file);
        fs.chmodSync(file, 0o600);
    }
}

export function hardenPrivateDatabaseFiles(file: string): void {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        if (!fs.existsSync(candidate)) continue;
        validateOwnedRegularFile(candidate);
        fs.chmodSync(candidate, 0o600);
    }
}

function validateOwnedRegularFile(file: string): void {
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`SQLite path must be a regular non-symlink file: ${file}`);
    }
    if (metadata.nlink !== 1) throw new Error(`SQLite path must not have hard-link aliases: ${file}`);
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
        throw new Error(`SQLite path is not owned by the current service identity: ${file}`);
    }
}
