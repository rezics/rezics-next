# Goal manager charter

A manager is an agent session that runs one Goal on the
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
that Goal's manager, and the maintainer settles what they cannot. The maintainer
does not see managers' sessions (maintainer, 2026-10-07). While a program Goal
runs, a manager sends what it would ask the maintainer to the program manager.
The program manager decides within this charter and passes on only what needs
the maintainer.

## Standing directions

The maintainer's directions in force on 2026-10-13, each with the day it was
given. They bind every manager until the maintainer changes them. Earlier
wording and directions that later ones replaced are in this file's history.

1. **Outcome** (2026-09-27). Make REZICS ready for its first public scope, by
   best practice. The maintainer wants the manager's judgment as a product
   owner: a reported defect is a symptom, so find its class and fix that.
2. **API first** (2026-10-12). "我们一直说面向 api." API operations define what
   the product does and the UI consumes them. A row of the scope is proved by
   what each kind of person gets from the API; with the API and the stories
   right, the web needs almost no verification of its own. The
   [method](method.md) is how every Goal works.
3. **Efficiency is tokens for each proved row** (2026-10-11, 2026-10-12). Not
   the price of a model and not the number of workers. The run of 2026-10-12
   was stopped as unacceptable: seven percent of worker output was first-attempt
   work. A manager reads the method's measures at every checkpoint. When
   repeated attempts dominate, the manager finds their common cause (a brief
   that left a decision open, a ruling awaited, a gate that refused on main's
   own state) and removes it. Dispatch does not stop for it (2026-10-13): a
   brief whose inputs are on main starts, because an idle account with work
   ready is the larger waste and holding first attempts can only lower the
   share that prompted it.
4. **Code over documents** (2026-09-30). Express in code (types, schemas, tests,
   lint rules, generators, stories, comments) whatever code can express. Keep
   documents for intent, decisions with their reasons and operating procedures.
   A rule a manager is meant to keep is a check in the tool, or it is not kept.
5. **Scope is narrowed, not polished** (2026-09-30, 2026-10-07). "所有需要打磨的，
   都可以暫時不開放，然後我們逐步完善，逐步開放." What is not ready stays closed
   behind a platform permission. The first public scope is the book library,
   recipes, VNDB-like and Bangumi-like catalogues and most Realm and Zone
   capabilities; third-party blocks stay closed.
6. **External conditions are a list** (2026-10-11). Hosts, names, providers,
   registrations and legal facts are the maintainer's
   [list](../operations/external-conditions.md). No Goal solves or waits for one.
7. **Architecture over API count; asymptotic scale** (2026-10-07). A slow engine
   is acceptable; a design whose cost for one operation grows with total data
   is not. A new vertical is configuration, not a second engine.
8. **Boundaries** (2026-09-27). Work locally and commit on `main`. Do not push,
   deploy, provision paid services or send repository data to other services
   unless the maintainer asks.
9. **Allowances** (2026-10-15). Account allowances and scheduling constraints
   are internal operational details and stay out of Git. They live in
   `.temp/goal-orchestration/accounts.md`; record changes there, not in briefs,
   documents, code or commit messages.
10. **Maintainer edits win** (2026-09-27). The maintainer may change any
    document at any time. Detect such changes, adapt, and never revert one
    silently ([documentation changes](README.md#maintainer-documentation-changes)).
11. **Managers are trusted; main's checks are not theirs** (2026-10-07,
    2026-10-13). "我们得信任 manager，然后不需要 manager 之间的互相监督，但是 main
    的定时回归检查，包括全量测试之类的则不应该信任 manager，就是要找毛病的." A
    manager decides inside its Goal and settles a cross-Goal matter with the
    other manager; no manager checks another. The scheduled run on `main` is the
    program's, trusts no manager and is there to find fault. Autonomy is not
    over the host: "manager 自治肯定是不能随便测试的，不然本机资源不是很够", so
    tests are admitted by the tool. The maintainer does not see managers'
    sessions: a scope promotion, what two managers cannot settle and what a
    manager would ask him go to the [program](program/GOAL.md)'s supermanager,
    who passes on only what needs him.
12. **Context length is the cost** (2026-10-13). "opus 用量到不是不够，主要是 token
    效率 … 就是上下文太长." A manager's state lives in the repository and the
    ledger, and a session is short and starts from them. Manager and researcher
    are identities; the resident supermanager is one and is not split. The [program](program/GOAL.md#how-managers-run-from-now-on) says how.
13. **Agents maintain termspaces** (2026-10-13). `goalctl` registers and removes
    every agent's window there. The maintainer starts only the supermanager in
    it.
14. **Reports are references** (2026-10-13). An analysis the maintainer passes on
    informs the manager. What is best practice is the manager's to work out and
    decide, and it is judged by measured efficiency.
15. **Decide; ask only what only he can decide** (2026-10-13). "我不一定盯着
    supermanager 的消息，我也可能不能及时回复，所以 supermanager 应当尽量自主决定，
    可以派发调研来辅助决定." The supermanager decides, and sends a researcher
    first where it lacks evidence. What only the maintainer can decide reaches
    him over Telegram, and other work continues meanwhile
    ([program](program/GOAL.md#asking-the-maintainer)).
16. **Efficiency is a continuous duty, never waited for** (2026-10-13,
    2026-10-16). "每 3h 启动一次，派发 6.1 sol 做 token 效率调研 … 通过实测和持续迭代来找出最优方案."
    And on 2026-10-16, after repeating it many times: "prioritize efficiency and
    proactively optimize it … The amount of useful work accomplished … as well
    as the token consumption caused by rework, are both major concerns." The
    supermanager monitors and optimizes efficiency all the time, without being
    asked and alongside everything else; it is never paused because work looks
    nearly done. Concretely:
    - **Measure.** The hourly monitor runs throughout. At least every three
      hours, measure the last full 12-hour window: useful work (tasks landed,
      rows proved, product and test lines) against tokens, attempts per landed
      task, and the tokens spent on rework by cause
      (`task goal -- efficiency --since … --until …`, and a read-only Sol
      analysis of turns and causes).
    - **Act.** Remove the largest cause the same day, by fixing the mechanism
      (tool, harness, protocol, brief), not by capping attempts (direction 3).
    - **Verify.** Judge each change by the same measures over the next full
      12-hour window, and record the before and after in the checkpoint.
    ([program](program/GOAL.md#the-efficiency-audit)).

## Resources

| Engine (`goalctl`) | Model | Account and readout | Used for |
| --- | --- | --- | --- |
| `claude`, `sonnet`, `haiku` | Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 | One Claude subscription shared by every manager; 5-hour and 7-day windows (`goalctl usage`) | Managers only (direction 9) |
| Configured Codex engines; `sol` selects an account | GPT-6.1 Sol | Local accounts in `.goalctl/settings.user.json`; `goalctl usage` | Outcome and implementation tasks that need judgment; the landing review |
| `luna` | GPT-6 Luna | Uses the first configured Codex account | Bounded mechanical work, at `max` |
| `grok` | Grok 4.7 | Grok Build CLI; no readout, a quota error shows exhaustion | Surface tasks and bounded work whose risk is not assertion integrity |
| `cursor` | Grok 4.7 | Cursor Agent, a separate quota; no readout | The same |

`fable` is not used: it shares Opus's session limit and does less.

### Settings layers

`.goalctl/settings.schema.json` defines version 1 of the settings format.
Every file declares `"version": 1`. Built-in defaults are overridden field by
field by tracked `.goalctl/settings.json`, then ignored
`.goalctl/settings.user.json`. Arrays replace the earlier array. Keep accounts,
machine paths, recipients and operational choices in the user file; the shared
file carries only portable project defaults. `task goal -- config` prints the
effective settings and each field's source. Invalid layers report their file
and field. Interactive commands use the current checkout's `.goalctl/`;
launched workers and coordinator turns inherit the originating settings directory.

`accounts` is a user-layer array. Each entry has a unique `engine` name,
`launcher` (an executable name or path) or `home` (a Codex home), numeric
`weight` greater than or equal to zero, and optional `pastAllowance`, an ordered
array of model IDs permitted after the allowance is exhausted. Its default is
empty; when exhausted, the first permitted model is used. A home without a
launcher uses `codex`. Supply a home for native session and usage readouts;
launcher-only accounts still appear with unavailable usage. Relative paths
resolve from `.goalctl/`; `~/` resolves from the user's home. Names cannot
shadow model selectors such as `sol` or `luna`.

For new `sol` work, selection maximizes weight times remaining allowance share
(weekly usage when available, otherwise current usage; unknown usage starts
with a full share). Ties retain configuration order, zero weights disable
automatic dispatch, and exhausted accounts require a nonempty `pastAllowance`.
A resumed attempt retains its recorded account. With no entries, the default
is the `codex` launcher. Removing the user file restores shared and built-in
defaults.

Other fields are `codexServiceTier` (`fast`, `default` or `flex`),
`reviewEngine` (a configured account, `sol` for selection, or `sonnet`),
`confirmIntervalMinutes` (zero disables scheduling), `gateLanes`, `qaSlots`,
`regressLaneCount`, `unitGateScope` (`affected` or `changed`),
`unitGateShards`, and `telegramChat`. Counts are positive integers. Existing
environment overrides continue to apply to individual commands.

The first settings load imports legacy one-value settings from
`.temp/goal-orchestration/` into missing user fields and reports each import.
Imported files gain a `.migrated` suffix so later loads cannot import them
again. The legacy names are `codex-service-tier`, `review-engine`,
`confirm-interval-minutes`, `gate-lane-count`, `qa-slot-count`,
`regress-lane-count`, `unit-gate-scope`, `unit-gate-shards`, and `telegram-chat`.
Ledger, run reports, mail, locks and last-start timestamps stay in `.temp/`.

What the logs of earlier Goals showed, to be revised with evidence:

- **Sol** over-designs. Its brief states the smallest change that satisfies the
  outcome and names what not to build. Never above `high`; fix the effort when
  the session starts.
- **Luna** at `max` gives complete handoffs on bounded work; on intricate
  parsing it needed its tests built from captured real output.
- **Grok** weakened assertions to make a failing test pass, three reviews in a
  row. It gets no task that could pass by loosening a check.
- **Every model** mocks more than a person would. An outcome test touches the
  real thing.
- A session's cost grows with the square of its length, because every call
  resends the context. A brief fits one session; a fix round starts a fresh
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

## How to run the Goal

1. **Start.** Confirm the registered manager with `goalctl status`; check
   `git log` and `git status` for maintainer edits. Read
   the Goal's `GOAL.md` and `state.md`, the [method](method.md), this charter
   and the [program](README.md). Load other documents only as a task needs them.
2. **Take rows, not tasks.** Work is a row of the scope registry. For each row:
   an outcome task, then an implementation task, then (in the web Goal) a
   surface task. Read the outcome matrix yourself before any implementation is
   dispatched.
3. **Brief the outcome.** A brief names the row, its tests, the files likely to
   change and what not to build. It never names a mechanism to build; a shared
   mechanism starts from a design note the supermanager has read.
4. **Let the tool decide landings.** A task lands on its gates, and on one
   review pass where the method asks for one. At the attempt cap the task stops
   and you choose, in the brief: cut the row's scope, split, or write a design
   note. Do not grant an exception in a mail. A wave build task
   (docs/goals/wave.md) is never landed on its own: accept its `RESULT: done`
   once its commits are on `wave/<n>`, and it reaches `main` with the wave.
   Leave it exited: program closes the wave's tasks as verified after the wave
   merges.
   (2026-10-14: managers ran `land` on wave tasks, and each run cost a
   settlement that the wave hold then refused.)
5. **Keep a later list.** A finding no row's persona meets goes to `later.md`
   in the Goal's directory, in one line. Promotion into scope is the
   supermanager's.
6. **Checkpoint.** Keep `state.md` short and current: rows proved, rows in
   work, the measures, the next action. After compaction or a restart, rebuild
   from `goalctl status`, `state.md` and `git log`. Commit only your own paths
   (`git commit --only <paths>`), and never amend or rebase a commit on `main`:
   landings rebase onto it at any moment, and on 2026-10-13 a commit amended
   seconds after it was made went into a task's branch. A correction is a new
   commit. Name a brief in `state.md` by its ID, without a link: the brief
   leaves the tree when its task closes.
7. **Close.** When the outcome holds, fold what the Goal decided into its
   owners, remove its row from the root `GOAL.md` and run `goal close <goal>`
   ([convergence](README.md#convergence)).

## Starting a manager

A Goal gets a manager once its directory exists, with `GOAL.md` and
`state.md`. From the repository root, start and register its headless manager:

```sh
task goal -- coordinator start <goal> --engine <engine> --effort <effort> [--model <id>]
```

The existing independent tmux server must run outside the coordinator service's
cgroup. The command uses its default socket; set `GOAL_COORDINATOR_TMUX_SOCKET`
when the server has a custom socket. It uses `goal start`'s registration and area
checks, sends the [start message](../../scripts/goal/coordinator.ts), and enrolls
the new native session without an interactive owner. Repeating it refuses an
existing session or an unresolved turn; when the native session is gone, it
starts a replacement. `enroll` below remains the handover command. Program runs
in the maintainer's own terminal.

### A manager on Codex

A manager can run on GPT-6.1 Sol when the maintainer chooses so (2026-10-07).
Choose a configured Codex engine with `--effort high` in
the start command. The coordinator replaces the foreground `next-event.sh`
loop: end each turn when nothing is ready, and arm no watcher. It resumes the
same native session when mail or a task exit arrives.

Managers message each other through durable Goal mail:
`task goal -- mail send <goal> --file <path> --key <unique-key> [--deadline <minutes>]`.
Sending requires the caller's `GOAL_ID`, recorded as the sender. The same key
never sends twice or extends its deadline. Read what still waits with `task goal -- mail inbox <goal>` (`--all` adds the acknowledged history) and acknowledge
each message after acting on it with `task goal -- mail ack <id>`. The old
`messages/<goal>.md` files are read-only history and still appear in the inbox
view. Keep the same reserve as any manager: if its account nears its limit,
move workers to the other account first.

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
The descriptor records `~/.claude` and that model. Each wake is one headless
`claude -p --resume` turn in the manager's directory. A live process whose
argv resumes the session, or a claude process whose shells still carry
`CLAUDE_CODE_SESSION_ID` for it, delays the wake. A worker that inherited
those variables (`GOAL_TASK_ID`) is not that owner. The Claude usage gate
defers the wake while the level is restricted, as it does for dispatch.

Keep the tmux server outside the coordinator's service cgroup so a coordinator
restart leaves manager turns and their dispatched workers running. Program
serializes enrollment with the coordinator pump, pausing and restarting the
pump when necessary; existing descriptors and attempts stay in its durable
store.
