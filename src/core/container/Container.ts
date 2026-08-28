import { ServiceMap, ServiceKey } from '../services.js';

export type Factory<T> = (app: Container) => T;

export class Container {
    private bindings = new Map<string | symbol, Factory<any>>();
    private singletons = new Map<string | symbol, any>();
    private singletonFactories = new Map<string | symbol, Factory<any>>();
    private resolvingSet = new Set<string | symbol>();
    private pendingDisposals = new Set<Promise<void>>();

    /**
     * Register a binding (factory created every time)
     */
    bind<K extends ServiceKey>(key: K, factory: Factory<ServiceMap[K]>): void {
        this.singletonFactories.delete(key);
        void this.releaseSingleton(key);
        this.bindings.set(key, factory);
    }

    /**
     * Register a singleton (created once)
     */
    singleton<K extends ServiceKey>(key: K, factory: Factory<ServiceMap[K]>): void {
        this.bindings.delete(key);
        this.singletonFactories.delete(key);
        void this.releaseSingleton(key);
        this.singletonFactories.set(key, factory);
    }

    async unbind(key: string | symbol): Promise<void> {
        this.bindings.delete(key);
        this.singletonFactories.delete(key);
        const disposal = this.releaseSingleton(key);
        await disposal;
    }

    private releaseSingleton(key: string | symbol): Promise<void> {
        if (!this.singletons.has(key)) return Promise.resolve();

        const instance = this.singletons.get(key);
        this.singletons.delete(key);

        // A shared instance remains owned until its last singleton key is removed.
        if (!instance || [...this.singletons.values()].includes(instance)) {
            return Promise.resolve();
        }

        this.shutdownStack = this.shutdownStack.filter(item => item !== instance);
        const disposal = this.disposeInstance(instance);
        this.pendingDisposals.add(disposal);
        void disposal.finally(() => this.pendingDisposals.delete(disposal));
        return disposal;
    }

    private async disposeInstance(instance: any): Promise<void> {
        const disposeFn = instance?.dispose || instance?.close;
        if (typeof disposeFn !== 'function') return;

        try {
            await disposeFn.call(instance);
        } catch (error) {
            const message = `[Container] Failed to dispose service`;
            const logger = this.singletons.get('ILogger');
            if (logger && logger !== instance) logger.error(message, error);
            else console.error(message, error);
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
        await Promise.allSettled([...this.pendingDisposals]);
        const reversed = [...this.shutdownStack].reverse(); // LIFO

        for (const instance of reversed) {
            await this.disposeInstance(instance); // Sequential wait preserves strict LIFO ordering.
        }

        this.shutdownStack = [];
        this.singletons.clear();
    }
}

/** @deprecated Use Bootstrap.boot() or new Container() instead of the global singleton. */
export const app = new Container();
