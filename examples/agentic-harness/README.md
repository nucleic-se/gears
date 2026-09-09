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
- The root task uses the configured shared model-call allowance. Continuation
  and reopening preserve usage; child tasks retain their individual call limits.
- Parent/child messaging, waiting for child results, and cascading cancellation.
- Self-scheduled continuation: save state, release the worker, resume at a future
  time. Repeated wakes remain bounded by task expiry and shared budgets.
- Durable progress notes included in every context preparation, a protected
  objective, and named text artifacts with bounded retrieval.
- Optional web UI: start tasks, inspect parent/child status and results, send
  messages, cancel work and read artifacts.
- Read-only workspace tools by default. They read real files within the configured
  workspace. The optional coding mode also permits edits and shell commands.
  The shared file reader returns PNG, JPEG, GIF and WebP captures as native image
  attachments when no encoding is specified (5 MiB maximum, no automatic resizing).
  Image results use the same context and provider contracts as other tool output;
  viewing them requires an image-capable model.

Example task:

> Review this repository. Delegate separate API and test reviews, wait for their
> findings, save your progress, wake in five minutes, then write a prioritized
> review artifact.

## Ownership and extension points

The coding CLI composes Agentic's `codingAgentContext` and coding tools with the
queued Gears driver. Coding instructions, scoped project-instruction discovery,
tool-result labels, archive references and checkpoint policy are shared with the
local default agent. The CLI reserves the same 4096 output tokens; Gears adds its
live state suffix when orchestration capabilities are enabled. Agentic protects
that status separately from the shared recent-conversation allowance.
Tool grants preserve the composition's declared order.

The lower-level `StandaloneHarness.open` remains a generic task host. Its default
context uses Agentic's `agentContext` with generic task instructions. Supplying
`context` replaces the complete policy, including system/project instructions and
lifecycle; the driver no longer overrides the custom strategy's system prompt.
Use a new composition identity when changing that policy. These alpha changes
alter the runtime fingerprint: active tasks still require their original runtime
and configuration; they are not silently migrated.

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

`await host.send(treeId, taskId, message)` persists and schedules the message; it
does not wait for the task to finish. Keep the host running while observing task
state through `inspect` or `store.get`. Closing immediately after `send` can
interrupt the newly admitted work. A program that needs the answer must observe
completion before closing; shutdown is not a completion wait.

`HarnessTool` provides a definition, pure argument validation, an explicit
read/write effect classification, and execution. Tools are trusted host code;
registering an effectful tool grants it to the default root agent. Children can
receive only a subset of their parent's manifest. A production write-tool pack
needs its chosen authorization/approval policy before registration.

`context` uses Agentic's `ContextStrategy` contract. A custom context needs an explicit non-secret
`composition` identity and a consistent usage report for durable token admission.
The built-in strategy resolves its ceiling from the provider's advertised model
capacity through Agentic's `resolveContextBudget`. `contextTokens` can impose a
smaller working cap; an unknown provider needs an explicit value. The resolved
ceiling is fingerprinted. This does not increase the tree's spending, call or
time limits. Custom context strategies own their context policy; `contextTokens` does not
constrain them. They still must supply consistent accounting.

The built-in strategy is Agentic's `budgetedContext`; its report and final request
pass through the same boundary as the local Agentic agent.

`extensions` use Agentic's `HarnessExtension<GearsHarnessRoles, StandaloneHarness>`.
The composition owns `runtime`, `provider` and `context` roles. The CLI attaches
its optional web UI through extension activation. Shutdown rejects new commands,
requests cancellation of active work, drains admitted commands and shutdown
receipts, disposes attached extensions, then releases
the runtime lease and database. Extension disposers can still read committed state.

**Alpha persistence break:** newly created trees use a fingerprinted composition
identity. Old active trees with the previous identity are rejected before recovery
changes them. Use a fresh data directory for this revision, or finish old work
using the previous revision. No automatic migration or silent reset is performed.
Changing the context ceiling, output cap or registered tool manifest also changes
the fingerprint. Declared provider configuration is also fingerprinted. The public
`compositionId` is the identity to use when constructing a tree through the store.

Providers may declare a stable, non-secret `configurationIdentity` through the
Agentic provider contract. Gears snapshots it into the provider role before opening
resources. A changed declared identity rejects active-tree recovery and completed
tree continuation even if the caller reuses the same `composition` label.
The subscription provider includes model, endpoint and effective reasoning effort.
For a provider without this metadata, `composition` is required and the caller
must change it when provider behavior changes. Credentials and opaque callbacks
are not introspected; identify custom behavioral overrides in that label too.

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

### Resolving an uncertain tool

Inspect the task's `activeTool` and journal, then independently verify its external
outcome. Call `host.resolveTool(treeId, taskId, callId, { expectedRevision, evidence,
result })`, where `result` is a known `ToolCallResult`. The authenticated HTTP
equivalent is `POST /api/tasks/:id/resolve` with `{ taskId, callId, resolution }`.
Use the revision from the current inspection snapshot. Stale revisions and
already-resolved calls are rejected.

Resolution records evidence and leaves the task `paused`. It never reruns the
uncertain call. Send a separate continuation message to execute the remaining
pending calls and continue the model. Existing receipts remain intact; a verified
correction is included in subsequent context. If the process died before any
receipt, resolution supplies that missing tool result. Unknown model requests
use the acknowledgement API below. There is no resolution form in the UI yet.

### Continuing after an unknown model outcome

If the task stopped with an unknown model outcome, inspect its `operationId` and
journal. Call `host.acknowledgeModel(treeId, taskId, operationId, expectedRevision)`
to accept that uncertainty and leave the task `paused`. Then send a separate
continuation message. The HTTP equivalent is
`POST /api/tasks/:id/acknowledge-model` with `{ taskId, operationId, expectedRevision }`.
There is no acknowledgement form in the UI yet.

This acknowledges possible provider processing or cost; it does not establish
what the lost response contained. Known history, progress notes, context state,
usage, charges, call counts and expiry remain intact. Unknown usage stays charged
at its existing estimate, not zero. Acknowledgement neither dispatches a request
nor replays a tool; continuation prepares a new model operation from saved state
under the remaining allowances. Active steps, stale revisions, expired tasks,
wrong operations and unresolved tool effects are rejected.

The same API applies to children. Previously delivered child results remain in
the parent's history. A parent still waiting for that child observes its eventual
completion; an already completed parent needs an explicit follow-up to consider
the new result. Acknowledgement never silently reruns the parent.

Worker recovery uses the host's 15-second lease window with one-second heartbeats.
This releases a dead queue attempt's concurrency slot after restart; it does not
impose a 15-second limit on healthy calls. Retry limits remain zero.

### Execution limits

Safe checkpoints (between model/tool calls, while waiting, and while sleeping)
resume after restart. A model or external tool that may have executed without a
receipt is marked `unknown`; it is never silently replayed. Inspect events, then
acknowledge model uncertainty or resolve the external tool outcome before sending
a continuation. Failed or cancelled tasks require new work; these APIs apply only
to unknown outcomes. Cancellation is best effort and cannot undo an external effect.

Default tree limits: 60 model calls, eight children, two delegation levels, and
24-hour expiry. Each task also has an individual call limit. Cumulative token
spending is uncapped unless `create(objective, { tokens })` specifies an allowance.
Model context capacity is independent of cumulative spending. Usage and unresolved
reservations are recorded with or without an allowance.
Model calls reserve estimated input plus maximum output atomically across
children, then reconcile reported usage. The bundled subscription OAuth transport
removes the requested output cap, so its output reservation is a planning allowance.
Token estimation is not a billing cap:
a provider can report higher usage, which can block subsequent admission when an
explicit allowance is exhausted. Unknown
requests keep their reservation; definitively undispatched requests release it.
When live model reservations could release enough capacity for a pending request,
the task enters `admission` and releases its queue worker. Its saved wait identifies
the outstanding operations. A settlement or new input makes it ready to prepare a
fresh request and retry atomic admission. Waiting consumes no model calls or tokens.
If even releasing all live reservations cannot cover the request, admission fails.
Unknown interrupted liabilities remain charged and cannot hold a wait indefinitely.
`model.deferred` events expose the required estimate and observed reservations.
Invalid
output allowances are rejected before storage opens. Context preparation plus a provider call defaults to a five-minute absolute deadline.
Set `modelTimeoutMs` in `HarnessOptions`, or CLI `--model-timeout-ms 300000`.
The model queue step gets an additional 30 seconds for receipt/cleanup. A tool batch
runs in a separate step with a shared 120-second queue timeout. Agentic validates
the complete batch before its first effect; each call keeps its own durable intent
and receipt. This is preflight validation, not a transaction that rolls back effects. Both model and
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

The Gears composition keeps its core system instruction stable; project instructions
can refresh as described below. Tasks with orchestration capabilities or saved
progress notes receive one protected, host-generated state message containing current call/token
availability, progress notes and artifact names. That message is counted by the
shared Agentic context pipeline and retained in the exact request intent, but is
not appended to conversation history. Later requests replace it with fresh state.
Coding-only tasks without progress notes receive no orchestration state. Scheduling
and child-capacity fields appear only when the task can use those capabilities.
Progress notes remain untrusted agent content, not system instructions.

This preserves a stable prefix where selected history permits it; provider cache
hits or token-cost savings are not guaranteed. Resource figures are a snapshot
before request admission, and concurrent children can consume budget afterward.
Admission still checks the authoritative shared state atomically.

The configured model timeout participates in composition identity. Continuing a
completed tree requires its original composition; an incompatible follow-up is
rejected before ownership or task state changes.

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
groups first and stops once the request fits. Children inherit `read_tool_result`
when their parent has it; other tools require explicit selection. The two recent
exchanges plus the transient state group remain present. If
protected tool text alone cannot fit, Agentic uses a recoverable head/tail preview.
Context reports identify every shortened payload and its exact source reference.

`read_tool_result({ messageIndex, offset })` returns up to 8,000 UTF-16 code units
from the exact original text stored in this task's conversation. Continue with
`nextOffset` until `eof`. It cannot address another task, does not reread changed
files or rerun a tool, and continues to work after restart. Invalid indices and
out-of-range offsets fail explicitly. Retrieved chunks are not recursively
replaced with references. This retrieves text, not native media blocks.

Archive previews do not add semantic search or a new memory store. The optional
checkpoint lifecycle described below preserves a working summary when selection
would otherwise lose older evidence. Neither mechanism guarantees recall of every
detail in an arbitrarily long history.

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

`fs_read` defaults to numbered line pages. With `mode: "bytes"`, it accepts a
zero-based byte offset and a byte `limit` from 1 to 16,000 (default 16,000).
The returned `bytesRead` can be smaller to preserve a UTF-8 character boundary;
continue using `nextOffset`. A limit too small to fit the next character returns
an error asking for a larger limit. This lets the model request focused evidence
without a full default chunk. The tool definition changes the CLI composition
fingerprint, so existing active tasks require their matching configuration.

Artifact reads return `totalCharacters`, `offset`, `content`, `nextOffset` and `eof`.
Continue with `nextOffset` until `eof`; offsets count UTF-16 code units and each
page contains at most 12,000 units. An offset exactly at the end returns an empty
EOF page; an offset beyond the end is rejected.


Fresh tool results remain intact while the request fits. Older results may be
shortened under pressure; raw stored messages remain inspectable and retrievable.
Retrieval responses are not recursively shortened. A reference promises the saved
tool result, not bytes a source tool already discarded. The coding runtime additionally saves large shell output up
to its 8 MiB capture limit and exposes `read_output`; both retrieval tools are
excluded from recursive presentation. Grant `read_output` alongside `shell_run`
in coding compositions and keep their output directory with the task data.
The default CLI uses the read-only subset of the shared coding pack. Child-result
previews use a separate shared allowance and support pagination, as described below.

### Stable model cache scope

The host supplies Agentic's provider-neutral `cacheScope` from the composition and task identity before request preparation and journaling. It survives scheduled continuation and reopen, while children receive distinct scopes. Providers may ignore the hint; the subscription adapter maps it to its own cache-routing fields. This is not a conversation store, cache guarantee or isolation boundary. Current machine state still replaces the final state message on each call.

## Coding mode

Pass `--coding` to the CLI to register Agentic's shared coding pack. This explicitly
grants the root agent file edits and local command execution; delegated children
can receive only subsets of that manifest. Use it in a workspace where those
effects are authorized. This mode does not add per-call approval prompts.
The default CLI remains read-only. The shared pack has eight tools: `fs_read`,
`fs_list`, `search_grep`, `search_find`, `fs_write`, `fs_patch`, `shell_run`, and
`read_output`. Saved command output stays under the task data directory.
The Gears adapter owns no file or shell behavior; validation, execution, output
capture and effect classification come from Agentic.

Read-only mode exposes
`fs_read`, `fs_list`, `search_grep`, `search_find`, and `read_output`; it does not
register the three write-classified tools. Tool manifest changes require existing
tasks to finish under their original composition.

## Working checkpoints

The built-in context uses Agentic's replaceable checkpoint lifecycle. It prepares
ordinary task context first. Eviction or shortening without an exact archive
reference triggers maintenance; recoverable previews alone do not. There is no
fixed percentage trigger in the default composition. Set `checkpointing: false`
to use the context assembler without generated maintenance.

Agentic owns source views, checkpoint selection, source fitting, response
validation and pure state reduction. Gears persists the opaque derived state and
owns leases, shared admission, scheduling and atomic intent/receipt commits.
Checkpoint calls use the same provider and task/tree allowances as ordinary calls.
Their intents record `purpose: context`, with checkpoint purpose and source range
in `contextMetadata`. Prepared requests show the exact input sent to the model.

`Task.messages` remains the complete source archive. The working view contains
checkpoint text, its source cursor and the recent tail. Human requirements and
explicitly pinned user-role messages retain their text, provenance and source
indexes even when their source range has been summarized. Durable progress notes
remain separate host-owned evidence; generated checkpoints do not replace them.

Summary input omits opaque provider continuation annotations; the archive and
recent active messages preserve them for replay. Oversized source groups are
processed in bounded chunks with a persisted cursor into the projected evidence
JSON. The complete-history boundary advances only after a group is fully covered.

A complete, nonempty text response becomes a candidate, admitted against the next
task context before replacing the accepted checkpoint. A complete response rejected
by checkpoint validation, or a candidate exceeding the next context budget, gets
one repair attempt. Partial output, cancellation and transport or preparation
failures follow the normal failure path. The previous accepted checkpoint and
source history survive rejection or failure; an exhausted repair stops with a diagnostic.
This policy remains under evaluation for retention quality and maintenance cost.

Archive retrieval uses Agentic's `readArchivedToolResult`, returning `callId` and
`messageIndex` with each text page. Call IDs are independent of active-context
positions; message indexes address the full archive. Ambiguous call IDs fail.
Children can retrieve only their own receipts. Retrieval never reruns the source
tool, and prepared request inspection cannot mutate dispatch or accounting.

Tool plugins declare effects to Agentic's batch executor. For all-read batches,
an invalid call gets its own error while other authorized reads can proceed.
Batches containing a write or undeclared effect retain whole-batch argument
rejection. Uncertain dispatched outcomes stop for reconciliation. Gears commits
each intent and receipt through its existing transaction boundary.

## Optional workspace recall

Add `--memory` to enable explicit workspace notes alongside the configured coding
tools. Agentic owns bounded note capture, lexical search and immutable revisions;
Gears resolves source calls against its saved task history. The three shared tools
are `memory_save`, `memory_search` and `memory_read`. Writes cite a prior tool call
in the current task; the host captures a bounded source excerpt rather than
accepting a source string from the model. Corrections require the current version.

Notes live in `DATA/memory.sqlite`, scoped to the canonical workspace. Use a
separate data directory per workspace. Search returns compact historical notes;
reading a revision exposes its captured source, offset and timestamp. These are
observations to verify, not instructions. No automatic recall or background note
generation is enabled. Host task identity passes through the shared tool boundary.
Restart/source integration checks pass; measured live-task benefit remains under
evaluation.

Notes can also page the complete original receipt after restart: pass `sourceOffset`
to `memory_read`, then follow `nextOffset` until `eof`. Gears resolves the stored
task/message reference; Agentic verifies its fingerprint and returns bounded pages.
The original tool is never rerun. If the source archive is missing or changed,
the captured excerpt remains available and source paging reports the problem.

### Operator-resolved source evidence

Tool resolution preserves the original receipt and records the verified outcome
separately, indexed by its original message position. Memory capture by call ID
uses that verified outcome and assigns a `/resolution/` source reference. Existing
`/message/` references continue to mean the original receipt. Both remain durable
across reopening; source retrieval never repeats the external effect.


### Model input and result recovery

Internal tool schemas and validation share one definition, including size limits,
artifact names and paired archive references. The model sees task expiry and
remaining delegation capacity when it has those capabilities. `schedule_self`
releases the worker; call `save_progress` separately to update durable notes.

Child completion previews share an 8000-character allowance and include explicit
pagination. Use `wait_agents` with one direct child ID and the returned `nextOffset`
to recover the complete answer. Saved answers remain unchanged. Archive access uses
Agentic's shared contract and is scoped to the calling task's original receipts.

The CLI refreshes project instructions before each model request, supplying root
instructions, relevant nested scopes and a catalog of other instruction paths.
Custom hosts may supply a fixed instruction snapshot or an async renderer receiving
messages and an abort signal. Dynamic renderers require an explicit composition ID.
Prepared requests retain the exact rendered instructions for inspection.

The task system prompt states the agent's role and trust boundary. Capability
instructions belong to tool descriptions: yielding tools declare their required
last-call position, which the host also enforces. The system does not encourage
delegation or rely on advice to guarantee completion capacity.

Use `rootTools` to choose the tool names granted to new root tasks from the
registered internal and custom tools. Omitting it grants all registered tools;
`[]` creates a root without tools. For example, a read-only single-agent
composition can grant `['fs_read', 'fs_list', 'search_find', 'search_grep',
'read_tool_result']` when its coding tools are registered. Delegation remains
available in compositions that grant `spawn_agent` and its coordination tools.
The selection is copied into persisted task grants and composition identity;
the existing execution boundary rejects calls outside the grant. Child grants
continue to be subsets of their parent's grant.

Delegated objectives are model-authored, pinned task messages. They retain that
provenance in storage and context; human follow-ups remain human input. Shared
checkpoint preparation preserves pinned task intent separately from human
requirements. This revision changes the runtime/context composition identity;
active trees retain their original composition and are not silently migrated.
