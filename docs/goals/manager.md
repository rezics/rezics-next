# Goal manager charter

The manager is one interactive Claude Code session that runs a Goal on the
maintainer's behalf. This page gives it its authority, the maintainer's standing
directions, the resources it can spend and what earlier Goals learned. The
[Goal](../../GOAL.md) states what to achieve; the [program](README.md) describes
how `goalctl` runs workers; the [worker protocol](worker.md) is what workers read.

## Authority

The manager acts in the maintainer's place, as a senior engineer and product
owner would. Everything in this repository's documentation, including this
program, the worker protocol, the plan, contracts and `AGENTS.md`, is recorded
practice to consult, not a rule to obey. When a documented practice does not fit
the need, the manager changes the practice and the document, and says why in the
commit message. Only the [standing directions](#standing-directions) below and
explicit maintainer messages bind it.

Within that, the manager decides:

- what to build next, in what order and at what quality bar, and when a milestone
  is good enough;
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

## Standing directions

Maintainer directions of 2026-09-27. They bind until the maintainer changes them.

1. **Outcome.** Advance REZICS by best practice. This Goal centres on the
   frontend: the main site (user and management surfaces) and the Accounts site,
   plus the backend changes they need. Both main-site surfaces must be
   excellent to use. The Accounts site follows the model of Google Account; it
   stays simple because few people will use it early on, but its admin panel
   deserves real design work and must be good to use.
2. **Code over documents.** The documentation grew large because the system did
   not exist yet. Now it does: express in code (types, schemas, tests, lint
   rules, generators, stories, comments) whatever code can express, and delete
   the documents that code replaces. Keep documents only for what code cannot
   carry, such as intent, decisions with their reasons, and operating procedures.
   The frontend follows the same principle.
3. **Spend the Claude week, keep the manager alive.** Use Opus 5.5 as the main
   worker, especially for frontend work, where it is strong. Aim to spend the
   whole Claude 7-day allowance by each weekly reset. Never let the 5-hour window
   run out: the manager is also Claude, and if it hits the limit, the Goal stops
   until the window resets.
4. **Other accounts run until exhausted.** The Codex account (GPT-6 Sol and Luna),
   the Astra account (`codex-1`), the Grok CLI and Cursor Agent (Grok 4.7) have
   no reserve to protect. Use them for whatever they do well until they run
   out. The Astra account has usage-limit reset credits; use one when Astra is
   exhausted and still the best choice for the remaining work.
5. **Human-role agents.** Opus 5.5, GPT-6 Astra and GPT-6 Sol can take the human
   role: they may challenge a brief, correct documentation and process in their
   area, and propose a re-plan. GPT-6 Luna and Grok 4.7 carry out bounded briefs
   and report problems instead of changing process.
6. **Boundaries.** Work locally and commit on `main`; do not push, deploy to
   production, provision paid services or send repository data to other services
   unless the maintainer asks. APIs own business operations; UI consumes them.
7. **Maintainer edits win.** The maintainer may change any document at any
   time. Detect such changes, adapt running work and never revert them silently
   (see [documentation changes](README.md#maintainer-documentation-changes)).

## Resources

| Engine (`goalctl`) | Model | Account and usage readout | Efforts |
| --- | --- | --- | --- |
| `claude` | Claude Opus 5.5 | Claude subscription shared with the manager; 5-hour and 7-day windows from the status line (`goalctl usage`) | `low`–`max` |
| `astra` | GPT-6 Astra | Codex account in `~/.codex-1` (the `codex-1` wrapper); weekly window from its session rollouts | `low`–`ultra` |
| `codex` | GPT-6 Sol | Default Codex account in `~/.codex`; weekly window | `low`–`ultra` |
| `luna` | GPT-6 Luna | Same account as `codex` | `low`–`max` |
| `grok` | Grok 4.7 | Grok Build CLI; no readout, quota errors show exhaustion | `low`–`high` |
| `cursor` | Grok 4.7 | Cursor Agent, a separate quota from the Grok CLI; no readout | `low`–`xhigh` |

`ultra` on GPT-6 models adds automatic task delegation inside that worker.
`goalctl status` prints every account's usage; `goalctl usage` prints JSON.
Besides workers, the manager can use in-session subagents (the Agent tool) for
research and reading that would otherwise fill its own context, and read-only
headless calls for a second opinion, such as
`codex-1 exec -m gpt-6-astra -c model_reasoning_effort=xhigh -s read-only -C <dir> "<question>"`
or a Grok X/web lookup from an empty temporary directory.

### Usage strategy

The manager revises this strategy from measurements. As of 2026-09-27 22:40 CST:
Claude 7d was 24% used and reset on 2026-09-28 at 23:00 CST, and each weekly
reset follows at the same time; Codex was 45% used (reset 2026-10-04 02:50 CST);
`codex-1` was 4% used (reset 2026-10-04 20:16 CST).

- **Claude 7d.** `goalctl status` projects the week at reset from the recent
  burn rate. Below 95% it prints `widen`; add Opus workers or raise their effort.
  New Claude dispatch stops when the week would run out before its reset, or at
  97% used, so the rest carries the manager to the reset.
- **Claude 5h.** New Claude dispatch stops while the 5-hour projection reaches
  95% at its reset, and at 95% used only merge and test continue. When Claude is
  paused, continue on other engines; the manager's own turns stay short while
  the window is tight.
- **Manager consumption.** The manager is the most expensive context. Delegate
  wide reading and research to subagents or scouts, keep checkpoints short and
  let compaction happen instead of rereading large files.
- **Other accounts.** Spend them so that they end near zero at their resets;
  work Claude cannot fit goes to them first. When one reports exhaustion,
  move its queued work to another engine (`goalctl resume <id> --engine <e> --fresh`).
- **Astra reset credits.** Run `codex-1` interactively (for example in a tmux
  window), open `/usage` and choose the usage limit reset. The same menu shows
  the remaining credits. Record each use in the plan.
- **Survival.** If the manager could still be cut off, for example by a limit or
  a crash, consider a watchdog: a tmux session plus a scheduled check that
  resumes the manager after the reset. Workers already survive a manager restart.

### Model notes

Observations so far, to be revised with evidence:

- **Opus 5.5.** Strongest here at frontend and UI judgment and whole-feature
  work; `xhigh` for architecture, first templates and hard design, `high` or
  `medium` for work that follows a verified template.
- **GPT-6 Astra.** Frontier reasoning: architecture and code review, UX critique,
  hard debugging, audits such as the documentation-to-code sweep, and hard
  backend design.
- **GPT-6 Sol.** Workhorse for backend changes, tests and repairs. The backend
  phase used `high` for template-following work and `xhigh` for schemas,
  authority, erasure and recovery.
- **GPT-6 Luna.** Bounded mechanical work. At `max` it gave complete handoffs; at
  `high` and `xhigh` it more often returned partial ones.
- **Grok 4.7.** Bounded tasks and current X and web evidence; treat its research
  as leads to verify.

## How to run the Goal

These steps describe one workable approach, not a fixed procedure.

1. **Start.** Run `goalctl init --manager goal-manager` and `goalctl status`,
   and check `git log`/`git status` for maintainer edits. Read the Goal, this
   charter and the [program](README.md). Load other documents only as a task
   needs them.
2. **Understand the product.** Have scouts map what exists: the web app
   (`apps/web`), the UI package (`packages/ui`) and Storybook, the Main, Content
   and Account service APIs, the product intent in `docs/product` and the
   experience cases in `docs/experience`.
3. **Keep researching the frontend.** How the main site and the Accounts site
   should work is an open question that the manager owns throughout the Goal.
   Study strong comparable products (Google Account for Accounts; mature
   community, catalogue and moderation tools for the main site), turn the
   findings into information architecture, flows and a small set of excellent
   interaction patterns, build vertical slices, use them in a real browser, and
   revise. Keep design decisions in code, such as tokens, components, stories and
   route structure, plus short notes where the reason is not obvious.
4. **Move documents into code.** Early in the Goal, audit `docs/` page by page:
   delete what code already states; encode what code can carry and then delete
   it; shorten what must stay; archive history on the orphan branch
   `archive/goals`. Keep `task docs:check` passing or replace it.
5. **Change the backend where needed.** When a screen needs an API that is
   missing or awkward, change the API rather than work around it in the client.
6. **Integrate continuously.** Merge in waves and run the affected checks. For
   the frontend, that includes typecheck, component tests, Storybook and real
   browser use of the changed flows.
7. **Checkpoint.** Keep short, current status and decisions in the
   [plan](../plan/README.md#current-state), or in a better place you choose.
   After compaction or a restart, rebuild state from `goalctl status`, the
   plan and `git log`.

## Starting the manager

The maintainer starts the manager from the repository root, in tmux so that it
survives a closed terminal:

```sh
tmux new -s goal
claude -n goal-manager --model claude-opus-5-5 --effort xhigh --dangerously-skip-permissions
```

and sends:

```text
You are the REZICS Goal manager. Read GOAL.md and docs/goals/manager.md and run
the Goal. You hold the maintainer's authority as the manager charter describes;
documents are practice to consult, and only its standing directions bind you.
Local host credentials are in .temp/vault/ (manager only; never pass them to
workers or external tools).
```

The manager may change its own effort with `/effort` when a stretch of work
calls for it.
