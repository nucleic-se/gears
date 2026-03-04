import Database from 'better-sqlite3';
import { IMutex } from '../interfaces.js';
import { getDbPath } from '../utils/paths.js';
import crypto from 'crypto';

export class SQLiteMutex implements IMutex {
    private db: Database.Database;
    private owners = new Map<string, string>();

    constructor(dbPath: string = 'locks.sqlite') {
        const fullPath = getDbPath(dbPath);
        this.db = new Database(fullPath);
        this.init();
    }

    private init() {
        // Harden SQLite for multi-process concurrency
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');

        this.db.exec(`
      CREATE TABLE IF NOT EXISTS locks (
        key TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        owner_id TEXT NOT NULL
      )
    `);

        try {
            this.db.prepare('ALTER TABLE locks ADD COLUMN owner_id TEXT').run();
        } catch {
            // Column already exists.
        }

        // Clear any legacy rows without an owner to avoid unsafe refresh/release behavior.
        this.db.prepare('DELETE FROM locks WHERE owner_id IS NULL').run();
    }

    async acquire(key: string, ttlMs: number): Promise<boolean> {
        if (!key) throw new Error('Lock key cannot be empty');
        if (ttlMs <= 0) throw new Error('Lock TTL must be greater than 0');

        const now = Date.now();
        const expiresAt = now + ttlMs;
        const ownerId = crypto.randomUUID();

        // Atomic acquire: Clean up expired locks AND try to acquire new one in single transaction
        const acquireTx = this.db.transaction(() => {
            // 1. Clean up expired locks (for this key or all? Better just this key to minimize write contention, 
            // but the original code did global cleanup. Let's stick to global cleanup but maybe optimized? 
            // Actually, deleting ALL expired locks every acquire is a bit heavy but correct for correctness.
            // Let's optimize: only delete expired locks for the key we want OR global cleanup? 
            // Original code: 'DELETE FROM locks WHERE expires_at < ?' (global)
            // Let's keep global for now to prevent zombies, but it might be a perf bottleneck. 
            // Optimally, a background job cleans up. But for now, correctness first.
            this.db.prepare('DELETE FROM locks WHERE expires_at < ?').run(now);

            try {
                this.db.prepare('INSERT INTO locks (key, expires_at, owner_id) VALUES (?, ?, ?)')
                    .run(key, expiresAt, ownerId);
                return true;
            } catch (err: any) {
                if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
                    return false; // Already locked
                }
                throw err;
            }
        });

        try {
            // IMMEDIATE to block other writers
            const success = acquireTx.immediate();
            if (success) {
                this.owners.set(key, ownerId);
            }
            return success;
        } catch (err) {
            if (String(err).includes('SQLITE_BUSY')) return false;
            throw err;
        }
    }

    async refresh(key: string, ttlMs: number): Promise<boolean> {
        const ownerId = this.owners.get(key);
        if (!ownerId) {
            return false;
        }

        const now = Date.now();
        const expiresAt = now + ttlMs;
        const result = this.db.prepare(`
            UPDATE locks
            SET expires_at = ?
            WHERE key = ? AND owner_id = ? AND expires_at >= ?
        `).run(expiresAt, key, ownerId, now);

        if (result.changes !== 1) {
            // Lock was released, expired, or stolen — clear stale local state
            this.owners.delete(key);
            return false;
        }

        return true;
    }

    async release(key: string): Promise<void> {
        const ownerId = this.owners.get(key);
        if (ownerId) {
            this.db.prepare('DELETE FROM locks WHERE key = ? AND owner_id = ?').run(key, ownerId);
            this.owners.delete(key);
        }
        // If we don't own it locally, do nothing.
    }

    async close(): Promise<void> {
        if (!this.db.open) return;

        // Release all owned locks
        const releaseStmt = this.db.prepare('DELETE FROM locks WHERE key = ? AND owner_id = ?');
        const releaseTx = this.db.transaction(() => {
            for (const [key, ownerId] of this.owners.entries()) {
                releaseStmt.run(key, ownerId);
            }
        });

        try {
            releaseTx.immediate();
        } catch (e) {
            // Ignore errors during close, best effort
        }

        this.owners.clear();
        this.db.close();
    }
}
