# Taking Gears from alpha to stable

Date: 2026-09-05  
Baseline: `0.2.0`, commit `7b1a0a0`  
Status: proposed release plan; the gates below are not yet satisfied

## Assessment

Gears has a credible foundation for a stable, single-machine background runtime.
Its scope is useful and restrained: a persistent queue, worker, scheduler, bundle
lifecycle, storage, and inspection tools. SQLite and modular TypeScript services
fit that scope. A rewrite or a new infrastructure dependency is not the next step.

The remaining work is to make a narrow set of guarantees explicit, demonstrate
that they survive failures, and give operators a repeatable way to install,
upgrade, recover, and diagnose the runtime.

The recent audit is a useful warning about relying on a green suite alone. The
original 83 tests passed despite concurrency, scheduling, reload, and shutdown
problems. After fixes and additional regressions, the last local verification
passed 103 tests across 25 files, the TypeScript build, and the diff checks. This
is evidence of progress, not proof of stable behavior across supported platforms
or long-running production workloads.

**Recommendation:** target a small, well-defined 1.0 for supervised single-machine
applications. Freeze feature expansion while closing the release gates in this
report. Keep application effects idempotent and make the limits of scheduling
and cancellation prominent.

## Evidence policy and confirmed documentation drift

This report treats implementation and executable tests at the baseline commit as
its evidence for current behavior. Existing documentation is evidence of intended
or advertised behavior only. When they disagree, the stable-release task is to
choose the intended contract and align code, tests, and docs; it is not necessarily
to change the implementation to match old prose.

The 103-test result above is the recorded verification from the preceding code
change, not a fresh platform qualification performed while writing this report.
Static inspection identifies additional risks but does not establish how they
behave under every failure. Effort estimates, support scope, and release gates
are proposals rather than descriptions of completed work.

Concrete mismatches found during this report's source review:

| Existing statement | Source-checked behavior | Release action |
| --- | --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) says graceful shutdown waits up to `shutdownTimeoutMs` | [Worker.stop()](../src/core/queue/Worker.ts) uses that timeout for a warning and awaits handler settlement without a forced deadline | Correct the documentation and specify supervisor responsibilities |
| [BUNDLES.md](BUNDLES.md) and the architecture lifecycle table prohibit resolution and side effects in `register()` | [DatabaseServiceProvider.register()](../src/bundles/database/DatabaseServiceProvider.ts) resolves data paths and opens/configures SQLite | Decide whether to enforce side-effect-free registration or explicitly support resource creation there, with ownership and rollback tests |
| The architecture worker section advertises token-usage metrics | [Worker](../src/core/queue/Worker.ts) emits queue-depth gauges, job duration, completion, retry, failure, and recovery metrics; token metrics are not built into it | Document actual built-in measurements; leave application metrics to applications |
| [TODO.md](TODO.md) marks Node-version checks aligned | Package metadata and `doctor` agree on 22+, but the [CI workflow](../.github/workflows/test.yml) selects 20 | Preserve the narrower completed fact, and track CI/support qualification separately |

This is a targeted drift review, not certification that every existing document
is accurate. In particular, future-feature lists in the current docs are not
accepted stable-release requirements. The code and tests should be reviewed
again if this report is used after the baseline changes.

## 1. Define what stable promises

Adopt or revise this proposed contract before freezing the public API:

| Area | Proposed stable contract | Explicit limit |
| --- | --- | --- |
| Deployment | One active worker per data directory on a tested local filesystem; CLI processes may inspect and submit work | No multi-machine or worker-cluster support; shared network filesystems are outside the initial support scope |
| Queue | Successfully persisted jobs survive process restart; recovery consumes a bounded retry budget | Delivery is at least once, not exactly once; external effects require idempotency or application fencing |
| Concurrency | Owned processing claims reserve their concurrency keys; timeouts retain worker slots and claims until handlers settle | Process pauses, claim loss, administrative transitions, and external effects cannot be fenced by a JavaScript promise alone |
| Scheduling | A scheduled occurrence is claimed at most once using the persisted timestamp watermark | No missed-tick replay; a crash between occurrence claim and queue insertion can lose that occurrence |
| Cancellation | Handlers receive an abort signal; dependencies stay available while work drains | Non-cooperative in-process work may prevent graceful shutdown indefinitely and requires supervisor termination |
| Events | Retained notifications reach live polling consumers | No acknowledgement, offline replay guarantee, or durable work-delivery guarantee |
| Bundles | Declared dependencies determine lifecycle order; supported failure paths leave a documented recoverable state | Bundles are trusted code, not sandboxed extensions |
| Compatibility | Documented public APIs and supported on-disk schemas follow a published compatibility policy | Internal files and undocumented deep imports are not stable APIs |

The deployment model needs particularly careful wording. “One worker” does not
mean that no other process ever writes SQLite: the CLI can enqueue jobs and
change configuration. Test this supported contention without presenting mutex
coordination as a promise of cluster support.

Stable does not require exactly-once effects, automatic termination of arbitrary
JavaScript, or guaranteed cron catch-up. It does require honest documentation
and tests for whichever semantics are chosen.

## 2. Current evidence and gaps

| Area | Evidence already present | What is still needed |
| --- | --- | --- |
| Queue recovery | Real child-process kill/restart tests verify payload persistence, new claim tokens, rejection of old claims, and retry exhaustion | Test more crash boundaries, shutdown under load, and storage failures |
| Timeout isolation | Regressions keep timed-out handlers' slots and claims occupied until they settle | Verify interaction with TTL expiry, claim loss, recovery, and multiple queued keys |
| Cron | Occurrence claims survive release, expiry, and restart; shutdown drains active callbacks | Clock/timezone boundaries, short lock TTLs, and crash-window documentation/tests |
| Bundle lifecycle | Tests cover provider boot failure cleanup, repeated load/unload, dependent removal, and repeated config replacement | Failed `bundle.init()`, active work during unload, service overrides, and concurrent restore/shutdown |
| Maintenance | Shared-store sweeping, retry response cancellation, and corrected registration after failure are covered | Long-running retention, contention during sweeps, and resource-growth measurements |
| CLI | Failure cleanup, invalid timeout rejection, and signal shutdown have process tests | Published-package execution, full configuration precedence, useful health exit codes, recovery runbooks |
| Release validation | Local build and tests pass | CI/support matrix alignment, package smoke tests, schema upgrade fixtures, and release-candidate evidence |

These are different categories: some are confirmed inconsistencies, some are
untested boundaries, and some are proposed operational requirements. An untested
boundary should become a test and investigation task, not automatically be
reported as a confirmed defect.

## 3. Prioritized work

Effort estimates below are rough focused engineering time for someone familiar
with the repository. They exclude soak time, review delays, and unexpected
failures. They are planning aids, not delivery commitments.

### A. Align CI and installation claims

**Priority:** release blocker. **Effort:** 1–3 days.

The current [CI workflow](../.github/workflows/test.yml) selects Node 20, while
[package.json](../package.json) requires Node `>=22.0.0`. The last local checks ran
on Node 26.7.0. Neither fact establishes support for the declared minimum.

Work:

- Choose the supported Node versions and operating systems. Test the exact
  minimum claimed by `engines`, or raise that minimum based on evidence.
- Run clean installs, build, and tests on the selected matrix. Exercise native
  SQLite installation as part of that matrix.
- Add a tarball smoke test: pack the project, install it in an empty consumer,
  import the public root, testing, and database entrypoints, compile a small
  TypeScript consumer, and execute the CLI.
- Check that the tarball includes only intended runtime artifacts and has no
  hidden dependency on checkout-only files or development dependencies.
- Type-check test code through a dedicated test configuration. The current
  `tsconfig.json` includes `src` and `examples`, not the test suite.

**Done when:** every advertised environment passes these checks from a clean
checkout and an installed tarball. Unsupported environments are explicitly
excluded from the support policy.

### B. Finish lifecycle and configuration failure behavior

**Priority:** release blocker. **Effort:** 3–5 days.

Keep the recent fixes, but extend the failure matrix around their boundaries:

- Fail `bundle.init()` after it has created resources or registered callbacks.
  Provider boot rollback is now covered; initialization follows a different path
  in [BundleManager](../src/core/bundle/BundleManager.ts).
- Unload a bundle while its handlers or cron callbacks use its services. Define
  whether unload drains, refuses, or requires a restart. Do not close services
  while application work still uses them.
- Test registration over an existing service key and subsequent failure/unload.
  Decide whether overrides are supported or rejected; avoid silently destroying
  another bundle's services.
- Test repeated shutdown and a configuration change arriving during shutdown.
  Prove that timers or watchers cannot restart disposed work.
- Validate environment and programmatic worker options consistently with CLI
  arguments. The environment parser still accepts `parseInt` prefixes and does
  not enforce positive values. Specify precedence, valid ranges, and timeout
  relationships without adding a general configuration framework unless needed.

**Done when:** every supported failure transition has an asserted postcondition:
no leaked owned services or timers, no unexpected queue consumption, no hidden
half-booted state, and a useful error or documented recovery action.

### C. Establish data upgrade and recovery safety

**Priority:** release blocker. **Effort:** 3–5 days.

Versioned queue migrations exist. A stable release needs evidence that users can
upgrade real persisted state, not just initialize an empty database.

Work:

- Keep database fixtures for every alpha version explicitly supported as an
  upgrade source. Include pending, processing, delayed, named, failed, and keyed
  jobs, plus store data and cron occurrence state.
- Upgrade each fixture and verify payloads, scheduling, retry counts, keys, and
  claim behavior. Verify reopening and repeated migration are safe.
- Define behavior for a database created by a newer unsupported schema. Refuse
  unsafe use with an actionable error rather than assuming compatibility.
- Exercise a process failure during migration and confirm atomic recovery or a
  clearly documented restore path.
- Write and rehearse backup/restore instructions covering all application state,
  bundle configuration, and SQLite WAL considerations. Prefer a stopped-runtime
  backup initially if that keeps cross-database consistency understandable.
- State the rollback policy. Restoring a pre-upgrade backup may be the supported
  path; automatic reverse migrations are not required.

**Done when:** a fresh installation can restore a documented backup, and every
supported upgrade fixture passes an automated preservation test. Excluded alpha
schemas have explicit export/rebuild instructions or an explicit support limit.

### D. Expand durability tests at actual failure boundaries

**Priority:** release blocker for documented guarantees. **Effort:** 3–5 days.

Build on [process recovery tests](../tests/integration/process_recovery.test.ts)
and [lifecycle tests](../tests/integration/lifecycle_edges.test.ts):

| Scenario | Required assertion |
| --- | --- |
| Kill after queue claim, before handler effects | Job remains recoverable within its retry budget |
| Kill after an application effect, before completion | Redelivery is observable; an example idempotency mechanism prevents repeating the effect |
| Stop while polling or processing several keys | Claims are released only at safe points; dependent services outlive invoked handlers |
| SQLite contention during normal CLI writes | Runtime remains live; transient failure does not silently discard a job or crash a maintenance timer |
| Read-only storage, write failure, malformed persisted rows | Error and recovery behavior are explicit; unrelated valid work is not silently corrupted |
| Cron claim followed by crash before enqueue | Test demonstrates the documented missed-occurrence limit, or verifies a stronger implementation if that requirement is adopted |
| Clock changes and timezone boundaries | No accidental duplicate invocation beyond the defined scheduling contract |

Use synchronization messages and bounded waits instead of timing guesses where
possible. Keep fault-injection tests reproducible and ensure test failure also
cleans up child processes and temporary resources.

**Done when:** the public guarantees map to executable assertions, with no
unexplained flaky failures. Test counts and percentage coverage are supporting
signals, not release criteria by themselves.

### E. Make operation and bounded growth predictable

**Priority:** release blocker for basic operation; advanced tooling can wait.
**Effort:** 2–4 days, plus workload observation.

- Document supervisor startup, graceful stop, forced termination, and restart.
  Rehearse stale PID/file-lock recovery while the old service is confirmed stopped.
- Define retention for completed/failed jobs, retained events, logs, and
  diagnostic/quarantine data. Automatic deletion is a product decision; explicit
  maintenance commands and a documented policy can be sufficient initially.
- Verify event retention after a small burst followed by idle time. In the current
  [event bus](../src/core/infra/SQLiteDurableEventBus.ts), empty polls return before
  advancing the retention sweep counter; “retention” should not imply an untested
  wall-clock deletion deadline.
- Measure memory, file descriptors, database growth, event-loop responsiveness,
  and queue latency under a representative workload.
- Make recovery counts, retry exhaustion, waiting shutdowns, and claim-loss errors
  discoverable through existing logs, metrics, and CLI tools. Avoid building a
  new dashboard merely to satisfy this gate.
- Check that `doctor` communicates failed health checks through useful output and
  exit status, and that a novice operator can follow the recovery instructions.

**Done when:** a maintainer can diagnose and recover the supported failure cases
using published instructions, and observed growth has an explained bound or
maintenance policy.

### F. Freeze APIs and reconcile documentation

**Priority:** release blocker. **Effort:** 2–3 days.

- Inventory the supported exports, container keys, interfaces, bundle lifecycle,
  CLI flags, configuration precedence, and data-schema compatibility rules.
- Publish a versioning/deprecation policy and release notes. Document migration
  requirements for custom scheduler and mutex adapters introduced by the audit.
- Compile and execute public examples against the packed artifact.
- Reconcile existing documentation. For example, the architecture page still
  describes graceful shutdown as bounded by `shutdownTimeoutMs`, whereas the
  implementation now waits for invoked work to settle. Its “no side effects in
  register” contract also needs to agree with actual provider behavior.
- Replace broad completed checklist claims in [TODO.md](TODO.md) with links to
  evidence and remaining acceptance criteria. A versioned migration function,
  for example, is not equivalent to a tested upgrade policy.

**Done when:** a consumer can build a bundle and operate the runtime using public
documentation alone, with no reliance on private imports or maintainer knowledge.

## 4. Decisions to settle before the API freeze

These are recommendations for review, not implementation authorization embedded
in this report.

| Decision | Recommended initial stable position | Cost of a stronger promise |
| --- | --- | --- |
| Missed cron occurrences | Keep explicit at-most-once invocation and no replay | Guaranteed enqueue across crashes needs an atomic scheduling/outbox design or another recoverable state machine |
| Handler termination | Cooperative signals plus a supervisor runbook | A managed child-process execution model adds a substantial lifecycle and IPC surface |
| Active bundle unload | Prefer refusing or draining unsafe unloads | Transparent replacement during active work requires service ownership and handover rules |
| Storage deployment | Tested local filesystem only | Network/shared filesystem support needs separate locking and failure validation |
| Release platforms | Advertise only the matrix actually maintained | Each added platform expands native dependency and process/signal testing obligations |
| Alpha data compatibility | Explicitly enumerate supported upgrade sources | Supporting every historical alpha snapshot expands fixture and migration work |

Choose these early. Changing them late can invalidate both implementation and
release evidence.

## 5. Suggested release sequence

1. **Stabilization milestone:** freeze feature additions; complete CI alignment,
   lifecycle/configuration fixes, upgrade/restore fixtures, and the contract test
   matrix. Keep the release marked alpha while these gates are open.
2. **Beta:** validate packed-package consumers and documented operator workflows;
   exercise at least two representative applications with different job patterns.
   Resolve public API changes before calling a build a release candidate.
3. **Release candidate:** run the exact candidate artifact in a defined trial.
   Proposed minimum: seven consecutive days, including busy and idle periods,
   scheduled work, intentional restarts, maintenance, and a backup/restore drill.
   Select and record workload-specific latency and growth thresholds before the
   trial; do not invent throughput guarantees from a tiny synthetic benchmark.
4. **1.0:** publish only when the checklist below has evidence attached. A material
   runtime change during the candidate trial requires repeating the affected tests
   and restarting the relevant observation period.

Allow roughly three to five focused engineering weeks for the listed work, plus
release-candidate observation, as an initial planning range. Re-estimate after the
first CI and lifecycle tasks. The date should follow the evidence; this report
does not establish a release deadline.

## 6. Stable release checklist

- [ ] Supported Node/platform matrix matches package metadata and passes CI.
- [ ] Clean packed-package installation, imports, consumer compilation, and CLI tests pass.
- [ ] Tests themselves are type-checked.
- [ ] Queue, scheduling, event, cancellation, and bundle contracts are documented.
- [ ] Lifecycle and configuration failure cases have deterministic regressions.
- [ ] Supported database upgrade fixtures and backup/restore drill pass.
- [ ] Retry exhaustion, stale ownership, and crash boundaries have process tests.
- [ ] Retention, resource growth, and operational thresholds have recorded evidence.
- [ ] Supervisor and stopped-service lock recovery instructions have been rehearsed.
- [ ] Public API/versioning policy and upgrade notes are complete.
- [ ] No unresolved high-severity reliability or security issues in the supported scope.
- [ ] Dependency review is current for the candidate; exceptions are documented.
- [ ] Representative applications complete the defined candidate trial.
- [ ] Release artifact, checksums, test results, and release notes identify the same commit.

The maintainer should record the evidence and sign-off for each gate in the
release issue. A checkbox alone is not evidence.

## 7. Keep these out of the critical path

A web inspector, bundle marketplace, new configuration service, alternative queue
backend, workflow language, built-in AI features, and horizontal scaling are not
requirements for stable Gears. Pursue them only when a concrete application needs
them and they can preserve the stability contract.

The strongest 1.0 is a smaller runtime whose failure behavior is understood and
whose support claims can be demonstrated. The existing architecture is suitable
for pursuing that goal; the next investment should be verification, recovery,
and consistent contracts.
