# Goal program

This page describes how a Goal runs worker processes: `goalctl`, briefs,
claims, integration, usage and recovery. It records practice that has worked,
for the manager to use and improve. The [Goal](../../GOAL.md) states the current
outcome, the [manager charter](manager.md) gives the manager's authority,
directions and resources, and workers follow the [worker protocol](worker.md).

## Worker processes

Workers are separate headless CLI processes in bypass mode, not in-session
subagents. Each runs in its own worktree under `.temp/worktrees/` on a
`goal/<id>` branch. Every state change goes through `bun scripts/goal/goalctl.ts`,
run by the manager from the main checkout:

| Command | Effect |
| --- | --- |
| `init --manager goal-manager` | Records the program start and the manager session name. |
| `dispatch docs/goals/tasks/G-NNN.md [--dry-run] [--force-usage]` | Validates the brief, refuses overlapping claims, unmet dependencies, the live-worker limit and exhausted usage for the brief's engine, then creates the worktree, installs dependencies (about 6 s), copies the brief and starts a detached worker. |
| `wait G-NNN` | Run in the background. Blocks until the worker exits, then prints branch, cleanliness, scope check, token use and the handoff. |
| `resume G-NNN -m <text> [--effort e] [--engine e] [--fresh]` | Continues the same session with full context, optionally at another effort. Another engine continues its own latest session or starts fresh on the same worktree. |
| `reclaim G-NNN <brief>` | Replaces an open, exited task's claims from an updated brief after the dispatch conflict checks. |
| `stop G-NNN` | Terminates the worker's process group and confirms exit. Claims and worktree remain. |
| `scope G-NNN` / `owner <path>` | Lists commits ahead, dirty files and files outside the claim / which open task claims a path. |
| `merge G-NNN [--allow-scope]` | Requires an exited worker, a clean worktree and in-scope files; rebases onto `main` and fast-forwards `main`. A conflict marks the task `conflict` for the worker to resolve. |
| `close G-NNN verified\|cancelled` | Removes the worktree and releases the claims. |
| `status` / `usage` | Live workers, elapsed time and the usage of every account. |
| `test <task test args>` / `slot -- <cmd>` | Runs a check inside one of the shared QA slots. |

Engines are `claude`, `astra`, `codex`, `luna`, `grok` and `cursor`; the
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

Briefs live at `docs/goals/tasks/G-NNN.md` and stay short. The frontmatter is
machine-checked:

```text
---
id: G-101
title: Accounts admin user search
engine: claude                        # claude | astra | codex | luna | grok | cursor
effort: xhigh
cases: []                             # acceptance IDs such as IAM02, when the task has them
paths: [apps/accounts/**, packages/ui/src/data-table/**]
migrations: []                        # <directory>:<first>-<last>
shared: [route:accounts-admin]
depends: [G-099]
---
```

The body states the outcome, what to read, the pattern to follow, the checks to
run and known risks. Duplicate work is prevented mechanically: only the manager
dispatches, merges and closes; case IDs, overlapping path globs, migration
ranges and shared slots are exclusive; retries resume the same session; files
outside the claim block a merge unless the manager passes `--allow-scope` after
review; workers propose out-of-scope work instead of doing it.

## Integration and QA

- Workers run only their own checks through `goalctl test`, which bounds
  concurrent QA stacks (default 4 slots, `GOAL_QA_SLOTS`).
- The manager merges ready tasks in waves, one at a time, regenerates derived
  artifacts once (`task gen`), runs the static checks and one
  `goalctl test --affected <wave base>` run, then commits. Failures go back to
  the responsible session through `resume`.
- Run wave tests from a worktree pinned at the wave commit: the harness aborts
  with `Source changed during QA run` when commits land during the run.
- Frontend waves also need the changed flows exercised in a real browser
  against the local stack, with screenshots reviewed, not only component tests.

## Capacity and usage

- Up to 25 live workers (`GOAL_MAX_WORKERS`). Merge throughput, not the slot
  count, sets the useful width.
- The interactive status line writes `~/.claude/usage/latest.json`. goalctl
  keeps six hours of samples and projects both Claude windows at their resets
  from the recent burn rate. `claude` dispatch is refused while the 5-hour
  projection reaches 95%, at 95% used, when the 7-day window would run out
  before its reset, or at 97% of it used. Below a 95% weekly projection, `status`
  advises widening Claude work. A snapshot older than 30 minutes is unknown;
  a manager turn refreshes it.
- Codex accounts report their weekly window in their session rollouts, which
  goalctl reads from `~/.codex` (`codex`, `luna`) and `~/.codex-1` (`astra`). An
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
Adapt running work: finish, stop and resume, or re-brief. Never revert or
silently overwrite a maintainer edit; refine one only in a separate commit that
states the reason. Workers branch from committed `main`, so commit stable
maintainer edits as "Adopt maintainer documentation update" before dispatching
work that depends on them.

## Checkpoints and recovery

- Handle every `wait` completion promptly. Keep checkpoints short and current.
- After compaction, restart or interruption: run `goalctl status`, read the
  recent checkpoints and `git log -20`, re-arm `wait` for live workers, then
  continue the recorded next action.
- Archive a finished Goal's briefs, handoffs and logs on the local orphan branch
  `archive/goals`, not in the working tree, so later agents are not misled by them.

## Lessons from earlier Goals

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
