
import { ILogger, IScheduler, IMutex, ILLMProvider, IFetcher, IHtmlParser, IStore, IMetrics } from './interfaces.js';
import { IQueue, JobHandler } from './queue/interfaces.js';
import { IEventBus, IDurableEventBus } from './events/interfaces.js';
import { BundleManager } from './bundle/BundleManager.js';
import { Worker, WorkerOptions } from './queue/Worker.js';
import { JobRegistry } from './queue/JobRegistry.js';
import { SharedDatabase } from './utils/SharedDatabase.js';
import { IAIPromptService, IAIActionRegistry } from './ai/interfaces.js';

export interface ServiceMap {
    // Core Services
    'ILogger': ILogger;
    'LoggerOptions': any;
    'IQueue': IQueue;
    'IStore': IStore;
    'IEventBus': IEventBus;
    'events': IEventBus;
    'IDurableEventBus': IDurableEventBus;
    'IScheduler': IScheduler;
    'IMutex': IMutex;
    'ILLMProvider': ILLMProvider;
    'IAIPromptService': IAIPromptService;
    'IAIActionRegistry': IAIActionRegistry;
    'BundleManager': BundleManager;
    'Worker': Worker;
    'WorkerOptions': WorkerOptions;
    'JobRegistry': JobRegistry;
    'JobHandlers': Map<string, JobHandler>;
    'IFetcher': IFetcher;
    'IHtmlParser': IHtmlParser;
    'IMetrics': IMetrics;
    'SharedDatabase': SharedDatabase;
}

export type ServiceKey = keyof ServiceMap;
