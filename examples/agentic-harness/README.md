# Agentic on Gears

A minimal independent agent runtime: Gears owns queue delivery, worker shutdown,
scheduling, and the database connection. Agentic supplies context preparation,
provider access, model execution, and journal transition primitives. The example
owns its state and event tables. Neither Pi nor Agentic's bundled harness host
is involved.

This private development package expects sibling `Gears` and `agentic` checkouts.
It adds no Agentic dependency to Gears core. From the Gears repository:

```sh
npm --prefix ../agentic install
npm --prefix ../agentic run build
npm install
npm run build
npm --prefix examples/agentic-harness ci
npm run test:agentic-example
npm --prefix examples/agentic-harness run demo
```

The deterministic demo runs a real queued job and verifies its persisted answer.
Use your existing Codex subscription login for an opt-in live model request:

```sh
npm --prefix examples/agentic-harness run demo -- --live
```

Both demos print a JSON result and shut down. Data is temporary by default;
`--data ./agentic-demo-data` retains the isolated database. Run without
`GEARS_APP_DB_PATH`, which the example rejects to avoid using another app's DB.

## Composition and guarantees

`openQueuedAgent(dataDir, provider)` returns `enqueue(prompt)`,
`schedule(id, cron, prompt)`, and `close()`, plus the underlying runtime objects
for application composition. Scheduling uses the Gears scheduled-job registrar;
the occurrence ID is the work identity, so queue redelivery preserves it.

Before the model request, an atomic compare-and-swap transaction commits the
operation intent and event. Afterward, another transaction records the receipt
and outcome. Only one competing delivery can claim ready work. A committed
answer survives restart and allows redelivery without another model request.
If a process dies after intent or a request has an uncertain outcome, the work
requires review; the example does not automatically replay it. This avoids
claiming exactly-once delivery from an at-least-once queue.

Tests cover real queue/worker execution, reopen and redelivery, simultaneous
claims, uncertain requests, cancellation, transactional revision conflicts,
and stable scheduled occurrence identity. The scheduler test manually triggers
the registered callback while retaining the real registrar, queue, and worker.

This is a one-turn composition example. It has no tool loop, chat UI, session
management, or recovery-resolution UI yet. Add those only as the application
requires them, using the same execution and persistence boundaries.
