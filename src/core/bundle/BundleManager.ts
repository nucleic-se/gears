import { Container } from '../container/Container.js';
import { Bundle } from './Bundle.js';
import { ILogger } from '../interfaces.js';
import { MissingDependencyError, CircularDependencyError, DependencyNotBootedError } from '../errors.js';
import path from 'path';
import { pathToFileURL } from 'url';

type BundleStatus = 'loaded' | 'registered' | 'booted';

interface BundleRecord {
    name: string;
    version: string;
    path: string; // Absolute path
    bundle: Bundle;
    status: BundleStatus;
}

export class BundleManager {
    private static readonly RESERVED_BUNDLE_NAMES = new Set([
        'work',
        'bundles',
        'load',
        'unload',
        'doctor',
        'top',
        'store',
        'queue',
    ]);
    private app: Container;
    private logger: ILogger;
    private bundles: Map<string, BundleRecord> = new Map();
    private bundleServiceKeys: Map<string, Set<string | symbol>> = new Map();
    private _configPath?: string;
    private isRestoring = false;
    private pendingRestore = false;
    private pendingRestoreOptions: { watch?: boolean; boot?: boolean } | null = null;
    private fsWatcher?: import('fs').FSWatcher;

    public getBundle(name: string): BundleRecord | undefined {
        return this.bundles.get(name);
    }

    constructor(app: Container, options: { configPath?: string } = {}) {
        this.app = app;
        this.logger = app.make('ILogger');
        this._configPath = options.configPath;
    }

    /**
     * Main entry point to load, boot, and persist a bundle.
     * @param options.boot - If true, run init() and provider.boot() (starts background tasks)
     * @param options.registerOnly - If true, only run provider.register() (for CLI commands)
     * @param options.persist - If true, save to bundles.json
     */
    async load(bundlePath: string, options: { boot?: boolean; registerOnly?: boolean; persist?: boolean } = { boot: true, persist: true }): Promise<void> {
        const absolutePath = path.resolve(bundlePath);

        // 1. Load Metadata (Validates and checks conflicts)
        const record = await this.loadMetadata(absolutePath);

        // 2. Boot or Register based on options
        if (options.boot) {
            await this.bootBundle(record, { registerOnly: false });
        } else if (options.registerOnly) {
            await this.bootBundle(record, { registerOnly: true });
        }

        // 3. Persist if requested
        if (options.persist) {
            await this.persistBundlePath(absolutePath);
            if (!options.boot) {
                this.logger.info(`Bundle added to config`, { bundle: record.name, version: record.version });
            }
        }
    }

    /**
     * Loads the bundle module and extracts metadata.
     * Idempotent: returns existing record if already loaded from same path.
     * Throws if name conflict with different path.
     */
    private async loadMetadata(absolutePath: string, options: { register?: boolean } = {}): Promise<BundleRecord> {
        const shouldRegister = options.register !== false;
        // Optimization: If we already have this exact path loaded, return the existing record.
        // This prevents re-evaluating the module (memory leak) on every restore() call.
        for (const record of this.bundles.values()) {
            if (record.path === absolutePath) {
                return record;
            }
        }

        const entryPoint = pathToFileURL(path.join(absolutePath, 'index.js')).href;

        let module;
        try {
            module = await import(entryPoint);
        } catch (error) {
            throw new Error(`Failed to import bundle at ${absolutePath}`, { cause: error });
        }

        const bundle: Bundle = module.default || module.bundle;
        if (!bundle) {
            throw new Error(`Bundle at ${absolutePath} does not export a default Bundle object.`);
        }
        if (BundleManager.RESERVED_BUNDLE_NAMES.has(bundle.name)) {
            throw new Error(
                `Bundle name '${bundle.name}' conflicts with a core CLI command. ` +
                `Choose a different name.`
            );
        }

        // Check for conflicts
        const existing = this.bundles.get(bundle.name);
        if (existing) {
            if (existing.path !== absolutePath) {
                throw new Error(`Bundle conflict: ${bundle.name} is already loaded from ${existing.path}, cannot load from ${absolutePath}`);
            }
            return existing;
        }

        // create new record
        const record: BundleRecord = {
            name: bundle.name,
            version: bundle.version,
            path: absolutePath,
            bundle: bundle,
            status: 'loaded'
        };

        if (shouldRegister) {
            this.bundles.set(bundle.name, record);
        }
        return record;
    }

    /**
     * Transitions a bundle from 'loaded' to 'booted' or 'registered'.
     * @param options.registerOnly - If true, only call register()/boot() on providers (no bundle.init)
     */
    private async bootBundle(record: BundleRecord, options: { registerOnly?: boolean } = {}): Promise<void> {
        if (record.status === 'booted') {
            if (options.registerOnly) {
                // Already booted means services are registered, that's fine for CLI
                return;
            }
            throw new Error(`Bundle ${record.name} is already booted.`);
        }
        if (options.registerOnly && record.status === 'registered') {
            // Already registered for CLI, skip
            return;
        }

        // Validate Dependencies (Strict Boot)
        const deps = record.bundle.requires || [];
        for (const depName of deps) {
            const depRecord = this.bundles.get(depName);
            if (!depRecord) {
                throw new MissingDependencyError(record.name, depName);
            }
            if (!options.registerOnly && depRecord.status !== 'booted') {
                // Even if it exists, if it's not booted, we cannot boot.
                // This shouldn't happen if getBootOrder does its job, but good safety.
                throw new DependencyNotBootedError(record.name, depName);
            }
        }

        const { bundle } = record;

        // Register all providers first, then boot all — so providers
        // booted later can depend on services registered by earlier ones.
        // Track which keys this bundle registers so we can unbind on unload.
        const registeredKeys = new Set<string | symbol>();
        const origBind = this.app.bind.bind(this.app);
        const origSingleton = this.app.singleton.bind(this.app);
        this.app.bind = ((key: any, factory: any) => { registeredKeys.add(key); return origBind(key, factory); }) as typeof this.app.bind;
        this.app.singleton = ((key: any, factory: any) => { registeredKeys.add(key); return origSingleton(key, factory); }) as typeof this.app.singleton;

        try {
            const providers = bundle.providers.map(P => new P(this.app));
            for (const provider of providers) await provider.register();
            for (const provider of providers) await provider.boot();
        } finally {
            this.app.bind = origBind;
            this.app.singleton = origSingleton;
        }

        this.bundleServiceKeys.set(record.name, registeredKeys);

        if (!options.registerOnly) {
            // Init hook - only for full boot (starts cron, background tasks)
            // Called AFTER providers so all services are available
            if (bundle.init) {
                await bundle.init(this.app);
            }
        }

        if (options.registerOnly) {
            record.status = 'registered';
        } else {
            record.status = 'booted';
            this.logger.info(`Bundle loaded`, { bundle: record.name, version: record.version });
        }
    }

    async unload(bundleName: string, options: { persist?: boolean; silent?: boolean } = { persist: true, silent: false }): Promise<void> {
        const record = this.bundles.get(bundleName);
        if (!record) {
            if (!options.silent) {
                this.logger.warn(`Bundle not loaded`, { bundle: bundleName });
            }
            return;
        }

        // Safety Check: Prevent unloading if others depend on this
        for (const other of this.bundles.values()) {
            if (other.name === bundleName) continue;
            if (other.bundle.requires?.includes(bundleName)) {
                throw new Error(`Cannot unload '${bundleName}': '${other.name}' depends on it. Unload '${other.name}' first.`);
            }
        }

        // Shutdown hook - only if booted
        if (record.status === 'booted') {
            const { bundle } = record;
            if (bundle.shutdown) {
                try {
                    await bundle.shutdown(this.app);
                } catch (e) {
                    this.logger.error(`Error shutting down bundle`, { bundle: bundleName, error: e });
                }
            }
        }

        // Unbind all services this bundle's providers registered
        const keys = this.bundleServiceKeys.get(bundleName);
        if (keys) {
            for (const key of keys) this.app.unbind(key);
            this.bundleServiceKeys.delete(bundleName);
        }

        this.bundles.delete(bundleName);

        // Remove from persistence ONLY if requested
        if (options.persist) {
            await this.removePersistence(record.path);
        }

        if (!options.silent) {
            this.logger.info(`Bundle unloaded`, { bundle: bundleName });
        }
    }

    /**
     * Unload all currently loaded bundles in a dependency-safe order.
     *
     * This is domain-agnostic and works for any bundle graph:
     * we repeatedly unload "leaf" bundles (bundles with no dependents)
     * until none remain.
     */
    async unloadAll(options: { persist?: boolean; silent?: boolean } = { persist: false, silent: true }): Promise<void> {
        while (this.bundles.size > 0) {
            const records = [...this.bundles.values()];

            // Leaves: no other loaded bundle depends on them.
            const leaves = records.filter(record =>
                !records.some(other =>
                    other.name !== record.name && (other.bundle.requires?.includes(record.name) ?? false),
                ),
            );

            if (leaves.length === 0) {
                // Should be impossible in a valid DAG, but guard against corrupted state.
                const remaining = [...this.bundles.keys()];
                this.logger.warn('Cannot compute dependency-safe unload order; unloading remaining bundles best-effort', {
                    remaining,
                });
                for (const name of remaining) {
                    try {
                        await this.unload(name, options);
                    } catch (e) {
                        this.logger.error('Failed to unload bundle during forced unload-all', {
                            bundle: name,
                            error: e,
                        });
                    }
                }
                return;
            }

            for (const record of leaves) {
                try {
                    await this.unload(record.name, options);
                } catch (e) {
                    // Continue unloading others; shutdown should be best-effort.
                    this.logger.error('Failed to unload bundle during unload-all', {
                        bundle: record.name,
                        error: e,
                    });
                }
            }
        }
    }

    /**
     * Remove a bundle from bundles.json by name (without booting).
     * Returns true when a matching entry was found and removed.
     */
    async removeFromConfigByName(bundleName: string): Promise<boolean> {
        const { JsonConfigFile } = await import('../utils/JsonConfigFile.js');
        const config = new JsonConfigFile(this.configPath, this.logger);
        let found = false;

        await config.update<{ bundles: string[] }>(async (data) => {
            for (const bundlePath of data.bundles) {
                const absPath = path.resolve(bundlePath);
                const record = await this.loadMetadata(absPath);
                if (record.name === bundleName) {
                    data.bundles = data.bundles.filter(p => p !== absPath);
                    found = true;
                    return data;
                }
            }
            return undefined; // no change
        }, { bundles: [] });

        return found;
    }

    getLoadedBundles(): Array<{ name: string; version: string; path: string }> {
        return Array.from(this.bundles.values()).map(b => ({
            name: b.name,
            version: b.version,
            path: b.path
        }));
    }

    /**
     * Topologically sorts bundle records based on dependencies.
     * Throws CircularDependencyError if a cycle is detected.
     * Throws MissingDependencyError if a dependency is not loaded.
     */
    /**
     * Topologically sorts bundle records based on dependencies.
     * Throws CircularDependencyError if a cycle is detected.
     * Throws MissingDependencyError if a dependency is not in the scope.
     * Throws CircularDependencyError if a cycle is detected.
     */
    private getBootOrder(records: BundleRecord[], scope: Map<string, BundleRecord>): BundleRecord[] {
        const visited = new Set<string>();
        const temp = new Set<string>();
        const order: BundleRecord[] = [];

        const visit = (record: BundleRecord, path: string[]) => {
            if (temp.has(record.name)) {
                throw new CircularDependencyError([...path, record.name]);
            }
            if (visited.has(record.name)) {
                return;
            }

            temp.add(record.name);

            // Visit dependencies
            const deps = record.bundle.requires || [];

            for (const depName of deps) {
                // Critical: Resolve ONLY from the provided scope (desired bundles)
                const depRecord = scope.get(depName);

                // If not found in scope, it means we are trying to boot a bundle 
                // whose dependency is NOT in the new configuration.
                if (!depRecord) {
                    throw new MissingDependencyError(record.name, depName);
                }

                visit(depRecord, [...path, record.name]);
            }

            temp.delete(record.name);
            visited.add(record.name);
            order.push(record);
        }

        for (const record of records) {
            if (!visited.has(record.name)) {
                visit(record, []);
            }
        }

        return order;
    }

    // --- Persistence ---

    private get configPath(): string {
        return this._configPath ? path.resolve(this._configPath) : path.resolve(process.cwd(), 'bundles.json');
    }

    async restore(options: { watch?: boolean; boot?: boolean } = { watch: true, boot: true }): Promise<void> {
        if (this.isRestoring) {
            this.pendingRestore = true;
            this.pendingRestoreOptions = options;
            return;
        }

        this.isRestoring = true;
        try {
            await this.restoreInternal(options);
        } finally {
            this.isRestoring = false;
            // If another restore was requested while we were running, execute it now.
            if (this.pendingRestore) {
                const pendingOptions = this.pendingRestoreOptions || options;
                this.pendingRestore = false;
                this.pendingRestoreOptions = null;
                setImmediate(() => this.restore(pendingOptions));
            }
        }
    }

    private async restoreInternal(options: { watch?: boolean; boot?: boolean } = { watch: true, boot: true }): Promise<void> {
        try {
            const fsPromises = await import('fs/promises');
            const fs = await import('fs');
            const data = await fsPromises.readFile(this.configPath, 'utf-8');
            const config = JSON.parse(data);

            const desiredBundles = new Set<string>(config.bundles || []);

            // Build reverse lookup for current state reconciliation if needed?
            // Actually, we just iterate desired list.

            if (options.boot) {
                this.logger.info('Restoring bundles...');
            }

            // 1. Identify Bundles to Unload (Present in memory but not in config)
            const desiredPaths = new Set(Array.from(desiredBundles).map(p => path.resolve(p)));

            if (options.watch) {
                const currentBundles = Array.from(this.bundles.values());
                for (const record of currentBundles) {
                    if (!desiredPaths.has(record.path)) {
                        this.logger.info(`Bundle removed from config, unloading`, { bundle: record.name });
                        try {
                            await this.unload(record.name);
                        } catch (e) {
                            this.logger.error(`Failed to unload bundle`, { bundle: record.name, error: e });
                        }
                    }
                }
            }

            // 2. Load Metadata for all configured bundles (desired)
            const recordsToBoot: BundleRecord[] = [];
            for (const bundlePath of desiredBundles) {
                try {
                    const absPath = path.resolve(bundlePath);
                    const entryPath = path.join(absPath, 'index.js');
                    if (!fs.existsSync(entryPath)) {
                        this.logger.error('Bundle path missing on disk', {
                            path: absPath,
                            hint: 'Remove from bundles.json or run `gears unload <name>`'
                        });
                        continue;
                    }
                    const record = await this.loadMetadata(absPath, { register: false });
                    recordsToBoot.push(record);
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    this.logger.error(`Failed to load bundle metadata`, { path: bundlePath, error: message });
                }
            }

            // 3. Create Scoped Map (Name -> Record) for validation
            const scopedMap = new Map<string, BundleRecord>(recordsToBoot.map(r => [r.name, r]));

            // 4. Validate & Sort (Topological Boot Order)
            let bootOrder: BundleRecord[] = [];
            try {
                // Pass the SCOPE map. Dependency resolution must be satisfied within this map.
                bootOrder = this.getBootOrder(recordsToBoot, scopedMap);
            } catch (e) {
                this.logger.error('Dependency validation failed. Some bundles may not boot.', { error: e });
                // Let's abort boot to prevent bad state.
                if (options.boot) return;
            }

            // 5. Update Internal State & Boot Ordered
            // Now that validation passed, we can update this.bundles
            for (const record of recordsToBoot) {
                this.bundles.set(record.name, record);
            }

            // 3. Boot Ordered
            if (options.boot) {
                for (const record of bootOrder) {
                    try {
                        if (record.status !== 'booted') {
                            await this.bootBundle(record);
                        }
                    } catch (e) {
                        this.logger.error(`Failed to boot bundle`, { bundle: record.name, error: e });
                    }
                }
            }

            if (options.watch) {
                this.watchConfig();
            }
        } catch (error: any) {
            if (options.watch && error.code === 'ENOENT') {
                this.watchConfig();
            } else if (error.code !== 'ENOENT') {
                this.logger.error('Error reading bundles.json', { error });
            }
        }
    }

    private isWatching = false;
    private async watchConfig() {
        if (this.isWatching) return;
        this.isWatching = true;

        const fs = await import('fs');
        this.logger.debug(`Watching for config changes`, { path: this.configPath });

        let debounceTimer: NodeJS.Timeout;

        // Watch directory if file doesn't exist? 
        // fs.watch on non-existent file throws.
        // We need to wait for it or watch directory.
        // watching directory is simpler but noisy.
        // Let's rely on polling-like check or watch the directory.

        const watchTarget = fs.existsSync(this.configPath) ? this.configPath : path.dirname(this.configPath);
        const watchingDir = watchTarget !== this.configPath;

        this.fsWatcher = fs.watch(watchTarget, (eventType, filename) => {
            // If watching dir, confirm it is our file (if filename provided)
            // If filename is null/undefined, we err on safe side and trigger reload (debounce handles flooding)
            if (watchingDir && filename && filename !== 'bundles.json') return;

            if (eventType === 'rename' && watchingDir) {
                // Might be created now.
            }

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                this.logger.debug('Config changed, reloading bundles');
                this.restore();

                // If we were watching dir and file appeared, maybe we should watch file now?
                // Simpler: just keep watching dir or re-evaluate. 
                // For now, simple reload is enough as restore checks file existence.
            }, 500);
        });

        // Handle error? fs.watch throws if path invalid. 
        // path.dirname(this.configPath) should allow exist (cwd).
    }

    private async persistBundlePath(newBundlePath: string): Promise<void> {
        const { JsonConfigFile } = await import('../utils/JsonConfigFile.js');
        const config = new JsonConfigFile(this.configPath, this.logger);
        const absolutePath = path.resolve(newBundlePath);

        await config.update<{ bundles: string[] }>(data => {
            if (data.bundles.includes(absolutePath)) return undefined; // no change
            data.bundles.push(absolutePath);
            return data;
        }, { bundles: [] });
    }

    private async removePersistence(bundlePathToRemove: string): Promise<void> {
        const { JsonConfigFile } = await import('../utils/JsonConfigFile.js');
        const config = new JsonConfigFile(this.configPath, this.logger);
        const absolutePathToRemove = path.resolve(bundlePathToRemove);

        await config.update<{ bundles: string[] }>(data => {
            const filtered = data.bundles.filter(p => p !== absolutePathToRemove);
            if (filtered.length === data.bundles.length) return undefined; // no change
            data.bundles = filtered;
            return data;
        }, { bundles: [] });
    }
    async close(): Promise<void> {
        this.isWatching = false;
        if (this.fsWatcher) {
            this.fsWatcher.close();
            this.fsWatcher = undefined;
            this.logger.debug('BundleManager config watcher closed');
        }
    }
}
