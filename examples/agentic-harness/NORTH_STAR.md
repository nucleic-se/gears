# Gears agent direction

The Gears agent is one composition of the Agentic harness, extended with Gears
infrastructure. Agentic's `docs/north-star.md` is the shared design direction;
with the standard sibling checkouts it lives at
`../agentic/docs/north-star.md` relative to the Gears repository root.

Build a useful standalone agent for long, complex tasks, with subagents, durable
progress and scheduled continuation. Reuse Gears queues, workers, scheduling,
mutexes and storage. Keep reusable agent contracts and execution behavior in
Agentic so the default agent and Gears composition improve together.

Prioritize foundations before feature breadth: useful and inspectable context
selection, explicit lifecycle ownership, bounded delegation, honest effect
outcomes and reliable recovery. UI remains an optional extension. This direction
does not imply that all these capabilities are complete today.

Simple, beautiful, understandable code is an acceptance criterion. Prefer clear
control flow and small contracts; remove obsolete paths and abstractions whose
complexity costs more than their benefit. Breaking changes are allowed during
alpha, with documented persistence consequences and no silent data loss.

Measure progress through shared Agentic conformance tests, Gears recovery tests
and real dogfooding. Use Pi and Hermes as benchmarks across all harness machinery,
ground comparisons in source evidence, and keep detailed competitor research
outside the repositories. Record failed workloads alongside successful ones.

See [README](README.md) for the current composition and
[validation](VALIDATION.md) for recorded evidence.
