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
