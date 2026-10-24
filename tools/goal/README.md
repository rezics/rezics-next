# goal

The control plane for the rewrite's multi-agent work. Its SQLite store is independent of the product database.
The worker side owns configuration, tasks, attempts, routing, launch, usage, failure classification and evidence bundles.
The integration side owns the landing train, manager sessions, completion checks and manager inboxes. They meet through
`src/contracts.ts`; neither side reads the other's tables.

```sh
bun install
bun run check
```

## Integration commands

```sh
goal land <task>
goal train
goal manager start <goal> --engine codex --budget 20000
goal manager start <goal> --engine claude --budget 20000
goal manager stop <manager>
goal inbox wait <manager>
goal inbox read <manager>
goal inbox ack <manager> [event numbers...]
```

`land` queues the current worker-owned landing request. `train` drains requests in insertion order, under a directory
lease identified by Linux pid, start ticks and boot id. It rebases detached candidates in its own worktrees, checks the
declared path globs, runs the gate, and fast-forwards main in the main checkout. Moving main invalidates a gate result
and causes another rebase and gate run. The worker's checkout and branch remain untouched. Git refusal is a merge
failure. The main checkout must already have main checked out.

Gate outcomes include stage, normalized failure fingerprint, log path, changed paths, diff size and host time. A failing
gate also runs against the same main commit to distinguish an existing failure. Requests and outcomes are durable;
outcome delivery to the worker sink is at least once. The sink must tolerate duplicate outcomes and obsolete attempt
references. A sink error leaves the outcome pending and stops the train for retry.

Inbox delivery commits the event before writing its per-manager signal file. `wait` subscribes to filesystem events and
checks SQLite after subscribing, then returns the unread events as JSON. It has no sleep loop. Reading marks events
read; acknowledgement removes them from subsequent reads. Recorded-only outcomes never write a signal or wake a
manager. Failed wake delivery remains pending for host recovery or a later signal.

## Runtime composition

Set `GOAL_RUNTIME` to the absolute path of a local TypeScript module exporting:

```ts
export function createIntegrationRuntime(): IntegrationRuntime | Promise<IntegrationRuntime>;
```

Import `IntegrationRuntime` from `src/integration-cli.ts`. This factory supplies all paths and settings, the opened
SQLite connection, the worker-owned fence and outcome sink, a task-to-`LandingRequest` adapter, and a Goal-to-`ManagerSpec`
adapter. It also supplies manager services: termspaces window settings, the command prefix, and a completion checker.
There is no second configuration reader in the integration modules.

Use `TermspacesWindows` for the window adapter and `completionChecker` for completion validation. The latter takes a
Goal condition (scoped task names and gate argv) and a read adapter returning merged task names. It checks all declared
tasks and runs the main gate in an isolated worktree. Changed conditions or a moving main invalidate the proposal;
`goal-unmet` includes the check log. The worker adapter remains responsible for interpreting its own task state.

Keep state and train worktrees in configured local directories under `.temp/`. Give `managerSocket` a short Unix socket
path under `.temp/` that fits the platform's socket path limit. The runtime factory runs in each command and in the
manager host; return the same database and socket locations in all processes.

The manager command prefix must be usable from the manager's cwd. For example, include `env`, an absolute
`GOAL_RUNTIME=...` assignment, the Bun executable, and the absolute `src/cli.ts` path. Public commands call
`recordManagerCommand` to count a manager's control-plane activity; worker-side command modules should call that same
helper. It attributes commands using `GOAL_MANAGER`, or a registered Codex thread's `CODEX_THREAD_ID`. Worker launches
must use their own session identity.

`manager start` starts a detached host if necessary and returns the manager state as JSON. The host has a directory
lease, stores errors in `manager-host.log`, and handles filesystem signals and deadlines. It rejoins persisted Codex
threads on restart. A committed event can be delivered again if the host exits after steering and before recording the
wake; inbox acknowledgement is independent of wake delivery.

## Manager sessions

Codex pools use dedicated `CODEX_HOME` directories. Each pool uses one managed `codex app-server` daemon and a stdio
JSON-RPC proxy, so the tmux `codex resume` viewer joins the same server. Startup sends `thread/start` with cwd,
`gpt-6.1-sol`, effort and a 300,000-token compaction limit; then `thread/goal/set` with objective, active status and
`tokenBudget`; then `turn/start` with the opening brief. Notifications persist the active turn, goal status and usage.
Active turns receive `turn/steer` with `expectedTurnId`; idle threads receive `turn/start`. A raced steer rejoins the
thread before retrying. The opening brief instructs an idle manager to wait inside `clock.sleep`.

Claude windows run `claude --model claude-opus-5-5 --autocompact 300000` with the brief and turn-accounting hooks. The
brief instructs the manager to run `goal inbox wait` in the background when it has no decisions pending. The watcher
returns when an event is committed. Claude's budget is stored in its manager specification; the Codex token-budget RPC
applies to Codex sessions.

Both engines have configured limits on turns, turns without a control-plane command, and elapsed wall time. Exceeding a
limit pauses the manager and delivers a `round-limit` event to the supermanager. Explicit stop pauses the Codex goal,
interrupts its active turn, and unregisters the window. Claude stop unregisters its interactive window. A completion
proposal (`goal manager complete <manager>`, or a Codex goal completion notification) runs deterministic validation.
Only successful validation closes the manager; failed validation returns evidence through the inbox. Claude hooks use
`manager turn-start` and `manager turn-end`; these hooks do not count as decisions.

The integration path contains no model review, review rounds, mail, old coordinator, QA-slot scheduling, or legacy
product-specific gates. Gate argv and manager briefs are supplied by the caller.

## Protocol checks and live smoke

The protocol names and fields were checked against installed codex-cli 0.163.0:

```sh
# From the repository root:
codex app-server generate-ts --out .temp/protocol
codex queue --help
```

The fake stdio app-server tests record actual JSON-RPC requests. Temporary Git repositories exercise rebasing, moving
main, cumulative failures, scope, fencing, Git refusal and recovery. Separate-process tests exercise inbox waiting,
lease exclusion and the manager host.

The live smoke runs separately from `bun test`:

```sh
# From tools/goal:
CODEX_HOME="$HOME/.codex-1" bun scripts/smoke-codex-manager.ts
```

It starts a real stdio app-server, creates a tiny objective with a 20,000-token budget, starts and steers a turn, reads
the goal, then pauses, interrupts and clears it. The run on 2026-10-25 accepted the steer, read active status with the
20,000-token budget and zero tokens consumed at that instant, and confirmed that the cleared goal was null.
