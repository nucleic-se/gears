# Roadmap & TODOs

Updated to reflect the current `gears` codebase.

## Done

- [x] **Typed Service Keys**: `ServiceMap` provides type-safe `app.make()` via string literal keys.
- [x] **Unified Disposal Pattern**: `IDisposable` interface; `Container.shutdown()` handles disposal.
- [x] **Explicit State Machine**: Bundle lifecycle (`loaded` -> `registered` -> `booted`).
- [x] **Typed Job Definitions**: `JobRegistry` with Zod schemas and `JobValidationError` handling.
- [x] **Worker Invariant Enforcement**: `PidLocker` prevents multiple worker processes.
- [x] **Robust Queue Migrations**: Versioned schema migrations for SQLiteQueue.
- [x] **Unified CLI Bootstrapping**: `Bootstrap` class with output/debug options.
- [x] **Standardized Error Handling**: `GearsError` base class, consistent `logger.error` usage.
- [x] **Metrics Service (`IMetrics`)**: SQLite-backed counters and gauges.
- [x] **Instrumentation**: Worker, Queue, and LLM providers emit metrics.
- [x] **Gears Inspector (`gears top`)**: TUI showing queue stats, metrics, and log tail.
- [x] **Cross-process EventBus**: `IDurableEventBus` / `SQLiteDurableEventBus`.
- [x] **Node version checks aligned**: `doctor` and `package.json` now both require Node >= 20.18.1.
- [x] **Queue requeue filter parity**: `queue requeue-all --type` now filters by job type.
- [x] **Bundle command namespace hardening**: Additional core commands reserved for bundle names.

## Core Runtime

- [ ] **IConfig service**: Centralize env/file/default config instead of scattered `process.env` reads.
- [ ] **Decouple `services.ts` from bundles**: Use declaration merging so bundles extend `ServiceMap` from their own modules.

## Reliability

- [x] **SQLiteStore TTL sweeper**: Background cleanup of expired entries.

## Developer Experience

- [ ] **Input validation in AIActionRegistry**: Validate payloads against `action.schema` before calling handlers.
- [ ] **Required env var validation at boot**: Let bundles declare required env vars; surface them in `doctor`.
- [ ] **`--dry-run` mode**: Validate config and bundle loading without starting workers.

## Test Coverage

- [ ] **Expand SQLiteStore unit tests**: Cover `delete`, `has`, `namespace`, `scan`, `setIfNotExists`, and TTL behavior.
- [x] **Unit tests for Container**: `bind` vs `singleton`, `bound`, `shutdown`, re-registration, leaks.
- [ ] **Fix flaky integration tests**: Replace `setTimeout` polling with event-driven completion.
