# Agentic harness on Gears

An independent standalone agent built from Agentic primitives and Gears infrastructure.
The original one-turn composition example remains available with `npm run demo`.

## Run the standalone agent

From the Gears repository (requires a sibling Agentic checkout and Node >=22.14):

```sh
npm --prefix ../agentic install
npm --prefix ../agentic run build
npm install
npm run build
npm --prefix examples/agentic-harness ci
npm --prefix examples/agentic-harness run build
npm --prefix examples/agentic-harness run agent -- --workspace /path/to/project
```

Open `http://127.0.0.1:4318` and enter the access token printed at startup. It uses
existing Codex subscription auth, with `gpt-6-astra` by default. Set `--model` to
select another supported model. `GEARS_AGENT_TOKEN` supplies a stable UI token.
The UI token is separate from model credentials; model credentials never go to
the browser.

For a phone on the same trusted Wi-Fi, add `--host 0.0.0.0` and open
`http://YOUR_COMPUTER_LAN_IP:4318`. This HTTP server is for local/trusted LAN use;
it is not an internet deployment. The web UI attaches to the running host and
can disconnect without stopping tasks. Keep the computer awake for scheduled
execution; overdue continuations run when the host next starts.

`--data /path/to/state` selects durable storage (default `.data/standalone`).
`--no-web` runs only the worker. Stop with Ctrl-C. A process killed abruptly may
leave the Gears host lease active for up to 15 seconds; restart after it expires.
Do not set `GEARS_APP_DB_PATH`: this harness uses its own data directory.

## What it does

- Tool-using model loop with durable sessions, model intents, receipts and usage.
- Subagents with separate conversations, explicit context, restricted tool subsets,
  bounded depth/count and individual call limits under a shared tree budget.
- Parent/child messaging, waiting for child results, and cascading cancellation.
- Self-scheduled continuation: save state, release the worker, resume at a future
  time. Repeated wakes remain bounded by task expiry and shared budgets.
- Durable progress notes included in every context preparation, a protected
  objective, and named text artifacts with bounded retrieval.
- Optional web UI: start tasks, inspect parent/child status and results, send
  messages, cancel work and read artifacts.
- Read-only workspace tools by default. They read real files within the configured
  workspace; this first version does not run shell commands or edit source files.

Example task:

> Review this repository. Delegate separate API and test reviews, wait for their
> findings, save your progress, wake in five minutes, then write a prioritized
> review artifact.

## Ownership and extension points

| Component | Responsibility |
| --- | --- |
| Gears `IQueue` / `Worker` | Durable steps, per-task concurrency keys, parallel children, cancellation and shutdown |
| Gears named delayed jobs | Persistent wake delivery and idempotent repair of state-to-queue gaps |
| Gears `IMutex` | Renewable ownership of one standalone host per data directory |
| Gears database provider | Connection and lifecycle for application-owned tables |
| Agentic context primitive | Token estimates, selection and atomic message-group handling |
| Agentic execution primitives | Model boundary and validated tool dispatch |
| Standalone harness | Task tree, delegation, progress, budgets and receipts |
| Optional adapters | Provider, workspace tools, context composer and web UI |

`StandaloneHarness.open({ dataDir, provider, tools, composeContext, composition })`
creates the runtime. It exposes `create`, `send`, `cancel`, `store` and `close`.
`HarnessTool` provides a definition, pure argument validation, an explicit
read/write effect classification, and execution. Tools are trusted host code;
registering an effectful tool grants it to the default root agent. Children can
receive only a subset of their parent's manifest. A production write-tool pack
needs its chosen authorization/approval policy before registration.

Change the explicit `composition` identifier when changing persisted execution
semantics. Startup refuses incompatible active tasks without changing their execution
state; restoring the original configuration preserves their ability to continue. The CLI binds its composition to the workspace path. Tool declarations
are not a sandbox; filesystem confinement does not defeat hostile local races.

The bounded task tree is the transaction boundary. Creating a child, spending
shared budget, or saving an internal tool result cannot partially update the
parent and child. Durable state is authoritative; queue entries are delivery
triggers. A periodic host reconciliation queries indexed active trees and repairs interrupted
enqueue steps. The UI paginates history separately. Tree owner epochs and captured
revision checks fence stale-host writes and startup claims.
There is no Assembly dependency, meeting model, fleet registry or extra queue.
Gears core has no Agentic dependency.

## Recovery and limits

Safe checkpoints (between model/tool calls, while waiting, and while sleeping)
resume after restart. A model or external tool that may have executed without a
receipt is marked `unknown`; it is never silently replayed. Inspect events and
start new work with the evidence. This version does not provide an operation
resolution UI. Cancellation is best effort and cannot undo an external effect.

Default tree limits: 60 model calls, 200,000 tokens for admission, eight children,
two delegation levels, and 24-hour expiry. Each task also has an individual call
limit. Model calls reserve estimated input plus maximum output atomically across
children, then reconcile reported usage. Token estimation is not a billing cap:
a provider can report higher usage, which blocks subsequent admission. Unknown
requests keep their reservation. Provider calls have a 90-second deadline.

The tree journal favors simple atomicity over very large-scale storage. It stores
bounded text artifacts in SQLite and retains event history. There is no automatic
journal pruning or model-written transcript compaction yet; context preparation
selects from history while progress notes and the objective remain available.

## Verification and dogfooding

```sh
npm --prefix examples/agentic-harness test
npm --prefix examples/agentic-harness run dogfood -- .
```

Run the dogfood command from this package directory, or pass its absolute path
as the workspace. It uses your live subscription to review the harness itself,
spawns two real model-driven children, collects their findings, saves progress,
and schedules a continuation. The controller kills the worker with SIGKILL at
that checkpoint, waits for the Gears lease to expire, restarts the same CLI, and
requires completed children and a final review artifact. The report is written
to `.data/dogfood-report.json`. This is an acceptance scenario, not a general
coding-agent capability benchmark.

Ordinary tests use fake providers with real Gears queues and databases. The
original one-turn example's recovery and scheduling tests remain included.
