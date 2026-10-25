# goal

One Bun control plane owns worker dispatch, attempt records, the landing train and manager sessions. Every module uses
one local SQLite file, independent of the product database. `config.ts` composes the real worker fence, outcome sink,
landing queue, manager inbox, train and completion checker. Production commands need no runtime module or plugin.

```sh
bun install --cwd tools/goal --frozen-lockfile
bun run --cwd tools/goal check
bun tools/goal/src/cli.ts dispatch .temp/goal/brief.md
bun tools/goal/src/cli.ts status
bun tools/goal/src/cli.ts attempts --json
```

Run dispatch from a checkout of this repository after configuring local pools and writing a brief. The main checkout
must have main checked out and be clean enough for Git to fast-forward. Workers commit on separate branches and do not
rebase, merge or change acceptance tests. The controller rebases detached candidates, checks scope, runs gates on the
merged result, then fast-forwards main. A passing attempt record is finalized through the real gate outcome sink.

Dispatch waits without a model for the child to exit, records its tokens and quota observations, saves its evidence,
enqueues its landing request, and starts the train. A train releases its lease and checks the queue again, reacquiring
the lease to drain a request that arrived during shutdown; pumps return quietly when another process holds the lease.
Failures return to the same profile, trigger one consultation, or reach the owning manager's inbox as appropriate.
Each process records the Git object id for `main:tools/goal` when it starts. A stale train hands its queue to a detached
current-code process, while a stale manager host restarts after finishing its active request and recovers persisted sessions.

## Local settings

Tracked package defaults are in `defaults.json`. Routing profiles and experiments are in `routing.json`; path ownership
is in `risk-areas.json`. Account names, pool mapping, executable/configuration paths and admission policy belong only
in the untracked `<main checkout>/.temp/goal/local.json`. The loader refuses a tracked local file. There is no implicit
account or pool policy.

The following illustrates the local schema. Replace placeholders with local values and supply the required policy
fields listed below; the empty policy object deliberately provides no account policy.

```json
{
  "version": 1,
  "pools": [
    {
      "name": "<worker-pool>",
      "cli": "codex",
      "classes": ["codex"],
      "command": "codex",
      "configDirectory": "/absolute/path/to/<cli-config-directory>",
      "allowanceKey": "<shared-allowance>",
      "policy": {}
    }
  ]
}
```

| Pool field | Meaning |
| --- | --- |
| `name` | Local pool name; appears only in local state and configuration. |
| `cli` | `codex`, `grok` or `cursor` for workers; `claude` is available only for managers. |
| `classes` | Routing pool classes it permits, such as `codex`; add `manager` for manager admission. |
| `command` | Official CLI executable or an absolute local launcher path. |
| `configDirectory` | Becomes `CODEX_HOME`, `GROK_HOME`, `CURSOR_CONFIG_DIR` or `CLAUDE_CONFIG_DIR`. |
| `allowanceKey` | Pools and CLI aliases sharing quota must use the same local key. |
| `usageFile` | Optional normalized `PoolReading` JSON for providers without Codex rollout quota events. |
| `policy.weight` | Required positive number for relative pool preference. |
| `policy.reservePercent` | Required number from zero up to, but excluding, 100. |
| `policy.allowUnknown` | Required boolean: whether dispatch may proceed without fresh quota observations. |
| `policy.maxAgeMs` | Required positive observation lifetime in milliseconds. |
| `policy.maxBurnPerHour` | Optional positive limit on recent same-window percentage consumption per hour. |

Only local policy determines unknown-quota admission, reserves and pacing. A retry prefers its current pool; a native
quota failure excludes all aliases of that allowance before selecting another permitted pool. There is no credit
purchase or reset-card redemption path.

`mainCheckout`, `stateDirectory`, `worktreeRoot`, `mainBranch`, `branchPrefix`, `terminationGraceMs`,
`gate`, `routingFile` and `riskAreasFile` can be set locally. Git's common directory identifies the main checkout even
when invoked from a linked worktree. Repository paths resolve against that main checkout. Pool configuration paths,
usage files and executable paths containing a slash resolve against the local file's directory.

| Environment variable | Override |
| --- | --- |
| `GOAL_LOCAL_CONFIG` | Local JSON file. |
| `GOAL_MAIN_CHECKOUT` | Main checkout. |
| `GOAL_STATE_DIRECTORY` | State directory; defaults to `<main checkout>/.temp/goal`. |
| `GOAL_WORKTREE_ROOT` | Worktree parent; defaults to `<main checkout>/.temp/worktrees`. |
| `GOAL_CODEX_SERVICE_TIER` | Codex service tier for the invocation. |

The `codex` settings layer exposes `serviceTier`, `compactTokens` by family, `solContextWindow` and `toolOutputTokens`.
The `integration` layer exposes `gateTimeoutMs`, `gateConcurrency` (the first train remains sequential),
`managerDirectory`, `inboxDirectory`, `managerSocket`, `tmuxSocket`, `tmuxCommand`, `termspacesCommand`, `tmuxSession`,
`managerCompactTokens`, `supermanager` and `managerLimits` (`turns`, `turnsWithoutDecision`, `wallMs`). State, manager
configuration, inbox signals and leases stay outside tracked source files. Unix manager sockets must fit the platform's
socket-path length limit; use a short local override when needed.

## Briefs and routing

Write the brief in the state directory, for example `.temp/goal/brief.md`:

```markdown
---
goal: example
manager: example
kind: implementation
paths: [tools/goal/src/example.ts]
riskAreas: []
acceptance:
  command: [bun, test, tools/goal/src/example.test.ts]
  tests: [rejects invalid input]
  failing: true
estimate:
  lines: 100
  files: 2
criticalPath: false
waiting: []
---
Implement the behavior described by the failing acceptance test.
```

Use the actual declared files and machine acceptance tests for the task. `manager` defaults to `goal`. Additional
observable features are `inseparable`, `citesSources` and `hostileInput`. Kinds are `implementation`, `interface`,
`bulk-text`, `claim`, `specification`, `research` and `mechanical`. A specified implementation must declare failing
acceptance tests and fit within 400 lines and eight files. Mechanical work is refused by model dispatch. Risk paths,
source citations and hostile input take precedence over cheaper classes. Critical-path classification additionally
requires waiting tasks and `inseparable`.

Declared paths support literals, `*`, `?` and whole-segment `**`. Absolute paths, traversal and unsupported glob syntax
are refused. Risk ownership is checked by intersecting the path patterns, including broad claims such as `src/**`.
Every intersected risk area must be declared. Extend the ownership data when adding product modules.

Routing records the table version on each attempt. The open implementation experiment alternates Luna `high` and `max`
by durable task sequence, starting with `high`; retries retain the original profile and version. Research is read-only.
Bulk text prompts prohibit translation services, scripts and character mappings. Workers return a structured result
using `worker-result.schema.json`, including any concrete blocker and the approaches tried.

## Landing, gates and attempt fencing

The tracked repository gate is `bun tools/goal/scripts/gate.ts`. It runs `bun install --frozen-lockfile` followed by
`bun run check` from the clean train checkout's `tools/goal` directory. Task acceptance commands also run there, from
the repository root, after the repository gate passes. Other repositories can override the local `gate` command.
Neither gates nor dependency installation run in the main checkout or the worker's checkout.

The train invalidates a gate when main moves, rebases again, and reruns it. A failing gate is compared with main at the
same commit. Baseline results are cached durably by main commit and gate command, including the repository gate's
identity. A changed main commit or command gets a new baseline. Main-only failures, setup problems and timeouts rerun
the original profile without consuming a fix round.

When a rebase conflicts only in derived files, the train restores their upstream versions, regenerates them with the commands in `defaults.json`, stages them and continues; any other conflict fails at the rebase stage.

Specification conflicts, tool failures and exhausted quota are attempt facts, parsed from a structured worker exit or
native CLI failure, and stored on the attempt. A CLI failure before a session or commit is rerun once; a second
consecutive launch failure or repeated environment fingerprint is escalated as stalled to the owning manager. Gate
outcomes remain gate-only; assertion and fingerprint text have no special
classification markers. A specification conflict reaches the manager inbox directly. Quota exhaustion chooses another
allowed pool. Repeating the same first assertion after a fix round triggers one read-only Sol `medium` consultation;
the original profile receives its answer in a fresh session. Scope growth, stalls, failure after consultation and the
two-fix-round limit reach the owning manager. An early success claim followed by a failed gate is recorded and continued.
Generated files marked `linguist-generated=true` are excluded from estimate totals, while every changed file remains subject to declared-path checks.
Rebase-stage conflicts with main receive one same-profile resolution attempt after the control plane starts that rebase in
the task worktree; a second conflict goes to the manager as a specification conflict.

Attempts persist the driver process identity alongside the worker identity. Orphan recovery waits for the worker group to exit, then settles its run log under the task lifecycle lease; unexpected driver exceptions are recorded as environment failures and delivered to the manager.

Each attempt's evidence directory contains `contract.md`, `diff.patch`, `failure.json` and `approaches.json`. Diffs
include commits, tracked edits and untracked files. Raw session logs stay in the runs directory and never enter the
consultation bundle. Consultation input uses only these four artifacts, with project-instruction loading and web search
disabled, a read-only sandbox and a bounded host deadline.

Retry supersedes the old attempt and publishes the next sequence in `BEGIN IMMEDIATE`. The train's final fence check,
`git merge --ff-only` and merged task-state publication run inside the same kind of transaction on the shared store.
A concurrent retry therefore either invalidates the attempt before the merge check or observes an already merged
attempt afterwards. Only after old worker and consultation process groups are identified, terminated and confirmed
gone may a replacement launch. Linux `/proc` and Python 3's `os.pidfd_open` provide process identity and kernel exit
notifications without a polling model or sleep loop. One lease module protects both lifecycle changes and the train.

## Commands and managers

```sh
bun tools/goal/src/cli.ts status [task]
bun tools/goal/src/cli.ts retry <task> [--brief <file>]
bun tools/goal/src/cli.ts stop <task>
bun tools/goal/src/cli.ts cancel <task>
bun tools/goal/src/cli.ts consult <task>
bun tools/goal/src/cli.ts attempts --json
bun tools/goal/src/cli.ts report [--json]
bun tools/goal/src/cli.ts land <task>
bun tools/goal/src/cli.ts train
bun tools/goal/src/cli.ts manager start <goal> --engine codex --budget 20000
bun tools/goal/src/cli.ts manager stop <manager>
bun tools/goal/src/cli.ts manager complete <manager>
bun tools/goal/src/cli.ts inbox wait <manager>
bun tools/goal/src/cli.ts inbox read <manager>
bun tools/goal/src/cli.ts inbox ack <manager>
bun tools/goal/src/cli.ts inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>]
```

`retry <task> [--brief <file>]` retries a task, optionally replacing its brief after checking that its Goal and manager stay the same.
`cancel <task>` stops a running task, marks it cancelled, and removes it from its Goal's completion scope.

`inbox send` delivers a one-line decision event to another manager and records the sending manager as its source.

`land` and `train` use the same queue and sink as dispatch. The manager host starts automatically and persists until
stopped. An untracked `<managerDirectory>/<goal>.json` can select a local `pool`, `objective`, `brief`, `effort`,
`supermanager` and `limits`; otherwise scoped task briefs and a matching local manager pool supply the defaults.
Termspaces owns the tmux windows. Each manager host starts a loopback WebSocket app-server for its Codex pool, and
the interactive viewer attaches to that same server with `codex resume <thread> --remote <endpoint>`. The host owns
the server process and stops it when the host closes; a restarted host starts a new server and resumes persisted
threads with `thread/resume`. Codex managers use a goal budget. Claude uses its configured executable and
configuration directory, interactive window and turn-accounting hooks.

Manager events are committed to SQLite and signaled through filesystem notifications. Inbox waiting has no sleep loop.
Managers receive only decisions requiring judgment; gates, merges and mechanical reruns do not wake them. Completion is
a proposal: the controller checks all scoped tasks are merged and the main gate passes in an isolated checkout.
Manager commands are attributed through `GOAL_MANAGER` or a registered Codex thread; workers get fresh session identities.
Brief front matter can use `after: [task-id, ...]` to hold dispatch until each named task has merged; unknown task ids are
refused, and already merged dependencies are ready immediately. For a Goal that uses `after`, once a merge leaves no ready,
running, landing, or held tasks, the control plane delivers one waking `goal-idle` event to its manager; replayed merge
outcomes do not deliver it again.

A manual smoke test for an authenticated local Codex manager is available without embedding any account name:

```sh
CODEX_HOME="/absolute/path/to/<cli-config-directory>" bun tools/goal/scripts/smoke-codex-manager.ts
```

## Measurements and historical imports

Records contain task/class/profile/pool, routing version and experiment, timing, steps, critical-path flag, input,
cached and output tokens, before/after quota, outcome, first failure, escalation, consultation, fix round, diff size,
changed files, host gate time and the fixed classifier version. Step classes are decision, read, edit, wait, check and
commit. Cumulative snapshots are differenced; repeated or older totals add no tokens. A resumed log requires its
preceding token baseline, or a rollout containing the pre-window observation.

```sh
bun tools/goal/src/cli.ts import-attempt /absolute/path/to/<capture-directory>
```

A capture directory contains `events.jsonl`, `meta.start.json` and `meta.end.json`. The importer records its original
CLI, model, effort, pool, critical-path flag, timestamps, exit code and available quota observation without starting a
model, creating a source worktree or requiring a current account mapping. Imported tasks are stopped for inspection;
missing contracts and unmeasured diff/gate data are explicit. Capture source names and account names remain local state.

For a standalone JSONL file, supply `--brief` or `--task`, `--start`, `--end`, `--pool`, `--model` and `--effort`.
Optional `--baseline` accepts `{"input":0,"cached":0,"output":0}` with the actual preceding totals; `--table-version`
and `--outcome` preserve known historical facts. Set `GOAL_STATE_DIRECTORY` to a scratch `.temp/` directory when
testing imports; the database is always `goal.sqlite` inside that state directory.
