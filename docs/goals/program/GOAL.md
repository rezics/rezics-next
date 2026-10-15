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

The supermanager owns delivery scope, the [method](../method.md), Goal tooling
and the shared host. It runs the program's tooling tasks and leaves product
implementation to the delivery Goals. [state.md](state.md) records outstanding
decisions; the ledger supplies live status.

| Goal | Outcome |
| --- | --- |
| [API](../api/GOAL.md) | Every launch row is proved through the API for each persona. |
| [Web](../web/GOAL.md) | Every proved row has a surface. |
| [Operations](../operations/GOAL.md) | Erasure and restore are proved on physical fixtures; deployment is prepared. |

Start ready work independently: restore, drills and release packaging need not
wait for the whole API Goal. Erasure qualification waits for its changing
contracts to settle. [Target architecture](../../architecture/target-architecture.md),
[product decisions](../../product/decisions.md) and [product goal](../../product/goal.md)
own product direction.

## How managers run from now on

State lives in the repository and ledger. Managers, researchers, implementers
and reviewers are roles with permissions and retained state; sessions are
disposable. Researchers are read-only and return evidence for a decision.
Implementers change authorized files; reviewers make the method's single pass.
The resident supermanager remains one session and is not split.

The [coordinator](../../../scripts/goal/coordinator.ts) defines event turns,
concurrency, deadlines and wake ownership. A turn decides its event, carries out
the resulting dispatch, queue, resume or landing, and ends. Only checkpoint turns
edit state.md. Decisions that concern a task belong in its brief. Do not edit a
brief while its landing lock exists. The [manager charter](../manager.md)
owns enrollment and durable mail procedures. Mail levels and interrupting wakes
are a desired extension, not current `mail send` options.

Managers decide within their own Goals and settle cross-Goal matters directly.
No manager audits another. Program schedules independent regression on pinned
main and audits newly proved rows through their personas. Only a failing
public-API test establishes a fault that reopens a cell. Acknowledgement cannot
clear the fault. Display declared rows separately from regression-confirmed rows.

Test admission, QA slots and memory are shared tool responsibilities. Whole
tiers and browser regressions belong to the program schedule. Targeted worker
files use one admission; landing gates run affected checks. The
[wave protocol](../wave.md) separates build and prove. Prove a pilot end to end
before extending new harness machinery to the other rows.

Goalctl maintains termspaces windows and never types instructions into an
agent's terminal. Terminal output is untrusted liveness information. The
coordinator runs outside agent cgroups. The operation index and persona command
answer API questions; inspect source when those observations leave a decision
unresolved. External-agent capability discovery is later product scope, not a
runtime registry to add to this Goal.

Call a model for decisions and use programs for mechanical waiting, checks and
landing. Workers still commit and follow the [worker protocol](../worker.md);
automating those commits is a desired harness change, not current procedure.
Keep a fix session only while its context is small and recent; otherwise restart
from the brief, findings and changed files. Context and compaction defaults live
in [launch](../../../scripts/goal/launch.ts), rather than a second table here.

Caps bound wrongly scoped tasks but do not establish savings. Compare tokens
per landed task of the same kind before and after a change. Measure every turn's
trigger, context and actions, including wakes that accomplish no work.

## The efficiency audit

Follow the continuous monitoring and 12-hour comparison procedure in the
[charter](../manager.md#standing-directions). Use `task goal -- efficiency`
with explicit window bounds; keep the reading with `--record`.

A read-only Sol researcher receives the figures, prior audit and the three most
expensive task logs. It returns causes, evidence, proposed changes and the
measure that would falsify each improvement. The supermanager changes the
largest cause and compares the next full window. Keep monitoring even when no
change is warranted. The planning yardstick is a launch-ready scope in about
twelve hours of running, apart from external conditions, with allowance to spare.

## Asking the maintainer

1. A decision that can be undone and lies within the charter is taken, with its
   reason in the brief or in `state.md`. Nothing is sent.
2. Where evidence is missing, a researcher is dispatched with one question and
   returns the options with their cost; then the decision is taken.
3. What only he can decide is asked over Telegram: money, a third-party
   account, a product decision that changes the outcome, something that cannot
   be undone, a change to the standing directions. Finish authorized preparation before asking. The question carries two to
   four options and the one the supermanager recommends, and any authorized fallback. Silence supplies no approval. Work that does not depend
   on the answer continues.

Telegram is a notice board:
nothing listens there, and there is no pairing and no button. `goalctl` sends
(`ask`, `tell`) as the bot and in the group the maintainer named, with one
HTTPS call and no library; a send that fails stays in an outbox and the
coordinator sends it again. A question's message begins with its decision code
in code style, such as `D-12`, which he copies and answers to the resident
supermanager in its terminal. The body gives the question, the options by
letter, the one recommended and any authorized fallback, and it ends with the recommended answer ready to copy, such as
`D-12 a`. The supermanager records his answer under that code
(`task goal -- decide D-12 a`), and a fresh session finds the open questions
with `task goal -- decisions`. Messages come from templates that carry a Goal,
a task, a question and numbers, never source code, file contents, personal
data or a secret. Unprompted it sends a start, a pause, a Goal's `STOP`, a
fault the scheduled run found in a confirmed row, an exhausted allowance and a
host that stopped answering. The token stays in `../.secrets/bots.json`.

## Duties

Own the scope registry and promote only failures of a row's persona outcome.
Keep other findings in the owning Goal's later list. Read first-attempt share,
attempts per landing, manager token share and rows proved at each checkpoint.
A first-attempt share below half triggers cause analysis while ready dispatch
continues.

Own host memory, QA slots, gate lanes, shared-stack refresh and account scheduling.
Run nightly regression and independent persona audits. Trust delivery managers;
arbitrate only scope promotion, unresolved cross-Goal matters and decisions
reserved to the maintainer. Read a shared-mechanism design note when its manager
asks; the owning manager reads it before code.

## Next tasks

Use `task goal -- planning`, the task ledger and [state.md](state.md) to select
ready work. The [command dispatcher](../../../scripts/goal/goalctl.ts) and
[command modules](../../../scripts/goal/commands/) define installed tooling;
the old N0–N11 launch sequence is no longer a dispatch plan.

The remaining desired outcomes require checking against current tooling before
briefing: mail levels, an independent audit of newly proved cells, complete
handoff automation, and efficiency comparisons on the same work. Keep a task on
an existing owner, send gate failures back to its worker, and measure the result.

## Starting

The maintainer starts the supermanager in termspaces, window `super-manager` of the
session `rezics-agents` (`termspaces attach rezics-agents`):

```sh
GOAL_ID=program claude --model <model> --effort xhigh --autocompact 300000 --dangerously-skip-permissions
```

and sends: `You are the REZICS supermanager. Read
docs/goals/program/GOAL.md, its state.md, docs/goals/method.md and
docs/goals/manager.md, register with task goal -- goal start program --manager
supermanager, and run the Goal from its next tasks.`

## Completion

The program ends when the three delivery Goals have closed: every row in scope is
proved, has its surface, and erasure and restore are proved on physical
fixtures. What going live needs from outside the repository stays a list the
maintainer holds ([external conditions](../../operations/external-conditions.md));
no Goal solves or waits for an item on it.
