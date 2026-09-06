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

### Runtime inspection

Both compositions expose read-only, revision-bounded inspection snapshots and web
inspectors with JSON download. Agentic tests verify an in-flight request equals
provider input, repeated reads do not reselect context, and events beyond the
captured revision are excluded. Gears verifies authenticated in-flight inspection,
full context accounting, and exact request preservation after reopening storage.
Both browser flows were exercised in headless Chrome at 390×844, including request
expansion and JSON download, with no page errors. These checks used deterministic
fixture providers; no live model was needed for inspection verification.

### Terra long-task baseline — 6 September 2026

The unchanged source-review/restart scenario passed on `gpt-5.6-terra` with the
existing 90-second request deadline and 200,000-token tree budget. Both children
completed and saved findings; the parent waited, scheduled continuation, survived
SIGKILL/restart, read evidence and saved `review.md` before completing.

- Elapsed: 133 seconds; 21 model calls.
- Reported usage: 107,321 input and 6,583 output tokens.
- Maximum request duration: parent 15.3 seconds; children 51.6 and 39.2 seconds.
- The parent used 12 calls; its estimated selected input grew from 1,188 to 13,969
  tokens. Repeated context remains a measurable cost even in this passing run.

The full report and per-task trace summary are retained outside source control.
This is one structural acceptance pass, not a controlled model comparison or an
independent assessment of the generated review's correctness. Earlier Astra
failures remain recorded. No limits were raised to obtain this result.

A subsequent focused hardening change uses own-property checks for artifact
membership and reads. Missing inherited names return HTTP 404; legitimate saved
names such as `constructor` remain readable after storage reload and count toward
the 32-artifact limit. The harness build and 29 tests passed. The live run preceded
this small artifact fix; its behavior is covered by the regression test.

### Stable instructions and transient state

Gears now uses stable system instructions and one fresh, protected state message
at the request tail. It includes the remaining shared token budget as well as
call limits, progress and artifact names. Existing Agentic provenance, sticky
message protection, accounting and intent recording provide this behavior; no
new Agentic abstraction or context protocol was added. Runtime extension version
3 prevents silently changing the layout of active version-2 compositions.

Build and 30 harness tests passed. A new regression verifies stable instructions,
updated counters/progress, no accumulation of transient state in durable history,
and exact request inspection. The restart test still verifies delivery of saved
progress after reopening, now through the state message.

The full Terra source-review/restart scenario passed again with unchanged limits:
145 seconds, 21 model calls, 108,233 reported input and 8,078 output tokens.
Receipts showed 17,408 cached input tokens (a subset of input, not additional
usage). All 21 request snapshots had identical system instructions and exactly
one deterministic state message. The longest request was 59.6 seconds.

The previous Terra pass took 133 seconds and used 107,321 input / 6,583 output
tokens with zero cache reads. These are individual stochastic task runs over an
evolving source checkout, not controlled latency or capability comparisons.
Cache reuse is observed; lower total tokens or faster completion is not.
The report and trace summary are retained outside source control. Recoverable
selection/compression of accumulated evidence remains future work.

### Recoverable evidence retention

Agentic now offers an opt-in reference policy for older large tool-result text.
Gears enables it only when the task has `read_tool_result`, backed by unchanged
conversation text in its existing database. No child grants are added implicitly.
The inspector records reference instructions, source indices and retained sizes.
Tests verify smaller prepared context, source/pair preservation, recent/error/media
exclusions, protection of references from subsequent compression, bounded exact
retrieval after reopen, task isolation, and no source-tool replay.

Validation: Agentic build and 482 tests passed; Gears harness build and 31 tests
passed. The full Terra scenario retained its original delegation instructions,
request deadline and aggregate budget. Children without retrieval grants did not
receive reference compression.

Two live acceptance runs passed, including both children, final artifact and
forced checkpoint restart:

- Initial retention window: 173 seconds, 30 calls, 162,956 input / 7,926 output
  tokens; two history retrieval calls.
- Final window (two recent exchanges plus transient state): 157 seconds, 26 calls,
  120,681 input / 8,000 output tokens; two history retrieval calls and 7,680 cached
  input tokens. The earlier no-retention pass used 108,233 input / 8,078 output
  tokens and 21 calls, so overall efficiency is not yet demonstrated.

Restoring the referenced original payloads into the final run's exact recorded
requests increased their summed estimates by 69,333 tokens. This paired estimate
measures request size only; it does not predict how the agent would have behaved
without retention. Reports and the comparison script remain outside source
control. Deterministic recovery works, but retrieval overhead and semantic
selection still require broader evaluation before claiming an efficiency gain.
