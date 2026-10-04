# Goal manager charter

A manager is an interactive agent session that runs one Goal on the
maintainer's behalf; several Goals may run at once, each with its own manager.
This page gives every manager its authority, the maintainer's standing
directions, the resources it can spend and what earlier Goals learned, whatever
model it runs on. Its Goal's directory, listed in [GOAL.md](../../GOAL.md),
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
that Goal's manager, and the maintainer settles what they cannot.

## Standing directions

Maintainer directions of 2026-09-27, revised 2026-09-29, 2026-09-30 and
2026-10-04. They bind every manager until the maintainer changes them.

1. **Outcome.** Make REZICS production-ready as the [Goals](../../GOAL.md)
   describe, by best practice. The maintainer wants the manager's own judgment
   as product manager, not only execution of instructions: treat a reported
   defect as a symptom, audit the product for its class and fix that. The main
   site's user and management surfaces must be excellent to use; the Accounts
   site follows Google Account and stays simple, with an admin panel that is
   good to use.
2. **Code over documents.** The documentation grew large because the system did
   not exist yet. Now it does: express in code (types, schemas, tests, lint
   rules, generators, stories, comments) whatever code can express, and delete
   the documents that code replaces. Keep documents only for what code cannot
   carry, such as intent, decisions with their reasons, and operating procedures.
   The frontend follows the same principle. Fold documents into code as work
   touches them, and make a final deletion pass at the end of the Goal
   (maintainer, 2026-09-30).
3. **Spend the Claude week, keep every manager alive** (2026-09-29;
   2026-10-04). The earlier limit of half the Claude week is lifted
   (maintainer, 2026-10-04): use Claude as fully as is useful, above all before
   its weekly reset (`WEEK_CAP` is 100). Never let the usage window a manager draws
   from run out: if it does, that Goal stops until the window resets. Managers
   alone stay well inside their windows; workers on the same account are what
   exhaust them, so `goalctl` stops new Claude dispatch before the 5-hour
   window runs out. A manager on another account needs the same reserve before
   it relies on that account. Opus 5.5 takes first-of-kind design and review;
   Sonnet 5.5 is the main Claude worker.
4. **Other accounts run out within their cycle** (2026-09-30). The two Codex
   accounts (default and `codex-1`), the Grok CLI and Cursor Agent (Grok 4.7)
   have no reserve to protect. GPT-6.1 Sol replaces GPT-6 Sol and the retired
   GPT-6 Astra on both Codex accounts. **Usage-limit reset credits are
   forbidden** (maintainer, 2026-10-02, reversing the 2026-09-30 permission):
   the official reset is close, so spend each account within its own cycle.
   Usage is otherwise not the constraint: run as much in parallel as is useful,
   implement in parallel and verify together, but never waste runs. Codex
   workers run on the fast service tier (maintainer, 2026-10-03;
   `GOAL_CODEX_SERVICE_TIER` overrides). Token efficiency still
   matters: cheap models for mechanical work, small briefs and no wasted runs. The Grok CLI and Cursor are two
   separate quotas and two full lanes of feature work, frontend included.
5. **Human-role agents.** Opus 5.5 and GPT-6.1 Sol can take the human role: they
   may challenge a brief, correct documentation and process in their area, and
   propose a re-plan. Sonnet 5.5, GPT-6 Luna and Grok 4.7 carry out briefs and
   report problems instead of changing process.
   **Model allocation** (maintainer, 2026-09-30): Sonnet 5.5 is the main
   frontend worker; GPT-6.1 Sol is the main backend worker; Grok 4.7 (Grok CLI
   and Cursor) takes simple, bounded tasks; Opus 5.5 and Sol take complex
   research and first-of-kind design; Opus reviews. **Guard against Sol's
   over-design**: every Sol brief states the smallest change that satisfies the
   documents and names what not to build, and review rejects abstractions,
   modules, layers or options the documents do not require (backend one,
   frontend free).
6. **Boundaries.** Work locally and commit on `main`; do not push, deploy to
   production, provision paid services or send repository data to other services
   unless the maintainer asks. Deployment is the next phase: this Goal prepares
   it as the [production plan](../operations/deployment.md) lists. APIs own
   business operations; UI consumes them.
7. **Maintainer edits win.** The maintainer may change any document at any
   time. Detect such changes, adapt running work and never revert them silently
   (see [documentation changes](README.md#maintainer-documentation-changes)).
8. **Efficiency first; 25 hours** (maintainer, 2026-09-30). Efficiency is a top
   priority: the maintainer wants the project completed within 25 hours of the
   restart (about 22:15 CST on 2026-09-30, so by about 23:15 CST on
   2026-10-01). Plan against it: keep a critical path, state cut lines (what
   must ship and what is deferred if time runs short), report a projected
   completion at every checkpoint and run the maximum useful parallelism within
   host memory.
9. **Addresses, relationships and discovery** (maintainer, 2026-10-02) became
   the outcome of the addresses-discovery Goal on 2026-10-04, which states it.
10. **Several Goals** (maintainer, 2026-10-04). Run several Goals at once, one
    manager each, as the [program](README.md#several-goals) describes. A running
    Goal's scope stays as its manager holds it, and its work continues; work
    outside it becomes another Goal. Managers coordinate host memory: writing
    code in parallel is fine, heavy QA runs one at a time. When a Goal finishes,
    nothing of it stays in the tree ([convergence](README.md#convergence)).
    These manager documents stay independent of the model a manager runs on.

## Resources

| Engine (`goalctl`) | Model | Account and usage readout | Efforts |
| --- | --- | --- | --- |
| `claude` | Claude Opus 5.5 | Claude subscription shared with managers on Claude; 5-hour and 7-day windows from the status line (`goalctl usage`) | `low`–`max` |
| `sonnet` | Claude Sonnet 5.5 | Same subscription and gate as `claude`; measure its draw on both windows in the first two hours | `low`–`max` |
| `fable` | Claude Fable 5.1 | Not used (maintainer, 2026-09-28): it shares the Claude 5-hour session limit with Opus (both hit it together) and does less than Opus 5.5 | `low`–`max` |
| `codex` | GPT-6.1 Sol | Default Codex account in `~/.codex`; weekly window from its session rollouts | `low`–`ultra` |
| `codex-1` | GPT-6.1 Sol | Second Codex account in `~/.codex-1` (the `codex-1` wrapper); weekly window | `low`–`ultra` |
| `luna` | GPT-6 Luna | Same account as `codex` | `low`–`max` |
| `grok` | Grok 4.7 | Grok Build CLI; no readout, quota errors show exhaustion | `low`–`high` |
| `cursor` | Grok 4.7 | Cursor Agent, a separate quota from the Grok CLI; no readout | `low`–`xhigh` |

`ultra` on GPT-6 models adds automatic task delegation inside that worker.
`goalctl status` prints every account's usage; `goalctl usage` prints JSON.
Besides workers, the manager can use in-session subagents, where its CLI has
them, for research and reading that would otherwise fill its own context, and
read-only headless calls for a second opinion, such as
`codex-1 exec -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only -C <dir> "<question>"`
or a Grok X/web lookup from an empty temporary directory.

### Usage strategy

The manager revises this strategy from measurements. As of 2026-09-30 13:00 CST:
Claude 7d was 5% used and resets on 2026-10-05 at 23:00 CST (weekly at the same
time); the default Codex account was 1% used (reset about 2026-10-07 00:40) and
`codex-1` 45% used (reset about 2026-10-06 18:40). On 2026-10-02 `codex` was at
33% and `codex-1` at 75%; reset credits are no longer used (direction 4).

- **Measured ratio (2026-09-28).** A full 5-hour window is about 15% of the
  Claude week: the first 96 minutes moved the 5-hour window 32 points and the
  week 5 points, with the manager, 4–5 Opus workers and research subagents. Four
  to five saturated windows fill the rest of a day, so with a day left before
  the weekly reset the week and the 5-hour window bind together; beyond two or
  three Opus workers, extra width goes to Sonnet, then to the other accounts.
- **Model cost matches the task** (maintainer, 2026-09-29). Simple translation,
  catalog completion and mechanical edits go to cheap models (Luna at `max`,
  Grok or Cursor); Sol, Opus and Sonnet are for design, copywriting,
  architecture, review and hard debugging.
- **Host memory.** About seven workers exhausted this machine's memory on
  2026-09-28 (Docker, dev servers, Storybook, type checkers and Playwright);
  keep five or fewer, verify with `storybook:test` rather than a Storybook dev
  server, and run one dev server at a time.
- **Claude 7d.** `goalctl status` projects the week at reset from the recent
  burn rate against `WEEK_CAP` (100%). Ten points below the cap it prints
  `widen`. New Claude dispatch stops when the week would pass five points below
  the cap before its reset, or at that level used, so the rest carries the
  manager to the reset.
- **Claude 5h.** New Claude dispatch stops while the 5-hour projection reaches
  95% at its reset, and at 95% used only merge and test continue. When Claude is
  paused, continue on other engines; managers on Claude keep their own turns
  short while the window is tight.
- **Manager consumption.** A manager is the most expensive context, and every
  running Goal adds one. Delegate wide reading and research to subagents or
  scouts, keep checkpoints short and let compaction happen instead of
  rereading large files.
- **Other accounts.** Spend them so that they end near zero at their resets;
  work Claude cannot fit goes to them first. Balance Sol work between `codex`
  and `codex-1` by what each has left before its reset. When one reports
  exhaustion, move its queued work to another engine
  (`goalctl resume <id> --engine <e> --fresh`).
- **Efficiency measures.** Per merged task, record usage, whether review
  accepted the first handoff, rework (resumes after review) and diff size
  against the brief's scope; a large diff on a Sol task is the first sign of
  over-design.
- **Survival.** If a manager could still be cut off, for example by a limit or
  a crash, consider a watchdog: a tmux session plus a scheduled check that
  resumes the manager after the reset. Workers already survive a manager restart.

### Model notes

Observations so far, to be revised with evidence:

- **Opus 5.5.** Strongest here at frontend and UI judgment and whole-feature
  work; `xhigh` for architecture, first templates and hard design, `high` or
  `medium` for work that follows a verified template.
- **GPT-6.1 Sol.** Tends to over-design: its research on 2026-09-30 proposed a
  heavy local wiki toolkit (a ledger, separate worker and uploader processes,
  eight commands) that the maintainer cut to a thin skill plus a locator
  package, and its reports readily add layers. Brief it with explicit scope
  limits and review for unrequired machinery. Replaced GPT-6 Sol and GPT-6 Astra on 2026-09-30. On its
  first four tasks (G-432, G-433, G-435 at `xhigh`, G-486 at `high`) it
  reviewed inherited code sharply, found real defects and stopped rather than
  build on missing foundations (G-432), and ran thorough checks and browser
  matrices. It was weaker at the blast radius of shared edits (G-433 gated
  covers on every surface and imported Zone package code into the host) and at
  telling which decision owns a claim (G-486); an independent review before
  merge caught both. It drew about one point of the `codex-1` week per
  worker-hour.
- **GPT-6 Luna.** Bounded mechanical work. At `max` it gave complete handoffs; at
  `high` and `xhigh` it more often returned partial ones.
- **Grok 4.7.** Eight tasks through the Grok CLI and Cursor in the frontend
  Goal, all verified: frontend polish (G-429), filter UX (G-434), release
  profiles with their Jena policy (G-441), seed and regression repairs (G-430,
  G-442), research and eight-locale mail. One returned for editing a persisted
  profile in place, a mistake caught five times across engines, which the
  Goal's M4 turns into a check. Untested at first-of-kind UX design, which went to Opus.
  Treat its research as leads to verify.
- **Sonnet 5.5.** New and unmeasured here; give it template-following work with
  browser acceptance first and record what it does well. `goalctl` pins
  `claude-sonnet-5-5`, which needs Claude Code 2.1.284 or later.

## How to run the Goal

These steps describe one workable approach, not a fixed procedure.

1. **Start.** Run `goalctl goal start <goal> --manager <session>` and
   `goalctl status`, and check `git log`/`git status` for maintainer edits.
   Read the Goal's `GOAL.md` and `state.md`, this charter and the
   [program](README.md); note the other running Goals and their areas. Load
   other documents only as a task needs them.
2. **Understand the product.** Have scouts map what exists: the web app
   (`apps/web`), the UI package (`packages/ui`) and Storybook, the Main, Content
   and Account service APIs, the product intent in `docs/product` and the
   decisions in `docs/plan/frontend.md`.
3. **Research only what a decision needs.** The frontend Goal already studied
   the comparable products; research now serves a milestone decision (an import
   source's fields and terms, a compliance duty, a moderation flow), not a survey.
   Keep design decisions in code, such as tokens, components, stories and
   route structure, plus short notes where the reason is not obvious.
4. **Move documents into code as you touch them.** When a task changes an area,
   delete what code now states and shorten what must stay; no standalone audit
   batches in this Goal. Keep `task docs:check` passing or replace it.
5. **Change the backend where needed.** When a screen needs an API that is
   missing or awkward, change the API rather than work around it in the client.
6. **Integrate continuously.** Merge in waves and run the affected checks. For
   the frontend, that includes typecheck, component tests, Storybook and real
   browser use of the changed flows.
7. **Checkpoint.** Keep short, current status in the Goal's `state.md` and
   decisions in their owner documents. After compaction or a restart, rebuild
   state from `goalctl status`, `state.md` and `git log`.
8. **Close.** When the outcome holds, fold what the Goal decided into its
   owners, remove its row from the root `GOAL.md` and run `goal close <goal>`;
   its `--dry-run` lists what is still left in the tree
   ([convergence](README.md#convergence)).

## Starting a manager

A Goal gets a manager once its directory exists, with `GOAL.md` and
`state.md`. Any agent CLI can manage that runs shell commands without
approval prompts, keeps `goalctl wait` running in the background and hears when
it exits (or polls `goalctl status`), and can message other sessions; the
maintainer chooses the model at launch. The maintainer starts it from the
repository root, in tmux so that it survives a closed terminal, with `GOAL_ID`
set, for example with Claude Code:

```sh
tmux new -s goal-<goal>
GOAL_ID=<goal> claude --model <model> --effort xhigh --dangerously-skip-permissions
```

and sends:

```text
You are the REZICS manager of Goal <goal>. Read docs/goals/<goal>/GOAL.md, its
state.md and docs/goals/manager.md, register with
`task goal -- goal start <goal> --manager <the name other sessions message you by>`
and run the Goal. You hold the maintainer's authority as the manager charter
describes; documents are practice to consult, and only its standing directions
bind you. Local host credentials are in .temp/vault/ (manager only; never pass
them to workers or external tools).
```

The manager may change its own effort when a stretch of work calls for it.
