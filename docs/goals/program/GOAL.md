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
supermanager himself, in termspaces ([Starting](#starting)).

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

| Measured on 2026-10-13, 04:20 to 06:12 UTC | Value |
| --- | --- |
| Input tokens of the three managers | 65 million of 205 million, 32%. Tokens, not cost; workers' sub-agent sessions are not counted |
| The supermanager alone (one interactive Opus session) | 38.5 million, 19%: 146 model calls carrying 264,000 tokens on average and 385,000 at the end |
| api and web managers (headless Sol, resumed for each wake) | 103 and 100 calls at 114,000 and 149,000 tokens on average; 3 and 11 turns |
| What the supermanager's 146 calls were, by a pattern on each call's commands | 55 mechanical (a handoff or status read, a merge, a close, an acknowledgement, a wait armed); 24 reports to the maintainer; 17 mails written, 12 of the 16 mails saying "no reply needed"; 17 diffs or notes read; 13 documents or code read to decide; 11 documents written; 5 briefs; 4 tasks sent back |

A usage report the maintainer passed on for 2026-10-11 to 2026-10-13 shows the
same for the earlier run: 44% of the cost in managers, about 505,000 cached
tokens for each manager call, 36 tasks of 407 taking 44% of the task cost. Its
figures for the four managers agree with their session logs.

That day's tasks were short and show little about workers. The two days before
do: every Codex session of 2026-10-11 and 2026-10-12 on both accounts, 1,986
sessions, 95,751 model steps and 9.2 billion input tokens (97% cached), read
from the session logs step by step.

| Workers on 2026-10-11 and 2026-10-12 | Value |
| --- | --- |
| Worker sessions and landing reviews | 8.5 billion and 0.7 billion tokens: 92% and 8% |
| By the task's turn (its first prompt and every resume, over all its sessions) | Turns 1 to 3: 53% of worker tokens; 4 to 6: 19%; 7 to 12: 11%; 13 and later: 18% |
| By task | 79 tasks finished in one turn at a median 4 million tokens; 44 tasks took 13 turns or more at a median 82 million and used 48% of all tokens; the 36 tasks over 500 steps used 48% |
| By what a step did | Reading and searching 35%; waiting on a running command 29%; editing 10%; running tests and checks 9%; thinking 6%; sub-agents 6%; other commands and commits 5% |
| The same for tasks finished in one turn | Reading 32%, waiting 31%, tests 14%, editing 10%: the waiting does not come from rework |
| By session length | 126 of 1,181 worker sessions ran past 150 steps and used 55% of worker tokens, 28% in the steps after the 150th. A step carried 72,000 tokens in a session's first 50 steps and 115,000 to 134,000 after |
| By engine | Sol: 2.4 million tokens a turn, a median 9.0 million and 5 turns for a task done on it alone. Luna: 7.7 million a turn, 8.0 million and 2 turns. Tasks were not assigned alike, so this compares little |
| By account | `codex` 6.9 billion, `codex-1` 2.4 billion |

Waiting was 30% of worker tokens in sessions begun on 2026-10-11 and 26% on
2026-10-12, when the protocol began to ask for one long wait call; in the short
tasks of 2026-10-13 it was 8% for tooling tasks. Whether that holds for long
tasks is not measured.

Three more things happened that day. One api manager read 18 persona matrices
one after another, so 15 worker sessions stood idle. Mail could not reach that
manager inside a turn of 37 minutes, and the order to wrap up arrived six
minutes late. The three pilot rows did not land, because the registry's loader,
the persona harness and the repository guards had each passed alone and had
never run together.

## How managers run from now on

Decided on 2026-10-13 by the supermanager at the maintainer's request (context
length is the cost; managers are trusted and main's scheduled checks trust no
one; agents maintain termspaces).
The [next tasks](#next-tasks) build what is not yet in the tool; until one
lands, a manager applies its rule by hand and says so.

- **State lives in the repository and the ledger, never in a session.** A Goal's
  `state.md`, its briefs, the ledger and Goal mail are enough to continue from;
  the pause of 2026-10-13 was written from them alone.
- **Manager, researcher, implementer and reviewer are identities.** An identity
  is a role card, its permissions and where its state lives; the session that
  carries it is disposable. A researcher is read-only and hands off a matrix, a
  measurement or a design note; an implementer changes its claimed files; a
  reviewer makes the one pass the method allows.
- **A manager is a role, not a session.** The coordinator starts one short turn
  for an event, in a fresh session whose context is the Goal's `state.md`, the
  event and what the event points to. A fresh Sol session carries about 17,000
  tokens before it reads anything (measured over 44 sessions), so the aim is
  about 40,000 once it has read its state. Turns
  of one Goal run side by side on unrelated events, and the ledger's claims keep
  them apart, so eighteen handoffs are read by eighteen turns. A turn is
  bounded, at ten minutes to begin with; no measurement stands behind that
  number yet. A turn resumes
  an earlier session only for a thread the event names. Turns write decisions
  into the brief they concern; one checkpoint turn at a time edits `state.md`.
- **The tool settles what needs no judgment.** A `done` handoff of an outcome,
  surface or tooling task that passes its gates is landed and closed by the
  coordinator. A turn starts for a landing that stopped, a handoff that is not
  `done`, or a decision someone asked for.
- **Mail has three levels.** `fyi` starts no turn and rides with the next one;
  the default starts a turn; `urgent` ends the recipient's running turn and
  starts one with that mail first. Twelve of the sixteen mails the supermanager
  sent on 2026-10-13 said "no reply needed"; what each cost its reader was not
  measured.
- **Managers are autonomous and trusted.** A manager decides everything inside
  its Goal, reads its own workers' design notes, and settles a cross-Goal
  matter with the other manager by mail, without the supermanager; on
  2026-10-13 every such matter went through the supermanager and cost it a
  turn. No manager checks another.
- **Main's scheduled checks trust no one.** The run on a pinned commit of `main`
  belongs to the program's schedule and to no manager, and it is there to find
  fault. It runs every tier outside the browser, one journey for each vertical
  and every outcome test. A row counts as proved when that run passed it on
  `main`: `status` prints the rows declared beside the rows confirmed. A bounded
  audit, by an auditor identity that proved none of them, tries each newly
  proved row as its personas and reports a fault only with a failing test
  through the public API. A fault reopens the cell and goes to its owner's
  inbox; a manager can acknowledge it and cannot clear it.
- **Tests are admitted by the tool, not by a manager's wish.** The host is the
  limit (62 GB; the full run took over three and a half hours beside workers on
  2026-10-13). A worker runs its own files in one QA slot. A landing runs the
  affected unit files and the guards in a gate lane. Whole tiers, browser runs
  and the regression start only from the schedule, one at a time and when no
  worker is live. Each Goal has a share of the QA slots, and `goalctl` refuses
  the rest. Autonomy is over decisions, not over the host.
- **One resident supermanager, not split.** It is the session the maintainer
  talks to, in its own window. It owns the scope and the method, arbitrates
  what two managers cannot settle, reads the measures, and brings the
  maintainer what needs him. It holds no wait on any task and relays no mail.
  It is one session that compacts itself and is not restarted by hand; the
  program's own tooling tasks are run by a program manager role in short turns,
  like any Goal's.
- **A session's cost is its calls times its average context.** Every call sends
  the whole context again. Checked in the session logs of the four managers of
  2026-10-11 and 2026-10-12: each compacted four or five times in about 3,000
  calls, at 760,000 to 970,000 tokens, down to 30,000 to 75,000, and averaged
  480,000 to 525,000 a call. A session carries a little over half its
  compaction limit. The supermanager of that run made 2,188 calls in 48 hours,
  about 1,090 a day at 482,000: 530 million cached tokens a day. After an hour
  without a call a Claude session sends its context uncached: on 2026-10-13 a
  call after 78 idle minutes wrote 375,000 tokens to the cache and read 40,000.

  What follows is an estimate, not a measurement. If the tool takes the
  mechanical calls and managers mail each other, the supermanager makes perhaps
  45% fewer calls (the 55 mechanical calls and 12 relayed mails of the 146
  above; one short session, classified by pattern). At about 600 calls a day a
  limit of 500,000 gives about 165 million cached tokens a day, 300,000 about
  105 million and 200,000 about 75 million, with about two, three and six
  compactions a day. The limit is the larger lever for the supermanager, and
  it is to be set again from each turn's record.

  | Who | Session | Compaction |
  | --- | --- | --- |
  | Supermanager | One resident session; `state.md` written at each checkpoint | 300,000, the maintainer's choice on 2026-10-13 (`claude --autocompact 300000`; the flag was not tried) |
  | A Goal's manager | A fresh turn for an event, several side by side. Compaction alone would not let two turns run at once, let mail in between turns, or spare a session woken after an hour from sending its history uncached | Not reached; while managers are still resumed, 300,000 |
  | Worker, researcher | One session for an attempt. The report's long tasks carried about 100,000 tokens a call and one made 3,182 calls, so their cost is their calls. A fix round resumes it when it is under 200,000 tokens and was active within the hour, and starts fresh from the brief, the findings and the changed files otherwise | 400,000 for Sol and 200,000 for Luna, a backstop: a compaction in the middle of a task loses what was read. The control is the brief and a budget of calls for an attempt |
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
- **The model is called for a decision; a program does the rest.** This holds
  for workers as for managers, and it lies under the count of turns: a turn
  costs what its steps cost. Over 2026-10-11 and 2026-10-12, 39% of worker
  tokens went to steps that held no decision (waiting on a running command 29%,
  starting tests and checks 9%, committing 1%), 35% to fetching what to read
  one piece at a time, and 16% to editing and thinking; a task finished in one
  turn had the same shares. So the harness, not the model, waits, runs the
  checks, commits, rebases and lands, and it hands the model what the brief
  names before the first step; the model is called again when a check fails,
  with the failure and not the log. Some turns come from the same cause: a gate
  refuses what a worker forgot to run.
- **A limit is a breaker, not a saving** (maintainer, 2026-10-13). A cap on
  attempts, steps or tokens bounds a task that was defined wrongly; it does not
  make the same work cost less, and a task cut at a count is read again by
  whoever continues it. A limit therefore asks for a decision and is never
  counted as efficiency. What is counted is the tokens for a landed task of a
  kind, measured on the same tasks before and after a change.
- **Every turn is measured.** Why it started, the context it carried, what it
  did. `status` prints the managers' share of tokens beside the first-attempt
  share, and a wake that did nothing is counted.

Search and description of capabilities for outside agents over MCP and HTTP is
product scope for a later row of the api Goal, not for the first public scope.
Its build-time half, the operation index, is task N5. Nothing becomes a registry
at run time.

## Asking the maintainer

He may not be watching the supermanager and may not answer soon (2026-10-13).

1. A decision that can be undone and lies within the charter is taken, with its
   reason in the brief or in `state.md`. Nothing is sent.
2. Where evidence is missing, a researcher is dispatched with one question and
   returns the options with their cost; then the decision is taken.
3. What only he can decide is asked over Telegram: money, a third-party
   account, a product decision that changes the outcome, something that cannot
   be undone, a change to the standing directions. The question carries two to
   four options and the one the supermanager recommends, and, when the matter
   can be undone, the default it will take and when. Work that does not depend
   on the answer continues.

Telegram is a notice board, not a conversation (maintainer, 2026-10-13):
nothing listens there, and there is no pairing and no button. `goalctl` sends
(`ask`, `tell`) as the bot and in the group the maintainer named, with one
HTTPS call and no library; a send that fails stays in an outbox and the
coordinator sends it again. A question's message begins with its decision code
in code style, such as `D-12`, which he copies and answers to the resident
supermanager in its terminal. The body gives the question, the options by
letter, the one recommended and, when the matter can be undone, the default and
its time, and it ends with the recommended answer ready to copy, such as
`D-12 a`. The supermanager records his answer under that code
(`task goal -- decide D-12 a`), and a fresh session finds the open questions
with `task goal -- decisions`. Messages come from templates that carry a Goal,
a task, a question and numbers, never source code, file contents, personal
data or a secret. Unprompted it sends a start, a pause, a Goal's `STOP`, a
fault the scheduled run found in a confirmed row, an exhausted allowance and a
host that stopped answering. The token stays in `../.secrets/bots.json`.

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
5. **Main's scheduled checks.** `task goal -- regress --nightly` on a pinned
   commit each night, and the audit of newly proved rows. They are the
   program's, they trust no manager, and their result is the progress figure.
6. **Managers.** Configure each delivery Goal's manager role when its row in the
   table above says so, and trust it. A manager brings the supermanager a scope
   promotion, a matter two managers could not settle, and what it would ask the
   maintainer; nothing else.
7. **Mechanism design notes.** A design note for a shared mechanism is read
   before its code is written by its Goal's manager, who refuses one that names
   a mechanism to build instead of an observable outcome. The supermanager
   reads a note when a manager asks.
8. **The host.** Tests are admitted by the tool; whole tiers and browser runs
   are the schedule's.
9. **One row first.** Before a Goal writes tests against new tooling, the
   program proves one row with it from end to end.

## Next tasks

On `main` since 2026-10-13: persona cells in the registry and `outcomeTest`;
the persona harness; `dispatch`, `land` and `resume` enforcing the method;
measures in `status`; `coordinator start` and mail with a sender and a deadline;
`regress --nightly`. Next, in this order:

| Task | Outcome |
| --- | --- |
| N0 | The regression of 2026-10-13 on `main` is read: its failures are clustered by first error line with no model, the clusters the run caused itself (a host shared with workers, an agent's environment) are rerun alone, and each cluster that remains is a pending cell of a row or one task of the Goal that owns it. [state.md](state.md) has the counts |
| N1 | One Books row is proved from end to end by the program: its declaration, its six outcome tests through the persona harness, landed through the gates, and `status` shows 1 of 67. It removes what stopped the pilots (the guard that cannot follow the loader's import, the harness's missing read) |
| N2 | `scripts/goal/goalctl.ts` is split along its commands, with no change of behaviour, so that tooling tasks stop sharing one file of 6,300 lines |
| N3 | The coordinator lands and closes what needs no judgment, starts a short fresh turn for an event, bounds a turn, delivers mail by level, and records each turn (reason, context, actions). A manager session that is still resumed compacts at 300,000 |
| N4 | `goalctl` maintains termspaces: it registers and removes the window of every turn and worker, `status` names each one's window, and nothing of a Goal runs on another tmux server |
| N5 | One command answers what a persona gets from an operation on a pooled QA stack and can record the response for a story; a generated index gives each operation's route file, owner and tests |
| N6 | The surface gate (types, unit tests, the changed stories fed by recorded responses); the measures read each attempt's recorded round; a cancelled task names its reason and what replaces it; at 150 model steps of one attempt the manager is told and decides (nine sessions in ten were shorter; nothing stops on the count alone); a worker starts no sub-agent; a mechanism brief's note is marked read by its Goal's manager; `dispatch` chooses the Codex account with more of its week left |
| N7 | Main's scheduled run is the judge: `status` prints the rows the last run on `main` confirmed beside the rows declared; a bounded audit tries each newly proved row as its personas and reports only with a failing test; a fault reopens the cell for its owner, who can acknowledge it and cannot clear it |
| N10 | The harness does what needs no decision in a worker's task. It hands the worker the files, tests and operations the brief names before the first step; `task goal -- check` runs types, lint, the task's tests and the guards in one blocking call and prints only what failed; at a handoff the harness itself commits, rebases onto the current `main` and runs the merge's checks in the gate's environment, and a refusal goes back to the same session as the failure alone. A worker never waits on a command, never commits and never learns of a refusal from a manager. Accepted on a comparison: five landed tasks of one kind done again this way, tokens and steps for each beside the first time. Over 2026-10-11 and 2026-10-12, 39% of worker tokens went to steps with no decision |
| N9 | The maintainer is told on Telegram and answers in the supermanager's terminal: `task goal -- ask` records a question under a decision code and sends it with that code first, in code style, then the options, the one recommended and any default with its time; `tell` sends a notice; `decide` records his answer and `decisions` lists the open ones; a failed send is retried from an outbox. No listener, no button, no library; its tests run against a fake Bot API |
| N8 | Tests are admitted by the tool: whole tiers, browser runs and `regress` start only from the program's schedule, one at a time and when no worker is live; each Goal has a share of the QA slots; `goalctl` refuses the rest. The full run's three and a half hours are measured by batch and cut |

N0 comes first and needs no worker until its clusters are known. N10 follows N2,
beside N3. N1, N2 and N9
start together; they share no file. N3 follows N2, N4 follows N3, N5 and N8 run beside N3,
N7 follows N1. The
api Goal resumes its 18 tasks after N4, with its matrices read by turns side by
side. termspaces needs one thing it lacks in 0.2.0 for N4, removing a single
window; until it has it, `goalctl` removes the window on termspaces' socket.

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

Until N3 is on `main` the supermanager runs the program's tooling tasks itself,
with one background wait for each task, so it is called more often in those
days than it will be later.

## Completion

The program ends when the three delivery Goals have closed: every row in scope is
proved, has its surface, and erasure and restore are proved on physical
fixtures. What going live needs from outside the repository stays a list the
maintainer holds ([external conditions](../../operations/external-conditions.md));
no Goal solves or waits for an item on it.
