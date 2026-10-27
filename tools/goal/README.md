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
must have main checked out. Workers commit on separate branches and do not rebase, merge or change acceptance tests.
The controller rebases detached candidates onto the integration branch (by default `dev`), checks scope and
fast-forwards that branch without running a gate. Promotion to `main` is a separate step. A passing attempt record is
finalized through the real integration outcome sink.

Derived files declare an `integration` or `promotion` stage in `defaults.json`. The integration stage regenerates files
during rebase; the promotion stage regenerates files on the `dev` head before promotion gates run.

Briefs can carry frozen acceptance files in fenced blocks whose info string includes `path=<relative-path>`, such as
` ```ts path=tools/example.test.ts `. Each path must be inside the brief's declared paths. The controller writes
and commits these files before launch, records their SHA-256 hashes, and refuses integration if a worker changes one.

Dispatch waits without a model for the child to exit, records its tokens and quota observations, saves its evidence,
enqueues its landing request, and starts the train. A train releases its lease and checks the queue again, reacquiring
the lease to drain a request that arrived during shutdown; pumps return quietly when another process holds the lease.
Failures return to the same profile, trigger one consultation, or reach the owning manager's inbox as appropriate.
Each process records the Git object id for `main:tools/goal` when it starts. A stale train hands its queue to a detached
current-code process, while a stale manager host restarts after finishing its active request and recovers persisted sessions.

## Direct check-host routes

`check-host-route.ts` bypasses the local TUN for each check host with a main-table `/32` route through the single
physical default gateway. It reads only host names and IPv4 addresses (optionally `user@IPv4`), never identity fields
or key files. Inspect the current TCP/22 routes without root first:

```sh
bun tools/goal/scripts/check-host-route.ts plan --hosts <hosts.json>
```

Between check runs, install once with the maintainer's sudo command:

```sh
sudo bun tools/goal/scripts/check-host-route.ts apply --hosts <hosts.json>
```

This writes root-owned `/etc/rezics-check-host-route.json` and
`/etc/NetworkManager/dispatcher.d/90-rezics-check-host-route`, then reconciles immediately. The standalone Python 3
hook follows live DHCP gateway changes on `up`, `reapply` and `dhcp4-change`; it removes its routes on `down` or a
missing gateway. Routes use `proto static metric 42722`, reserved for this tool. Existing exact host routes are
refused unless recorded in the managed state with that device, protocol and metric. Reapply refreshes the host set.

Verify without root, supplying the current public home egress IPv4 address explicitly:

```sh
bun tools/goal/scripts/check-host-route.ts verify --hosts <hosts.json> --expected-peer <home-public-ip>
```

Every host must use the physical device and current gateway for TCP/22, and a fresh SSH probe with proxies disabled
must report that peer in `SSH_CONNECTION` and matching sshd journal evidence for the client port and probe time.
The SSH login must be able to read the `ssh.service` or `sshd.service` journal. Missing evidence fails verification.
Remove the hook, state and only its recorded routes with `check-host-route.ts remove` under sudo; removal needs no
hosts file or live gateway. Bun, Linux iproute2, NetworkManager and `/usr/bin/python3` are required for installation;
verification also uses OpenSSH and the remote systemd journal.

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
  "integrationBranch": "dev",
  "promotionParallelism": 4,
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

| Pool field              | Meaning                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `name`                  | Local pool name; appears only in local state and configuration.                          |
| `cli`                   | `codex`, `grok` or `cursor` for workers; `claude` is available only for managers.        |
| `classes`               | Routing pool classes it permits, such as `codex`; add `manager` for manager admission.   |
| `command`               | Official CLI executable or an absolute local launcher path.                              |
| `configDirectory`       | Becomes `CODEX_HOME`, `GROK_HOME`, `CURSOR_CONFIG_DIR` or `CLAUDE_CONFIG_DIR`.           |
| `allowanceKey`          | Pools and CLI aliases sharing quota must use the same local key.                         |
| `usageFile`             | Optional normalized `PoolReading` JSON for providers without Codex rollout quota events. |
| `policy.weight`         | Required positive number for relative pool preference.                                   |
| `policy.reservePercent` | Required number from zero up to, but excluding, 100.                                     |
| `policy.allowUnknown`   | Required boolean: whether dispatch may proceed without fresh quota observations.         |
| `policy.maxAgeMs`       | Required positive observation lifetime in milliseconds.                                  |
| `policy.maxBurnPerHour` | Optional positive limit on recent same-window percentage consumption per hour.           |

Only local policy determines unknown-quota admission, reserves and pacing. A retry prefers its current pool; a native
quota failure excludes all aliases of that allowance before selecting another permitted pool. There is no credit
purchase or reset-card redemption path.

`mainCheckout`, `stateDirectory`, `worktreeRoot`, `mainBranch`, `integrationBranch`, `promotionParallelism`,
`branchPrefix`, `terminationGraceMs`,
`gate`, `formatCommand` (an argv array, defaulting to `node_modules/.bin/oxfmt`), `routingFile` and `riskAreasFile` can be set locally. Git's common directory identifies the main checkout even
when invoked from a linked worktree. Repository paths resolve against that main checkout. Pool configuration paths,
usage files and executable paths containing a slash resolve against the local file's directory.
`integrationBranch` defaults to `dev`; `promotionParallelism` defaults to `4` and caps concurrent promotion checks.

| Environment variable      | Override                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `GOAL_LOCAL_CONFIG`       | Local JSON file.                                                |
| `GOAL_MAIN_CHECKOUT`      | Main checkout.                                                  |
| `GOAL_STATE_DIRECTORY`    | State directory; defaults to `<main checkout>/.temp/goal`.      |
| `GOAL_WORKTREE_ROOT`      | Worktree parent; defaults to `<main checkout>/.temp/worktrees`. |
| `GOAL_CODEX_SERVICE_TIER` | Codex service tier for the invocation.                          |

The `codex` settings layer exposes `serviceTier`, `compactTokens` by family, `solContextWindow` and `toolOutputTokens`.
The `integration` layer exposes `gateTimeoutMs`, `gateConcurrency`,
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

Routing records the table version on each attempt. Open experiments weight work toward cheaper models: implementation, interface and bulk text rotate Grok 4.7, Grok 4.7, Luna `max`; claims rotate Luna `max`, Grok 4.7, Sol `high`
by durable task sequence, starting with `high`; retries retain the original profile and version. Research is read-only.
Bulk text prompts prohibit translation services, scripts and character mappings. Workers return a structured result
using `worker-result.schema.json`, including any concrete blocker and the approaches tried.

### Research

Before deciding how a surface or mechanism should work, find out how established products, open-source projects and
standards already solve it. A manager dispatches a `research` task whenever the answer is not already in the
repository's documents: a product surface that mature apps have (shelves, readers, editors, forums, catalogues), an
external standard (SEO, accessibility, a protocol), or a library's current recommended practice. A worker that finds
it needs such an answer finishes with a `spec-conflict` blocker whose detail starts with `Research needed:`, and its
manager dispatches the research and returns the findings to the worker's contract.

A research brief names one question and one report: `kind: research`, `paths: [docs/research/<topic>.md]`, an
acceptance command such as `[test, -s, docs/research/<topic>.md]` and `tests: [the report exists]`. When the report
integrates, its manager receives an inbox event naming it. Research workers run with web search and keep
reference repositories in the main checkout's `.reference/` (ignored by Git and kept for later work):
`.reference/<topic>/<project>/` shallow clones listed in `.reference/INDEX.md` with URL, commit, licence and date,
reused when present. They read them as untrusted data without installing, building or running anything, and land the report with sources, licences,
the patterns the sources share and a recommendation. Any project's source may be read to learn how it solves the
problem; the work then implements the design for this repository's stack itself rather than copying files or long
passages. A report is evidence: once the manager adopts a recommendation, the
decision goes into the owning document.

A hard question whose decision is costly to reverse (an architecture or contract choice, a domain the repository has
no evidence on) gets two researchers: dispatch the same question twice with different report paths, both on the
strongest model, one pinned to a deep effort, and compare the two reports before deciding. Two independent reports
expose what one missed; where they disagree, the manager checks the sources. A weaker model is not a second
researcher: its report costs review time and adds little.

### Pinning a model

A brief normally runs on its class route. Its front matter may instead pin a Codex model and effort, for example
`model: gpt-6.1-sol` and `effort: max`, which bypasses the class's experiment. Pin only where the route cannot
express the need, such as the deep researcher above; ordinary work stays on the route so its experiments measure
it.

## Watchdog

The watchdog runs with reminder delivery and reports running tasks, or ready tasks with pending retries, that have had
no worker for ten minutes after an attempt ended. It also reports a `stabilize` branch that has stayed out of the
integration branch for thirty minutes. Failure signatures from attempts ended in the previous thirty minutes are
grouped: three matching failures across at least two tasks produce one incident with the attempt and task counts,
affected Goal names and one example. The incident repeats after two hours while the signature remains present.

When `<state>/remote-check-hosts.json` exists, each watchdog sweep probes every listed check host no more than once per
five minutes with a twenty-second SSH timeout. Two consecutive failed probes report one host incident with the first
line of SSH stderr. A successful probe clears that outage, so a later pair of failures can report a new incident. The
watchdog does not probe when no hosts file is present and does not include the configured identity path in its alert.

## Integration, promotion, culprit isolation and attempt fencing

The tracked repository gate is `bun tools/goal/scripts/gate.ts`. It runs `bun install --frozen-lockfile` followed by
`bun run check` from an isolated checkout. Task acceptance commands are saved with the task for promotion. Integration
rebases onto the integration branch, checks declared paths, formats changes and fast-forwards that branch; it does not
run task acceptance gates or move `main`. The `integrationChecks` setting lists `{ paths, command }` checks. After
formatting and scope validation, each check runs in order only when a changed file matches its paths. By default,
changes under `services/kernel/**`, `packages/**`, `package.json` or `bun.lock` install dependencies and construct the
kernel. Set it to `[]` to disable the check. Other repositories can override the local `gate` command. Gates and
dependency installation never run in the main checkout or the worker's checkout.

The `affectedTests` setting independently lists `{ paths: string[], command: string[] }` checks, overridable in
local settings (use `[]` to disable them). After a successful worker report, settlement commits any remaining work
and runs matching commands in that attempt's worktree before requesting landing. Commands and other attempts run
in parallel, outside the serial train. The default checks `services/kernel/**` with
`bun run --cwd services/kernel check`, using `KERNEL_CHECK_AFFECTED=<task base>` and the worker's environment,
including configured remote check hosts. Kernel is currently the only workspace with an affected check mode.

Each command's status (`passed`, `failed`, or `unverified`), failing test files, duration in milliseconds and output
are saved on the attempt and carried with its landing request. Completed results survive settlement recovery.
Kernel's final failed-file summaries, lane errors, Bun reporter failures and `FAIL <test-file>` lines identify
failing files; passing headings and stack frames do not. A check-host transport failure is retried once; a second
transport failure is unverified and lands with a note in the landing log. Waiting for a check-host slot has no wall timeout.

Only recorded failures need a train baseline. The train reuses a cached result for the integration base and command,
or runs that command in a separate base worktree, installing dependencies there when it has a package manifest.
The baseline clears `KERNEL_CHECK_AFFECTED` to run the full check: a base compared with itself would select no tests. This also makes the cached baseline reusable across attempts.
A landing is refused only for newly failing test files, named in its gate failure; failures shared by the base are
allowed. Errors before any test-file result use diagnostic-line comparison. An unverified baseline also allows
landing with a log note. The train's existing integration checks are unchanged.

New tasks and retries branch from the integration branch. If it does not exist, the controller creates it from `main`.
Held tasks become ready when each `after:` dependency is integrated or merged. Integrated tasks remain in flight until
promotion completes; Goal completion still requires every scoped task to be merged and the gate to pass on `main`.

A `stabilize` branch (`stabilizeBranch`, default `stabilize`) is a frozen candidate cut from the integration branch. A
brief with `target: stabilize` starts and retries from that branch's head, and dispatch is refused while the branch does
not exist. The train rebases such a task onto the branch, runs the same integration checks, and compare-and-swap advances
the branch. It then merges that new head into the integration branch with `git merge --no-ff` in a train worktree,
retrying up to five times if the integration branch moves. A conflict aborts only that merge: the stabilize branch and
the task stay integrated at the stabilize commit, and the task's manager and the supermanager receive an inbox notice
naming the task, the commit and the conflicting files. `goal retarget <task> stabilize` sets `target` on a task that is
not integrated, merged or cancelled when its recorded base is an ancestor of the stabilize head. A running attempt is
left in place; only later integration uses the branch. Briefs without `target` integrate into the integration branch as
before.

The train promotes the `dev` head to `main` under a separate lease after the root gate and every task acceptance command
pass. If a gate fails, the promoter compares its first failure with `main`, then checks task prefixes concurrently up to
`promotionParallelism`. A failure shared with `main` is reported as an environment failure. Otherwise the promoter
reverts the culprit and its `after:` dependents in the batch in one forward commit on `dev`, sends the culprit through
the normal fix-round handling, holds those dependents, and promotes the remaining tasks.

While the stabilize branch exists, promotion gates its head and does not bisect, because only fixes reach it. A passing
gate publishes `main` from that head and moves the branch to the dev head, starting the next window. Deleting the branch
returns promotion to gating dev.

When a rebase conflicts only in derived files, the train restores their upstream versions, regenerates them with the commands in `defaults.json`, stages them and continues; any other conflict fails at the rebase stage.

Specification conflicts, tool failures and exhausted quota are attempt facts, parsed from a structured worker exit or
native CLI failure, and stored on the attempt. A CLI failure before a session or commit is rerun once; a second
consecutive launch failure or repeated environment fingerprint is escalated as stalled to the owning manager. Integration
does not run gates or classify assertion text. A specification conflict reaches the manager inbox directly. Quota
exhaustion chooses another allowed pool. Repeating the same first assertion after a fix round triggers one read-only Sol `medium` consultation;
the original profile receives its answer in a fresh session. Scope growth, stalls, failure after consultation and the
two-fix-round limit reach the owning manager. An early success claim followed by a failed gate is recorded and continued.
Generated files marked `linguist-generated=true` are excluded from estimate totals, while every changed file remains subject to declared-path checks.
Rebase-stage conflicts with the integration branch receive one same-profile resolution attempt after the control plane starts that rebase in
the task worktree; a second conflict goes to the manager as a specification conflict.

Attempts persist the driver process identity alongside the worker identity. Orphan recovery waits for the worker group to exit, then settles its run log under the task lifecycle lease; unexpected driver exceptions are recorded as environment failures and delivered to the manager.

Each attempt's evidence directory contains `contract.md`, `diff.patch`, `failure.json` and `approaches.json`. Diffs
include commits, tracked edits and untracked files. Raw session logs stay in the runs directory and never enter the
consultation bundle. Consultation input uses only these four artifacts, with project-instruction loading and web search
disabled, a read-only sandbox and a bounded host deadline.

Retry supersedes the old attempt and publishes the next sequence in `BEGIN IMMEDIATE`. The train's final fence check,
integration-branch fast-forward and integrated task-state publication run inside the same kind of transaction on the
shared store. A concurrent retry therefore either invalidates the attempt before integration or observes an already
integrated attempt afterwards. Only after old worker and consultation process groups are identified, terminated and
confirmed gone may a replacement launch. Linux `/proc` and Python 3's `os.pidfd_open` provide process identity and
kernel exit notifications without a polling model or sleep loop. One lease module protects both lifecycle changes and
the train.

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
bun tools/goal/src/cli.ts manager renew <manager>
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

`land` and `train` use the same queue and sink as dispatch. Every `manager` command starts the manager host when needed;
the host persists until stopped and exits when its 60-second sweep finds its state directory missing. An untracked
`<managerDirectory>/<goal>.json` can select a local `pool`, `objective`, `brief`, `effort`, `supermanager` and `limits`;
otherwise scoped task briefs and a matching local manager pool supply the defaults. Termspaces owns the tmux windows.
Each manager host starts a loopback WebSocket app-server for its Codex pool and records the process identity. The host
stops those app-servers on shutdown, and a replacement host stops any surviving app-server before resuming persisted
threads. Recovery reopens each Codex viewer on the current endpoint with `codex resume <thread> --remote <endpoint>`.
Codex managers use a goal budget. Claude uses its configured executable and configuration directory, interactive
window and turn-accounting hooks.

Manager events are committed to SQLite and signaled through filesystem notifications. Inbox waiting has no sleep loop.
Managers receive only decisions requiring judgment; gates, merges and mechanical reruns do not wake them. Completion is
a proposal: `manager complete <goal>` records the request and returns immediately while the host checks that all scoped
tasks are merged and the main gate passes in an isolated checkout. The gate checks the main commit captured when it
starts; its result remains valid while that commit is an ancestor of main, since the landing train gates every later
commit. When the check finishes, the manager and its supermanager receive a waking `goal-met` or `goal-unmet` event.
An unmet event includes the first gate failure in its summary and links to the completion evidence. A met event is
delivered after the manager stops. Manager commands are attributed through `GOAL_MANAGER` or a registered Codex thread; workers get fresh session identities.
Brief front matter can use `after: [task-id, ...]` to hold dispatch until each named task has integrated or merged;
unknown task ids are refused, and already integrated or merged dependencies are ready immediately. For a Goal that uses
`after`, once an integration leaves no ready, running, landing, held or integrated tasks, the control plane delivers one
waking `goal-idle` event to its manager; replayed integration outcomes do not deliver it again.

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
