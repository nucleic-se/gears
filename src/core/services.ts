
import { ILogger, IScheduler, IMutex, IFetcher, IHtmlParser, IStore, IMetrics } from './interfaces.js';
import { IQueue, IJobRegistry, JobHandler } from './queue/interfaces.js';
import { IEventBus, IDurableEventBus } from './events/interfaces.js';
import { IScheduledJobRegistrar } from './schedule/interfaces.js';
import { IDataPaths } from './utils/paths.js';

/** Lean container contracts. Concrete infrastructure must not leak through ServiceMap. */
export interface WorkerOptions {
    maxConcurrency?: number;
    pollInterval?: number;
    recoveryTimeoutMs?: number;
    recoveryCheckIntervalMs?: number;
    heartbeatIntervalMs?: number;
    shutdownTimeoutMs?: number;
    executionTimeoutMs?: number;
}

export interface IWorker {
    start(): void;
    stop(): Promise<void>;
    dispose(): Promise<void>;
}

export interface IBundleManager {
    load(path: string, options?: { boot?: boolean; registerOnly?: boolean; persist?: boolean }): Promise<void>;
    unload(name: string, options?: { persist?: boolean; silent?: boolean }): Promise<void>;
    unloadAll(options?: { persist?: boolean; silent?: boolean }): Promise<void>;
    removeFromConfigByName(name: string): Promise<boolean>;
    getLoadedBundles(): Array<{ name: string; version: string; path: string }>;
    restore(options?: { watch?: boolean; boot?: boolean }): Promise<void>;
    close(): Promise<void>;
}

export interface ISharedDatabase {
    createStore(): IStore;
    createScheduler(mutex: IMutex, logger: ILogger, timezone?: string): IScheduler;
    createDurableEventBus(): IDurableEventBus;
    createMetrics(): IMetrics;
    close(): void;
    dispose(): void;
}

export interface ServiceMap {
    // Core Services
    'ILogger': ILogger;
    'DataPaths': IDataPaths;
    'LoggerOptions': any;
    'IQueue': IQueue;
    'IStore': IStore;
    'IEventBus': IEventBus;
    'events': IEventBus;
    'IDurableEventBus': IDurableEventBus;
    'IScheduler': IScheduler;
    'IMutex': IMutex;
    'BundleManager': IBundleManager;
    'Worker': IWorker;
    'WorkerOptions': WorkerOptions;
    'JobRegistry': IJobRegistry;
    'JobHandlers': Map<string, JobHandler>;
    'ScheduledJobs': IScheduledJobRegistrar;
    'IFetcher': IFetcher;
    'IHtmlParser': IHtmlParser;
    'IMetrics': IMetrics;
    'SharedDatabase': ISharedDatabase;
}

export type ServiceKey = keyof ServiceMap;
