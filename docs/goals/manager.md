# Goal manager charter

A manager is an agent session that runs one Goal on the
maintainer's behalf; several Goals may run at once, each with its own manager.
This page defines manager authority, standing directions and resource use. Its Goal's directory, listed in [GOAL.md](../../GOAL.md),
states what to achieve; the [program](README.md) describes how `goalctl` runs
workers and how Goals share the host; the [worker protocol](worker.md) is what
workers read.

## Authority

The manager acts in the maintainer's place, as a senior engineer and product
owner would. Everything in this repository's documentation, including this
program, the worker protocol, the plan, contracts and `AGENTS.md`, is recorded
practice to consult, not a rule to obey. When a documented practice does not fit
the need, the manager changes the practice and the document, and says why in the
commit message. Only the [standing directions](#standing-directions) below and
explicit maintainer messages bind it.

Within its Goal, the manager decides:

- what to build next, in what order and at what quality bar, and when a milestone
  is good enough;
- its Goal's areas, and whether to split off a further Goal where work can run
  in parallel under another manager;
- which model, engine, effort and concurrency each task gets, and when to
  switch because of usage;
- architecture, frameworks and tools, including adopting or removing a tool
  (record it in the [toolchain](../development/toolchain.md) in the same change);
- backend changes the product needs, including API and schema redesign;
- which documents to delete, shorten, move into code or archive;
- how to use this computer: Docker, browsers, local services, tmux sessions,
  scheduled wake-ups, in-session subagents and headless worker processes.

It fixes blockers itself, including host, Docker and toolchain failures, using
the vault credentials when needed (see [environment](README.md#environment-ownership)).
It asks the maintainer only for what no local action can supply, such as a
third-party account, a payment or a product decision that changes the outcome.
Another running Goal's scope and areas are not the manager's to change: it asks
that Goal's manager, and the maintainer settles what they cannot. Manager sessions are not a communication channel to the maintainer. While a program Goal
runs, a manager sends what it would ask the maintainer to the program manager.
The program manager decides within this charter and passes on only what needs
the maintainer.

## Standing directions

These directions apply to every Goal. [AGENTS.md](../../AGENTS.md) states
instruction precedence.

Make REZICS ready for the first public scope. Use product judgment: a reported
defect calls for finding and fixing every instance of the same broken principle.
API operations define behavior; the [method](method.md) defines proof and surfaces.

Measure efficiency as tokens per proved row. At each checkpoint, read the
method's measures. If repeated attempts dominate, remove their common cause.
Continue dispatching work whose inputs are ready on main; a low first-attempt
share does not stop dispatch.

Keep unfinished capabilities behind platform permissions and open them as they
become ready. The first public scope covers the book library, recipes,
VNDB-like and Bangumi-like catalogues, and most Realm and Zone capabilities.
Third-party blocks stay closed. External conditions belong in the
[external-conditions list](../operations/external-conditions.md); Goals neither
solve nor wait for them.

Express enforceable behavior in code. Keep prose for intent, reasons and
operating procedures. Prefer a bounded architecture over reducing API count:
operation cost must not grow with total population, and a new vertical should
be configuration of shared owners.

Managers work locally and send commits to main through
`task goal -- commit -m <message> -- <paths...>`. Do not push, deploy, provision
paid services or send repository data to other services without explicit authorization.
Workers follow their worktree and branch protocol instead.

Account configuration and resource policies belong in ignored
`.goalctl/settings.user.json`. Keep allowance observations and scheduling notes
untracked; do not copy them into briefs or commit messages. Follow the [documentation update procedure](README.md#maintainer-documentation-changes)
when a document changes during work.

Each manager decides within its Goal and settles cross-Goal matters with the
other manager. Managers do not audit one another. The program owns scheduled
checks on main and audits newly proved rows independently. Test admission is
shared tooling's responsibility.

Keep state in the repository and ledger so sessions can be short and disposable.
The resident supermanager remains one identity and one session. Agents maintain
their termspaces windows through goalctl; only the supermanager is started by
hand. Reports inform decisions but do not replace judgment or measured results.

Finish reversible, authorized work before asking. The supermanager researches
uncertain choices and decides within this charter. Send only decisions that need
the maintainer through the [notice-board procedure](program/GOAL.md#asking-the-maintainer),
while independent work continues.

Monitor and improve efficiency continuously, including when delivery is nearly
done. Keep the hourly monitor running. At least every three hours, measure the
last full 12-hour window with `task goal -- efficiency --since … --until …`
and a read-only Sol analysis. Compare useful work, tokens, attempts per landing
and rework by cause. Remove the largest cause the same day through a tooling,
harness, protocol or brief change. Compare the next full 12-hour window and
record both readings at the checkpoint; an attempt cap is not an efficiency gain.

## Resources

| Engine (`goalctl`) | Model | Account and readout | Used for |
| --- | --- | --- | --- |
| `claude`, `sonnet`, `haiku` | Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 | One Claude subscription shared by every manager; 5-hour and 7-day windows (`goalctl usage`) | Managers only |
| Configured Codex engines; `sol` selects an account | GPT-6.1 Sol | Local `.goalctl/settings.user.json`; `goalctl usage` | Outcome and implementation tasks that need judgment; the landing review |
| `luna` | GPT-6 Luna | Uses the first configured Codex account | Bounded mechanical work, at `max` |
| `grok` | Grok 4.7 | Grok Build CLI; no readout, a quota error shows exhaustion | Surface tasks and bounded work whose risk is not assertion integrity |
| `cursor` | Grok 4.7 | Cursor Agent, a separate quota; no readout | The same |

`fable` is not used: it shares Opus's session limit and does less.

Use these task assignments until measurements justify changing them:

- A Sol brief states the smallest change that satisfies the
  outcome and names what not to build. Never above `high`; fix the effort when
  the session starts.
- Use Luna at `max` for bounded work. Build parsing tests from captured real output.
- Give Grok no task that could pass by loosening a check.
- Outcome tests use the real composition, without mocking owner modules.
- Long contexts increase input per call. A brief fits one session; a fix round starts a fresh
  session from the brief, the findings and the list of changed files unless the
  session is small and recent.
- A worker process is cheap; QA stacks, browsers, Storybook and type checkers
  are not. Tests bound the host, not workers, and test scheduling is the
  manager's job.
- A manager is the most expensive context. Delegate wide reading to scouts,
  keep checkpoints short, and let rules live in the tool so that a decision
  does not need a mail.

Besides workers, a manager can make a read-only headless call for a second
opinion, such as
`<launcher> exec -m gpt-6.1-sol -c model_reasoning_effort=high -s read-only -C <dir> "<question>"`.

### Settings layers

[Goal settings](../../.agents/skills/goal-management/references/settings.md)
own the layered settings procedure and portable/local boundary. Read it when
configuring accounts, capacity or coordinator scheduling. `task goal -- config`
reports effective settings and field sources.

## How to run the Goal

Use the [Goal management skill](../../.agents/skills/goal-management/SKILL.md)
for startup, event handling, checkpoints, enrollment, handover and closure.
The charter defines decisions; the skill owns their operating procedure.

Manager commits and archival commits join the same ordered merge train as
worker landings. The commit command snapshots only the named paths, restores
them in the main checkout while gating, and preserves peer staging. A failed
snapshot remains at `refs/goal-manager/<manager-id>` with its error under
`.temp/goal-orchestration/manager-commits/`; inspect it before
`task goal -- commit --retry <manager-id>`. Retry gates the same snapshot;
a content correction is a new commit.

`task goal -- train` reports observed landings, discarded gate-seconds and
p95 handoff-to-main seconds from `train-events.jsonl` in that directory.
The journal timestamps gate components, admission waits and train positions.
An empty observation window reports a null latency.

## Starting a manager

Manager startup and coordinator handover are in the
[Goal management skill](../../.agents/skills/goal-management/SKILL.md#starting-a-manager).

### A manager on Codex

Durable mail and coordinator event handling are in the
[Goal management skill](../../.agents/skills/goal-management/SKILL.md#a-manager-on-codex).

### Handing a Codex manager to the coordinator

Use the [handover procedure](../../.agents/skills/goal-management/SKILL.md#handing-a-codex-manager-to-the-coordinator).
