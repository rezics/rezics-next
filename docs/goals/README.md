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
| `task goal -- dispatch docs/goals/<goal>/tasks/G-NNN.md [--dry-run] [--force-usage]` | Validates the brief, refuses overlapping claims, paths in another Goal's areas, unmet dependencies, the live-worker limit and exhausted usage for the brief's engine, then creates the worktree, installs dependencies (about 6 s), copies the brief and starts a detached worker. |
| `task goal -- wait G-NNN` | Run in the background. Blocks until the worker exits, then prints branch, cleanliness, scope check, token use and the handoff. |
| `task goal -- resume G-NNN -m <text> [--effort e] [--engine e] [--fresh]` | Continues the same session with full context, optionally at another effort. Another engine continues its own latest session or starts fresh on the same worktree. |
| `task goal -- reclaim G-NNN <brief>` | Replaces an open, exited task's claims from an updated brief after the dispatch conflict checks. |
| `task goal -- stop G-NNN` | Terminates the worker's process group and confirms exit. Claims and worktree remain. |
| `task goal -- scope G-NNN` / `task goal -- owner <path>` | Lists commits ahead, dirty files and files outside the claim / which open task claims a path. |
| `task goal -- merge G-NNN [--allow-scope] [--allow-ids]` | Requires an exited worker, a clean worktree, in-scope files and no new task names in the tree ([convergence](#convergence)); rebases onto `main` and fast-forwards `main`. A conflict marks the task `conflict` for the worker to resolve. |
| `task goal -- close G-NNN... verified\|cancelled` | Removes the worktrees and releases the claims, then moves the briefs and handoffs to `archive/goals` and removes the briefs from the tree in one commit. |
| `task goal -- tidy [--legacy <dir>]` / `task goal -- goal close <goal> [--dry-run]` | Archives closed briefs still in the tree / ends a Goal once nothing of it remains ([convergence](#convergence)). |
| `task goal -- status` / `task goal -- usage` | Running Goals and their managers, live workers, the heavy QA holder and the usage of every account. |
| `task goal -- test [--heavy] <task test args>` / `task goal -- slot [--heavy] -- <cmd>` | Runs a check inside one of the shared QA slots; heavy runs also take the [host-wide heavy lock](#integration-and-qa). |

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
  A disagreement goes to the maintainer.
- **Shared host.** Claims, QA slots, the heavy QA lock, the live-worker limit,
  usage gates and host memory are one pool for all Goals. Writing code in
  parallel is cheap; heavy QA is not, and the lock keeps it to one run at a time.
  After merges, bring the shared stack to committed main with `task dev:refresh` in the main checkout (`-- --dry-run` previews it); it preserves data and refuses a held heavy QA lock.
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
commit only their own paths. The manager starts one web dev server, one
Storybook and one type-check watcher there and lists them in
`.temp/goal/shared.md`; workers start none of their own and run only unit tests
of their files. The manager merges the shared branch once, after its tasks
exit, and runs the integration tiers, Storybook and browser journeys once.

## Integration and QA

- Workers run only their own checks through `goalctl test`, which bounds
  concurrent QA stacks (default 3 slots, `GOAL_QA_SLOTS`; four exhausted a 62 GB host beside a dozen workers).
- Heavy runs take a host-wide lock as well as a slot, so the host carries at
  most one heavy run, from whichever Goal, beside two light ones. `--affected`
  and `--tier` runs are heavy by themselves; pass `--heavy` to `test` or `slot`
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

- Up to 25 live workers (`GOAL_MAX_WORKERS`) across all Goals. Merge
  throughput, not the slot count, sets the useful width.
- The interactive status line writes `~/.claude/usage/latest.json`. goalctl
  keeps six hours of samples and projects both Claude windows at their resets
  from the recent burn rate. `claude` dispatch is refused while the 5-hour
  projection reaches 95%, at 95% used, when the 7-day window would run out
  before its reset, or at 97% of it used. Below a 95% weekly projection, `status`
  advises widening Claude work. A snapshot older than 30 minutes is unknown;
  a manager turn refreshes it.
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
