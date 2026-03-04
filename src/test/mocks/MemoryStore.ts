import type { IStore } from '../../core/interfaces.js';

interface Entry {
    value: any;
    expiresAt: number | null;
}

export class MemoryStore implements IStore {
    private data = new Map<string, Entry>();
    private readonly prefix: string;

    constructor(prefix = '') {
        this.prefix = prefix;
    }

    private fullKey(key: string): string {
        return this.prefix ? `${this.prefix}:${key}` : key;
    }

    private isExpired(entry: Entry): boolean {
        return entry.expiresAt !== null && Date.now() > entry.expiresAt;
    }

    async get<T = any>(key: string): Promise<T | null> {
        const entry = this.data.get(this.fullKey(key));
        if (!entry || this.isExpired(entry)) return null;
        return entry.value as T;
    }

    async set<T = any>(key: string, value: T, ttlMs?: number): Promise<void> {
        this.data.set(this.fullKey(key), {
            value,
            expiresAt: ttlMs != null ? Date.now() + ttlMs : null,
        });
    }

    async setIfNotExists<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean> {
        const existing = this.data.get(this.fullKey(key));
        if (existing && !this.isExpired(existing)) return false;
        await this.set(key, value, ttlMs);
        return true;
    }

    async delete(key: string): Promise<boolean> {
        return this.data.delete(this.fullKey(key));
    }

    async has(key: string): Promise<boolean> {
        const entry = this.data.get(this.fullKey(key));
        return !!entry && !this.isExpired(entry);
    }

    namespace(prefix: string): IStore {
        const combined = this.prefix ? `${this.prefix}:${prefix}` : prefix;
        // Share the same underlying Map so namespaced views see each other's writes.
        const child = new MemoryStore(combined);
        child.data = this.data;
        return child;
    }

    async scan<T = any>(prefix?: string): Promise<Record<string, T>> {
        const result: Record<string, T> = {};
        const scopePrefix = this.prefix ? `${this.prefix}:` : '';
        const filterPrefix = prefix ? `${scopePrefix}${prefix}` : scopePrefix;

        for (const [k, entry] of this.data) {
            if (this.isExpired(entry)) continue;
            if (!k.startsWith(filterPrefix)) continue;
            const relativeKey = k.slice(scopePrefix.length);
            result[relativeKey] = entry.value as T;
        }
        return result;
    }

    /** Test helper: wipe all entries. */
    clear(): void {
        this.data.clear();
    }
}
