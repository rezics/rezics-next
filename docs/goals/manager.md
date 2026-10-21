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
that Goal's manager and agrees ownership and a compatible change directly.
All manager roles, including implementation managers and Program/supermanager,
are engineering peers. Program's shared-host, registry and coordination duties
do not make it an approval gate for routine investigation, design or repair.
Only decisions reserved to the maintainer below need escalation; ordinary
engineering uncertainty is resolved through evidence and peer coordination.

## Standing directions

These directions apply to every Goal. [AGENTS.md](../../AGENTS.md) states
instruction precedence.

Make REZICS ready for the first public scope. Use product judgment: a reported
defect calls for finding and fixing every instance of the same broken principle.
API operations define behavior; the [method](method.md) defines proof and surfaces.

Measure efficiency as tokens per proved row. At each checkpoint, read the
method's measures and manager token share. If repeated attempts dominate, remove
their common cause. Continue dispatching work whose inputs are ready on main;
a low first-attempt share does not stop dispatch.

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
affected peers. Shared problem notices require checking related local failures,
not another manager-review layer. The program owns scheduled
checks on main and audits newly proved rows independently. Test admission is
shared tooling's responsibility. Only a failing public-API test of a row's
persona outcome reopens a proved cell; acknowledgement cannot clear the fault.
Report declared rows separately from regression-confirmed rows.

Keep state in the repository and ledger so sessions can be short and disposable.
The resident supermanager remains one identity and one session. Agents maintain
their termspaces windows through goalctl; only the supermanager is started by
hand. Reports inform decisions but do not replace judgment or measured results.
Use models for decisions and programs for mechanical waiting, checks and landing.

Follow [Asking the maintainer](#asking-the-maintainer) for decisions reserved to the maintainer.

Landing gates run the tests the change affects plus those its brief names;
main's scheduled confirmation catches what that selection misses, and its
failures are fixed on main. The owning manager investigates a second landing
review's findings with affected peers, including Program for shared-tool faults;
it does not wait for a routine ruling. Findings that disclose data or bypass
authority are fixed before the merge; the rest merge with the change and join
the next batch. A branch's
confirmation failure in a test that passed on main is the branch's regression
only when a rerun of that file on the branch head fails again; a failure that
does not repeat is repaired on main. Small follow-ups
in the same tooling or owners go to one batch task rather than separate briefs,
so they cannot conflict with each other.

A review test blocks only after its run on the reviewed head fails at an
outcome assertion in the test body. A setup failure returns to its reviewer
once with the runner evidence. If setup still fails, program receives an
unconfirmed finding; it does not consume a worker fix round. Worker handoffs
blocked on a test premise state whether that test reached its assertion.

Monitor and improve efficiency continuously, including when delivery is nearly
done. Keep the hourly monitor running. At least every three hours, measure the
last full 12-hour window with the
[researcher procedure](../../.agents/skills/goal-management/SKILL.md#efficiency-audit).
Compare useful work, tokens, attempts per landing and rework by cause. Remove the
largest cause the same day through a tooling, harness, protocol or brief change.
Compare the next full 12-hour window and record both readings at the checkpoint.
The planning yardstick is launch-ready scope in about twelve hours of running,
apart from external conditions, with allowance to spare.

### Shared problem-solving duty

This standing direction supersedes older internal Program-reading or ruling
holds for routine work. Explicit maintainer boundaries and required independent
review remain in force.

Every manager owns recognizing and resolving problems, not merely assigning
work or relaying a blocked status. A failed operation, stalled or idle work,
unexpected cost or delay, repeated attempt, conflicting instruction or suspect
test premise triggers this duty immediately; do not wait for an hourly audit
or for the maintainer to notice.

Investigate the current source, actual inputs, logs and first failed assertion
or setup stage. Research credible remedies, including reuse of existing code,
evidence, fixtures and infrastructure, and compare correctness, time, resource
cost and effects on peers. Use primary documentation or a bounded researcher
when the uncertainty needs it; reuse applicable prior research. A known local
defect needs a focused investigation, not an academic survey or a new report.
Choose the most efficient correct remedy, execute it yourself or through an
explicit owner, and verify the original failure and affected behavior. Research,
mail, a larger retry allowance and an unchanged rerun are not a repair.

At discovery, notify **every active manager**, including Program, with one
problem identifier, evidence, impact and the immediate containment or next
action. Consult affected peers before changing their claimed paths, contracts,
data or running resources; agree one repair owner, boundaries and compatibility
so work is not duplicated. Keep independent ready work moving. Do not wait for
general acknowledgement, Program review or maintainer feedback to perform an
authorized repair. Stop repeating an unchanged failure while investigating it,
preserving healthy work and useful evidence.

After verification, notify the same managers with that identifier, the actual
fix and source revision, checks, changed usage or recovery instructions and any
remaining limits. Recipients apply the lesson to their own affected scope;
they do not just acknowledge it. Put durable guidance in its existing owner so
future managers learn it. Use [Goal mail](../../.agents/skills/goal-management/SKILL.md#shared-problem-notices)
for discovery and resolution notices, not an approval chain. Ask the maintainer
only when a genuinely reserved decision remains; continue all independent work.

## Asking the maintainer

Take reversible decisions within this charter and record the reason in the
brief or at a checkpoint. If evidence is missing, dispatch a read-only researcher
with one question and get options with their costs before deciding.

Ask the maintainer over Telegram only for money, a third-party account, a product
decision that changes the outcome, an irreversible action or a change to the
standing directions. Finish authorized preparation first. Give two to four
options, a recommendation and any authorized fallback. Silence supplies no
approval; continue independent work.

Telegram is a notice board, with no listener, pairing or buttons. `goalctl ask`
and `tell` send one HTTPS request as the bot to the maintainer's configured group;
the coordinator retries failed sends from the outbox. Begin a question with its
decision code in code style, such as `D-12`; give lettered options and end with
the recommended answer ready to copy, such as `D-12 a`. The maintainer answers
in the resident supermanager's terminal. Record it with
`task goal -- decide D-12 a`; `task goal -- decisions` lists open questions.

Templates carry a Goal, task, question and numbers, never source code, file
contents, personal data or secrets. Unprompted notices cover a start, pause,
Goal `STOP`, scheduled regression fault in a confirmed row, exhausted allowance
or unresponsive host. The token stays in `../.secrets/bots.json`.

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
worker landings.

## Starting a manager

Manager startup and coordinator handover are in the
[Goal management skill](../../.agents/skills/goal-management/SKILL.md#starting-a-manager).

### A manager on Codex

Durable mail and coordinator event handling are in the
[Goal management skill](../../.agents/skills/goal-management/SKILL.md#a-manager-on-codex).

### Handing a Codex manager to the coordinator

Use the [handover procedure](../../.agents/skills/goal-management/SKILL.md#handing-a-codex-manager-to-the-coordinator).
