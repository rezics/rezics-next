# Goal program

This page describes how Goals run worker processes: `goalctl`, briefs,
claims, integration, usage, several Goals at once and how a Goal leaves the
tree. It records practice that has worked, for managers to use and improve.
[GOAL.md](../../GOAL.md) lists the running Goals, each stated in its own
directory here; the [manager charter](manager.md) gives a manager's authority,
directions and resources, and workers follow the [worker protocol](worker.md).

How work is defined, proved and landed is the [method](method.md), designed on
2026-10-12. This page describes the tool as it is; the method supplies its
landing rules and attempt cap.

## Worker processes

Workers are separate headless CLI processes in bypass mode, not in-session
subagents. Each runs in its own worktree under `.temp/worktrees/` on a
`goal/<id>` branch. Every state change goes through `bun scripts/goal/goalctl.ts`,
run by a manager from the main checkout with `GOAL_ID` set to its Goal:

| Command | Effect |
| --- | --- |
| `task goal -- goal start <goal> --manager <session>` | Registers a Goal whose `GOAL.md` exists, refusing areas that overlap another running Goal's; after a manager restart it records the new session name. |
| `task goal -- coordinator start <goal> --engine <codex\|codex-1\|claude> --effort <effort> [--model <id>]` | Registers and enrolls a headless manager in the independent tmux server, with the charter's start message. Refuses a live native session or unresolved attempt; replaces a missing native session. `coordinator enroll` remains the interactive handover command. |
| `task goal -- mail send <goal> --file <path> --key <key> [--deadline <minutes>]` / `mail inbox [goal]` / `mail ack <id>` | Sending records the caller's `GOAL_ID`; a retry preserves its sender and deadline. A delivery past its deadline gets one extra wake and one notice to its sender. `coordinator status` lists overdue deliveries. |
| `task goal -- new [--goal <goal>] <title>` | Reserves the next task ID for the Goal and writes the brief skeleton at `docs/goals/<goal>/tasks/G-NNN.md`, so two managers never take the same number. |
| `task goal -- dispatch docs/goals/<goal>/tasks/G-NNN.md [--dry-run] [--force-usage]` | Requires `kind` and `## Mechanisms`. Implementations must name at least one row, each with a complete outcome declaration and a pending persona; a mechanism needs a non-empty `## Design note` with `Read by program: YYYY-MM-DD`. Checks claims, dependencies and launch capacity before starting; `--dry-run` only checks. |
| `task goal -- wait G-NNN` | Run in the background. Blocks until the worker exits, then prints branch, cleanliness, scope check, token use and the handoff. A brief with `land: auto` also runs `land`, delivering a verified task or a stop reason; other briefs keep the handoff-only behaviour. |
| `task goal -- resume G-NNN -m <text> [--effort e] [--engine e] [--fresh] [--force-usage]` | Records a next step after a partial handoff whose work is merged or clean with no commits ahead of main; otherwise a fix. Only fixes count toward the cap. After two, a further fix requires a UTC-dated `## Decision` after the last start, naming a cut, split or design note. Transport/capacity retries consume no round; no flag bypasses the cap. Launch gates still apply. Before the worker starts, `resume` brings a clean worktree to `main` (a branch with no commit is fast-forwarded, one with commits is rebased, and a rebase that stops on a conflict is undone with the files named); a dirty or shared worktree is left alone, and one line of output says which. A resume after a `blocked` handoff that changed nothing is a step. |
| `task goal -- reclaim G-NNN <brief>` | Replaces an open, exited task's claims from an updated brief after the dispatch conflict checks. |
| `task goal -- stop G-NNN` | Terminates the worker's process group and its task-marked detached children. Preserves other live sharers and shared resources; after the last live worker stops, also sweeps worktree processes and removes its stack. Claims and worktree remain. |
| `task goal -- scope G-NNN` / `task goal -- owner <path>` | Lists commits ahead, dirty files and files outside the claim / which open task claims a path. |
| `task goal -- scope` | With no task: by vertical, the rows declared proved, the rows the last regression on a pinned commit confirmed and the rows it saw fail, with that run's commit and age; a row declared proved that the run saw fail is named first. |
| `task goal -- loan G-NNN <path>…` | Lends files that another open task claims to task `G-NNN`, so its `land` or `merge` may carry hunks in them (the review still reads them). Run by the manager of the Goal whose task holds the claim, or by the program; anyone else is refused. Use it when the holder agreed to a named hunk instead of waiting for the holder to land. |
| `task goal -- auto-land G-NNN [off]` | Gives a task that is already dispatched what `land: auto` gives a brief: when a `wait` on it sees the worker hand off `RESULT: done`, the task is reviewed, gated and closed without a manager turn. `off` takes it back. Something must keep a `wait` on the task for this to happen: a manager's own background `wait`, or a waiter loop over every running task (the shell waiter of 2026-10-12 is archived at `archive/goals:program-2026-10-06/study-2026-10-12/tools/`; the program's first tasks make it `goalctl` behaviour). |
| `task goal -- land G-NNN [--step]` | Requires an exited task, clean exclusive branch and `RESULT: done`; `--step` accepts `partial` and leaves the task open. Only `implementation` or `mechanism` changes to authority, disclosure, rights, erasure or Account get one review. A finding blocks only when its new public API test under `tests/qa/integration/review/` runs and fails on the branch; land commits that test as the fix target. Other findings go to `recorded.json`. Later landings run those committed tests and the existing gates and guards, then `close … verified`, without another reviewer. |
| `task goal -- merge G-NNN [--allow-scope] [--allow-ids] [--landed] [--skip-unit-gate] [--skip-type-gate]` | Requires all open sharers to have exited, a clean worktree, files within their combined claims and no new task names in the tree ([convergence](#convergence)); rebases onto `main` and normalizes composition roots. In each directory where added SQL migrations fall behind main’s head, renumbers the task’s added sequence above it in order, rewrites proven migration references in task-changed files and commits the normalization. Proven references outside those files or ambiguous SQL self-references refuse normalization for manual renumbering; unrelated numeric data does not. Before the type check, regeneration (`bun scripts/generate.ts`) runs on the rebased branch and commits any result; `gen:check` then verifies it. A generator or check failure blocks and names `task gen`. Paths under `generated/` are not claims: they do not conflict at dispatch and are not checked against claims at land or merge. Files written only by a regeneration commit are exempt from scope and claim checks at land, merge and refresh, whatever their path; a file the task's own commit also changed is still checked. After generated outputs are regenerated, the type check of every workspace whose TypeScript sources or configs the branch changed (the `<workspace>:typecheck` tasks, which wait for host memory) runs once on the normalized branch, within the same per-side budget (the main-side comparisons share one deadline); a diagnostic only the branch has (compared without line numbers) blocks, one already on `main` is reported, and an unfinished run, a failure with no diagnostics or an error line the parser cannot classify (diagnostics without a location are classified) is inconclusive and blocks. The unit gate then runs on the normalized branch outside the ledger lock. If `main` advances, rebase and fast-forward using that gate, rebasing once more if it moves again before the fast-forward lands; a conflict in that rebase stops with the conflict. Commits touching task-changed or gated files re-run both gates once; commits changing any TypeScript source or config of a type-checked workspace, without touching those files, re-run only that workspace’s type check once. Further overlap, moved task heads or changed sharers require a manager retry. Affected unit files, affected owner-tier files (run with `task test`, so their environment matches the owner tier) and the reasoned repository-wide inventory guards in `scripts/qa/repository-guards.ts` always run in `GOAL_UNIT_GATE_SHARDS` parallel calls (default 4) within `GOAL_UNIT_GATE_BUDGET_MS` per side (default 12 minutes). That budget starts once the gate holds one of `GOAL_GATE_LANES` host-wide lanes (default 2), so time waiting for a lane is outside the budget. A file whose longest declared `test`, `it` or `setDefaultTimeout` value plus 60 seconds exceeds that budget runs alone, with that longer budget; other shards keep the default. Shards run together, so the ceiling is the slowest shard. A declared timeout that cannot be parsed keeps the default budget and the file is logged. Owner files use the same budget, inherited-failure comparison, isolated timeout retry and never-started rerun as unit files. The owner command receives that shard budget (600s only when none is given); a timeout inside that command leaves the shard unfinished, so the running file is retried alone and files it never started are run again. The running file stays identifiable when the gate itself stops the command, because each file header is written as the file starts. A side that does not finish is inconclusive, not a refusal, but first the files of a shard cut by the budget that were not named as timed out are rerun once, in shards sized like a first run of that many files under one fresh budget, and their results count like first-run results; the timed-out file itself is retried alone, and only a file still unfinished after those reruns makes the side inconclusive (on `main` too). Branch failures are rerun together once; a file that then passes is order-dependent and reported, not blocking. A file that still fails only on the branch is rerun alone on the branch and, when that run still fails, alone on main. It is introduced when the alone branch run fails a case name the alone main run does not, or has a file-level error whose normalized first line the alone main run does not. A file that passes alone is order or load dependent, reported and not blocking. A pg_ctl start, embedded PostgreSQL, or port bind failure is retried once alone. The step is read from that error, not from the rest of the transcript. Repeated, it is inconclusive and not blocking. Fallout of that failed start, such as pool.end on a pool that never connected, is part of that report. Any other non-zero exit with no failing case and no file error refuses as a runner error with the output tail, including a crash on the branch alone and the same crash on main. The affected plan is the candidate’s own changes, `git diff <current main>...<candidate>`, plus the files recorded for that stream’s earlier merges (a record with no file list is recovered with `git diff --name-only` of its two commits); commits `main` landed in between are not selected. Files that fail again are rerun at the current main commit the merge targets, including after earlier merges of the same stream. A file is introduced when it has a failing case name the main run does not, or a file-level error whose normalized first line the main run does not; differing error text is evidence, not the key. Each case is attributed from bun's JUnit report for that file, not from the end-of-run text summary. A non-zero shard exit with no failing case and no file error is a runner error reported with the output tail. The classification checkout includes `.temp`. The gate resolves the main checkout, then refuses before any unit run when the task worktree or the baseline tree would put a PostgreSQL socket path over 107 bytes, naming that path and its byte length; the refusal is not inconclusive. Dispatch refuses a new worktree the same way. Inherited failures are reported, and the merge fast-forwards only if no file introduces a failure. Each classified run (first, isolated timeout retry, never-started rerun and confirm on the branch; first, isolated retry and never-started rerun on main) keeps every failing file's `(fail)` names and the first 40 lines of its error, together with a file-level error on that file, in the merge log and a sibling JSON file, caps that file's transcript at 20KB, names the running test on a timeout when the transcript or owner progress file shows it, and prints those case names or the file-level error in the refusal. The merge log also keeps the last 20,000 characters of the raw branch transcript. Fast-forwards and own-only commits briefly retry a held Git index lock without deleting it. `--skip-unit-gate` and `--skip-type-gate` print the explicit bypass reason. Model, integration and browser tiers remain outside this gate. Records every open sharer and a merge event with both commit boundaries and the files that merge changed; `--landed` records manually landed work. A repeated merge with nothing new succeeds. A conflict marks the named task `conflict`, stores the first line of the refusal, and `status` shows that line until the task leaves the state. |
| `task goal -- gate G-NNN [--skip-unit-gate] [--skip-type-gate]` | Runs the same rebase, composition normalization, migration renumber, regeneration, type check and unit gate as merge, then stops without fast-forwarding `main` or recording a merge. It does not change the task. A pass or a failure leaves the state and the refusal field as they were; a failure prints the result and exits non-zero. A running worker is refused before the worktree is touched (`<id> is still running; stop it first`). A checkout too deep for a PostgreSQL socket refuses before the unit run, with the path and its byte length. |
| `task goal -- close G-NNN... verified\|cancelled` | Removes the worktrees and releases the claims, then moves the briefs and handoffs to `archive/goals` and removes the briefs from the tree in one commit. |
| `task goal -- tidy [--legacy <dir>]` / `task goal -- goal close <goal> [--dry-run]` | Archives closed briefs still in the tree / ends a Goal once nothing of it remains ([convergence](#convergence)). |
| `task goal -- status` / `task goal -- usage` | Running Goals and their managers, live workers, unacknowledged regression counts, the heavy QA and shared lifecycle holders, gate-lane holders and their waiters, and the usage of every account. |
| `task goal -- settle` | One settling pass over every active Goal. An exited task whose handoff is `RESULT: done` is landed and closed when its brief has `land: auto` or its kind is outcome, surface or tooling; any other exited task gets its reason recorded, which `status` prints beside it. The coordinator's pump runs the pass each interval, and a `wait` does the same for its task. A landing refused for something the worker can repair goes back to that worker once, with the gate's failure; a second refusal is the manager's event. A landing stopped by the gate's own failure (a timeout or a crashed runner on a file the task did not change) leaves the task in `conflict`: `merge` it once more and `close` it. |
| `task goal -- check [--only types,lint,tests,guards]` | Run by a worker in its worktree: the types, the lint, the files its brief lists under `tests:` in one QA slot, and the guards, in one blocking call that prints only what failed. |
| `task goal -- windows [--remove]` / `task goal -- follow G-NNN` | `windows` runs one pass that keeps, in the termspaces session `Rezics Agents`, one window `goal-<goal>-<task>` for each live worker and one `goal-<goal>-turn-<n>` for each live manager turn, and removes the windows of those that ended; it touches no window with another name. The coordinator's pump runs it each interval. `--remove` removes every `goal-` window, for a `termspaces reset`. `follow` prints a worker's steps as its window shows them. A window is a view: closing it changes nothing for the worker. |
| `task goal -- coordinator turns [--goal <goal>] [--since <UTC time>]` | The manager turns the coordinator ran: the event, the start and end, how it ended, its tokens and the commands it ran. A manager enrolled with the coordinator is a role: each event (a settled task that is not closed, a mail) starts one fresh turn bounded at ten minutes (`GOAL_TURN_MINUTES`), up to six side by side (`GOAL_MANAGER_TURNS`). |
| `task goal -- efficiency [--since <UTC time>] [--until <UTC time>] [--record] [--last] [--json]` | The token measures of the worker sessions begun in the window, from the engines' session logs and the ledger: steps and input tokens by kind of step, by engine and by task. `--record` keeps the reading as an audit; `--last` prints the last one kept. |
| `task goal -- ask ...` / `tell --event <start\|pause\|stop\|fault\|allowance\|host> --goal <goal> [--task <id>] [--note <text>]` / `decide <D-n> <letter>` / `decisions [--all]` / `flush` | The notice board to the maintainer on Telegram ([charter](manager.md)): `ask` records a question under a decision code and sends it, `tell` sends a notice, `decide` records his answer given in the supermanager's terminal, `decisions` lists the open ones, and `flush` retries the outbox. A message carries a Goal, a task, a question and numbers, never code or a secret. |
| `task operation -- <query> [--json]` | Not a `goalctl` command: prints an API operation's route file, exposure, credentials and calling tests from the generated index, by `"<METHOD> /path"` or by words of its id. |
| `task goal -- persona '<persona> <METHOD> <path> [json]' ... [--private] [--full] [--record <file>]` | What the API answers a persona: the calls run in order in one set of persona sessions on a pooled stack, in one QA slot, and each prints its status, a few headers and the JSON answer. `{realm}`, `{space}` and `{zone}` are the fixture's, `{1.id}` a field of the first call's answer. A call that matches no operation is refused before a stack starts. `--record` writes the calls and answers for a story, with no secret, time or run id. About three minutes beside twenty workers. |
| `task goal -- test [--heavy] <task test args>` / `task goal -- slot [--heavy \| --recovery] -- <cmd>` | Checks take a shared QA slot or the [heavy QA lock](#integration-and-qa); `slot --recovery` takes only the shared lifecycle lock. A wide run (a whole tier, a browser run, `regress`) is the program's: a worker and another Goal's manager are refused on every way in, and the program's own wide runs go one at a time and wait while a worker is live (`--beside-workers` overrides, and is counted). `slot --holders` lists who holds each slot, by Goal and task; each Goal has a share of the ordinary slots. |
| `task goal -- regress [--at <rev>] [--resume <run-id>]` | Pins `main` (or the selected revision) in a detached worktree, checks committed generated artifacts and runs the harness manifest. Pinned checkouts default to verified disk storage under `~/.cache/rezics-r/<repo-key>/`; `GOAL_REGRESS_CHECKOUT_ROOT` selects another short disk path. Memory-backed checkout and report roots are refused, and child commands use a separate disk-backed `TMPDIR` in each checkout. Owner and fault/recovery batches contain at most 15 files; integration batches contain at most 5 files to fit the active-work deadline under concurrent load. They run concurrently up to `GOAL_QA_SLOTS` (default 3), with checkout-local state isolated per batch and harness memory admission; only browser journeys and Storybook take the heavy lock. The default selection excludes e2e and Storybook; a nightly full run uses `--only unit,owner,model,integration,fault/recovery,e2e,accounts:storybook`. `REZICS_QA_SHARDS` defaults to 1. Reports and checkpoints live under `.temp/goal-orchestration/regress/<run-id>/`; resume keeps the SHA and skips finished batches. `--only unit,model --integration-batches 2` runs a restricted check, which cannot certify a complete pass. `GOAL_REGRESS_STATE_DIR` keeps smoke-run reports in a writable worktree. Restricted selections are partial reports; the default certifies the selected nonbrowser tiers. |
| `task goal -- regress --timing <run-id>` | Reads a finished or running regression: wall, queue, test and stack start-up time by tier, the ten slowest batches and files, and the lanes it used. It starts nothing. A failure is classed `deadline` only when its own output shows a timeout, and a run takes as many lanes as there are QA slots when no worker is live. |
| `task goal -- inbox [--ack <n>]` | Lists the caller Goal's regression inbox (`GOAL_ID`, default `program`) and acknowledges the displayed line number. Verified merge boundaries route deterministic failures to their Goal; uncertain ownership, inherited, flaky and order-dependent failures go to `program`. Infrastructure results are void and re-queued. |

Engines are `claude`, `sonnet`, `haiku`, `fable`, `sol`, `codex`, `codex-1`, `luna`, `grok` and `cursor`
(`sol` is Sol on the Codex account with more of its week left when the task starts); the
[charter](manager.md#resources) lists their models and accounts; the
[`goalctl` launcher](../../scripts/goal/goalctl.ts) owns their executable commands.
A brief without `engine` runs on `claude` (`GOAL_ENGINE` changes the default).
To add an engine, extend `launchCommand` and its tests in `goalctl.ts`.

The lifecycle is dispatch, handoff, then landing or resume, and close. With the
coordinator's service running, its pump settles each exited task and no `wait`
is needed; without it, a background `wait` does the same for its task.
A command of the tool that needs no shared state is one file in
[`scripts/goal/commands/`](../../scripts/goal/commands/), named as the command. Worker processes are detached and survive
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
kind: surface                        # outcome | implementation | surface | mechanism | tooling
rows: [account/user-search]           # required for implementation; optional otherwise
engine: claude                        # claude | sonnet | haiku | sol | codex | codex-1 | luna | grok | cursor
effort: xhigh
cases: []                             # acceptance IDs such as IAM02, when the task has them
paths: [apps/accounts/**, packages/ui/src/data-table/**]   # name new files by capability, never g-NNN
tests: [apps/accounts/src/admin/user-search.test.ts]   # optional: the files `task goal -- check` runs in one QA slot
refs: [.temp/goal-api/refs/user-search-facts.md]        # optional: files `dispatch` copies to `.temp/ref/` in the worktree before the worker starts
operations: [searchAccountUsers]       # optional: operations whose index entry the first prompt carries
migrations: []                        # <directory>:<first>-<last>
shared: [route:accounts-admin]
depends: [G-099]
worktree: wave-9                      # optional: tasks naming one worktree share its tree and branch
land: auto                           # optional: wait lands a done handoff on an exclusive branch
---
```

The body states the outcome, what to read, the pattern to follow, the checks to
run and known risks. Duplicate work is prevented mechanically: only the manager
dispatches, merges and closes its Goal's tasks; case IDs, overlapping path
globs, migration ranges and shared slots are exclusive across all Goals, and
each Goal's areas are closed to the others; retries resume the same session; files
outside the claim block a merge unless the manager passes `--allow-scope` after
review; workers propose out-of-scope work instead of doing it.

Claims keep two tasks off the same files, but not off the same decision: two
tasks can build one concept twice in different files. So every brief has a
`## Mechanisms` section, and `dispatch` and `reclaim` refuse one without it. The
section has one line for each mechanism in `scripts/static/mechanisms.ts` that
the task touches, `<id>: consume | configure | extend | new — <why no owner
fits>`, or the single line `none`. A brief names the outcome and the owner
mechanism, not a representation. The repository guards that land and merge
always run refuse writes to an owned state from outside its owner.

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
- **Shared host.** Claims, QA slots, the heavy QA lock, the shared lifecycle lock, merge gate lanes, the live-worker limit,
  usage gates and host memory are one pool for all Goals. Writing code in
  parallel is cheap; heavy QA is not, and the lock keeps it to one run at a time.
  The shared backend (Account, Main, relay) runs the last refreshed revision from a pinned checkout; web, Accounts and Storybook hot-reload from the main checkout. A merge reaches the shared backend only through `task dev:refresh -- --wait`, which the merging manager runs in the main checkout (`-- --dry-run` previews it). Refresh and AppHost repair use their own shared lifecycle lock, independent of heavy QA and ordinary slots. A second waiting refresh joins the queued one. After admission, refresh freezes committed `main`, stages that revision and re-executes inspection and maintenance in a fresh process from the staged checkout. Merges need no hold while a refresh is queued or running; later merges are included by the next refresh. A refresh that fails before changing storage or the model keeps the previous revision serving; one that fails after leaves writers stopped and prints the step, error and retry command, because migrations and model alignment are forward-only. Ordinary heavy waiters rotate between Goals, keeping arrival order within each Goal. Restoring a down shared stack uses `task goal -- slot --recovery -- <command>` and takes no QA slot or heavy lock. Existing browser runs continue; queued lifecycle work starts before new heavy QA. Image builds and native dependency installation wait for host memory through `scripts/qa/host-admission.ts`.
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
- **Supermanager.** The [program](program/GOAL.md) Goal's manager owns the
  scope registry, the [method](method.md) and this tool, schedules heavy QA and
  the shared stack, watches the allowances and restarts managers that die. It
  runs no product work. It runs `task goal -- regress` on one pinned commit each
  night for unit, owner, model, integration and fault/recovery coverage, with one
  browser journey for each vertical, resumes recorded batches after an
  interruption and uses at most eight probes for each failing file to find the
  merge that introduced it. Results go to `goalctl inbox`; `status` shows
  unacknowledged counts. Unavailable builds and unrecorded commits leave an
  explicit suspect range, never a guessed task.
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
- Heavy runs take only the host-wide heavy lock and consume no ordinary slot.
  At most one heavy run starts; the three ordinary slots remain available to
  other QA runs, and memory admission controls when each stack can start. `--affected`
  and whole `--tier` runs are heavy by themselves; bounded nonbrowser `--tier ... --file ...` batches use ordinary slots. Selected e2e journeys retain the heavy lock. Pass `--heavy` to `test` or `slot`
  for wave batches, Storybook and browser suites. The lock belongs to the
  process and frees itself when it exits. `status` shows whether the heavy
  holder's command has started and lists runs waiting for a heavy turn, an
  ordinary slot or memory; each waiting run also prints its current wait.
- Merge, land and `gate` run their type check and unit gate only while holding one
  host-wide gate lane (`GOAL_GATE_LANES`, default 2). Ordinary QA slots are unchanged.
  The per-side budget starts when the lane is acquired, so waiting does not consume it.
  A waiting gate prints who holds the lanes, and `status` lists the holders and the
  waiters. The lane is the process-identity lease, so a killed gate's lane is free
  for the next gate.
- Shared refresh and `slot --recovery` serialize on the shared lifecycle lock. They run alongside admitted isolated QA and take no ordinary slot. Pending lifecycle work is served before a new heavy run; its memory-heavy steps use host admission. Recovery commands that invoke refresh inherit lifecycle ownership rather than deadlocking on a second lock.
- `task goal -- regress` uses at most two ordinary slots at once, leaving one
  available for Goals' own test runs.
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

- One cap for all Goals: 34 live workers (`task goal` default of
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
