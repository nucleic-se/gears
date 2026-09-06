# Standalone harness acceptance — 2026-09-06

Validated on macOS with Node 26.7.0. No Assembly or deployed agent configuration
was changed. Pi remains Assembly's default runtime.

## Automated checks

- 23 example-package tests pass, including the original six one-turn tests.
- 103 Gears core tests pass.
- Standalone source and tests type-check; the package builds.
- A real CLI subprocess starts and exits cleanly with code 0 on SIGTERM,
  including disconnecting its IPC channel after worker/database shutdown.

The new checks use real Gears queues, mutexes and SQLite databases. They cover
parent/child completion, restart while sleeping, shared call and concurrent token
admission limits, cancellation, unknown external outcomes, read-only error
feedback, stale-owner writes and claims, incompatible startup, messages arriving
before sleep, completed-session continuation, UI authentication, FIFO rejection,
UTF-8 boundaries, and bounded directory enumeration.

## Live dogfooding

The same CLI used by operators ran a source review using existing Codex
subscription authentication. The parent spawned two actual model-driven
subagents. They inspected workspace files and saved review artifacts. The parent
waited for their results, saved progress, scheduled itself, and released its
worker. The controller sent SIGKILL, waited for the Gears lease to expire, and
started a new CLI process against the same data directory. The parent woke and
completed its synthesis.

The second successful review used 23 model calls and reported 135,673 input
and 7,011 output tokens across the tree. Both children completed and the parent
produced `review.md`. Raw evidence is in the local ignored
`.data/dogfood-report.json`, including its retained database directory.

The reviews exposed issues that were checked against the code and fixed:
read-only error classification, individual budget feedback, stale-host write
fencing, inbox/sleep races, empty UI tokens, FIFO reads, UTF-8 chunk boundaries,
directory enumeration, artifact-view persistence, active-history scans, startup
configuration handling, and UI pagination. Startup/UI refinements made after the
live review were checked with targeted regressions and a fresh build.

Model-generated findings are leads, not proof. Some references in the synthesis
were inaccurate; only findings confirmed against the actual implementation were
used for changes. This is one bounded engineering-review acceptance scenario,
not evidence of general autonomous coding quality or a complete crash matrix.

## UI verification

A real browser at a 390×844 viewport authenticated, submitted a task through the
UI, observed its completed response, and opened the resulting artifact. The
artifact remained visible across background refreshes. The server listens on
port 4318 with bearer authentication and can be bound to the local network for
same-Wi-Fi phone access.

## Deliberate limits

The default tool pack is read-only; source editing and shell execution are not
included. Unknown external outcomes require inspection and new work with the
recovered evidence. There is no approval/resolution UI, automatic journal pruning,
or automatic model-written compaction yet. Token admission uses estimates and
reported usage rather than a guaranteed billing ceiling. One host owns a data
directory, with parallel Gears workers inside that host.

## Foundation consolidation — 6 September 2026

Agentic's local driver and the Gears queued driver now share composition and
request-boundary contracts. The shared conformance suite checks request-only
selection, preservation of source history/tool grants, and no dispatch following
invalid or rejected context. Gears-specific coverage checks startup rollback,
shutdown admission/drain and context configuration mismatch before recovery.

Validation for this cycle:

- Agentic build and 476 tests passed, including crash recovery and new foundation checks.
- Gears core: 103 tests and test-source type checking passed.
- Gears harness: build, test-source type checking and 27 tests passed.
- Full live source-review scenario did **not** pass: both children exceeded the
  90-second model deadline and became unknown. The parent checkpoint survived
  SIGKILL/restart, but child-completion acceptance failed. 24 model calls;
  107,020 reported input and 2,536 output tokens.
- A separate smaller live scenario passed on the consolidated composition:
  two children read package.json and tsconfig.json, returned results, and the
  parent saved progress, slept, survived SIGKILL and lease-expiry restart, and
  produced an artifact. 11 model calls; 10,054 input and 520 output tokens.

The small live result establishes the composition/delegation/restart path. It
is not a replacement for the failed longer workload or evidence of general
coding-agent quality. Detailed local run artifacts are retained outside source
control. Neither production nor other application instances were restarted.

### Simplicity review and repeated source review

The follow-up removed an untyped composition implementation and a redundant tool
wrapper. A shutdown-failure test verifies that remaining resources are released
even when the driver or a UI disposer reports an error. Agentic: 477 tests passed;
Gears harness: 27 tests and both builds passed.

The unchanged live source-review scenario failed again in about 245 seconds.
One child completed, one hit the 90-second model deadline, and the scheduled
checkpoint survived SIGKILL/restart. The parent subsequently exhausted shared
token admission: 195,805 tokens charged against 200,000, with insufficient room
for the next reservation. There were 30 model calls, with 180,116 reported input
and 3,938 output tokens. Unknown work retains its reservation. A successful child
response took about 68 seconds; this does not establish the timeout's root cause.

The controller now saves failure reports even when the root fails or the run
deadline expires. The repeated run verified the root-failure report path; it did
not exercise the controller-deadline path. Its report is retained outside source
control. The final source also exposes the receipt's actual failure reason in task
state, verified through a deterministic reopen test; this small diagnostic change
was built after the live run.

Next evaluation work should investigate context repetition, request deadlines and
budget use together. Do not raise limits simply to turn this scenario green.
The 128k-token / 4 MB illustration is a mental model, not an acceptance threshold.
