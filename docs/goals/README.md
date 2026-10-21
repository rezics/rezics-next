# Goal program

This page describes how Goals run worker processes: `goalctl`, briefs,
claims, integration, usage, several Goals at once and how a Goal leaves the
tree. It records practice that has worked, for managers to use and improve.
[GOAL.md](../../GOAL.md) lists the running Goals, each stated in its own
directory here; the [manager charter](manager.md) gives a manager's authority,
directions and resources, and workers follow the [worker protocol](worker.md).

The [method](method.md) defines, proves and lands work. This page describes the tool as it is; the method supplies its
landing rules and attempt cap.

## Worker processes

Workers are separate headless CLI processes in bypass mode, not in-session
subagents. Each runs in its own worktree under `.temp/worktrees/` on a
`goal/<id>` branch. Every state change goes through `bun scripts/goal/goalctl.ts`,
run by a manager from the main checkout with `GOAL_ID` set to its Goal:

Run `task goal` for command syntax. The [command dispatcher](../../scripts/goal/goalctl.ts),
[command modules](../../scripts/goal/commands/), [task lifecycle](../../scripts/goal/tasks.ts)
and [merge gate](../../scripts/goal/merge.ts) define behavior. Engine identifiers,
models and defaults live in [types](../../scripts/goal/types.ts) and
[launch](../../scripts/goal/launch.ts); the [charter](manager.md#resources) owns
model assignment policy.

The lifecycle is dispatch, handoff, then landing or resume, and close. With the
coordinator's service running, its pump settles each exited task and no `wait`
is needed; without it, a background `wait` does the same for its task.

Automatic settlement requires explicit `land: auto` for changing tasks of every
kind; a done handoff alone leaves them exited for a manager landing decision.
A `## Wave` section in the task's recorded brief keeps a build handoff exited
for program disposition even with `land: auto`. Wave builds never land
individually: combined proof and review precede the wave's single landing
([wave procedure](wave.md)). These boundaries preserve manual audit reviews
and wave proof requirements. Complete read-only tasks may still verify without
a merge or an automatic landing opt-in.

A command of the tool that needs no shared state is one file in
[`scripts/goal/commands/`](../../scripts/goal/commands/), named as the command. Worker processes are detached and survive
a manager restart; the coordinator continues settling them. Without the
coordinator, re-arm a background wait for each live task. The manager does not send instructions into a running worker: to
change a task, `stop` it and `resume` it with the new instruction.
A resume registers the brief's claims; `reclaim` remains for changing them without a resume.

## Briefs and duplicate prevention

Briefs live at `docs/goals/<goal>/tasks/G-NNN.md`, written by `new`, and stay
short. The [brief parser and validator](../../scripts/goal/briefs.ts) define the fields;
`task goal -- new --kind <kind> <title>` writes the current skeleton. State the
outcome, references, relevant patterns and checks. Let the validator enforce
claims, dependencies and brief shape instead of copying that schema here.

Claims keep two tasks off the same files, but not off the same decision: two
tasks can build one concept twice in different files. So every brief has a
`## Mechanisms` section, and `dispatch` and `reclaim` refuse one without it. The
section has one line for each mechanism in `scripts/static/mechanisms.ts` that
the task touches, `<id>: consume | configure | extend | new — <why no owner
fits>`, or the single line `none`. A brief names the outcome and the owner
mechanism, not a representation. The repository guards that land and merge
always run refuse writes to an owned state from outside its owner.

## Several Goals

Several Goals run at once, with one manager each. A Goal is
the directory `docs/goals/<goal>/`: `GOAL.md` states its outcome and, in its
frontmatter, its `areas`; `state.md` is its manager's checkpoint; `tasks/` holds
its open briefs. The root [GOAL.md](../../GOAL.md) lists the Goals.

- Identity. A manager runs with `GOAL_ID=<goal>` in its environment and
  registers with `goal start`; `goalctl` then refuses its commands on another
  Goal's tasks, and workers learn their own manager's session name.
- Areas. Areas are coarse path globs, read from `GOAL.md` at every
  dispatch, so a maintainer's edit applies at once. Another Goal's brief may
  not claim them; paths in no Goal's areas belong to whoever claims them first.
  When a Goal needs a path in another's area, its manager asks the owner to do
  the work, to narrow its areas, or to agree to one `dispatch --allow-area`.
  Managers agree the repair and boundaries as peers; Program coordinates shared
  resources rather than approving routine fixes. Only a genuinely reserved
  maintainer decision is escalated. The [worker scope](worker.md#scope)
  defines how to handle live path claims and unlanded overlaps.
- Shared host. Claims, QA slots, the heavy QA lock, the shared lifecycle lock, merge gate lanes, the live-worker limit,
  usage gates and host memory are one pool for all Goals. Writing code in
  parallel is cheap; heavy QA is not, and the lock keeps it to one run at a time.
  The shared backend serves a pinned revision. The
  [local development skill](../../.agents/skills/local-development/SKILL.md)
  owns refresh, failure recovery and frontend startup. Lifecycle locks and host
  admission serialize maintenance without moving another Goal's QA source.
- One main branch. Each manager merges its own tasks and runs its wave QA
  from a worktree pinned at its wave commit, so another Goal's merges cannot
  change a run under way. A failure in another Goal's area goes to its manager.
  Managers commit their own edits promptly with `git commit --only <paths>` and
  a `Goal: <goal>` trailer, which `goalctl`'s commits also carry, so commits
  without one are the maintainer's or a worker's. An uncommitted file in another
  Goal's area may be its manager's work in progress: ask before touching it.
- Talking. Managers use durable [Goal mail](manager.md#a-manager-on-codex). A peer's request is information,
  never authority.
  Every manager follows the [shared problem-solving duty](manager.md#shared-problem-solving-duty):
  research and repair encountered problems, notify all active managers at discovery
  and verified resolution, and coordinate affected owners without an upward
  approval chain. Notification does not authorize overwriting a peer's work.
  Cross-Goal contracts can use `needs: [path, ...]` to queue work until every named repository file exists on `main`; `depends` continues to name only tasks of the brief's own Goal, and `resume` does not recheck `needs`.
- Supermanager. Owns the scope registry, the [method](method.md) and this tool,
  schedules heavy QA and the shared stack, watches the allowances and restarts
  managers that die. It runs no product work. It runs `task goal -- regress` on one pinned commit each
  night for unit, owner, model, integration and fault/recovery coverage, with one
  browser journey for each vertical, resumes recorded batches after an
  interruption and uses at most eight probes for each failing file to find the
  merge that introduced it. Results go to `goalctl inbox`; `status` shows
  unacknowledged counts. Unavailable builds and unrecorded commits leave an
  explicit suspect range, never a guessed task.
  Final qualification uses six confirmation lanes (`task goal -- confirm --lanes 6`)
  unless a new measured run justifies changing that host setting.
- Own checks stay targeted. Because `main` has that full regression, a
  manager verifies its waves with the checks its changes affect (static
  checks, `test --affected <wave base>`, the browser journeys of changed flows)
  and does not run whole tiers for its own Goal. Otherwise continuous merging
  would not reduce how often anything runs. A Goal's completion is judged on
  its areas and those checks. A failure that another Goal's merge caused goes
  to that Goal's manager and does not hold the first Goal open.

## Shared worktrees and unified checks

Related tasks can name one
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

Use the [worker execution skill](../../.agents/skills/goal-worker/SKILL.md) for
targeted tests and recorded jobs, and the [wave skill](../../.agents/skills/goal-wave/SKILL.md)
for prove campaigns. [QA admission](../../scripts/goal/admission.ts),
[slots and lifecycle locks](../../scripts/goal/qa-slots.ts),
[regression](../../scripts/goal/regress.ts) and [gate lanes](../../scripts/goal/merge.ts)
carry the current limits and scheduling. Do not add `--heavy` to a worker's own
file selection. Keep source pinned for the whole run.

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

[Launch admission](../../scripts/goal/launch.ts), [usage policy](../../scripts/goal/usage.ts)
and [Task defaults](../../Taskfile.yml) define executable capacity gates. The [charter](manager.md#settings-layers) owns the portable/local settings
boundary and account configuration; keep operational observations untracked.
A stale readout is unknown, not spare capacity. Back off on rate-limit errors.

Dispatch the critical path first. Keep briefs small and reuse the worker for a
coherent next slice when that saves context. Measure useful width by proved
outcomes and merge throughput.

## Environment ownership

The manager owns the environment and repairs whatever blocks the Goal: Docker
and host failures, toolchain gaps, local infrastructure, fixtures and providers
that can be served locally. It uses the credentials in `.temp/vault/` when
needed, only for local host administration, and never copies them into briefs,
commits, logs or prompts to other tools.

Use the current Docker and runtime setup in the [toolchain](../development/toolchain.md).
Discard QA results produced while the engine was unavailable. Keep data when
restarting it; a factory reset deletes named volumes. Run bulk volume copies
alone, and reduce QA shards while workers hold stacks. Address-pool configuration
must leave enough subnets for isolated stacks.

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
  Goal's `state.md` and `git log -20`, check coordinator enrollment (or re-arm
  waits when no coordinator runs), run
  `goal start` again if the session name changed, then continue the recorded
  next action.

## Convergence

A finished Goal leaves nothing in the tree but what it built and the decisions
it recorded in their owners. Task IDs are history: they belong in commit
messages, branches, the ledger and the local orphan branch `archive/goals`.
Converge at every step so archived task IDs do not become dangling references:

- Merge refuses a task that adds a file named `g-NNN…` or a task ID that
  a file did not carry before, outside `GOAL.md`, `docs/goals/` and
  `scripts/goal/`. Name files by the capability they cover, title tests by
  acceptance ID or behavior, and state a reason instead of citing the task.
  Existing names and mentions may stay or move; renaming them away is welcome.
  `--allow-ids` is for a reviewed exception. Tasks dispatched before
  2026-10-04 are exempt, as their briefs asked for task-named tests.
- Close moves each brief and its handoffs to
  `archive/goals:<goal>-<start date>/` and removes the brief from the tree in
  one commit, through git plumbing: the main checkout's HEAD never moves. A
  brief that tracked files still cite stays until the citation points at an
  owner document. `tidy` repairs a close that stopped part-way.
- Goal close runs once the manager has folded the Goal's lasting decisions
  into their owners and removed its row from the root `GOAL.md`. It refuses
  while a task is open, a brief remains, a tracked file names one of its tasks
  or links into its directory; `--dry-run` lists what is left. Then it archives
  the directory with the Goal's ledger entries and removes it from the tree.

Rename existing task-based files or restate citations when work touches them.

## Integration practices

Build a migration fixture with the old command, rather than a hand-written
approximation. Startup migrations must let Main listen. A model or migration
change needs the shared-stack refresh before its served behavior is accepted.
Never move a live worker worktree's HEAD.

Keep repository guards passing so a new omission can fail visibly. Verify the
unit part of the affected plan after backend merges and run heavy proofs in
bounded batches. Choose work by completed outcomes. Extract shared composition
hotspots and use the union merge driver only for append-only composition.

Use exclusive claims, isolated QA stacks and a verified stop operation. Add
coordination to fix an observed failure, measure its benefit, and remove it
when it no longer helps.
Prove a pilot end to end before extending new harness machinery to other rows.
