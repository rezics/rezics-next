---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
# The program owns the Goal tooling, the method, the scope registry and the shared QA
# harness; inventories other Goals append to (integration lists, coverage declarations)
# stay unowned.
areas:
  - scripts/goal/**
  - docs/goals/README.md
  - docs/goals/manager.md
  - docs/goals/worker.md
  - docs/goals/method.md
  - scripts/qa/cases/launch-coverage.ts
  - scripts/qa/affected.ts
  - scripts/qa/acceptance.ts
  - scripts/qa/cli.ts
  - scripts/qa/core.ts
  - scripts/qa/test.ts
  - scripts/qa/e2e.ts
  - scripts/qa/integration-shards.ts
  - scripts/qa/resource-classes.ts
  - scripts/qa/browser-budget.ts
  - scripts/qa/stack-environment.ts
  - scripts/qa/stack-ownership.ts
  - tests/qa/support/**
---

# Program Goal

The supermanager owns delivery scope, the [method](../method.md), Goal tooling
and the shared host. It runs the program's tooling tasks and leaves product
implementation to the delivery Goals. [state.md](state.md) records outstanding
decisions; the ledger supplies live status.

| Goal | Outcome |
| --- | --- |
| API (closed 2026-10-16) | Every launch row is proved through the API for each persona; main's confirmation passed all 408 cells. |
| Web (closed 2026-10-16) | Every proved row has its surface with its stories. |
| Operations (closed 2026-10-16) | Erasure and restore are proved on physical fixtures and deployment is prepared; see the [operations runbooks](../../operations/README.md). |

Erasure qualification waits for its changing
contracts to settle. [Target architecture](../../architecture/target-architecture.md),
[product decisions](../../product/decisions.md) and [product goal](../../product/goal.md)
own product direction.

## How managers run from now on

Mail levels and interrupting wakes
are a desired extension, not current `mail send` options.

External-agent capability discovery is later product scope, not a
runtime registry to add to this Goal.

## Next tasks

The [command dispatcher](../../../scripts/goal/goalctl.ts) and
[command modules](../../../scripts/goal/commands/) define installed tooling;
the old N0–N11 launch sequence is no longer a dispatch plan.

The remaining desired outcomes require checking against current tooling before
briefing: mail levels, an independent audit of newly proved cells, complete
handoff automation, and efficiency comparisons on the same work.

## Completion

The program ends when the three delivery Goals have closed: every row in scope is
proved, has its surface, and erasure and restore are proved on physical
fixtures.
