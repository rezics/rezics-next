# Goal program

This page describes how Goals run worker processes: `goalctl`, briefs,
claims, integration, usage, several Goals at once and how a Goal leaves the
tree. It records practice that has worked, for managers to use and improve.
[GOAL.md](../../GOAL.md) lists the running Goals, each stated in its own
directory here; the [manager charter](manager.md) gives a manager's authority,
directions and resources, and workers follow the [worker protocol](worker.md).

## Worker processes

Workers are separate headless CLI processes in bypass mode, not in-session
subagents. Each runs in its own worktree under `.temp/worktrees/` on a
`goal/<id>` branch. Every state change goes through `bun scripts/goal/goalctl.ts`,
run by a manager from the main checkout with `GOAL_ID` set to its Goal:

| Command | Effect |
| --- | --- |
| `task goal -- goal start <goal> --manager <session>` | Registers a Goal whose `GOAL.md` exists, refusing areas that overlap another running Goal's; after a manager restart it records the new session name. |
| `task goal -- new [--goal <goal>] <title>` | Reserves the next task ID for the Goal and writes the brief skeleton at `docs/goals/<goal>/tasks/G-NNN.md`, so two managers never take the same number. |
| `task goal -- dispatch docs/goals/<goal>/tasks/G-NNN.md [--dry-run] [--force-usage]` | Validates the brief, refuses overlapping claims, paths in another Goal's areas, unknown or unmet dependencies, the live-worker limit, host `MemAvailable` below `GOAL_MEMORY_FLOOR_GIB` (default 12 GiB) and exhausted usage for the brief's engine, then creates the worktree, installs dependencies (about 6 s), copies the brief and starts a detached worker. Cross-Goal dependencies are contracts on the [program's board](program/state.md), not task IDs. |
| `task goal -- wait G-NNN` | Run in the background. Blocks until the worker exits, then prints branch, cleanliness, scope check, token use and the handoff. A brief with `land: auto` also runs `land`, delivering a verified task or a stop reason; other briefs keep the handoff-only behaviour. |
| `task goal -- resume G-NNN -m <text> [--effort e] [--engine e] [--fresh] [--force-usage]` | Re-checks the live-worker limit, host memory floor and selected engine's usage, then continues the session, optionally at another effort. Another engine continues its own latest session or starts fresh on the same worktree; `--force-usage` bypasses only the usage gate. |
| `task goal -- reclaim G-NNN <brief>` | Replaces an open, exited task's claims from an updated brief after the dispatch conflict checks. |
| `task goal -- stop G-NNN` | Terminates the worker's process group and its task-marked detached children. Preserves other live sharers and shared resources; after the last live worker stops, also sweeps worktree processes and removes its stack. Claims and worktree remain. |
| `task goal -- scope G-NNN` / `task goal -- owner <path>` | Lists commits ahead, dirty files and files outside the claim / which open task claims a path. |
| `task goal -- land G-NNN` | Requires an exited task with a clean, exclusive branch and a `RESULT: done` handoff. Codex Sol/high reviews its diff against the brief read-only for blocking behaviour, scope, test or security defects; reports stay in the task's run directory. A clean review runs the existing `merge` gates and `close … verified`; any finding or refusal leaves the task open with its reason. Work added on resume belongs in the brief first, since the review checks scope against it. |
| `task goal -- merge G-NNN [--allow-scope] [--allow-ids] [--landed] [--skip-unit-gate]` | Requires all open sharers to have exited, a clean worktree, files within their combined claims and no new task names in the tree ([convergence](#convergence)); rebases onto `main` and normalizes composition roots. In each directory where added SQL migrations fall behind main’s head, renumbers the task’s added sequence above it in order, rewrites proven migration references in task-changed files and commits the normalization. Proven references outside those files or ambiguous SQL self-references refuse normalization for manual renumbering; unrelated numeric data does not. The unit gate runs on the normalized branch outside the ledger lock. If only `main` advances, rebase and fast-forward using that gate; commits touching task-changed or gated files re-run the gate once. Further overlap, moved task heads or changed sharers require a manager retry. Affected unit files plus the reasoned repository-wide inventory guards in `scripts/qa/repository-guards.ts` always run in `GOAL_UNIT_GATE_SHARDS` parallel calls (default 4) within `GOAL_UNIT_GATE_BUDGET_MS` per side (default 12 minutes). A side that does not finish is inconclusive, not a refusal. Branch failures are rerun together once; a file that then passes is order-dependent and reported, not blocking. Files that fail again are rerun at the commit before the task’s first recorded merge (including shared or manually landed merges), or main’s HEAD for a new task; a stream remains responsible for failures its earlier merge introduced. Inherited failures are reported, and the merge fast-forwards only if no file introduces a failure. Fast-forwards and own-only commits briefly retry a held Git index lock without deleting it. `--skip-unit-gate` prints the explicit bypass reason. Model, integration and browser tiers remain outside this gate. Records every open sharer and a merge event with both commit boundaries; `--landed` records manually landed work. A repeated merge with nothing new succeeds. A conflict marks the named task `conflict` for the worker to resolve. |
| `task goal -- close G-NNN... verified\|cancelled` | Removes the worktrees and releases the claims, then moves the briefs and handoffs to `archive/goals` and removes the briefs from the tree in one commit. |
| `task goal -- tidy [--legacy <dir>]` / `task goal -- goal close <goal> [--dry-run]` | Archives closed briefs still in the tree / ends a Goal once nothing of it remains ([convergence](#convergence)). |
| `task goal -- status` / `task goal -- usage` | Running Goals and their managers, live workers, unacknowledged regression counts, the heavy QA holder and the usage of every account. |
| `task goal -- test [--heavy] <task test args>` / `task goal -- slot [--heavy] -- <cmd>` | Runs a check inside one of the shared QA slots; heavy runs also take the [host-wide heavy lock](#integration-and-qa). |
| `task goal -- regress [--at <rev>] [--resume <run-id>]` | Pins `main` (or the selected revision) in a detached worktree, checks committed generated artifacts and runs the harness manifest. Pinned checkouts default to verified disk storage under `~/.cache/rezics-r/<repo-key>/`; `GOAL_REGRESS_CHECKOUT_ROOT` selects another short disk path. Memory-backed checkout and report roots are refused, and child commands use a separate disk-backed `TMPDIR` in each checkout. Owner and fault/recovery batches contain at most 15 files; integration batches contain at most 5 files to fit the active-work deadline under concurrent load. They run concurrently up to `GOAL_QA_SLOTS` (default 3), with checkout-local state isolated per batch and harness memory admission; only browser journeys and Storybook take the heavy lock. The default selection excludes e2e and Storybook; a nightly full run uses `--only unit,owner,model,integration,fault/recovery,e2e,accounts:storybook`. `REZICS_QA_SHARDS` defaults to 1. Reports and checkpoints live under `.temp/goal-orchestration/regress/<run-id>/`; resume keeps the SHA and skips finished batches. `--only unit,model --integration-batches 2` runs a restricted check, which cannot certify a complete pass. `GOAL_REGRESS_STATE_DIR` keeps smoke-run reports in a writable worktree. Restricted selections are partial reports; the default certifies the selected nonbrowser tiers. |
| `task goal -- inbox [--ack <n>]` | Lists the caller Goal's regression inbox (`GOAL_ID`, default `program`) and acknowledges the displayed line number. Verified merge boundaries route deterministic failures to their Goal; uncertain ownership, inherited, flaky and order-dependent failures go to `program`. Infrastructure results are void and re-queued. |

Engines are `claude`, `sonnet`, `fable`, `codex`, `codex-1`, `luna`, `grok` and `cursor`; the
[charter](manager.md#resources) lists their models and accounts; the
[`goalctl` launcher](../../scripts/goal/goalctl.ts) owns their executable commands.
A brief without `engine` runs on `claude` (`GOAL_ENGINE` changes the default).
To add an engine, extend `launchCommand` and its tests in `goalctl.ts`.

The lifecycle is dispatch, background `wait`, handoff, then merge or resume,
and close after the wave verifies it. Worker processes are detached and survive
a manager restart; after one, `status` shows them and `wait` is re-armed for each
live one. The manager does not send instructions into a running worker: to
change a task, `stop` it and `resume` it with the new instruction.

## Briefs and duplicate prevention

Briefs live at `docs/goals/<goal>/tasks/G-NNN.md`, written by `new`, and stay
short. The frontmatter is machine-checked:

```text
---
id: G-101
title: Accounts admin user search
engine: claude                        # claude | sonnet | codex | codex-1 | luna | grok | cursor
effort: xhigh
cases: []                             # acceptance IDs such as IAM02, when the task has them
paths: [apps/accounts/**, packages/ui/src/data-table/**]   # name new files by capability, never g-NNN
migrations: []                        # <directory>:<first>-<last>
shared: [route:accounts-admin]
depends: [G-099]
worktree: wave-9                      # optional: tasks naming one worktree share its tree and branch
land: auto                           # optional, exclusive branches: wait reviews, merges and verifies a done handoff
---
```

The body states the outcome, what to read, the pattern to follow, the checks to
run and known risks. Duplicate work is prevented mechanically: only the manager
dispatches, merges and closes its Goal's tasks; case IDs, overlapping path
globs, migration ranges and shared slots are exclusive across all Goals, and
each Goal's areas are closed to the others; retries resume the same session; files
outside the claim block a merge unless the manager passes `--allow-scope` after
review; workers propose out-of-scope work instead of doing it.

## Several Goals

Maintainer, 2026-10-04: several Goals run at once, one manager each. A Goal is
the directory `docs/goals/<goal>/`: `GOAL.md` states its outcome and, in its
frontmatter, its `areas`; `state.md` is its manager's checkpoint; `tasks/` holds
its open briefs. The root [GOAL.md](../../GOAL.md) lists the Goals.

- **Identity.** A manager runs with `GOAL_ID=<goal>` in its environment and
  registers with `goal start`; `goalctl` then refuses its commands on another
  Goal's tasks, and workers learn their own manager's session name.
- **Areas.** Areas are coarse path globs, read from `GOAL.md` at every
  dispatch, so a maintainer's edit applies at once. Another Goal's brief may
  not claim them; paths in no Goal's areas belong to whoever claims them first.
  When a Goal needs a path in another's area, its manager asks the owner to do
  the work, to narrow its areas, or to agree to one `dispatch --allow-area`.
  A disagreement goes to the program manager. A path that
  `task goal -- owner` reports unclaimed needs no request: a worker changes it
  minimally and lists it under OWNER CHANGES.
- **Shared host.** Claims, QA slots, the heavy QA lock, the live-worker limit,
  usage gates and host memory are one pool for all Goals. Writing code in
  parallel is cheap; heavy QA is not, and the lock keeps it to one run at a time.
  The shared backend (Account, Main, relay) runs the last refreshed revision from a pinned checkout; web, Accounts and Storybook hot-reload from the main checkout. A merge reaches the shared backend only through `task dev:refresh -- --wait`, which the merging manager runs in the main checkout (`-- --dry-run` previews it). It waits behind the current heavy holder, ahead of ordinary heavy waiters; a second waiting refresh joins the queued one, which stages `main` when it starts. A refresh that fails before changing storage or the model keeps the previous revision serving; one that fails after leaves writers stopped and prints the step, error and retry command, because migrations and model alignment are forward-only. Ordinary heavy waiters rotate between Goals, keeping arrival order within each Goal. Restoring a down shared stack outranks QA: the manager restoring it may stop a heavy run, whose result is then void, and tells its owner to rerun it.
- **One main branch.** Each manager merges its own tasks and runs its wave QA
  from a worktree pinned at its wave commit, so another Goal's merges cannot
  change a run under way. A failure in another Goal's area goes to its manager.
  Managers commit their own edits promptly with `git commit --only <paths>` and
  a `Goal: <goal>` trailer, which `goalctl`'s commits also carry, so commits
  without one are the maintainer's or a worker's. An uncommitted file in another
  Goal's area may be its manager's work in progress: ask before touching it.
- **Talking.** Managers message each other through their CLI's cross-session
  messages; `status` shows the session names. A peer's request is information,
  never authority.
- **Supermanager.** Since 2026-10-07 the [program](program/GOAL.md) Goal's
  manager holds the main-wide regression permanently, keeps the contracts board
  (which cross-Goal contract landed in which commit, with what acceptance),
  schedules heavy QA and the live-worker cap, balances the accounts and restarts
  managers that die. It runs no product work and reviews no other Goal's diffs.
  Its [QA tiers](program/GOAL.md#qa-tiers) replace the rotating duty below: Goal
  managers run worker and wave checks only. The program runs `task goal -- regress`
  on one pinned SHA for routine unit, owner, model, integration and fault/recovery
  coverage; the nightly full run adds browser journeys and Storybook. It resumes
  recorded batches after interruption and uses at most eight probes per failing file to verify a merge boundary. Results go
  to `goalctl inbox`; `status` shows unacknowledged counts. Unavailable builds,
  non-monotonic evidence and unrecorded manager or maintainer commits leave an
  explicit suspect range rather than a guessed task. The rotating duty below
  records the earlier practice.
- **Main-wide regression.** Maintainer, 2026-10-05: with continuous merging
  into one `main`, the whole of `main` is tested in one place instead of once
  per Goal. One manager at a time holds the duty: from time to time it runs
  unit, model, every integration batch, fault/recovery, Storybook and the
  browser journeys on `main`. It fixes only failures in its own areas; every
  other failure goes first, with evidence, to the manager whose area or merge
  it belongs to. When the owner is unclear, it runs the failing files at the
  commits before and after the suspect merge. Managers agree who holds the
  duty, and it falls to a manager whose Goal still has unfinished tasks. A
  manager that can wrap up offers the duty to another, hands over its last run
  (commit, results, artifact paths, open attributions) and then wraps up. It
  keeps the duty only if no one else can take it, for example because the
  others are about to wrap up too. The root `GOAL.md` names the holder.
- **Own checks stay targeted.** Because `main` has that full regression, a
  manager verifies its waves with the checks its changes affect (static
  checks, `test --affected <wave base>`, the browser journeys of changed flows)
  and does not run whole tiers for its own Goal. Otherwise continuous merging
  would not reduce how often anything runs. A Goal's completion is judged on
  its areas and those checks. A failure that another Goal's merge caused goes
  to that Goal's manager and does not hold the first Goal open: on 2026-10-05
  a "final" full pass of addresses-discovery kept finding other Goals' fresh
  regressions, because `main` moved under every run.

## Shared worktrees and unified checks

Maintainer, 2026-10-02: one worktree per task multiplied dev servers, Storybook,
type-checkers and QA runs until 64 GB was not enough. Related tasks now name one
`worktree:`; their agents work concurrently in that tree on disjoint claims and
commit only their own paths. Names are scoped by Goal: `worktree: wave-1` in
Goal `program` uses `.temp/worktrees/program-wave-1` and branch
`goal/program-wave-1`; joining a tree with another Goal's open tasks is refused.
Stopping one worker preserves its live peers and shared resources until the
last live worker stops. The manager starts one web dev server, one
Storybook and one type-check watcher there and lists them in
`.temp/goal/shared.md`; workers start none of their own and run only unit tests
of their files. The manager merges the shared branch once, after its tasks
exit, against their combined claims. That merge records every open sharer at
the same commit, and a later merge with nothing new is a no-op. The manager
runs the integration tiers, Storybook and browser journeys once.

## Integration and QA

- Workers run only their own checks through `goalctl test`, which bounds
  concurrent QA stacks (default 3 slots, `GOAL_QA_SLOTS`; four exhausted a 62 GB host beside a dozen workers).
- Heavy runs take a host-wide lock as well as a slot, so the host carries at
  most one heavy run, from whichever Goal, beside two light ones. `--affected`
  and whole `--tier` runs are heavy by themselves; bounded nonbrowser `--tier ... --file ...` batches use ordinary slots. Selected e2e journeys retain the heavy lock. Pass `--heavy` to `test` or `slot`
  for wave batches, Storybook and browser suites. The lock belongs to the
  process and frees itself when it exits; `status` shows its holder, and a
  heavy run waits for it.
- The manager merges ready tasks in waves, one at a time, regenerates derived
  artifacts once (`task gen`), runs the static checks and one
  `goalctl test --affected <wave base>` run, then commits. Failures go back to
  the responsible session through `resume`. With several Goals on one `main`,
  a merge that adds a profile or changes a served contract is followed at once
  by `task gen`, `task main:typecheck` and a regeneration commit, because other
  Goals type-check `main` between your waves.
- Run wave tests from a worktree pinned at the wave commit: the harness aborts
  with `Source changed during QA run` when commits land during the run.
- Frontend waves also need the changed flows exercised in a real browser
  against the local stack, with screenshots reviewed, not only component tests.

## Capacity and usage

- One cap for all Goals: 24 live workers (`task goal` default of
  `GOAL_MAX_WORKERS`), and no new dispatch while the host has less than 8 GiB
  available. A worker process holds about 0.2 GiB; memory goes to what workers
  run, which the QA slots, the heavy lock and the one-dev-server rule already
  bound. The critical path dispatches first. Merge and review throughput, not
  the cap, sets the useful width: brief short, keep a worker on its area across
  slices (`resume` it with the next slice after a merge instead of dispatching
  afresh), and never put `--heavy` on a worker's own test files.
- The interactive status line writes `~/.claude/usage/latest.json`. goalctl
  keeps six hours of samples and projects both Claude windows at their resets
  from the recent burn rate. The weekly projection is a low–high range because
  readouts are rounded to whole points: a sampled change uses one point less
  for its low rate (at least zero), and one point more for its high rate.
  Claude dispatch uses the low end against the weekly cap’s five-point margin;
  `status` warns when the high end reaches that margin. New Claude work also stops at the weekly used margin,
  at 95% of the 5-hour allowance used, or a 5-hour projection of 95%. Below the weekly target
  (the cap minus ten points), `status` advises widening Claude work. A snapshot
  older than 30 minutes is unknown; a manager turn refreshes it.
- Codex accounts report their weekly window in their session rollouts, which
  goalctl reads from `~/.codex` (`codex`, `luna`) and `~/.codex-1` (`codex-1`). An
  exhausted account refuses dispatch for its engines.
- Grok and Cursor have no readout; a quota error in a worker's output means that
  engine is exhausted for now.
- Back off on rate-limit errors instead of retrying in a loop.

## Environment ownership

The manager owns the environment and repairs whatever blocks the Goal: Docker
and host failures, toolchain gaps, local infrastructure, fixtures and providers
that can be served locally. It uses the credentials in `.temp/vault/` when
needed, only for local host administration, and never copies them into briefs,
commits, logs or prompts to other tools.

Known host facts: the host has 62 GB and Docker Desktop's VM 24 GiB (`MemoryMiB` in `~/.docker/desktop/settings-store.json`). On 2026-09-27 a 36 GiB VM, about a dozen agent workers and a six-shard affected run exhausted host memory and the kernel OOM-killed the whole VM; every later test failed on `ECONNREFUSED`. Run wave QA with `REZICS_QA_SHARDS=2` while workers hold QA stacks, and restart with `systemctl --user start docker-desktop` if it dies. Never choose "Reset to
factory defaults", which deletes every named volume. Results produced while the
engine was down are void. Run bulk volume copies alone: the engine panicked
under full QA load during a 400,000-file copy. `~/.docker/daemon.json` sets
`default-address-pools` to `10.210.0.0/16` in /24 subnets because sharded QA
stacks exhausted the default pools.

## Maintainer documentation changes

The maintainer may change any documentation at any time, including during a
run. At every checkpoint and before writing a brief, check `git log` and
`git status` for changes the manager did not make and re-read what changed.
Commits with another Goal's trailer and that Goal's merged tasks are a peer's,
not the maintainer's.
Adapt running work: finish, stop and resume, or re-brief. Never revert or
silently overwrite a maintainer edit; refine one only in a separate commit that
states the reason. Workers branch from committed `main`, so commit stable
maintainer edits as "Adopt maintainer documentation update" before dispatching
work that depends on them.

## Checkpoints and recovery

- Handle every `wait` completion promptly. Keep the Goal's `state.md` short and
  current.
- After compaction, restart or interruption: run `goalctl status`, read the
  Goal's `state.md` and `git log -20`, re-arm `wait` for live workers, run
  `goal start` again if the session name changed, then continue the recorded
  next action.

## Convergence

A finished Goal leaves nothing in the tree but what it built and the decisions
it recorded in their owners. Task IDs are history: they belong in commit
messages, branches, the ledger and the local orphan branch `archive/goals`.
In the tree they became dangling pointers once their briefs were archived
(comments still cite G-051 and G-314), and files named after tasks organized
code by when it was written rather than by what it covers. So convergence
happens at every step, not in a final sweep:

- **Merge** refuses a task that adds a file named `g-NNN…` or a task ID that
  a file did not carry before, outside `GOAL.md`, `docs/goals/` and
  `scripts/goal/`. Name files by the capability they cover, title tests by
  acceptance ID or behavior, and state a reason instead of citing the task.
  Existing names and mentions may stay or move; renaming them away is welcome.
  `--allow-ids` is for a reviewed exception. Tasks dispatched before
  2026-10-04 are exempt, as their briefs asked for task-named tests.
- **Close** moves each brief and its handoffs to
  `archive/goals:<goal>-<start date>/` and removes the brief from the tree in
  one commit, through git plumbing: the main checkout's HEAD never moves. A
  brief that tracked files still cite stays until the citation points at an
  owner document. `tidy` repairs a close that stopped part-way.
- **Goal close** runs once the manager has folded the Goal's lasting decisions
  into their owners and removed its row from the root `GOAL.md`. It refuses
  while a task is open, a brief remains, a tracked file names one of its tasks
  or links into its directory; `--dry-run` lists what is left. Then it archives
  the directory with the Goal's ledger entries and removes it from the tree.

About 600 task-named files and 560 files citing task IDs predate this practice.
Rename or restate them when a task touches them; the merge check keeps the
count from growing.

## Lessons from earlier Goals

- scoped-subjects (2026-10-05) held the main-wide regression while it closed. A new route trips several inventory guards at once (rate limit, public reads, suitability), and a worker's fix that widens a check (subject readability, reference disclosure) breaks neighbouring suites; the manager therefore runs at least the unit part of `test --affected` after every backend merge, not only the type-checkers. A guard that is already red hides every new omission, so the holder makes red guards green first. Heavy passes run at one shard in chunks of about 15 files while workers are live: the host has 62 GB and Docker Desktop was OOM-killed twice in one day.
- post-layers (2026-10-05) changed a kernel type on live data. A migration's
  fixture must come from the old command itself, since a hand-written one
  missed a field the real data had; a startup migration must never keep Main
  from listening; a merge that adds a profile or migration needs the full
  shared-stack refresh (image, `dev:prepare`, `dataset:bootstrap-model`,
  Main/relay restart); every new route needs a rate-limit class, which the
  g-543 guard now enforces; and a manager never moves a worker worktree's HEAD,
  or the worker's commits land off its branch.
- Throughput came from exclusive claims, isolated worktrees, per-run QA stacks
  and short merge waves. Two-worker caps and one shared QA stack serialized work.
- Choose work by the outcome it completes, not by depth in one area: a third of
  one program's slices deepened areas that stayed partial.
- Shared composition files (`services/main/src/app.ts`, registries, coverage
  declarations) became merge hotspots. Small extractions and git's union merge
  driver for append-only files fixed most conflicts.
- A manager without a verified stop operation could not safely replace a
  worker, and concurrency without exclusive claims produced duplicate work.
- Published multi-agent experiments ([Cursor](https://cursor.com/blog/agent-swarm-model-economics),
  [Anthropic](https://www.anthropic.com/research/multiagent-systems),
  [MSEval](https://arxiv.org/html/2607.27877v1)) found that more agents and a
  manager persona do not by themselves produce good products; decision ownership,
  shared design records and evaluating complete integrated behavior matter more.
  Add coordination only to fix an observed failure, and remove it when it stops
  paying for itself ([harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps)).
