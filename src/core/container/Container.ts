import { ServiceMap, ServiceKey } from '../services.js';

export type Factory<T> = (app: Container) => T;

export class Container {
    private bindings = new Map<string | symbol, Factory<any>>();
    private singletons = new Map<string | symbol, any>();
    private singletonFactories = new Map<string | symbol, Factory<any>>();
    private resolvingSet = new Set<string | symbol>();

    /**
     * Register a binding (factory created every time)
     */
    bind<K extends ServiceKey>(key: K, factory: Factory<ServiceMap[K]>): void {
        this.bindings.set(key, factory);
        this.singletons.delete(key);
        this.singletonFactories.delete(key);
    }

    /**
     * Register a singleton (created once)
     */
    singleton<K extends ServiceKey>(key: K, factory: Factory<ServiceMap[K]>): void {
        this.removeShutdownInstance(key);
        this.singletonFactories.set(key, factory);
        this.bindings.delete(key);
        this.singletons.delete(key); // Fix: Clear existing instance if any
    }

    unbind(key: string | symbol): void {
        this.removeShutdownInstance(key);
        this.bindings.delete(key);
        this.singletons.delete(key);
        this.singletonFactories.delete(key);
    }

    private removeShutdownInstance(key: string | symbol) {
        if (this.singletons.has(key)) {
            const instance = this.singletons.get(key);
            if (instance) {
                this.shutdownStack = this.shutdownStack.filter(i => i !== instance);
            }
        }
    }

    private shutdownStack: any[] = []; // Stack of resolved instances for LIFO shutdown

    /**
     * Resolve a service
     */
    make<K extends ServiceKey>(key: K): ServiceMap[K] {
        // 1. Check instantiated singletons
        if (this.singletons.has(key)) {
            return this.singletons.get(key);
        }

        // Cycle detection
        if (this.resolvingSet.has(key)) {
            throw new Error(`Circular dependency detected for key: ${String(key)}`);
        }
        this.resolvingSet.add(key);

        try {
            let instance: any;

            // 2. Check singleton factories
            if (this.singletonFactories.has(key)) {
                const factory = this.singletonFactories.get(key)!;
                instance = factory(this);
                this.singletons.set(key, instance);
            }
            // 3. Check ordinary bindings
            else if (this.bindings.has(key)) {
                const factory = this.bindings.get(key)!;
                instance = factory(this);
            } else {
                throw new Error(`No binding found for key: ${String(key)}`);
            }

            // Track for shutdown if disposable
            if (instance && (typeof instance.dispose === 'function' || typeof instance.close === 'function')) {
                // Ensure we don't add duplicates to the stack (e.g. if make() is called twice for same singleton)
                if (!this.shutdownStack.includes(instance)) {
                    this.shutdownStack.push(instance);
                }
            }

            return instance;
        } finally {
            this.resolvingSet.delete(key);
        }
    }

    /**
     * Resolve a service if it exists, otherwise return null
     * (Useful for optional dependencies)
     */
    makeOrNull<K extends ServiceKey>(key: K): ServiceMap[K] | null {
        if (!this.bound(key)) return null;
        return this.make(key);
    }

    /**
     * Resolve a service, letting the caller specify the type GENERICALLY.
     * Use this ONLY for dynamic keys not in ServiceMap (e.g. dynamic bundle services).
     * @deprecated Try to use typed make() by adding to ServiceMap if possible.
     */
    makeUnsafe<T = any>(key: string | symbol): T {
        return this.make(key as ServiceKey) as unknown as T;
    }

    bound(key: string | symbol): boolean {
        return this.singletons.has(key)
            || this.singletonFactories.has(key)
            || this.bindings.has(key);
    }

    /**
     * Gracefully shuts down the container and disposes all singletons.
     * Iterates through all instantiated singletons in REVERSE resolution order (LIFO).
     */
    async shutdown(): Promise<void> {
        const logger = this.makeOrNull<any>('ILogger');
        const reversed = [...this.shutdownStack].reverse(); // LIFO

        for (const instance of reversed) {
            // Check for .dispose() or .close() (generic convention)
            const disposeFn = instance.dispose || instance.close;

            if (typeof disposeFn === 'function') {
                try {
                    const result = disposeFn.call(instance);
                    if (result instanceof Promise) {
                        try {
                            await result; // Sequential wait to ensure strict ordering
                        } catch (e: any) {
                            const msg = `[Container] Failed to dispose service`;
                            if (logger) logger.error(msg, e);
                            else console.error(msg, e);
                        }
                    }
                } catch (e) {
                    const msg = `[Container] Failed to dispose service`;
                    if (logger) logger.error(msg, e);
                    else console.error(msg, e);
                }
            }
        }

        this.shutdownStack = [];
        this.singletons.clear();
    }
}

/** @deprecated Use Bootstrap.boot() or new Container() instead of the global singleton. */
export const app = new Container();
