import { IEventBus, EventHandler } from './interfaces.js';
import { ILogger } from '../interfaces.js';
import { Container } from '../container/Container.js';

export class EventBus implements IEventBus {
    private handlers = new Map<string | symbol, EventHandler[]>();
    private logger: ILogger;
    private maxListeners: number;
    private app: Container;

    constructor(app: Container) {
        this.app = app;
        this.logger = app.make('ILogger');
        this.maxListeners = 10; // Default value moved here as maxListeners parameter was removed
    }

    on<T = any>(event: string | symbol, handler: EventHandler<T>): () => void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        const handlers = this.handlers.get(event)!;
        handlers.push(handler);

        if (handlers.length > this.maxListeners) {
            this.logger.warn(`Max listeners (${this.maxListeners}) exceeded for event '${String(event)}'. Possible memory leak?`, {
                event: String(event),
                count: handlers.length
            });
        }

        return () => this.off(event, handler);
    }

    once<T = any>(event: string | symbol, handler: EventHandler<T>): void {
        const wrapper = (payload: T) => {
            this.off(event, wrapper);
            handler(payload);
        };
        this.on(event, wrapper);
    }

    off<T = any>(event: string | symbol, handler: EventHandler<T>): void {
        const handlers = this.handlers.get(event);
        if (!handlers) return;

        const index = handlers.indexOf(handler);
        if (index !== -1) {
            handlers.splice(index, 1);
        }
    }

    clear(event: string | symbol): void {
        this.handlers.delete(event);
    }

    listenerCount(event: string | symbol): number {
        return this.handlers.get(event)?.length || 0;
    }

    async emit<T = any>(event: string | symbol, payload: T): Promise<void> {
        const handlers = this.handlers.get(event);
        if (!handlers || handlers.length === 0) return;

        // Defensive copy to prevent mutation during iteration
        const safeHandlers = [...handlers];

        const promises = safeHandlers.map(async (handler) => {
            try {
                await handler(payload);
            } catch (err) {
                this.logger.error(`Event listener failed`, {
                    event: String(event),
                    error: err instanceof Error ? err.message : String(err)
                });
            }
        });

        await Promise.allSettled(promises);
    }

    async emitStrict<T = any>(event: string | symbol, payload: T): Promise<void> {
        const handlers = this.handlers.get(event);
        if (!handlers || handlers.length === 0) return;

        // Defensive copy
        const safeHandlers = [...handlers];

        // Wrap execution in Promise.resolve().then() to ensure synchronous throws
        // are caught as promise rejections and don't stop the loop.
        const promises = safeHandlers.map(handler =>
            Promise.resolve().then(() => handler(payload))
        );

        await Promise.all(promises);
    }
}
