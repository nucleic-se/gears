# Gears

A modular, local-first runtime for long-running Node.js apps.

Gears gives you a hardened worker, job queue, scheduler, and bundle system so you can build durable background apps without re‑building infrastructure every time.

## Highlights
- Worker with retries, heartbeats, and recovery
- SQLite-backed queue and distributed cron locking
- Bundle lifecycle with CLI-safe commands
- DI container and event bus
- **Observability**: Real-time TUI Inspector (`gears top`) and Metrics

## Quickstart

```bash
npm install
npm run build
```

Node.js requirement: `>=20.18.1`

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
LLM_PROVIDER=ollama

OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b
OLLAMA_EMBED_MODEL=nomic-embed-text:latest
OLLAMA_API_KEY=
OLLAMA_EMBED_HOST=
OLLAMA_TIMEOUT_MS=120000
OLLAMA_RETRIES=0

ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_MAX_TOKENS=4096

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash
GEMINI_EMBED_MODEL=text-embedding-004
GEMINI_TIMEOUT_MS=120000

WORKER_CONCURRENCY=5
WORKER_POLL_INTERVAL_MS=1000
WORKER_RECOVERY_TIMEOUT_MS=300000
WORKER_RECOVERY_CHECK_INTERVAL_MS=60000
WORKER_HEARTBEAT_INTERVAL_MS=30000
```

## Documentation
See `docs/` for architecture, bundle design, CLI, and data layout.

## Development
```bash
npm run dev
```

This runs the TypeScript watcher and restarts the worker automatically.
