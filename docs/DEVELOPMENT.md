# Developer Guide

Quick reference for understanding and contributing to gears.

## Project Structure

```
gears/
├── src/
│   ├── index.ts                  # Library entry, exports boot()
│   ├── cli/
│   │   └── index.ts              # CLI (Commander.js)
│   ├── core/
│   │   ├── interfaces.ts         # Core interfaces (IStore, IQueue, ILogger, etc.)
│   │   ├── services.ts           # Typed ServiceMap registry
│   │   ├── errors.ts             # Custom error classes
│   │   ├── Bootstrap.ts          # Bootstrap with options (output/debug)
│   │   ├── bundle/
│   │   │   ├── Bundle.ts         # Bundle interface
│   │   │   └── BundleManager.ts  # Load/unload/watch bundles
│   │   ├── container/
│   │   │   ├── Container.ts      # DI container (bind, singleton, make)
│   │   │   └── ServiceProvider.ts # Base class for providers
│   │   ├── providers/
│   │   │   ├── CoreServiceProvider.ts   # Registers core services
│   │   │   └── QueueServiceProvider.ts  # Registers queue + worker
│   │   ├── events/
│   │   │   ├── interfaces.ts     # IEventBus interface
│   │   │   └── EventBus.ts       # In-process pub/sub
│   │   │
│   │   ├── infra/
│   │   │   ├── PinoLogger.ts     # ILogger (pino-based, file+console)
│   │   │   ├── CronScheduler.ts  # IScheduler with mutex locking
│   │   │   ├── SQLiteMutex.ts    # IMutex (SQLite-backed)
│   │   │   ├── SQLiteStore.ts    # IStore (SQLite-backed)
│   │   │   ├── SQLiteDurableEventBus.ts # Cross-process event bus
│   │   │   ├── RateLimitedFetcher.ts  # IFetcher with rate limiting
│   │   │   ├── CheerioParser.ts  # IHtmlParser
│   │   │   └── PidLocker.ts      # Single-worker enforcement
│   │   ├── metrics/
│   │   │   ├── interfaces.ts     # IMetrics interface
│   │   │   └── SQLiteMetrics.ts  # SQLite-backed metrics
│   │   ├── queue/
│   │   │   ├── interfaces.ts     # IQueue, Job, JobHandler types
│   │   │   ├── SQLiteQueue.ts    # Queue implementation
│   │   │   ├── Worker.ts         # Concurrent job processor
│   │   │   ├── JobRegistry.ts    # Schema validation registry
│   │   │   └── Console/
│   │   │       └── QueueCommands.ts  # queue CLI subcommands
│   │   └── utils/
│   │       └── paths.ts          # Data directory + path traversal protection
│   └── bundles/                  # Built-in bundles
│       └── database/             # Kysely database provider
├── tests/
│   ├── unit/                     # Unit tests
│   └── integration/              # Integration tests
├── docs/                         # Documentation
├── bundles.json                  # Generated active bundle paths, when bundles are loaded
├── tsconfig.json                 # TypeScript config
└── vitest.config.ts              # Test config
```

## Key Concepts

### Container (Dependency Injection)

`ServiceMap` is the compile-time registry. Applications extend it for their
own keys instead of passing type arguments at each lookup:

```typescript
declare module '@nucleic-se/gears' {
    interface ServiceMap {
        'my-bundle:service': IMyService;
        'my-bundle:store': IStore;
    }
}
```

```typescript
// Factory — new instance each time
app.bind('my-bundle:service', (container) => new MyService());

// Singleton — one instance, lazy-created
app.singleton('ILogger', () => new PinoLogger());

// Resolve (type-safe via ServiceMap)
const logger = app.make('ILogger');

// Check existence
if (app.bound('ILogger')) { ... }
```

### Service Providers

Providers register services during boot. Two phases:

```typescript
class MyProvider extends ServiceProvider {
    register(): void {
        // Phase 1: Register bindings (no resolving other services)
        this.app.singleton('my-bundle:service', () => new MyService());
    }

    async boot(): Promise<void> {
        // Phase 2: Wire services (can resolve dependencies)
        const events = this.app.make('IEventBus');
        events.on('item:created', handler);
    }
}
```

### Lifecycle Contract (CLI vs Worker)

The lifecycle is intentionally split:

- `provider.register()` — binds services. Must avoid resolving other services.
- `provider.boot()` — wires listeners, runs migrations. May resolve dependencies but must remain lightweight.
- `bundle.init()` — starts long-running work (cron, schedulers). **Worker only** — skipped by CLI commands.

If a provider needs background work, put it in `bundle.init()`, not `provider.boot()`.

### Bundles

```typescript
export const bundle: Bundle = {
    name: 'my-bundle',
    version: '1.0.0',
    description: 'What this bundle does',
    requires: ['database'],
    providers: [MyServiceProvider],
    commands: [{
        name: 'do-thing',
        description: 'Does the thing',
        args: '<input>',
        options: [{ flags: '-v, --verbose', description: 'Verbose output' }],
        action: async (args, app) => {
            const svc = app.make('my-bundle:service');
            // ...
        },
    }],
    async init(app) { /* start schedulers */ },
    async shutdown(app) { /* cleanup */ }
};
```

### Core Interfaces

| Interface | Key Methods | Implementation |
|-----------|-------------|----------------|
| `ILogger` | `debug`, `info`, `warn`, `error` | PinoLogger |
| `IStore` | `get`, `set`, `delete`, `has`, `namespace`, `scan`, `setIfNotExists` | SQLiteStore |
| `IQueue` | `add`, `addDelayed`, `pop`, `complete`, `fail`, `recover`, `stats` | SQLiteQueue |
| `IScheduler` | `schedule`, `unschedule`, `stopAll` | CronScheduler |
| `IMutex` | `acquire`, `refresh`, `release`, `close` | SQLiteMutex |
| `IFetcher` | `get`, `post` | RateLimitedFetcher |
| `IEventBus` | `emit`, `emitStrict`, `on`, `off`, `clear`, `listenerCount` | EventBus |
| `IDurableEventBus` | `emit`, `on`, `off`, `startPolling`, `stopPolling` | SQLiteDurableEventBus |
| `IMetrics` | `increment`, `gauge`, `snapshot` | SQLiteMetrics |
| `IDisposable` | `dispose` | (pattern) |

### Event Bus

```typescript
const events = app.make('IEventBus');

// Subscribe (returns unsubscribe function)
const unsub = events.on('page:fetched', async (payload) => { ... });

// Emit (errors logged, not thrown)
await events.emit('page:fetched', { url: 'https://example.com' });

// Strict mode (throws on handler failure)
await events.emitStrict('critical:event', data);
```

### Store with Namespacing

Bundles should namespace their keys to avoid collisions:

```typescript
register(): void {
    this.app.singleton('my-bundle:store', () => {
        const store = this.app.make('IStore');
        return store.namespace('my-bundle');
    });
}

// Usage — keys are prefixed automatically
const store = app.make('my-bundle:store');
await store.set('counter', 42);     // Stored as 'my-bundle:counter'
await store.get<number>('counter'); // 42
```

### Sharing State Between CLI and Worker

Use `IStore` — it's backed by SQLite and shared across processes:

```typescript
// Worker writes
const store = app.make('IStore').namespace('my-bundle');
await store.set('lastRun', Date.now());

// CLI reads (same value, different process)
const store = app.make('IStore').namespace('my-bundle');
const lastRun = await store.get<number>('lastRun');
```

---

## Common Patterns

### Creating a New Bundle

1. Create directory: `src/bundles/my-bundle/`

2. Create service provider:
```typescript
import { ServiceProvider } from '../../core/container/ServiceProvider.js';

export class MyServiceProvider extends ServiceProvider {
    register(): void { /* bind services */ }
    async boot(): Promise<void> { /* wire listeners */ }
}
```

3. Create bundle definition:
```typescript
import { Bundle } from '../../core/bundle/Bundle.js';
import { MyServiceProvider } from './MyServiceProvider.js';

export const bundle: Bundle = {
    name: 'my-bundle',
    version: '0.1.0',
    providers: [MyServiceProvider],
};
```

4. Build and load:
```bash
npm run build
npx gears load ./dist/src/bundles/my-bundle
```

### Custom Scheduler and Mutex Implementations

`IScheduler.dispose()` must abort and await active callbacks before returning.
`IMutex.acquire(key, ttlMs, occurrence?)` must atomically claim an optional scheduled
Unix timestamp together with the lock. Reject timestamps at or below the latest
claimed timestamp for that key, and retain that watermark across release, expiry,
and close. A failed acquisition must not consume the occurrence. Custom adapters
must implement these semantics to preserve cron deduplication.

### Adding a Scheduled Task

For application work, register a durable scheduled job. The cron callback only
enqueues; the normal worker owns validation, retries, heartbeats, and execution:

```typescript
async boot(): Promise<void> {
    const scheduled = this.app.make('ScheduledJobs');
    scheduled.register({
        id: 'my-bundle:daily-import',
        cron: '0 6 * * *',
        jobType: 'my-bundle.import',
        payload: { source: 'daily' },
        jobOptions: { maxRetries: 3 },
    });

    this.app.make('JobHandlers').set('my-bundle.import', async (job) => {
        // The occurrence supplies scheduleId, scheduledFor, and an occurrenceId
        // suitable for application-level idempotency.
        await importSource(job.payload.payload.source, job.payload.occurrence);
    });
}
```

Use the lower-level callback form only for small process-local maintenance that
does not need durable retry:

```typescript
async init(app): Promise<void> {
    // init() runs only in worker mode; CLI commands skip it
    // so scheduled tasks won't start during command execution.
    const scheduler = app.make('IScheduler');
    scheduler.schedule('* * * * *', async () => {
        // runs every minute, mutex-protected
    }, 'my-bundle:my-task');
}
```

Unschedule on shutdown:
```typescript
async shutdown(app) {
    app.make('ScheduledJobs').unregister('my-bundle:daily-import');
    app.make('IScheduler').unschedule('my-bundle:my-task');
}
```

### Adding a Job Handler

```typescript
async boot(): Promise<void> {
    const handlers = this.app.make('JobHandlers');
    handlers.set('my-job-type', async (job, { signal }) => {
        signal.throwIfAborted();
        console.log('Processing:', job.payload);
    });
}
```

Queue a job:
```typescript
const queue = app.make('IQueue');
await queue.add('my-job-type', { data: 'value' });

// Delayed job (run in 30 seconds)
await queue.addDelayed('my-job-type', { data: 'value' }, 30_000);
```

### Commands with Preferred Output Mode

For commands that need a specific logger mode:

```typescript
commands: [{
    name: 'my-tui',
    description: 'Launch interactive UI',
    preferredMode: 'tui', // or 'silent', 'json', 'text'
    action: async (args, app) => { /* ... */ }
}]
```

---

## Development Workflow

### Setup

```bash
git clone <repo>
cd gears
npm install
npm run build
```

### Dev Loop

```bash
npm run dev    # tsc -w + nodemon (auto-restart worker on changes)
```

### Testing

```bash
npm test                              # Run all tests
npx vitest run tests/unit/            # Unit tests only
npx vitest run tests/integration/     # Integration tests only
npx vitest                            # Watch mode
```

### Test Helpers

```typescript
import { TestContainer } from '../src/test/helpers/TestContainer.js';

const app = new TestContainer();

// TestContainer comes with a MemoryLogger pre-registered
app.logger.info('Test message');
expect(app.logger.hasLog('info', 'Test message')).toBe(true);
app.logger.clear();
```

### Worker Configuration

CLI flags:
```bash
npx gears work --concurrency 10 --poll-interval-ms 500
```

Environment variables:
- `WORKER_CONCURRENCY` (default 5)
- `WORKER_POLL_INTERVAL_MS` (default 1000)
- `WORKER_RECOVERY_TIMEOUT_MS` (default 300000)
- `WORKER_RECOVERY_CHECK_INTERVAL_MS` (default 60000)
- `WORKER_HEARTBEAT_INTERVAL_MS` (default 30000)

---

## Debugging

### Quick Diagnostics

```bash
npx gears doctor         # Check system health
npx gears queue stats    # Queue metrics
npx gears store dump     # All store entries as JSON
npx gears bundles        # List loaded bundles
```

### Raw SQLite Inspection

```bash
# Queue status breakdown
sqlite3 .gears/jobs.sqlite \
  "SELECT type, status, COUNT(*) FROM jobs GROUP BY type, status"

# Shared DB contents (store/events/metrics share this DB)
sqlite3 .gears/shared.sqlite "SELECT key, value FROM store"

# Active locks
sqlite3 .gears/locks.sqlite \
  "SELECT key, expires_at FROM locks WHERE expires_at > $(date +%s)000"

# Check bundles config
cat bundles.json
```

(Replace `.gears/` with `$GEARS_DATA_DIR` if set.)

---

## Architecture Decisions

### Why SQLite for Everything?

- Zero setup — just works, no external services
- Multi-process safe with WAL mode
- Durable — survives restarts
- Inspectable — standard SQL tools
- Swappable — interfaces allow Redis/Postgres later

### Why Separate register() and boot()?

- `register()` — Safe to run in any order, just declares bindings
- `boot()` — Can depend on other services being registered

This prevents circular dependency issues during startup.

### Why CLI Commands Don't Run init()?

CLI commands need services registered (to access `IStore`, etc.) but shouldn't start background tasks (cron, workers). Skipping `init()` handles this cleanly.

### Why Namespace the Store?

Bundles share a single `IStore` instance. Namespacing prevents key collisions:
- `my-bundle:counter` won't clash with `other-bundle:counter`

### Why Single Worker?

The single-worker invariant enables SQLite as the infrastructure layer. Multiple writers would need coordination protocols, leader election, and distributed locking — exactly the complexity gears avoids. A `PidLocker` enforces this at runtime.
