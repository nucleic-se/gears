# Architecture

gears is a local-first automation runtime with durable state, background jobs, scheduled tasks, and hot-pluggable modules.

---

## Core Philosophy

gears answers a specific question: *What's the simplest possible way to run durable background work on a single machine, with plugin-style extensibility?*

The answer: **SQLite + single worker + strict lifecycle contracts.**

This is intentional restraint, not under-engineering. gears avoids accidental distributed complexity — no Redis, no message brokers, no coordination protocols. Just the things you actually need.

---

## What gears Is

- A **local automation runtime** — not a web framework, broker, or cloud service
- A **durable task orchestration engine** — jobs survive restarts
- A **plugin system** — bundles add functionality without modifying core
- An **inspectable system** — CLI tooling exposes operational workflows

## What gears Is Not

- Not a distributed job system
- Not a multi-worker cluster coordinator
- Not a high-throughput message broker
- Not a web framework or HTTP server
- Not a database ORM

---

## The Single-Worker Invariant

Everything in gears works because of one assumption: **one worker process, one SQLite writer.**

This invariant enables:
- SQLite as a coordination primitive (queue, mutex, store)
- Simple cron scheduling without leader election
- Hot-reload without distributed cache invalidation
- CLI commands that safely read/write shared state

The invariant is architectural, not accidental. Protect it.

### When to Graduate

If you need multiple worker processes, gears is not the right tool. Consider:
- **Temporal** — durable workflow orchestration
- **BullMQ** — Redis-backed job queue with workers
- **Celery** — distributed task queue for Python

---

## SQLite as Infrastructure

SQLite is not a compromise or placeholder. It's the coordination kernel.

| Component | Role |
|-----------|------|
| `SQLiteQueue` | Job persistence with status machine (`pending → processing → completed/failed`) |
| `SQLiteMutex` | Distributed locks via `INSERT OR FAIL` + TTL expiry |
| `SQLiteStore` | Persistent key-value storage, namespaced per bundle |
| `CronScheduler` | Uses mutex to prevent duplicate scheduled runs |
| `SQLiteMetrics` | Counters and gauges for observability |

All databases live under `GEARS_DATA_DIR` (defaults to `./.gears`):
- `jobs.sqlite` — queue state
- `locks.sqlite` — distributed mutex locks
- `shared.sqlite` — shared DB used by store, metrics, and durable event bus
- `app.sqlite` — app data (Kysely, via database bundle)

Key configuration:
- **WAL mode** — concurrent reads during writes
- **Busy timeout** — waits for locks instead of failing immediately
- **Heartbeats** — active jobs update timestamps; recovery detects stale jobs

### Failure Handling

- **Worker crash**: Recovery loop resets jobs stuck in `processing` beyond timeout
- **Lock expiry**: Mutex entries have TTLs; stale locks are garbage-collected
- **Job retries**: Configurable max attempts with exponential backoff

---

## Lifecycle Contracts

Bundles and providers follow a strict three-phase lifecycle:

| Phase | What Happens | Side Effects |
|-------|--------------|--------------|
| `provider.register()` | Bind services to container | None — no resolution allowed |
| `provider.boot()` | Wire listeners, resolve dependencies | Lightweight only |
| `bundle.init()` | Start cron jobs, background loops | Long-running work |

### CLI vs Worker

- **Worker** (`npx gears work`): Runs all three phases. Background tasks start.
- **CLI commands**: Run `register()` + `boot()` only. `init()` is skipped.

This separation prevents CLI commands from accidentally starting schedulers, consuming queue jobs, or duplicating background work.

### Shutdown

Bundles may define `shutdown()` to clean up:
- Unschedule named cron tasks
- Flush pending writes
- Release resources

The container calls `dispose()` or `close()` on all singletons during `app.shutdown()`.
**Crucially, this happens in LIFO order (Last-In, First-Out).** Services are disposed in the reverse order of their resolution. This ensures that dependent services (e.g., Worker) are stopped before their dependencies (e.g., Database) are closed.

---

## Hot Reload

Bundles can be loaded and unloaded without restarting the worker because:

1. **State is external** — Jobs, locks, and stores live in SQLite, not memory
2. **Tasks are named** — Schedulers can unschedule by job name
3. **Shutdown hooks exist** — Bundles clean up before unload
4. **Dependencies are declared** — BundleManager respects `requires` ordering

The worker watches `bundles.json` for changes and reconciles automatically.

---

## Container (Dependency Injection)

The DI container is minimal by design:

```typescript
app.bind('Key', (container) => new Service());      // Factory — new instance each time
app.singleton('Key', (container) => new Service()); // Lazy singleton
app.make<ILogger>('ILogger');                       // Resolve (type-safe via ServiceMap)
```

The container uses a typed `ServiceMap` registry so `app.make()` returns the correct type for known keys. Cycle detection prevents infinite resolution loops.

This simplicity works because the entire system runs in one process — no need for sophisticated scoping or cross-service coordination.

### Core Services (registered by CoreServiceProvider)

| Key | Implementation |
|-----|----------------|
| `ILogger` | `PinoLogger` (respects output mode + debug options) |
| `IStore` | `SQLiteStore` (with TTL sweeper) |
| `IMutex` | `SQLiteMutex` |
| `IScheduler` | `CronScheduler` (mutex-backed) |
| `IEventBus` | `EventBus` |
| `IFetcher` | `RateLimitedFetcher` (1s default) |
| `IHtmlParser` | `CheerioParser` |
| `ILLMProvider` | `OllamaLLMProvider` |
| `IMetrics` | `SQLiteMetrics` |
| `BundleManager` | `BundleManager` |

### Queue Services (registered by QueueServiceProvider)

| Key | Implementation |
|-----|----------------|
| `IQueue` | `SQLiteQueue` |
| `Worker` | `Worker` (concurrent job processor) |
| `JobRegistry` | `JobRegistry` (schema validation) |
| `JobHandlers` | `Map<string, JobHandler>` |

---

## Queue & Worker

### Job Lifecycle

```
pending → processing → completed
                    ↘ failed (after max retries)
```

### Job Options

Jobs support: `maxRetries`, `backoffBase`, `heartbeatIntervalMs`, `stuckTimeoutMs`, `executionTimeoutMs`, `priority`, `ttlMs`.

### Worker Behavior

- **Concurrent processing**: Fills slots up to `maxConcurrency` (default 5)
- **Heartbeats**: Active jobs ping `updated_at` periodically
- **Recovery**: Background loop resets stuck `processing` jobs
- **Graceful shutdown**: Awaits all active jobs (up to `shutdownTimeoutMs`)
- **Priority**: Jobs dequeued by priority, then by `scheduled_at`
- **Metrics**: Reports throughput, latency, token usage via `IMetrics`

### Worker Configuration

Environment variables:
- `WORKER_CONCURRENCY` — max concurrent jobs (default 5)
- `WORKER_POLL_INTERVAL_MS` — polling frequency (default 1000)
- `WORKER_RECOVERY_TIMEOUT_MS` — stuck job threshold (default 300000)
- `WORKER_RECOVERY_CHECK_INTERVAL_MS` — recovery loop frequency (default 60000)
- `WORKER_HEARTBEAT_INTERVAL_MS` — heartbeat interval (default 30000)

---

## Bundles

Bundles are plugins that extend gears with new capabilities.

### Structure

```
src/bundles/my-bundle/
├── index.ts              # Bundle definition
├── MyServiceProvider.ts  # Service registration + boot logic
└── MyService.ts          # Business logic
```

### Definition

```typescript
export const bundle: Bundle = {
    name: 'my-bundle',
    version: '0.1.0',
    description: 'What this bundle does',
    requires: ['database'],
    providers: [MyServiceProvider],
    commands: [...],

    async init(app) { /* worker-only startup */ },
    async shutdown(app) { /* cleanup */ }
};
```

### Dependency Resolution

- `requires` declares bundle dependencies
- BundleManager boots dependencies first (topological sort)
- Circular dependencies throw `CircularDependencyError`
- Missing dependencies throw `MissingDependencyError`
- Reserved names (`work`, `bundles`, `load`, `unload`) are rejected

---

## Event Bus

Bundles communicate via a simple pub/sub event bus:

```typescript
const events = app.make<IEventBus>('IEventBus');

// Emit (fire-and-forget — errors logged, not propagated)
await events.emit('item:created', { id: '123' });

// Listen (returns unsubscribe function)
const unsub = events.on('item:created', async (payload) => { ... });

// Strict mode (throws if any handler fails)
await events.emitStrict('critical:event', data);
```

The in-process event bus (`IEventBus`) is for intra-process events only. For cross-process communication, use `IDurableEventBus` — a SQLite-backed durable event bus that persists events and delivers them across processes via polling. Local subscribers fire immediately on emit; remote processes pick up events on the next poll cycle.

---

## LLM Integration

A core `ILLMProvider` interface provides structured JSON output via Ollama. Core AI services in `src/core/ai` provide higher-level APIs:

- **IAIPromptService** — Fluent prompt builder (`.system()`, `.user()`, `.schema()`, `.run()`)
- **IAIPipeline** — Chainable pipeline (`.llm()`, `.pipe()`, `.transform()`, `.validate()`, `.retry()`, `.clog()`, `.catch()`)
- **IAIActionRegistry** — Tool/action registration for LLM-driven function calling

---

## Use Cases

| Use Case | Key Features Used |
|----------|-------------------|
| Background agents / chatrooms | Queue, LLM integration, Store, Vectors |
| Local automation (IFTTT-style) | Scheduler, EventBus, Bundles |
| Data pipelines / ETL | Queue (job chaining), Store |
| Web crawlers / scrapers | Queue, Scheduler, Store, Fetcher |
| Monitoring / watchdogs | Scheduler, Notifications |
| CI/CD helpers | Queue, CLI commands |

gears is **not** suited for:
- High-throughput systems needing horizontal scaling
- Multi-machine deployments
- Real-time streaming workloads

---

## Known Boundaries

### Single Writer Assumption

SQLite handles concurrent reads well, but gears assumes one writer (the worker). CLI commands are short-lived and occasionally write. Running multiple workers will cause undefined behavior. A `PidLocker` enforces the single-worker invariant at runtime.

### No Built-in Config System

Configuration is currently environment-based or hardcoded. An `IConfig` service is planned but not yet implemented.

---

## Future Directions

- **IConfig service** — Centralized, environment-aware configuration
- **Inspector Web UI** — Local web dashboard (evolution of `gears top`)
- **Bundle Registry** — Standard way to install/distribute bundles
- **Crawl bundle extraction** — Move `IFetcher` to an optional bundle
- **Typed container keys** — Further type safety improvements

---

## Summary

gears is a focused tool that knows its place. It provides durable, inspectable background orchestration without becoming a distributed systems research project.

The constraints are intentional:
- Single worker enables SQLite as infrastructure
- Lifecycle contracts prevent accidental side effects
- External state enables hot reload
- Minimal container reduces complexity

If a system runs mostly on one machine, needs background work, benefits from plugins, values inspectability, and doesn't want infrastructure overhead — gears is a solid foundation.
