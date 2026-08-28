
export interface JobOptions {
    maxRetries?: number;
    backoffBase?: number; // In milliseconds
    heartbeatIntervalMs?: number;
    stuckTimeoutMs?: number;
    executionTimeoutMs?: number;
    priority?: number; // Higher is better (default 0)
    ttlMs?: number; // Time-to-live: job expires if not completed within this many ms of creation
}

export interface Job<T = any> {
    id: string;
    type: string;
    payload: T;
    options?: JobOptions;
    attempts: number;
    status: 'pending' | 'processing' | 'failed' | 'completed';
    created_at: number;
    updated_at?: number;
    scheduled_at?: number;
    priority: number;
    error?: string | null;
    /** Opaque ownership token for the current processing attempt. */
    claimToken?: string | null;
}

export type JobHandler<T = any> = (job: Job<T>) => Promise<void>;

export interface IQueue {
    add(type: string, payload: any, options?: JobOptions): Promise<Job>;
    addDelayed(type: string, payload: any, delayMs: number, options?: JobOptions): Promise<Job>;
    /**
     * Upsert a named delayed job — create it if it doesn't exist, or push its
     * fire time to `now + delayMs` if it does. Pending jobs are rescheduled,
     * terminal jobs are reactivated, and a job already processing is left
     * untouched.
     *
     * Useful for debounced background work (e.g. flush after inactivity):
     * call `bump(name, ...)` on every relevant event and the job fires once,
     * after the last call.
     */
    bump(name: string, type: string, payload: any, delayMs: number, options?: JobOptions): Promise<void>;
    list(status: Job['status'], limit?: number, type?: string): Promise<Job[]>;
    get(jobId: string): Promise<Job | null>;
    delete(jobId: string): Promise<boolean>;
    retryFailed(jobId: string): Promise<boolean>;
    retryAll(type?: string): Promise<number>;
    pop(): Promise<Job | null>;
    /**
     * A claim token fences transitions to the processing attempt that popped the job.
     * Omitting it preserves administrative/legacy force-transition behavior.
     */
    complete(jobId: string, claimToken?: string): Promise<void>;
    fail(jobId: string, error: string, claimToken?: string): Promise<void>;
    retry(jobId: string, delayMs: number, lastError?: string, claimToken?: string): Promise<void>;
    heartbeat(jobId: string, claimToken?: string): Promise<void>;
    recover(timeoutMs: number): Promise<number>;
    stats(): Promise<{
        overview: Record<string, number>;
        breakdown: Record<string, Record<string, number>>;
    }>;
    clear(status: Job['status'], type?: string): Promise<number>;
    close(): Promise<void>;
    release(jobId: string, claimToken?: string): Promise<void>;
}

export interface ValidationSchema<T = unknown> {
    safeParse(value: unknown):
        | { success: true; data: T }
        | { success: false; error: { message: string } };
}

export interface JobDefinition<T = unknown> {
    type: string;
    schema?: ValidationSchema<T>;
    description?: string;
}

export interface IJobRegistry {
    register<T>(type: string, schema?: ValidationSchema<T>, description?: string): void;
    get(type: string): JobDefinition | undefined;
    validate(type: string, payload: unknown): { valid: boolean; error?: string };
}
