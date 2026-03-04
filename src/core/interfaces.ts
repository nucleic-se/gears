
export interface FetchOptions {
    headers?: Record<string, string>;
    timeout?: number;
    retries?: number;
}

export interface FetchResponse {
    body: string | Buffer;
    status: number;
    headers: Record<string, string>;
    contentType: string;
}

export interface IElement {
    text(): string;
    // Returns the value of the attribute or null if missing
    attr(name: string): string | null;
    query(selector: string): IElement[];
    queryOne(selector: string): IElement | null;
    /** Get the inner HTML of the element */
    html(): string | null;
    /** Remove all elements matching the selector from this subtree */
    remove(selector: string): void;
}

export interface IHtmlParser {
    parse(html: string): IElement;
}

export interface IFetcher {
    get(url: string, options?: FetchOptions): Promise<FetchResponse>;
    post(url: string, body: string | Buffer, options?: FetchOptions): Promise<FetchResponse>;
}

export interface IScheduler {
    /**
     * Schedule a task to run based on a cron expression.
     * @param expression Cron expression (e.g. "* * * * *")
     * @param task Callback function to execute
     */
    schedule(
        expression: string,
        task: () => void | Promise<void>,
        jobName: string,
        options?: { lockTtlMs?: number }
    ): void;

    /**
     * Unschedule a specific job by name.
     * @param jobName The name of the job to remove
     */
    unschedule(jobName: string): void;

    /**
     * Stop all scheduled jobs.
     */
    stopAll(): void;
}

export interface IMutex {
    /**
     * Attempt to acquire a lock.
     * @param key Unique lock key
     * @param ttlMs Time to live in milliseconds
     * @returns true if lock acquired, false if already locked
     */
    acquire(key: string, ttlMs: number): Promise<boolean>;

    /**
     * Refresh a lock TTL for the current owner.
     * @param key Unique lock key
     * @param ttlMs Time to live in milliseconds
     * @returns true if refreshed, false if lock is not owned anymore
     */
    refresh(key: string, ttlMs: number): Promise<boolean>;

    /**
     * Release a lock.
     * @param key Unique lock key
     */
    release(key: string): Promise<void>;

    /**
     * Close the mutex (and underlying connection).
     */
    close(): Promise<void>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface IDisposable {
    dispose(): Promise<void> | void;
}

export interface ILogger {
    debug(message: string, context?: object): void;
    info(message: string, context?: object): void;
    warn(message: string, context?: object): void;
    error(message: string, context?: object | Error): void;
}

export interface ICommandOutput {
    log(message: string): void;
    table(data: any[]): void;
    error(message: string): void;
}

// --- CLI Command Abstraction ---

export type OutputMode = 'text' | 'json' | 'silent' | 'tui';

export interface CommandOption {
    /** Option flags, e.g., '-d, --depth <n>' or '--no-robots' */
    flags: string;
    /** Description shown in help */
    description: string;
    /** Default value if not provided */
    default?: any;
}

export interface CommandDefinition {
    /** Command name, e.g., 'crawl' (becomes `bundle-name crawl`) */
    name: string;
    /** Description shown in help */
    description: string;
    /** Positional arguments, e.g., '<url>' or '[query]' */
    args?: string;
    /** Command options/flags */
    options?: CommandOption[];
    /**
     * Handler function.
     * Signature: (args, app, output?) => Promise<void>
     */
    action: (args: Record<string, any>, app: any, output?: ICommandOutput) => Promise<void>;
    /**
     * The preferred output mode for this command.
     * e.g., 'tui' for interactive interfaces, 'text' for standard CLI tools.
     * If not specified, defaults to the global CLI default (usually 'text' or 'silent' depending on configuration).
     */
    preferredMode?: OutputMode;
}

// --- Storage Abstraction ---

export interface IStore {
    /** Get a value by key */
    get<T = any>(key: string): Promise<T | null>;

    /** Set a value by key, with optional TTL in milliseconds */
    set<T = any>(key: string, value: T, ttlMs?: number): Promise<void>;

    /**
     * Set a value only if the key does not exist (atomic).
     * Returns true if the value was set, false if key already existed.
     * Used for idempotent operations like notification guards.
     */
    setIfNotExists<T = any>(key: string, value: T, ttlMs?: number): Promise<boolean>;

    /** Delete a key. Returns true if it existed */
    delete(key: string): Promise<boolean>;

    /** Check if a key exists */
    has(key: string): Promise<boolean>;

    /** Create a namespaced view of this store */
    namespace(prefix: string): IStore;

    /** Return all keys and values, optionally filtered by prefix (relative to namespace) */
    scan<T = any>(prefix?: string): Promise<Record<string, T>>;
}

// --- LLM Abstraction (re-exported from @nucleic/agentic) ---

export type { ILLMProvider, LLMRequest } from '@nucleic/agentic/contracts';

export * from './metrics/interfaces.js';
