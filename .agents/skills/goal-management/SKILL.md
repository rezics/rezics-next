---
name: goal-management
description: Start or enroll a REZICS Goal manager, handle its event turns, checkpoint it, and close it. Use for manager lifecycle work, not ordinary product implementation.
---

# Goal management

The [manager charter](../../../docs/goals/manager.md) owns authority and policy.
Use the [Goal program](../../../docs/goals/README.md) for shared-host ownership
and the [method](../../../docs/goals/method.md) for acceptance. Load only the
procedure below needed for the current event. For account configuration or
capacity defaults, read [settings](references/settings.md).

## How to run the Goal

1. Start. Confirm the registered manager with `goalctl status`; check
   `git log` and `git status` for maintainer edits. Read
   the Goal's `GOAL.md` and `state.md`, the [method](../../../docs/goals/method.md), this charter
   and the [program](../../../docs/goals/README.md). Load other documents only as a task needs them.
2. Take rows, not tasks. Use `task goal -- planning` and the ledger to choose
   ready work. Work is a row of the scope registry. For each row:
   an outcome task, then an implementation task, then (in the web Goal) a
   surface task. Read the outcome matrix yourself before any implementation is
   dispatched.
3. Brief the outcome. A brief names the row, its tests, the files likely to
   change and what not to build. It never names a mechanism to build; a shared
   mechanism starts from a design note the owning manager and supermanager have
   read before implementation. Use the operation index (`task operation -- <query>`)
   and `task goal -- persona` for API questions; inspect source when those
   observations leave a decision unresolved.

   Record settled answers in the brief. After many decisions, restate the whole
   current instruction in the next decision and supersede the rest. Never edit
   a brief while its landing lock exists. Before resuming a worker, commit the
   brief decision, rebase its branch onto main and reinstall dependencies if the
   lockfile changed; workers do not rebase.
4. Let the tool decide landings. A task lands on its gates, and on one
   review pass where the method asks for one. At the attempt cap the task stops
   and you choose, in the brief: cut the row's scope, split, or write a design
   note. Do not grant an exception in a mail. A wave build task
   (docs/goals/wave.md) is never landed on its own: accept its `RESULT: done`
   once its commits are on `wave/<n>`, and it reaches `main` with the wave.
   Leave it exited: program closes the wave's tasks as verified after the wave
   merges. Verify a landing-tool repair with an actual landing, not ledger state
   alone.
5. Keep a later list. A finding no row's persona meets goes to `later.md`
   in the Goal's directory, in one line. Promotion into scope is the
   supermanager's.
6. Checkpoint. Keep `state.md` short and current: rows proved, rows in
   work, the measures, the next action. After compaction or a restart, rebuild
   from `goalctl status`, `state.md` and `git log`. Commit only your own paths
   (`task goal -- commit -m <message> -- <paths...>`), and never amend or rebase a commit on `main`:
   the train gates cumulative trees before advancing it. A correction is a new commit. Name a brief in `state.md` by its ID, without a link: the brief
   leaves the tree when its task closes.

   The commit command snapshots only the named paths, restores them in the main
   checkout while gating, and preserves peer staging. A failed snapshot remains
   at `refs/goal-manager/<manager-id>` with its error under
   `.temp/goal-orchestration/manager-commits/`; inspect it before
   `task goal -- commit --retry <manager-id>`. Retry gates the same snapshot;
   a content correction is a new commit.

   `task goal -- train` reports observed landings, discarded gate-seconds and
   p95 handoff-to-main seconds from `train-events.jsonl` in that directory.
   The journal timestamps gate components, admission waits and train positions.
   An empty observation window reports a null latency.
7. Close. When the outcome holds, fold what the Goal decided into its
   owners, remove its row from the root `GOAL.md` and run `goal close <goal>`
   ([convergence](../../../docs/goals/README.md#convergence)).

## Event turns

The [coordinator](../../../scripts/goal/coordinator.ts) owns events, concurrency,
deadlines and wakes. Decide the event, carry out its dispatch, queue, resume or
landing, then end the turn. Edit `state.md` only on checkpoint turns.
An exited task with ready work behind it gets an executable disposition within
five minutes.

## Efficiency audit

Follow the charter's [monitoring schedule](../../../docs/goals/manager.md#standing-directions).
Use explicit window bounds with `task goal -- efficiency --since … --until … --record`.
Give a read-only Sol researcher the figures, prior audit and three most expensive
task logs. It returns causes, evidence, proposed changes and a measure that would
falsify each improvement. Compare tokens per landed task of the same kind before
and after a change; caps bound bad scope but do not establish savings. Include
each turn's trigger, context and actions, even wakes that accomplish no work.

## Starting a manager

A Goal gets a manager once its directory exists, with `GOAL.md` and
`state.md`. From the repository root, start and register its headless manager:

```sh
task goal -- coordinator start <goal> --engine <engine> --effort <effort> [--model <id>]
```

The existing independent tmux server must run outside the coordinator service's
cgroup. The command uses its default socket; set `GOAL_COORDINATOR_TMUX_SOCKET`
when the server has a custom socket. It uses `goal start`'s registration and area
checks, sends the [start message](../../../scripts/goal/coordinator.ts), and enrolls
the new native session without an interactive owner. Repeating it refuses an
existing session or an unresolved turn; when the native session is gone, it
starts a replacement. `enroll` below remains the handover command. Program runs
in the maintainer's own terminal, using [supermanager startup](#starting-the-supermanager).

### Starting the supermanager

The maintainer starts the supermanager in termspaces, window `super-manager`
of session `rezics-agents` (`termspaces attach rezics-agents`). Choose an active
Goal with `GOAL.md` and `state.md`; a closed Goal needs a new slug.

```sh
GOAL_ID=<goal> claude --model <model> --effort xhigh --autocompact 300000 --dangerously-skip-permissions
```

Send: `You are the REZICS supermanager. Read docs/goals/manager.md,
docs/goals/README.md, docs/goals/method.md and
.agents/skills/goal-management/SKILL.md, then the active Goal's GOAL.md and
state.md. Register with task goal -- goal start <goal> --manager supermanager,
and run the Goal from its next ready work.`

### A manager on Codex

A manager can run on GPT-6.1 Sol.
Choose a configured Codex engine with `--effort high` in
the start command. The coordinator replaces the foreground `next-event.sh`
loop: end the turn when its event is decided and arm no watcher. The
coordinator launches a fresh native event turn from retained state.

Managers message each other through durable Goal mail:
`task goal -- mail send <goal> --file <path> --key <unique-key> [--deadline <minutes>]`.
Sending requires the caller's `GOAL_ID`, recorded as the sender. The same key
never sends twice or extends its deadline. Read what still waits with `task goal -- mail inbox <goal>` (`--all` adds the acknowledged history) and acknowledge
each message after acting on it with `task goal -- mail ack <id>`. The old
`messages/<goal>.md` files are read-only history and still appear in the inbox
view. Keep the same reserve as any manager: if its account nears its limit,
move workers to the other account first.

The resident supermanager receives mail at the reserved `program` address,
which needs no product Goal registration. Program reads and acknowledges it
with `GOAL_ID=program task goal -- mail inbox program` and
`GOAL_ID=program task goal -- mail ack <id>`; replies use the same sender context.

Inbox entries and wake prompts show the sender and deadline. Mail has no
deadline unless one was supplied. Once an unacknowledged delivery is past its
deadline, the coordinator adds one deadline wake and sends the original sender
one automatic notice, attributed to the recipient. The notice has no deadline.
`task goal -- coordinator status` lists overdue deliveries; acknowledgements
remove them from that list. Historical mail keeps unknown sender and deadline
fields rather than inventing them.

### Handing a Codex manager to the coordinator

The coordinator can hold one enrolled manager per Goal, on a configured Codex account.
Hand over explicitly while the interactive owner is still running:

1. Checkpoint the Goal's state and commit coherent progress.
2. Mail Program the exact native session UUID and the interactive Codex process
   PID, along with the Goal, engine, effort, working directory and tmux socket.
3. Program enrolls it with
   `task goal -- coordinator enroll <goal> --session <UUID> --engine <engine> --effort <effort> --cwd <directory> --previous-owner-pid <pid> --tmux-socket <socket>`.
   The descriptor retains that engine's configured account home; status reports
   the wait for the named previous owner to exit.
4. After Program confirms enrollment, exit the interactive session. The
   coordinator starts finite turns for queued mail and task exits; end each
   turn once nothing is ready.

A Claude manager uses the same handover. Program enrolls it with
`task goal -- coordinator enroll <goal> --session <UUID> --engine claude --model <id> --effort <effort> --cwd <directory> --previous-owner-pid <pid> --tmux-socket <socket>`.
The descriptor records `~/.claude` and that model. Each event is a fresh headless Claude turn in the manager's directory. A live process whose
argv resumes the session, or a claude process whose shells still carry
`CLAUDE_CODE_SESSION_ID` for it, delays the wake. A worker that inherited
those variables (`GOAL_TASK_ID`) is not that owner. The Claude usage gate
defers the wake while the level is restricted, as it does for dispatch.

Keep the tmux server outside the coordinator's service cgroup so a coordinator
restart leaves manager turns and their dispatched workers running. Program
serializes enrollment with the coordinator pump, pausing and restarting the
pump when necessary; existing descriptors and attempts stay in its durable
store.
