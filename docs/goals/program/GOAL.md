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

Status: paused on 2026-10-13; this page is the plan the next start works from,
and [state.md](state.md) is the checkpoint. The maintainer starts the
supermanager's desk himself, in termspaces ([Starting](#starting)).

The program's manager is the **supermanager**. It runs no product work. It owns
what decides whether the delivery Goals are efficient: the scope, the
[method](../method.md) and the tool that enforces it, and the shared host.

| Goal | Outcome | Starts |
| --- | --- | --- |
| [api](../api/GOAL.md) | Every row of the first public scope is proved through the API, for each persona | Resumes when tasks N1 to N4 below are on `main` |
| [web](../web/GOAL.md) | Every proved row has its surface | When the first vertical's rows are proved |
| [operations](../operations/GOAL.md) | Erasure and restore are proved on physical fixtures; deployment is prepared | When the api Goal no longer changes the erasure and recovery contracts |

The product direction is settled and is not this Goal's subject: the
[target architecture](../../architecture/target-architecture.md), the
[decisions](../../product/decisions.md) and the [goal page](../../product/goal.md)
hold it. Implementation questions are researched when a row needs them.

## What two runs showed

**2026-10-12.** Ten hours with about 25 workers closed 77 tasks and moved the
scope registry by nothing after noon. Seven percent of worker output was
first-attempt work; the rest was the same tasks returning from a review that had
no limit. The [method](../method.md) has the figures and what replaced that.

**2026-10-13.** Ninety minutes under the method, with its checks built on the
way. First attempts were 92% in api, 62% in web and 60% in program, and no row
was proved. What cost was the managing:

| Measured on 2026-10-13 | Value |
| --- | --- |
| Input tokens of the three managers | 66 million of 207 million, 32% |
| The supermanager alone (one interactive Opus session) | 40 million, 19%: 149 model calls carrying 267,000 tokens on average and 418,000 at the end |
| api and web managers (headless Sol, resumed for each wake) | 103 and 100 calls at 114,000 and 149,000 tokens on average |
| Calls of the supermanager that needed judgment | About a quarter: briefs, four diffs read, three design notes, mail. The rest read a handoff, merged, closed or forwarded |

A usage report the maintainer passed on for 2026-10-11 to 2026-10-13 shows the
same for the earlier run: 44% of the cost in managers, about 505,000 cached
tokens for each manager call, 36 tasks of 407 taking 44% of the task cost.

Three more things happened that day. One api manager read 18 persona matrices
one after another, so 15 worker sessions stood idle. Mail could not reach that
manager inside a turn of 37 minutes, and the order to wrap up arrived six
minutes late. The three pilot rows did not land, because the registry's loader,
the persona harness and the repository guards had each passed alone and had
never run together.

## How managers run from now on

Decided on 2026-10-13 by the supermanager at the maintainer's request (context
length is the cost; the supermanager may be split; agents maintain termspaces).
The [next tasks](#next-tasks) build what is not yet in the tool; until one
lands, a manager applies its rule by hand and says so.

- **State lives in the repository and the ledger, never in a session.** A Goal's
  `state.md`, its briefs, the ledger and Goal mail are enough to continue from;
  the pause of 2026-10-13 was written from them alone.
- **A manager is a role, not a session.** The coordinator starts one short turn
  for an event, in a fresh session whose context is the Goal's `state.md`, the
  event and what the event points to: 20,000 tokens or fewer at its start. Turns
  of one Goal run side by side on unrelated events, and the ledger's claims keep
  them apart, so eighteen handoffs are read by eighteen turns. A turn ends
  within ten minutes and the coordinator ends one that does not. A turn resumes
  an earlier session only for a thread the event names. Turns write decisions
  into the brief they concern; one checkpoint turn at a time edits `state.md`.
- **The tool settles what needs no judgment.** A `done` handoff of an outcome,
  surface or tooling task that passes its gates is landed and closed by the
  coordinator. A turn starts for a landing that stopped, a handoff that is not
  `done`, or a decision someone asked for.
- **Mail has three levels.** `fyi` starts no turn and rides with the next one;
  the default starts a turn; `urgent` ends the recipient's running turn and
  starts one with that mail first. Half of the supermanager's mail on
  2026-10-13 said "no reply needed" and still cost a turn of over 100,000
  tokens each.
- **The supermanager is a desk and events.** The desk is the interactive session
  the maintainer talks to. It decides scope, method and design notes, and holds
  no wait on any task; when its context passes 150,000 tokens it writes
  `state.md` and starts a fresh session. Program events are short turns like
  any Goal's: the program's own tooling tasks and what managers ask within the
  [charter](../manager.md). What needs the desk or the maintainer reaches the
  desk as mail.
- **termspaces is the agents' terminal, and `goalctl` maintains it.** `goalctl`
  registers a window when a turn or a worker starts and removes it when it
  ends: windows named `goal-…` in the session `rezics-agents`, and no other
  window is touched. They run on termspaces' own tmux server, which systemd
  keeps outside every agent's cgroup. The coordinator stays a systemd service,
  and a window `coordinator` in the session `rezics` follows its journal: it is
  machinery, not an agent. Text captured from a terminal is untrusted. It
  serves watching and liveness; no instruction travels through it, and nothing
  types into an agent's terminal.
- **A question goes to the API first.** An agent that needs to know what a
  persona gets asks the running API with one command, and finds the operation,
  its route and its tests in a generated index; it reads source after that, not
  before. The matrices of 2026-10-13 state what the API answers today from
  reading code, which is the dear way to learn it. The web is checked by
  stories fed with responses recorded from the same calls.
- **Every turn is measured.** Why it started, the context it carried, what it
  did. `status` prints the managers' share of tokens beside the first-attempt
  share, and a wake that did nothing is counted.

Search and description of capabilities for outside agents over MCP and HTTP is
product scope for a later row of the api Goal, not for the first public scope.
Its build-time half, the operation index, is task N5. Nothing becomes a registry
at run time.

## Duties

1. **Scope.** The registry (`scripts/qa/cases/launch-coverage.ts`) is the scope
   and the supermanager owns it. A finding becomes scope only when a row's
   stated outcome fails for one of its personas; everything else goes to that
   Goal's later list. The one progress figure is rows proved of rows in scope.
2. **Method in code.** A rule a manager is meant to keep is a check in
   `goalctl`. A rule that lives only in a document is not kept.
3. **Measures.** Read them at every checkpoint: first-attempt share, attempts
   for each landed task, the managers' share of tokens. When a Goal's
   first-attempt share falls under half, its dispatch stops until the cause is
   known.
4. **Shared host and allowance.** Host memory, QA slots, gate lanes, the shared
   development stack and its refresh, each account's allowance.
5. **Main-wide regression.** `task goal -- regress --nightly` on a pinned commit
   each night, with one browser journey for each vertical.
6. **Managers.** Configure each delivery Goal's manager role when its row in the
   table above says so. Managers bring the supermanager only what the method
   cannot decide: a scope promotion, a design note for a shared mechanism, a
   stop at the attempt cap.
7. **Mechanism design notes.** Read every design note for a shared mechanism
   before its code is written, and refuse one that names a mechanism to build
   instead of an observable outcome.
8. **One row first.** Before a Goal writes tests against new tooling, the
   program proves one row with it from end to end.

## Next tasks

On `main` since 2026-10-13: persona cells in the registry and `outcomeTest`;
the persona harness; `dispatch`, `land` and `resume` enforcing the method;
measures in `status`; `coordinator start` and mail with a sender and a deadline;
`regress --nightly`. Next, in this order:

| Task | Outcome |
| --- | --- |
| N1 | One Books row is proved from end to end by the program: its declaration, its six outcome tests through the persona harness, landed through the gates, and `status` shows 1 of 67. It removes what stopped the pilots (the guard that cannot follow the loader's import, the harness's missing read) |
| N2 | `scripts/goal/goalctl.ts` is split along its commands, with no change of behaviour, so that tooling tasks stop sharing one file of 6,300 lines |
| N3 | The coordinator lands and closes what needs no judgment, starts a short fresh turn for an event, bounds a turn, delivers mail by level, and records each turn (reason, context, actions) |
| N4 | `goalctl` maintains termspaces: it registers and removes the window of every turn and worker, `status` names each one's window, and nothing of a Goal runs on another tmux server |
| N5 | One command answers what a persona gets from an operation on a pooled QA stack and can record the response for a story; a generated index gives each operation's route file, owner and tests |
| N6 | The surface gate (types, unit tests, the changed stories fed by recorded responses); the measures read each attempt's recorded round; a cancelled task names its reason and what replaces it; an attempt has a budget of model calls |

N1 and N2 start together. N3 follows N2, N4 follows N3, N5 runs beside N3. The
api Goal resumes its 18 tasks after N4, with its matrices read by turns side by
side. termspaces needs one thing it lacks in 0.2.0 for N4, removing a single
window; until it has it, `goalctl` removes the window on termspaces' socket.

## Starting

The maintainer starts the desk in termspaces, window `super-manager` of the
session `rezics-agents` (`termspaces attach rezics-agents`):

```sh
GOAL_ID=program claude --model <model> --effort xhigh --dangerously-skip-permissions
```

and sends: `You are the REZICS supermanager's desk. Read
docs/goals/program/GOAL.md, its state.md, docs/goals/method.md and
docs/goals/manager.md, register with task goal -- goal start program --manager
desk, and run the Goal from its next tasks.`

Until N3 is on `main` the desk also handles the program's own task exits, with
one background wait for each task, and keeps to the 150,000-token limit by
starting fresh from `state.md`.

## Completion

The program ends when the three delivery Goals have closed: every row in scope is
proved, has its surface, and erasure and restore are proved on physical
fixtures. What going live needs from outside the repository stays a list the
maintainer holds ([external conditions](../../operations/external-conditions.md));
no Goal solves or waits for an item on it.
