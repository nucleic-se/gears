# Agentic harness on Gears

A standalone composition of the Agentic harness, using Gears for durable execution.
The original one-turn composition example remains available with `npm run demo`.

See the [north star](NORTH_STAR.md) for the shared Agentic/Gears direction and
the simplicity and reliability criteria that guide this composition.

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
| Agentic context strategy | Shared budgeted policy, token estimates, selection and atomic message-group handling |
| Agentic harness composer and execution services | Extension contracts, request preparation, model boundary and validated tool dispatch |
| Gears driver | Task tree, delegation, progress, budgets, receipts and worker admission |
| Optional adapters | Provider, workspace tools, context composer and web UI |

`StandaloneHarness.open({ dataDir, provider, tools, context, composition, extensions })`
composes the Agentic harness with the Gears driver. It exposes `create`, `send`, `cancel`, `store` and `close`.
`HarnessTool` provides a definition, pure argument validation, an explicit
read/write effect classification, and execution. Tools are trusted host code;
registering an effectful tool grants it to the default root agent. Children can
receive only a subset of their parent's manifest. A production write-tool pack
needs its chosen authorization/approval policy before registration.

`context` uses Agentic's `ContextStrategy` contract, replacing the old
`composeContext` callback. A custom context needs an explicit non-secret
`composition` identity and a consistent usage report for durable token admission.
The built-in strategy is Agentic's `budgetedContext`; its report and final request
pass through the same boundary as the local Agentic agent.

`extensions` use Agentic's `HarnessExtension<GearsHarnessRoles, StandaloneHarness>`.
The composition owns `runtime`, `provider` and `context` roles. The CLI attaches
its optional web UI through extension activation. Shutdown rejects new commands,
drains admitted commands and workers, disposes attached extensions, then releases
the runtime lease and database. Extension disposers can still read committed state.

**Alpha persistence break:** newly created trees use a fingerprinted composition
identity. Old active trees with the previous identity are rejected before recovery
changes them. Use a fresh data directory for this revision, or finish old work
using the previous revision. No automatic migration or silent reset is performed.
Changing the context ceiling, output cap or registered tool manifest also changes
the fingerprint. The CLI additionally includes its model choice. The public
`compositionId` is the identity to use when constructing a tree through the store.

Change the explicit `composition` identifier when changing persisted execution
semantics. Startup refuses incompatible active tasks without changing their execution
state; restoring the original configuration preserves their ability to continue. The CLI binds its composition to the workspace path as well as the role fingerprint. Tool declarations
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
children, then reconcile reported usage. The bundled subscription OAuth transport
removes the requested output cap, so its output reservation is a planning allowance.
Token estimation is not a billing cap:
a provider can report higher usage, which blocks subsequent admission. Unknown
requests keep their reservation. Context preparation plus a provider call defaults to a five-minute absolute deadline.
Set `modelTimeoutMs` in `HarnessOptions`, or CLI `--model-timeout-ms 300000`.
The model queue step gets an additional 30 seconds for receipt/cleanup; tools run
in separate steps with their existing 120-second queue timeout. Both model and
tool execution are also cancelled at the tree's expiry, and receipts cannot mark
expired work completed. Model intents record the effective deadline and configured
limit. These are absolute deadlines, not progress-sensitive idle timers. Unknown
outcomes are still never retried automatically.

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
has a 15-minute overall controller deadline, spawns two real model-driven children, collects their findings, saves progress,
and schedules a continuation. The controller kills the worker with SIGKILL at
that checkpoint, waits for the Gears lease to expire, restarts the same CLI, and
requires completed children and a final review artifact. The report is written
to `.data/dogfood/<run>.json`. This is an acceptance scenario, not a general
coding-agent capability benchmark.

Ordinary tests use fake providers with real Gears queues and databases. The
original one-turn example's recovery and scheduling tests remain included.

The shared `assertHarnessBoundaryConformance` suite now runs against this queued
composition and Agentic's local session composition. It covers isolated context
selection and rejected-request behavior. Gears-specific tests additionally cover
activation rollback, shutdown drain, configuration mismatch and lease recovery.

### Evaluating longer work

Run `npm run dogfood` from this example directory to repeat the source-review
scenario with two children and a forced restart after a scheduled checkpoint.
Dogfooding defaults to `gpt-5.6-terra` for the parent and children, including
after restart. Override it with `AGENTIC_EVAL_MODEL=gpt-6-astra npm run dogfood`
for an explicit heavier-model comparison. The selected model is recorded in the
report; compare outcomes by model rather than merging them.
The controller writes `.data/dogfood/<run>.json` on success or failure, including
elapsed time and its last observed task tree. Each run has its own report file, so later runs do not overwrite failures. Reports and task data stay outside source control.

Context sizes are workload-dependent. The illustrative 128k-token / 4 MB example
in design discussions is not a fixed limit or acceptance requirement.

### Inspecting the machinery

Click **Inspect machinery** on a task tree to capture its committed state and
trace. Expand `model.intent` to see the exact request submitted to the provider
adapter, plus context decisions and token accounting. Model receipts include
outcome, duration and usage; the other events show tool execution and task
transitions. The state includes messages, inboxes, progress, children, wake times
and shared budget charges. Refresh captures again; **Download JSON** saves the
current snapshot and trace page. This works while a model call is in flight.

Programmatically, use `host.inspect(treeId, afterSequence)` or authenticated
`GET /api/tasks/:id/inspect?after=0`. Trace pages contain at most 200 events;
pass `nextSequence` as `after` to continue. Each page is capped at its captured
state revision. Requests are read from durable intents, never reconstructed or
reselected. Older intents may contain only selection decisions rather than the
new full context report.

The snapshot describes committed harness state, not arbitrary extension internals
or provider-private processing. Before request admission, selected context may not
exist yet. An intent alone does not prove dispatch. JSON exports include task and
tool content and inherit the UI's authentication boundary.

### Stable instructions and current state

The Gears composition keeps its system instructions stable. Each request ends
with one protected, host-generated state message containing current call/token
availability, progress notes and artifact names. That message is counted by the
shared Agentic context pipeline and retained in the exact request intent, but is
not appended to conversation history. Later requests replace it with fresh state.
Progress notes remain untrusted agent content, not system instructions.

This preserves a stable prefix where selected history permits it; provider cache
hits or token-cost savings are not guaranteed. Resource figures are a snapshot
before request admission, and concurrent children can consume budget afterward.
Admission still checks the authoritative shared state atomically.

The Gears runtime extension is version 6 (version 4 fixed UTF-8 reads and admission
diagnostics; version 5 added timeout policy and separated model/tool steps;
version 6 preserves ambiguous tool outcomes and validates completed-task continuation). The
configured model timeout is included in the composition fingerprint. Active
trees from earlier compositions require their original revision; new dogfood
runs use fresh data directories. Existing data is not migrated or deleted.
Continuing a completed tree also requires its original composition. An incompatible
follow-up is rejected before ownership or task state changes.

After dispatch, Agentic tool receipts classified as `unknown`, `timeout` or
`cancelled` stop the task as `unknown` in the same transaction as the receipt.
No remaining tools or model calls run automatically, including after restart.
An explicit task cancellation before dispatch remains cancelled and does not imply
an unknown effect.

### Recovering older tool evidence

The built-in context policy can replace older large text results with short
previews and `read_tool_result` references. It uses Agentic's shared retention
policy and only does this under budget pressure when the current task has that
tool. Full evidence stays intact while it fits; Agentic references lower-priority
groups first and stops once the request fits. Include
`read_tool_result` in a delegated child's tools to enable recovery there; grants
are never added implicitly. The two recent exchanges plus the transient state group stay intact, and context reports
show exactly which older payloads were shortened.

`read_tool_result({ messageIndex, offset })` returns up to 8,000 UTF-16 code units
from the exact original text stored in this task's conversation. Continue with
`nextOffset` until `eof`. It cannot address another task, does not reread changed
files or rerun a tool, and continues to work after restart. Invalid indices and
out-of-range offsets fail explicitly. Retrieved chunks are not recursively
replaced with references. This retrieves text, not native media blocks.

The context extension is version 3 for pressure-driven retention; older active compositions
must finish on their matching revision. This does not add semantic summaries,
search across dropped history or a new memory store. Whole groups can still be
dropped under the context ceiling, so it is not a guarantee of arbitrary-history
recall.

### Dogfood controller and admission failures

The controller rejects waits when already cancelled, when a worker exits, or when
launch fails. It drains normal shutdown and forcibly stops only its own disposable
worker if that worker ignores shutdown for 15 seconds. Reports retain the last
observed state on failure and are written to a unique file under `.data/dogfood/`.
Model admission failures identify shared call limits, per-task call limits, token
reservation shortages or expiry; token errors include required and remaining
amounts. Rejected admission still does not dispatch a provider request.

### Repeatable scenario set

Run from this example directory after building:

```sh
node dist/standalone/dogfood.js .
AGENTIC_DOGFOOD_SCENARIO=reconciliation-with-restart node dist/standalone/dogfood.js
```

Both runs use fresh isolated storage, two children, saved progress, scheduled
continuation and a forced checkpoint restart. The first reviews actual harness
source; it checks lifecycle completion, not the correctness of model findings.
The second generates two fixed CSV ledgers in its temporary workspace and checks
an exact combined total excluding void rows in both the artifact and final answer. Its expected result is computed by
the controller and never inserted into the model prompt. This checks an objective
result as well as lifecycle completion; it is not a broad reasoning benchmark.
Reports retain scenario identity, expected result when applicable, task state and
usage. Preserve every run, including failures, when repeating the set.

Combine these with Agentic's `eval:retention` and `eval:retention:live` for controlled
evidence recovery, and the harness tests for deadline/unknown-outcome behavior.
Exact model requests and deadline metadata remain available in the task journal
through inspection. No one scenario substitutes for the other checks.

### Focused source reads

`read_file` accepts an optional byte `limit` from 1 to 16,000 (default 16,000).
The returned `bytesRead` can be smaller to preserve a UTF-8 character boundary;
continue using `nextOffset`. A limit too small to fit the next character returns
an error asking for a larger limit. This lets the model request focused evidence
without a full default chunk. The tool definition changes the CLI composition
fingerprint, so existing active tasks require their matching configuration.

Artifact reads return `totalCharacters`, `offset`, `content`, `nextOffset` and `eof`.
Continue with `nextOffset` until `eof`; offsets count UTF-16 code units and each
page contains at most 12,000 units. An offset exactly at the end returns an empty
EOF page; an offset beyond the end is rejected. Runtime version 7 requires the
original composition for older persisted tasks, as described above.


The context composition (version 5) presents recoverable text tool results using
Agentic's `maxToolResultCharacters: 4000`. Large recent diagnostics receive a
head/tail preview with an exact `read_tool_result` reference. Raw stored messages
remain inspectable and retrievable; retrieval responses are not recursively
shortened. The reference promises the saved tool result, not bytes a source tool
already discarded. The coding runtime additionally saves large shell output up
to its 8 MiB capture limit and exposes `read_output`; both retrieval tools are
excluded from recursive presentation. Grant `read_output` alongside `shell_run`
in coding compositions and keep their output directory with the task data.
The default read-only CLI remains unchanged. Older persisted tasks require their
original context composition. Child-completion messages are not yet budgeted as
a batch by this option.

### Stable model cache scope

The host supplies Agentic's provider-neutral `cacheScope` from the composition and task identity before request preparation and journaling. It survives scheduled continuation and reopen, while children receive distinct scopes. Providers may ignore the hint; the subscription adapter maps it to its own cache-routing fields. This is not a conversation store, cache guarantee or isolation boundary. Current machine state still replaces the final state message on each call.

The `runtime.gears` extension is now version `8`. Existing trees retain their composition fingerprint and require their original runtime composition to resume. Start a new tree for this composition; no stored history is rewritten.


## Experimental working checkpoints

The host can summarize an outgoing history prefix before context selection drops
it. The checkpoint is ordinary text plus a source cursor, while `Task.messages`
retains the complete source history. Each checkpoint call uses the normal model
intent/receipt journal and consumes the same task and shared call/token budgets.
Intent events identify `purpose: checkpoint` and the source range; subsequent
prepared requests show the exact checkpoint the task model received.

Only a complete, nonempty, bounded text response commits the checkpoint. A partial
or failed response preserves the prior checkpoint, notes and source history and
stops the task with a diagnostic. Successful checkpoints reconcile and replace
progress notes. Oversized source groups are processed in bounded chunks with a persisted partial
cursor. Each intent records exact character coverage. The complete history boundary
advances only when the group is fully processed; no source is silently truncated.

`HarnessOptions.checkpointing` defaults to `true`; set it to `false` for an explicit
composition without automatic maintenance. The setting participates in composition
identity. Tool evidence can be retrieved by `callId`, independent of active-context
positions; the older `messageIndex` form still addresses the full archive. Ambiguous
call IDs are rejected. This policy remains under evaluation for retention quality
and maintenance overhead.


Recoverable tool results have 1,000-character previews by default to leave room
for checkpoints and recent instructions. The full original remains in the task
archive and `read_tool_result` pages it without rerunning the tool. Maintenance
fits complete prefixes locally and uses resumable chunks for oversized groups.
These context and runtime changes bump composition identity; open existing task
stores with their original composition rather than silently reinterpreting them.


Prepared requests are owned by Agentic execution; inspection cannot change their
accounting or dispatch content. Checkpoint source messages must survive custom
context preparation unchanged. Rich tool results use the shared Agentic projection
and retain content blocks in the working transcript as well as the receipt.

Gears owns lease checks, shared-budget admission, queue scheduling and atomic
state/receipt commits. Agentic owns source views, checkpoint fitting and cursors,
lossless source preparation, model dispatch and tool-message conversion. The host
supplies transient state to `checkpointView` instead of manually adjusting indexes.
