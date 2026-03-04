
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
}

export type JobHandler<T = any> = (job: Job<T>) => Promise<void>;

export interface IQueue {
    add(type: string, payload: any, options?: JobOptions): Promise<Job>;
    addDelayed(type: string, payload: any, delayMs: number, options?: JobOptions): Promise<Job>;
    list(status: Job['status'], limit?: number, type?: string): Promise<Job[]>;
    get(jobId: string): Promise<Job | null>;
    delete(jobId: string): Promise<boolean>;
    retryFailed(jobId: string): Promise<boolean>;
    retryAll(type?: string): Promise<number>;
    pop(): Promise<Job | null>;
    complete(jobId: string): Promise<void>;
    fail(jobId: string, error: string): Promise<void>;
    retry(jobId: string, delayMs: number, lastError?: string): Promise<void>;
    heartbeat(jobId: string): Promise<void>;
    recover(timeoutMs: number): Promise<number>;
    stats(): Promise<{
        overview: Record<string, number>;
        breakdown: Record<string, Record<string, number>>;
    }>;
    clear(status: Job['status'], type?: string): Promise<number>;
    close(): Promise<void>;
    release(jobId: string): Promise<void>;
}

export interface JobDefinition<T = any> {
    name: string;
    schema: any; // Zod schema
}
