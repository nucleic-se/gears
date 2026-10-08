# Gears

A modular, local-first alpha runtime for long-running Node.js apps.

Gears provides a worker, SQLite job queue, scheduler, and bundle system so you
can build durable single-machine background apps without rebuilding the same
infrastructure every time. Its APIs may still change incompatibly while the
framework is alpha.

## Highlights
- Worker with retries, heartbeats, and recovery
- SQLite-backed queue and distributed cron locking
- Bundle lifecycle with CLI-safe commands
- DI container and event bus
- **Observability**: Real-time TUI Inspector (`gears top`) and Metrics

## Quickstart

For an independent agent built on the queue and scheduler, see the
[Agentic harness example](examples/agentic-harness/README.md).

```bash
npm install
npm run build
```

Node.js requirement: `>=22.14.0`

Run the worker:
```bash
npx gears work
```

Monitor the system:
```bash
npx gears top
```

Set output mode (global):
```bash
npx gears --output text work
npx gears --output silent queue stats
```

## Cron date calculation

Use the calculation-only entry point without booting Gears or opening a database:

```ts
import { nextCronOccurrence, validateCronSchedule } from '@nucleic-se/gears/scheduling';

const schedule = { cron: '0 9 * * MON-FRI', timeZone: 'Europe/Stockholm' };
validateCronSchedule(schedule); // throws on invalid syntax, timezone or explicit date
const next = nextCronOccurrence(schedule, new Date('2026-10-08T07:00:00Z'));
// 2026-10-09T07:00:00.000Z — strictly after the supplied instant
```

Both functions are also exported from the main package. `CronSchedule` is the
public readonly `{ cron: string; timeZone: string }` type. Five-field expressions
and six-field expressions including seconds use node-cron's supported syntax;
parser-only extensions such as `L` and `@daily` are rejected. Both day-of-month
and weekday must match, consistent with Gears' existing scheduler.

An explicit timezone and a valid `Date` reference are required. Calculation does
not read the wall clock, mutate the reference, register jobs, perform catch-up,
create an occurrence identity or execute work. No expiry or interval/task lifecycle
is implied. Invalid inputs and dates with no calculable occurrence throw.

Calendar iteration uses the pinned cron-parser DST policy: a nonexistent local
02:30 in Stockholm's spring transition advances to 03:30 that day. Iterating
from before the autumn overlap emits the first 02:30, then the following day;
starting inside the second repeated hour can select that hour instead. Ordinary
local times such as 09:00 keep their wall-clock time as the UTC offset changes.
These are calculation semantics, not runtime delivery guarantees. Existing
node-cron callbacks are unchanged and can behave differently at skipped/repeated
clock times; callers needing identical execution must drive work from these
calculated UTC instants. The API searches at most 400 calendar years.

## Bundles
Bundles are the unit of extension in Gears. Each bundle can register services, CLI commands, and optional background behavior.

**Internal bundles** (ship with gears):
- `database` — Kysely SQLite connection

Bundle commands use the pattern:
```bash
npx gears <bundle> <command>
```

## Data Directory
Gears stores its SQLite files under `GEARS_DATA_DIR`. If not set, it defaults to `./.gears`.

```bash
export GEARS_DATA_DIR=/absolute/path/to/.gears
```

Core files:
- `jobs.sqlite` — queue
- `locks.sqlite` — mutex locks
- `shared.sqlite` — store + durable events + metrics
- `app.log` — runtime logs

The app database (Kysely) uses:
- `GEARS_APP_DB_PATH`
- default: `app.sqlite`

## Environment Variables
```bash
WORKER_CONCURRENCY=5
WORKER_POLL_INTERVAL_MS=1000
WORKER_RECOVERY_TIMEOUT_MS=300000
WORKER_RECOVERY_CHECK_INTERVAL_MS=60000
WORKER_HEARTBEAT_INTERVAL_MS=30000
```

Gears intentionally has no built-in LLM or agent runtime. Applications and bundles
bring their own model integration when needed.

## Documentation
See `docs/` for architecture, bundle design, CLI, and data layout.

## Development
```bash
npm run dev
```

This runs the TypeScript watcher and restarts the worker automatically.

## Release validation

See [release checks and supported runtime](docs/RELEASE_VALIDATION.md) for CI,
consumer-package validation, and test type-checking.
