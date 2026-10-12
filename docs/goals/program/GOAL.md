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

# Program

Status: redesigned on 2026-10-12 and not started. The maintainer stopped the run
of 2026-10-07 to 2026-10-12 because its efficiency was not acceptable, asked for
the way of working to be redesigned, and starts this Goal's manager himself.
[state.md](state.md) records where everything stands.

The program's manager is the **supermanager**. It runs no product work. It owns
what decides whether the delivery Goals are efficient: the scope, the
[method](../method.md) and the tool that enforces it, and the shared host.

| Goal | Outcome | Starts |
| --- | --- | --- |
| [api](../api/GOAL.md) | Every row of the first public scope is proved through the API, for each persona | When the program's first three tasks have landed |
| [web](../web/GOAL.md) | Every proved row has its surface | When the first vertical's rows are proved |
| [operations](../operations/GOAL.md) | Erasure and restore are proved on physical fixtures; deployment is prepared | When the api Goal no longer changes the erasure and recovery contracts |

The product direction is settled and is not this Goal's subject: the
[target architecture](../../architecture/target-architecture.md), the
[decisions](../../product/decisions.md) and the [goal page](../../product/goal.md)
hold it. Implementation questions are researched when a row needs them.

## What went wrong, in one paragraph

Ten hours on 2026-10-12 with about 25 workers closed 77 tasks and moved the scope
registry by nothing after noon. Seven percent of worker output was first-attempt
work; the rest was the same tasks returning from a review that had no limit and
asked about tests and hypothetical interleavings instead of what each person gets
from the API. The [method](../method.md) has the figures and what replaces that.

## Duties

1. **Scope.** The registry (`scripts/qa/cases/launch-coverage.ts`) is the scope
   and the supermanager owns it. A delivery Goal works on rows it was given. A
   finding becomes scope only when a row's stated outcome fails for one of its
   personas; everything else goes to that Goal's later list. The supermanager
   reports one progress figure to the maintainer: rows proved of rows in scope.
2. **Method in code.** Each rule of the [method](../method.md) becomes a check in
   `goalctl` (first tasks below). A rule that lives only in a document is not
   kept: "stop after three attempts" was written on 2026-10-11 and broken the
   next day in every Goal, by the supermanager too.
3. **Measures.** At every checkpoint read the method's measures. When the
   first-attempt share of a Goal falls under half, stop its dispatch and find the
   cause before any further spending.
4. **Shared host and allowance.** Host memory, QA slots, gate lanes, the shared
   development stack and its refresh, and each account's allowance. See
   [state.md](state.md) for the engines the maintainer allows.
5. **Main-wide regression.** `task goal -- regress` on a pinned commit each
   night, with one browser journey for each vertical. No other browser run is
   routine.
6. **Managers.** Start each delivery Goal's manager when its row in the table
   above says so, enrol it with the coordinator, and restart one that dies.
   Managers bring the supermanager only what the method cannot decide: a scope
   promotion, a design note for a shared mechanism, a stop at the attempt cap.
7. **Mechanism design notes.** Read every design note for a shared mechanism
   before its code is written, and refuse one that names a mechanism to build
   instead of an observable outcome.

## First tasks

They make the method checkable. The api Goal starts after the first three.

| Task | Outcome |
| --- | --- |
| P1 | A registry row carries an outcome for each persona (a named test, `not applicable` with its reason, or `missing`). Existing proofs are filed under the persona they exercise and the rest are `missing`, so the registry says what is proved. `status` prints rows proved of rows in scope |
| P2 | A persona harness in `tests/qa/support`: one call gives an outcome test the six personas' sessions on a real stack through the public API. A guard refuses an outcome test that imports from a service's `src` |
| P3 | Briefs declare `kind: outcome \| implementation \| surface \| mechanism \| tooling`. `dispatch` refuses an implementation brief whose outcome tests do not exist or do not fail on `main`, and a mechanism brief without a design note |
| P4 | `land` follows the method: one review pass, only for implementation tasks in authority, disclosure, rights, erasure or Account code; a finding blocks only when the test it supplies fails on the branch; `resume` refuses a third fix round without a dated decision in the brief |
| P5 | The surface gate: types, unit tests and the changed stories, no review; stories take responses recorded from outcome tests |
| P6 | `status` and `usage` report the method's measures from the ledger and the session logs |
| P7 | Every manager runs under the coordinator; what the shell waiter did (keep a wait on each running task, land `land: auto` tasks, tell the manager when a landing stops) is `goalctl` behaviour; mail carries a deadline and a sender |
| P8 | The nightly regression runs one browser journey for each vertical and nothing else in a browser |

P1, P2 and P4 decide the efficiency and come first. The others follow while the
api Goal runs.

## Starting

The maintainer starts the supermanager from the repository root:

```sh
tmux new -s goal-program
GOAL_ID=program claude --model <model> --effort xhigh --dangerously-skip-permissions
```

and sends: `You are the REZICS manager of Goal program. Read
docs/goals/program/GOAL.md, its state.md, docs/goals/method.md and
docs/goals/manager.md, register with task goal -- goal start program --manager
<session name>, and run the Goal.`

[state.md](state.md) lists what to do first after a cold start of the host.

## Completion

The program ends when the three delivery Goals have closed: every row in scope is
proved, has its surface, and erasure and restore are proved on physical
fixtures. What going live needs from outside the repository stays a list the
maintainer holds ([external conditions](../../operations/external-conditions.md));
no Goal solves or waits for an item on it.
