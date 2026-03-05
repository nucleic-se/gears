# CLI

gears CLI auto-discovers bundle commands plus built-in runtime commands.

## Global Flags

```bash
npx gears --output <mode> <command>   # text | json | silent | tui
npx gears --debug <command>    # Enable debug-level logging
```

Notes:
- `--output` controls logger mode.
- `text` logs to stderr + file.
- `json`, `silent`, and `tui` suppress console logs and keep file logging.
- Command output (`ConsoleOutput`) is still written to stdout by the command itself.

## Core Commands

```bash
npx gears work                 # Start the worker process
npx gears bundles              # List all enabled bundles
npx gears load <path>          # Load and persist a bundle
npx gears unload <name>        # Remove a bundle from config
npx gears doctor               # Check system health and dependencies
npx gears top                  # TUI monitor (queue stats, metrics, log tail)
npx gears store dump           # Dump all IStore entries as JSON
```

### Worker Options

```bash
npx gears work --concurrency 10
npx gears work --timeout 3600              # Exit after N seconds
npx gears work --poll-interval-ms 500
npx gears work --recovery-timeout-ms 600000
npx gears work --recovery-check-interval-ms 30000
npx gears work --heartbeat-interval-ms 15000
```

All flags have matching environment variables (e.g. `WORKER_CONCURRENCY`).

## Queue Commands

```bash
npx gears queue stats                      # Queue metrics overview
npx gears queue list [status]              # List jobs (default status: failed)
npx gears queue list failed --type <type>  # Filter by job type
npx gears queue inspect <jobId>            # Show job details
npx gears queue retry <jobId>              # Retry a specific failed job
npx gears queue retry-all [--type <type>]  # Retry all failed jobs
npx gears queue clear <status>             # Purge jobs by status
npx gears queue delete <jobId>             # Delete a job
npx gears queue requeue <jobId>            # Move processing job -> pending
npx gears queue requeue-all [--type <type>]# Requeue all processing jobs
```

## Bundle Commands

Bundle commands are auto-registered under the bundle name:

```bash
npx gears <bundle> <command> [args] [options]
```

Examples:
```bash
npx gears queue stats
npx gears queue list failed
npx gears store dump
```

## How It Works

1. CLI boots the framework (`register()` + `boot()` only — `init()` is skipped)
2. BundleManager restores persisted bundles from `bundles.json`
3. Each bundle's `commands[]` are registered under its name
4. When a command is invoked, it receives parsed args and the DI container
5. Commands can set `preferredMode` (e.g. `tui` or `silent`) in `CommandDefinition`
