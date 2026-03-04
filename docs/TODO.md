# Roadmap & TODOs

Harvested from current codebase analysis.

## Done

- [x] **Typed Service Keys**: `ServiceMap` provides type-safe `app.make()` via string literal keys.
- [x] **Unified Disposal Pattern**: `IDisposable` interface; `Container.shutdown()` handles disposal.
- [x] **Explicit State Machine**: Bundle lifecycle (`loaded` → `registered` → `booted`).
- [x] **Typed Job Definitions**: `JobRegistry` with Zod schemas and `JobValidationError` handling.
- [x] **Worker Invariant Enforcement**: `PidLocker` prevents multiple worker processes.
- [x] **Robust Queue Migrations**: Versioned schema migrations for SQLiteQueue.
- [x] **Unified CLI Bootstrapping**: `Bootstrap` class with output/debug options.
- [x] **Standardized Error Handling**: `GearsError` base class, consistent `logger.error` usage.
- [x] **Metrics Service (`IMetrics`)**: SQLite-backed counters and gauges.
- [x] **Instrumentation**: Worker, Queue, and LLMProvider metrics.
- [x] **Gears Inspector (`gears top`)**: TUI showing queue stats, metrics, log tail.

## Core Architecture

- [ ] **IConfig service** — Centralized, environment-aware configuration. Replace scattered env var reads and hardcoded values with a unified `IConfig` interface (env + file + defaults).
- [ ] **Decouple `services.ts` from bundles** — Core directly imports bundle types. Use declaration merging so bundles extend `ServiceMap` from their own files.
- [ ] **Constructor injection** — Some services (`InboxService`, `NotesService`, `EmotionService`) accept `Container` and call `make()` per-method. Inject concrete dependencies via constructor.
- [x] **Cross-process EventBus** — SQLite-backed durable events for inter-process communication (`IDurableEventBus` / `SQLiteDurableEventBus`).

## Reliability

- [x] **SQLiteStore TTL sweeper** — Background cleanup of expired entries.
- [ ] **ProcessorService idempotency** — Track processed item IDs to prevent duplicate creation on crash recovery.
- [ ] **NotificationService exponential backoff** — Increase delay on consecutive Telegram API errors.

## Developer Experience

- [ ] **Input validation in AIActionRegistry** — Validate payloads against `action.schema` before calling handlers.
- [ ] **Required env var validation at boot** — Bundles declare required env vars; `doctor` checks them.
- [ ] **`--dry-run` mode** — Validate config and bundle loading without starting workers.

## Test Coverage

- [ ] **Unit tests for SQLiteStore** — `delete`, `has`, `namespace`, `scan`, `setIfNotExists`, TTL.
- [ ] **Unit tests for VectorService** — `getRandom`, `delete`, `swap`, `searchNear`, edge cases.
- [x] **Unit tests for Container** — `bind` vs `singleton`, `bound`, `shutdown`, re-registration, leaks.
- [ ] **Unit tests for EmotionService** — `react`, `decay`, `getPublicState`, delta application.
- [ ] **Fix flaky integration tests** — Replace `setTimeout` polling with event-driven completion.

## Future Features

- [ ] **Web Dashboard** — Local web dashboard consuming `IStore` and `IQueue` stats (evolution of `gears top`).
- [ ] **Bundle Registry** — Standard way to install/distribute bundles (`npx gears install`).
- [ ] **Crawl bundle extraction** — Move `IFetcher` and crawler logic out of core into a dedicated bundle.
- [ ] **Per-bundle/per-job concurrency limits** — Fine-grained worker concurrency control.

## Documentation

- [ ] **"Escape Hatch" Guide** — How to migrate from SQLite to Redis/Postgres when scaling up.
- [ ] **Event naming conventions** — Document `namespace:action` pattern for events, jobs, and store keys.
