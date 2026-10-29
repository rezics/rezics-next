# goal

One Bun control plane owns worker dispatch, attempt records, the landing train and manager sessions. Every module uses
one local SQLite file, independent of the product database. `config.ts` composes the real worker fence, outcome sink,
landing queue, manager inbox, train and completion checker. Production commands need no runtime module or plugin.

Each worker attempt runs its detached process tree in its own transient `rezics-workers.slice` scope under the user's
systemd manager. The slice uses CPUWeight 50 and IOWeight 50 so workers yield processor time and disk to checks,
managers and the control plane when the host is busy, without a hard quota on worker width. IOWeight affects only
devices whose scheduler honours weights, such as the BFQ-scheduled SATA member on host c. When a user systemd manager
is unavailable, workers start in the existing detached process group and the launch logs the fallback reason.

```sh
bun install --cwd tools/goal --frozen-lockfile
bun run --cwd tools/goal check
bun tools/goal/src/cli.ts dispatch .temp/goal/brief.md
bun tools/goal/src/cli.ts status
bun tools/goal/src/cli.ts attempts --json
```

Run dispatch from a checkout of this repository after configuring local pools and writing a brief. The main checkout
must have main checked out. Workers commit on their assigned branches and do not rebase, merge or change acceptance tests.
The controller rebases detached candidates onto the integration branch (by default `dev`), checks scope and
fast-forwards that branch without running a gate. Promotion to `main` is a separate step. A passing attempt record is
finalized through the real integration outcome sink.

Every landing also runs the sibling test for each changed source file that has one: `<name>.test.ts` beside the source,
or `tests/<name>.test.ts` at the workspace root when no same-directory test exists. The command prefix is configured by
`siblingTests.command` in `defaults.json` and receives the selected test paths. If a sibling test fails on the candidate,
the train reruns the failing test files on the landing base; a failure already present there is recorded as pre-existing.
Kernel changes continue to use the kernel affected-test command, which selects its own affected tests.

Every landing command runs in its own process group, including acceptance, integration, affected, sibling and derived
regeneration commands. The train kills the whole group when a command exits, times out, or the train stops, so a command
cannot leave background children running. Control-plane tests set affected checks explicitly; when omitted, train
fixtures use no affected or sibling checks and never inherit the repository's live check defaults.

Derived files declare an `integration` or `promotion` stage in `defaults.json`. Rebase conflicts regenerate declared
files from either stage, including on dev landings and retries. Promotion-stage files may declare `inputs`; a dev
landing that changes one of those inputs runs the declared generator against the rebased candidate and includes changed
outputs in its landing commit. Promotion runs promotion-stage generators on `dev-verified` before its final gates,
falling back to `dev` before the verifier initializes that ref.

Briefs can carry frozen acceptance files in fenced blocks whose info string includes `path=<relative-path>`, such as
` ```ts path=tools/example.test.ts `. Each path must be inside the brief's declared paths. The controller runs the
configured `formatCommand` on exactly these files before committing them and records their formatted SHA-256 hashes. If
the formatter rejects a file, the controller restores the brief's original bytes, commits those, and reports the
formatter output so the manager can repair the brief. The train checks hashes before formatting a landing and refuses
integration if a worker changes a frozen file.

Dispatch waits without a model for the child to exit, records its tokens and quota observations, saves its evidence,
enqueues its landing request, and starts the train. Requests targeting `main` use the `train-main.lease`; other
requests use `train.lease`. The two lanes select and order their own requests, so a long control-plane landing on
`main` can run alongside a dev landing. Each lane remains serial. A train releases its lease and checks its lane's
queue again, reacquiring the lease to drain a request that arrived during shutdown. Detached train processes wait for
the lane lease and recheck the control-plane version while they wait. Every process records the Git object id for
`main:tools/goal` when it starts; a stale train finishes its active landing, releases its lease and hands the remaining
queue to current code before it can take another request. Pumps used by short commands still return quietly when
another process holds the lane lease.
Failures return to the same profile, trigger one consultation, or reach the owning manager's inbox as appropriate.
A stale manager host restarts after finishing its active request and recovers persisted sessions. Restarts are limited to
one per ten minutes. Requests retry transient socket absence during handoff, and long recovery sweeps yield between
small batches so manager requests continue to be serviced. Watchdog and settlement scans read at most the last 256 KiB
of an attempt log, beginning at a complete line boundary; the recent commands and final failure events remain visible.

Workers start checks with `worker-check --run`, keep working while check slots are queued, and end their turn with a
`waiting` result containing the check ids when only checks remain. A waiting attempt keeps its worktree and session but
does not count toward the worker cap. The manager host watches the durable check results in that worktree and resumes
the same session when all checks finish, passing their exit statuses, failure summaries and log paths; a missing run or
failed check host also wakes the session with that fact. Waiting time remains part of the long-attempt limit. This
avoids the measured polling cost: in 342 attempts, 3,001 of 18,639 tool calls were waits, rereading about 230k tokens
each, or roughly 690M input tokens; waiting workers also held slots while only two or three of 44 workers did work.

## Shared module workspaces (opt in)

Isolated worktrees remain the default. Local settings can name modules as path globs:

```json
{
  "sharedWebModules": {
    "library": [
      "apps/web/src/library/**",
      "apps/web/src/stories/library-*.stories.tsx",
      "apps/web/tests/library*.test.ts"
    ]
  }
}
```

A task whose declared paths all fit one configured module uses that module's single worktree at
`<worktreeRoot>/modules/<module>`, on `ws/<module>`, created from `dev-verified` on first use (or `dev` before that
ref exists). Matching includes exact paths,
identical globs and subtrees under a configured `/**` root; unproved glob containment, mixed-module and unmatched
tasks keep isolated worktrees. Stabilize-target tasks also keep their existing isolated workflow. Module mappings
cannot overlap. Explicit brief dependencies still apply; overlapping paths introduce no dependencies, reservations,
worker cap or holds. Several workers run in the same module at once.

Peers edit the tree at the same time. Workers commit their own work often with `git add <your paths>` (never `-A`
or `.`), then a path-limited `git commit --only ... -- <your paths>` to leave a peer's staged files alone. The subject
is `<task name>: <message>`; task name is the original brief's file name without `.md`. Every worker commit carries
`Goal-Task: <task id>` as a Git trailer. Attribution uses Git's trailer parser, never subject text or the entire branch
diff. Workers never reset, checkout, stash, clean or rebase. A failure in files they did not touch is a peer's work in
progress: rerun later or check only their own tests. The controller never sweeps shared leftovers into a commit or
stops processes merely because their working directory is shared. Frozen acceptance inputs retain their usual
protection and controller commits; undeclared risk areas remain closed.

When a worker finishes, the train captures the workspace branch head and merges it with dev in the train's own
worktree. It runs the usual affected checks and task acceptance on that combined candidate before advancing dev
with its usual expected-head check. Source commits remain intact. Each task's trailer commits determine which
changes belong to it and whether all its commits are on dev; those tasks become integrated. A task with no trailer
commits cannot finish by claiming a peer's work. A failing landing returns to the tasks identified by the failing
acceptance or changed files. Main promotion retains its existing workflow.

The controller merges dev into the workspace only while no worker runs there, under the same short lease used for
launch. Pending launches also block that merge. Dirty work is preserved and defers the merge until a later idle
opportunity; no checkpoint, stash, reset or snapshot machinery is used. Landing can proceed while peers keep editing.
The shared worktree persists across completed tasks. Shared retries skip isolated cleanup and rebasing.

Acceptance: `bun test tools/goal/src/workspace.test.ts`. Before landing executable control-plane changes, run the
whole tools/goal suite and its typecheck. The [research report](../../docs/research/web-shared-workspace.md) retains
historical measurements and source evidence; this README owns the adopted protocol.

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

Only local policy determines unknown-quota admission, reserves and pacing. A retry prefers its current pool. When a
CLI reports a usage-limit refusal, Goal checks the pool's latest quota reading: a used-up window or a reading older
than `maxAgeMs` excludes that allowance. A fresh reading with allowance left retries the same pool after three
minutes; the attempt records the refusal and the primary and secondary windows it read. Three usage-limit refusals on
one pool within an hour temporarily exclude its allowance for one hour. Other native quota failures exclude all
aliases of that allowance immediately. There is no credit purchase or reset-card redemption path.

Control-plane processes reload only the `pools` entries from their startup local settings file whenever they choose a
pool. An unchanged file is not reparsed; the rest of the process settings retain their startup values. If the file
cannot be read or its pool entries are invalid, the process keeps its startup pool policies and sends one error event
to the supermanager inbox.

`mainCheckout`, `stateDirectory`, `worktreeRoot`, `mainBranch`, `integrationBranch`, `promotionParallelism`,
`branchPrefix`, `terminationGraceMs`, `silenceMs`,
`gate`, `formatCommand` (an argv array, defaulting to `node_modules/.bin/oxfmt`), `routingFile` and `riskAreasFile` can be set locally. Git's common directory identifies the main checkout even
when invoked from a linked worktree. Repository paths resolve against that main checkout. Pool configuration paths,
usage files and executable paths containing a slash resolve against the local file's directory.
`integrationBranch` defaults to `dev`; `integration.batchSize` defaults to `4` and limits how many queued dev landings
share one integration check. Set it to `1` to keep one-at-a-time integration. A passing batch checks the combined tree
once and fast-forwards dev through its members in queue order, recording each member's own integrated commit. If the
combined check fails, the train retries the members individually so a passing member can still land. A member that
cannot rebase onto earlier batch members stays queued for a later round while the rest continue.
Each member's acceptance command runs concurrently against the final batch candidate in its own detached worktree.
`integration.batchAcceptanceConcurrency` defaults to `8` and caps these acceptance commands. If any command fails,
times out, or changes its worktree, the train retries the members individually so the failure is attributed to its task.
`promotionParallelism` defaults to `4` and caps concurrent promotion checks.

### Delivery flow telemetry

`report --flow [--since <time>] [--json]` reads durable, timestamped per-task and per-attempt flow events. It reports
stage totals and p50/p90 durations, Goal totals and percentiles, working-time efficiency from dispatch through
integration, attempts per integrated task, and the length and oldest age of the start, check, landing, verification
and promotion queues. Missing lifecycle events stay unknown; reports do not backfill old tasks. Check-slot request,
acquisition and release events are distinct, so slot waiting is excluded from worker working time. The stage with the
most waiting is named as the bottleneck.

The manager host evaluates absolute flow targets each hour and sends one `environment` event to the configured
supermanager for each breached threshold: efficiency below 40%, any queue older than 60 minutes, landing p90 above
30 minutes, or more than 1.5 attempts per integrated task. `flow` in local settings can override `efficiencyBelow`,
`oldestQueueMs`, `landingP90Ms` and `attemptsPerIntegrated`; the defaults are `0.4`, `3600000`, `1800000` and `1.5`.
Alarm summaries name the stage, measurement and up to three oldest waiting task IDs. A threshold can alert again after
one hour.

Once per UTC day the manager host dispatches the research brief at
[`templates/daily-step-audit.md`](templates/daily-step-audit.md), unless a daily audit task is already open. It
reviews failure prevention, recorded catch counts, time and allowance cost for each step from dispatch through
promotion, includes the prior day's flow report, and recommends one measured structural change. Unknown telemetry is
reported as unknown rather than inferred.

### Host-capacity admission

Ordinary starts that wait for host capacity and checks that decide whether an ordinary start can begin count running
attempts through the `worker_attempts_state` expression index. Each poll issues one `COUNT(*)` query and does not
decode attempt bodies. The existing 15-second polling interval and ticket ordering are unchanged.

#### Cost: running-attempt count

- **Touches:** One SQLite statement and the state-index entries for running attempts; no attempt bodies are returned.
- **Bound:** One indexed count per capacity check, with work proportional to the number of running entries and no scan
  of non-running attempt history.
- **Growth check:** `capacity-wait.test.ts` seeds 10, 100 and 1,000 attempts, verifies the indexed query plan and
  checks the running count at each scale.

### Manager-host database reads

Host recovery, dependency release, cancellation reporting and watchdog sweeps use the task and attempt state indexes.
Settled dependency checks read state and commit/target scalars by task id; dispatch validation reads task ids only.
`WorkerStore` caches decoded task and attempt bodies for the current SQLite `data_version`, and its own task/attempt
writes invalidate that snapshot. Repeated store reads in a sweep or request reuse decoded rows.

The `host-db-reads.test.ts` live-sized fixture has 3,000 settled task bodies averaging 7.5 KB and 5,000 settled
attempt bodies averaging 8 KB, about 62.5 MB of settled JSON. Before active-row reads, a full sweep decoded all of
those bodies (about 62.5 MB, plus active rows); after the change it decodes only five active task and five active
attempt bodies (under 50 KB each in the fixture), about 77.5 KB total. Task-id and dependency-state request lookups,
including the inbox-send path, decode zero task bodies. Repeated reads add no decoded bytes until an external
connection changes `data_version` or this store writes a task or attempt.

| Environment variable      | Override                                                        |
| ------------------------- | --------------------------------------------------------------- |
| `GOAL_LOCAL_CONFIG`       | Local JSON file.                                                |
| `GOAL_MAIN_CHECKOUT`      | Main checkout.                                                  |
| `GOAL_STATE_DIRECTORY`    | State directory; defaults to `<main checkout>/.temp/goal`.      |
| `GOAL_WORKTREE_ROOT`      | Worktree parent; defaults to `<main checkout>/.temp/worktrees`. |
| `GOAL_CODEX_SERVICE_TIER` | Codex service tier for the invocation.                          |

The `codex` settings layer exposes `serviceTier`, `compactTokens` by family, `solContextWindow`, `toolOutputTokens` and
`backgroundTerminalMaxTimeoutMs`. Codex worker launches enable unified exec and pass this timeout as
`background_terminal_max_timeout`, the maximum empty `write_stdin` wait; its default is 7,200,000 ms, matching the
two-hour limit of the longest worker class. Workers run checks with `bun scripts/worker-check.ts -- <command...>`.
Goal writes the current priority to `.temp/goal/task-priority` in the task worktree at attempt start and whenever
`goal priority <task> critical|normal` changes it. Performance's `worker-check` reads this file and passes
`REMOTE_CHECK_PRIORITY=critical` for remaining checks when its contents are `critical`.
It writes command output to `.temp/goal/checks/`, records the check duration for the worker deadline and silence monitor,
then prints the exit status, a short failure summary when needed, and the log path. See the
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) for unified exec and
`background_terminal_max_timeout` behavior.
The `integration` layer exposes `gateTimeoutMs`, `gateConcurrency`,
`managerDirectory`, `inboxDirectory`, `managerSocket`, `tmuxSocket`, `tmuxCommand`, `termspacesCommand`, `tmuxSession`,
`batchSize`, `managerCompactTokens`, `supermanager` and `managerLimits` (`turns`, `turnsWithoutDecision`, `wallMs`). State, manager
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
acceptance tests and fit within 1,500 lines and 24 files: one complete user-visible slice, never padded. Mechanical work is refused by model dispatch. Risk paths,
source citations and hostile input take precedence over cheaper classes. Critical-path classification additionally
requires waiting tasks and `inseparable`.

Declared paths support literals, `*`, `?` and whole-segment `**`. Absolute paths, traversal and unsupported glob syntax
are refused. Risk ownership is checked by intersecting the path patterns, including broad claims such as `src/**`.
Every intersected risk area must be declared. Extend the ownership data when adding product modules. A `control-plane`
brief may declare only `tools/goal/` paths; dispatch refuses outside paths and asks that they be split into a dev task.

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
`model: gpt-6.1-sol` and `effort: xhigh`. The pin sets the model and effort for every attempt, including retries, and
bypasses the class experiment, fallbacks, pacing and three-failure model switch. Pool selection still chooses among
available pools that serve that Codex profile. If all such pools are exhausted or unavailable, the task waits in the
ready state rather than switching models. A reshaped brief's pin replaces the prior attempt's profile. Pin only where
the route cannot express the need, such as the deep researcher above; ordinary work stays on the route so its
experiments measure it.

## Watchdog

The watchdog runs with reminder delivery and reports running tasks, or ready tasks with a pending retry intent, that
have had no worker for ten minutes after an attempt ended and its recorded driver identity is no longer live. A reused
PID does not count as the same driver. A live driver may still be settling the attempt, including running affected tests
or waiting for a check-host slot. It also reports a `stabilize` branch that has stayed out of the integration branch for
thirty minutes. Failure signatures from attempts ended in the previous thirty minutes are grouped: three matching
failures across at least two tasks produce one incident with the attempt and task counts, affected Goal names and one
example. The incident repeats after two hours while the signature remains present.

A running attempt that exceeds its routed time limit (two hours by default) sends its owning manager one event. The
event includes elapsed time, commits in the task worktree, time recorded waiting for check slots and the last ten shell
commands in the run log. Check wait time is reported separately; it does not reduce this elapsed time. If those recent
commands repeatedly run `ps` or `pgrep` without a `scripts/worker-check.ts` invocation, the watchdog sends that manager
one additional polling event. Both alerts are deduplicated for the lifetime of that attempt.

When `<state>/remote-check-hosts.json` exists, each watchdog sweep probes every listed check host no more than once per
five minutes with a twenty-second SSH timeout. Two consecutive failed probes report one host incident with the first
line of SSH stderr. A successful probe clears that outage, so a later pair of failures can report a new incident. The
watchdog does not probe when no hosts file is present and does not include the configured identity path in its alert.

## Integration, promotion, culprit isolation and attempt fencing

The tracked repository gate is `bun tools/goal/scripts/gate.ts`. It runs `bun install --frozen-lockfile` followed by
`bun run check` from an isolated checkout. Task acceptance commands are saved with the task and run on the merged
candidate before either dev integration or promotion to `main`, using configured remote check hosts like other train
checks. A failed dev acceptance refuses that landing and records the command and first failure. The train runs the same
command on the dev base and marks an identical fingerprint as pre-existing. Batched landings run each entry's
acceptance against its cumulative candidate; a failed batch acceptance falls back to single landings so the failing
task is identified and other entries can proceed. Integration rebases onto
the integration branch, checks declared paths, formats changes and fast-forwards that branch without moving `main`.
Promotion gates on correctness only: the root gate and the promoted tasks' own acceptance. Capability completion
(`docs/goals/<goal>.capabilities.md`) is reported by the completion checker on `main` and never blocks a promotion,
so `main` receives finished work while other In rows are still open.
The `integrationChecks` setting lists `{ paths, command }` checks. After
formatting and scope validation, each check runs in order only when a changed file matches its paths. By default,
changes under `services/kernel/**`, `packages/**`, `package.json` or `bun.lock` install dependencies and construct the
kernel. Set it to `[]` to disable the check. Other repositories can override the local `gate` command. Gates and
dependency installation never run in the main checkout or the worker's checkout.

Task worktrees with the same dependency key share one read-only Bun install under the configured dependency-store root
(default `<worktree root>/../dependency-stores`). Each tree keeps its own small `node_modules` skeleton and workspace
links; only `.bun` points at the shared store. The key covers the Bun version, root and workspace manifests, `bun.lock`
and `bunfig.toml`. Store builds use `--backend=copyfile`; the `.bun` tree is made read-only before publication. Run
`bun tools/goal/src/cli.ts deps private` before changing a manifest or lockfile. A five-directory host-c comparison
created 69,426 `node_modules` entries per private install (median 4.956 s) versus 27 per shared worktree (median
0.016 s), after building one shared store.

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
transport failure is unverified and lands with a note in the landing log. Kernel's database-storage environment failure
(`SQLSTATE 53100`) is also unverified and carries no failing files. Waiting for a check-host slot has no wall timeout.

Only recorded failures need a train baseline. The train sends only failing files present in the integration base,
reuses a cached result for that base and command, or runs the command in a separate base worktree, installing
dependencies there when it has a package manifest. Failing files added by the branch are introduced failures by
definition; if none of the failing files exist in the base, no baseline runs. The baseline clears
`KERNEL_CHECK_AFFECTED` to run the full check: a base compared with itself would select no tests. This also makes the
cached baseline reusable across attempts. A landing is refused only for newly failing test files, named in its gate
failure; failures shared by the base are allowed. Errors before any test-file result use diagnostic-line comparison.
An unverified baseline also allows landing with a log note. The train's existing integration checks are unchanged.

A `control-plane` brief may declare only `tools/goal/` paths; dispatch refuses outside paths and tells the manager to
split them into a dev task. A control-plane task starts from `main`, the branch it integrates into, even when `dev` has
different `tools/goal/` content. This rule also applies if a brief or later retarget names `stabilize`. It rebases onto
current `main`, formats its changes,
then runs `bun run --cwd tools/goal typecheck` and `bun test tools/goal/src` before `main` advances. The train compare-and-
swaps `main`, then merges the checked main commit into `stabilize` and merges that resulting stabilize head into the
integration branch, also using compare-and-swap. A conflict aborts that merge, leaves its target branch unchanged, and
notifies the task manager and supermanager. When no stabilize branch exists, the checked main commit merges directly
into the integration branch. A failed control-plane check is recorded as a gate failure and retried with its failure
evidence; changes outside the task's declared paths still count as scope growth. Control-plane tasks that change a file
outside `tools/goal/` are not routed to `main`; historical tasks that declared such paths continue to use their recorded
target. Tasks from other Goals continue to integrate into the integration branch as before.

New tasks and retries branch from the integration branch, except control-plane tasks, which branch from `main`. The
landing train routes control-plane changes under `tools/goal/` to `main` and measures their change set from their fork
from `main`. If the integration branch does not exist, the controller creates it from `main`.
Held tasks become ready when each `after:` dependency is integrated or merged. Integrated tasks remain in flight until
promotion completes; Goal completion still requires every scoped task to be merged and the gate to pass on `main`.
Task worktrees exist while an attempt can use them. A background control-plane sweep removes integrated, merged and
cancelled worktrees one at a time, under idle I/O priority, after `/proc/pressure/io` reports `some avg10` at or below
20 (hosts without that file do not wait); a retry recreates a missing worktree from its task branch and installs its
dependencies before launch.
Declared paths never hold a task: tasks that declare the same file run side by side and resolve any overlap when they
rebase. Only `after:` holds a task.

A `stabilize` branch (`stabilizeBranch`, default `stabilize`) is a frozen candidate cut from the integration branch. A
non-control-plane brief with `target: stabilize` starts and retries from that branch's head, and dispatch is refused
while the branch does not exist. The train rebases such a task onto the branch, runs the same integration checks, and compare-and-swap advances
the branch. It then merges that new head into the integration branch with `git merge --no-ff` in a train worktree,
retrying up to five times if the integration branch moves. A conflict aborts only that merge: the stabilize branch and
the task stay integrated at the stabilize commit, and the task's manager and the supermanager receive an inbox notice
naming the task, the commit and the conflicting files. `goal retarget <task> stabilize` sets `target` on a task that is
not integrated, merged or cancelled when its recorded base is an ancestor of the stabilize head. A running attempt is
left in place; only later integration uses the branch. Briefs without `target` integrate into the integration branch as
before. Before compare-and-swap advancing `dev`, the train runs each newly included stabilize task's acceptance command
against the merged `dev` candidate, using the configured check-host environment. A failed command leaves `dev` unchanged
and the task integrated on stabilize; the task manager and supermanager receive one notice naming the command, first
failure and merged candidate. Passing commands allow `dev` to advance as usual.

The train promotes the `dev` head to `main` under a separate lease after the root gate and every task acceptance command
pass. If a gate fails, the promoter compares its first failure with `main`, then checks task prefixes concurrently up to
`promotionParallelism`. A failure shared with `main` is reported as an environment failure. Otherwise the promoter
reverts the culprit and its `after:` dependents in the batch in one forward commit on `dev`, sends the culprit through
the normal fix-round handling, holds those dependents, and promotes the remaining tasks.

When no stabilize branch exists, promotion first runs the root typecheck and compiles the bundled definitions
catalogue against one detached `dev-verified` snapshot. It creates the initial stabilize branch only if both checks pass
and `dev-verified` still points at that snapshot; a failed preflight leaves stabilize absent for a later retry. Once
cut, that candidate is frozen while its long gate runs, even as `dev-verified` advances. While the stabilize branch exists, promotion gates its head
and does not bisect, because only fixes reach it. An
infrastructure-only failure (process timeout, Docker setup/run failure, or SSH/rsync transport failure) reruns the
failing workspace checks on the same candidate up to twice; each rerun is recorded in the promotion run. Assertion
failures block immediately. A passing gate merges newer control-plane-only commits from main into the candidate,
then fast-forwards main when possible; other main history changes still need a fresh gate. The branch moves to the
`dev-verified` head, starting the next window. Deleting the branch starts a fresh preflight of `dev-verified`.

`defaults.json` `derivedFiles` declares generated path patterns, their pipeline stage and regeneration command; an untracked local `derivedFiles` setting can replace it. A rebase resolves a conflict in a declared generated path at either stage by keeping the integration side, running each matching command in the train worktree, staging its generated outputs and continuing through the ordinary landing checks. Retries use the same declarations and regeneration commands. The stabilize-to-dev merge applies the same rule and commits regenerated output in its merge commit. A mixed rebase conflict is resolved only when every non-generated conflict is Markdown, an already supported import-only conflict, or a configured flat JSON message catalog; any other conflict stays with the worker before regeneration runs. Markdown rebase conflicts use `git merge-file --union` to keep both sides' additions; the landing log and the owning Goal's integration notice name each such file for section-order review, including unions performed during a retry and in a batch landing. Configured `jsonMessageConflicts` patterns use a three-way key merge, retain the checked-out catalog's order and append keys introduced by the worker, and format the result with the repository formatter. A key changed to different values on both sides remains a conflict and the error names that key. Other non-generated conflicts stay with the worker. Other stabilize-to-dev conflicts keep the existing notification and recovery behavior.
`defaults.json` `derivedFiles` declares generated path patterns, their pipeline stage and regeneration command; an untracked local `derivedFiles` setting can replace it. A rebase resolves a conflict in a declared generated path at either stage by keeping the integration side, running each matching command in the train worktree, staging its generated outputs and continuing through the ordinary landing checks. This includes `bun.lock`: the train keeps the integration lockfile and runs `bun install` against the merged manifests, stages the regenerated lockfile and continues. Retries use the same declarations and regeneration commands. The stabilize-to-dev merge applies the same rule and commits regenerated output in its merge commit. A mixed rebase conflict is resolved only when every non-generated conflict is Markdown or an already supported import-only conflict; any other conflict stays with the worker before regeneration runs. Markdown rebase conflicts use `git merge-file --union` to keep both sides' additions; the landing log and the owning Goal's integration notice name each such file for section-order review, including unions performed during a retry and in a batch landing. Other non-generated conflicts stay with the worker. Other stabilize-to-dev conflicts keep the existing notification and recovery behavior.

After rebasing a single or batched landing, the train checks every path changed by that task against the current dev tree. If the task changed a path but the landing leaves that path's dev content unchanged, the train returns the task to its worker at the merge stage and names the path; a task diff already empty against dev is treated as already represented. Markdown and configured JSON message conflict resolution also stays with the worker when the resolved file keeps only dev's content and discards a worker change. A landing with no net tree change against dev is never reported as integrated on an existing commit.

Specification conflicts, tool failures and exhausted quota are attempt facts, parsed from a structured worker exit or
native CLI failure, and stored on the attempt. A usage-limit refusal with a fresh reading that shows allowance left
is retried on the same pool; a spent window, a stale reading, or three refusals within an hour routes the retry to a
different allowed pool. A CLI failure before a session or commit is rerun once; a second
consecutive launch failure or repeated environment fingerprint is escalated as stalled to the owning manager. Integration
does not run gates or classify assertion text. A specification conflict reaches the manager inbox directly. Quota
exhaustion chooses another allowed pool. Repeating the same first assertion after a fix round triggers one read-only Sol `medium` consultation;
the original profile receives its answer in a fresh session. Scope growth, stalls, failure after consultation and the
two-fix-round limit reach the owning manager. An early success claim followed by a failed gate is recorded and continued.
Generated files marked `linguist-generated=true` are excluded from estimate totals, while every changed file remains subject to declared-path checks.
Rebase-stage conflicts with the integration branch receive one same-profile resolution attempt after the control plane starts that rebase in
the task worktree; a second conflict goes to the manager as a specification conflict.

Attempts persist the driver process identity alongside the worker identity. Orphan recovery waits for the worker group to exit, then settles its run log under the task lifecycle lease; unexpected driver exceptions are recorded as environment failures and delivered to the manager.

At settlement, Goal removes Docker containers carrying the exact `rezics.worker.attempt=<task>/<attempt>` label.
Removal errors are logged and do not prevent attempt settlement; containers without that label are never selected.

### Worker container cleanup

- Touches: one label-filtered Docker listing and removal of that attempt's returned container IDs.
- Bound: only containers created by the exact task attempt are examined or removed; the work grows with that attempt's containers.
- Growth check: `bun test tools/goal/src/worker-containers.test.ts` records wrapper arguments and attempt cleanup.

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
bun tools/goal/src/cli.ts verify
bun tools/goal/src/cli.ts manager start <goal> --engine codex --budget 20000
bun tools/goal/src/cli.ts manager renew <manager>
bun tools/goal/src/cli.ts manager stop <manager>
bun tools/goal/src/cli.ts manager complete <manager>
bun tools/goal/src/cli.ts inbox wait <manager>
bun tools/goal/src/cli.ts inbox read <manager>
bun tools/goal/src/cli.ts inbox ack <manager>
bun tools/goal/src/cli.ts inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>]
```

`retry <task> [--brief <file>]` retries a task, optionally replacing its brief after checking that its Goal and manager stay the same. Brief comparison canonicalizes line endings to LF and ignores trailing end-of-file whitespace. If the supplied brief matches the current contract after that normalization, the command reports that the contract is unchanged and exits without starting another attempt. A changed brief records SHA-256 hashes of the previous and new contract on the new attempt; a stopped task can still be restarted with plain `retry <task>`.
Explicit retries are recorded with their amended brief as pending host start intents and return without waiting for capacity. The host consumes pending intents on recovery ticks in their saved order, starting each once as capacity becomes available.
`cancel <task>` stops a running task, marks it cancelled, and removes it from its Goal's completion scope. Tasks held
after it remain held because cancellation does not satisfy `after`; each manager that owns those held tasks receives one
instruction naming the held tasks and cancelled dependency. During host recovery, a held task with a cancelled
dependency that predates this notification is reported once to its manager. The manager decides whether to revise the
dependency.

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

### Development verification

Landing on `dev` is a mechanical integration step. A single leased verifier checks each new `dev` head after the
merge train has landed its batch. It starts from `dev-verified`, runs the root typecheck with `TYPECHECK_CHANGED`,
the affected checks for changed paths, and each landed task's acceptance command (except specification and research
tasks). Passing verification advances `dev-verified` with a compare-and-swap. Workers, retries and rebases use that
verified ref as their base, and promotion cuts stabilize candidates from it. `status` reports the verified commit,
how many landings `dev` is ahead, and whether verification is pending, running or current.

When a check fails, the verifier narrows suspects by the failing command's workspace closure and bisects only those
landings. It reverts each culprit's changes in one commit, returns the task to its manager with the failing log, and
advances the verified ref past the culprits. The worker can retry from that verified base. Infrastructure failures
rerun only the failed command, up to twice, and do not revert a landing. This moves expensive checks after integration
and lets a batch share them while keeping unstable `dev` separate from promotion's verified input.

When a Codex manager reaches 90% of its token budget, the host delivers one instruction to write
`.temp/goal/<manager>/CONTINUATION.md` with live task IDs and states, current decisions, pending cross-owner agreements
and next actions, then message its supermanager with `continuation written`. A confirmation or a `budgetLimited` Goal
automatically pauses and renews the manager with a fresh thread. If the continuation file exists, the new thread's first
prompt names it; the supermanager receives one environment event with the old token count and new thread. A manual
`manager renew` also accepts Codex Goals in `budgetLimited` or `blocked` status without a separate stop.

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
waking `goal-idle` event to its manager; replayed integration outcomes do not deliver it again. The host releases held
tasks under their task lease and starts them from the updated target branch. A pending attempt whose launcher was
lost is abandoned only while the task lease is held, then superseded by the replacement. The host recovery sweep also
retries an old pending attempt when the task is ready and its lease is free; released `after` tasks stay on the release
path so they refresh their worktree base first.

A manual smoke test for an authenticated local Codex manager is available without embedding any account name:

```sh
CODEX_HOME="/absolute/path/to/<cli-config-directory>" bun tools/goal/scripts/smoke-codex-manager.ts
```

## Pausing and resuming the Goal

A pause stops spending allowance without losing work. Nothing is cancelled: tasks keep their worktrees, branches and
briefs, and a stopped attempt's uncommitted changes are committed as leftovers on its next retry.

To pause:

1. Back up `<state>/capacity.json`, then write `{"maxWorkers": 0, "minAvailableMiB": 999999999}` to it. It is read on
   every capacity check, so no worker starts, critical-path and stabilize starts included.
2. Tell every manager to dispatch, retry, reshape, stop, cancel and gate nothing, and to bring its
   `<state>/<goal>/CONTINUATION.md` up to date.
3. Stop every running attempt with `stop <task>`, or let them finish when the remaining allowance allows it.
4. Stop the managers whose engine must not run (`manager stop <manager>`); a stopped Codex manager resumes with
   `manager renew <manager>`, which starts a fresh thread from its continuation file.
5. `touch <state>/promotion.paused` to keep promotion from starting gates.
6. Confirm no attempt is running or pending, no worker CLI process remains, and the main checkout's `tools/goal` matches
   HEAD. Record the state, the reasons and the restart order in `<state>/PAUSED.md`.

To resume, reverse the steps: set the pools' pacing (`policy.maxBurnPerHour`) and the worker cap, renew the stopped
managers, tell every manager to resume and retry its stopped tasks, and remove `promotion.paused` once the gate fixes
are in. A local `<state>/resume.sh` can script these steps for one pause; it is local configuration, not a repository
file.

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
