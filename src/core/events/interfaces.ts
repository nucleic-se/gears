
export type EventHandler<T = any> = (payload: T) => void | Promise<void>;

export interface IEventBus {
    /**
     * Emit an event. All listeners are executed in parallel.
     * Waits for all listeners to settle.
     * Does NOT throw if a listener fails (logs errors internally).
     */
    emit<T = any>(event: string | symbol, payload: T): Promise<void>;

    /**
     * Emit an event. All listeners are executed in parallel.
     * Waits for all listeners to settle (or the first rejection).
     * Rejects early if ANY listener fails (Promise.all behavior).
     */
    emitStrict<T = any>(event: string | symbol, payload: T): Promise<void>;

    /**
     * Register a handler for an event.
     * @returns An unsubscribe function to remove this listener.
     */
    on<T = any>(event: string | symbol, handler: EventHandler<T>): () => void;

    /**
     * Remove a specific handler.
     */
    off<T = any>(event: string | symbol, handler: EventHandler<T>): void;

    /**
     * Remove all handlers for an event.
     */
    clear(event: string | symbol): void;

    /**
     * Get number of listeners for an event.
     */
    listenerCount(event: string | symbol): number;
}

/**
 * Cross-process durable event bus backed by SQLite.
 *
 * Complements IEventBus (in-process) with persistent, cross-process event
 * delivery. Producers insert rows; consumers poll with a cursor.
 *
 * Local subscribers fire immediately on emit(). Cross-process events are
 * picked up on the next poll cycle — no double-firing within the same process.
 *
 * This is a notification channel, not a task queue:
 * - No acknowledgments (use IQueue for that)
 * - No guaranteed delivery for offline consumers
 * - Configurable retention with automatic sweep
 */
export interface IDurableEventBus {
    /** Emit an event. Persists to SQLite and fires local subscribers immediately. */
    emit<T = any>(event: string, payload: T): Promise<void>;

    /** Subscribe to an event. Returns an unsubscribe function. */
    on<T = any>(event: string, handler: EventHandler<T>): () => void;

    /** Remove a specific handler from an event. */
    off<T = any>(event: string, handler: EventHandler<T>): void;

    /** Start polling for cross-process events. */
    startPolling(intervalMs?: number): void;

    /** Stop polling. */
    stopPolling(): void;

    /** Clean up resources (stops polling, closes DB). */
    close(): void;
}
