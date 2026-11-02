# goal

The Goal control plane and the REZICS workflow—managers, workers, briefs, checks, landing, verification and
promotion—are a REZICS product, developed and measured like the others. The
[agent work systems research](research/agent-work-systems.md) compares established systems and ranks improvements
by expected gain in landed useful work per allowance.

One Bun control plane owns worker dispatch, attempt records, the landing train and manager sessions. Every module uses
one local SQLite file, independent of the product database. `config.ts` composes the real worker fence, outcome sink,
landing queue, manager inbox, train and completion checker. Production commands need no runtime module or plugin.

Each worker attempt runs its detached process tree in its own transient `rezics-workers.slice` scope under the user's
systemd manager. The slice uses CPUWeight 50 and IOWeight 50 so workers yield processor time and disk to checks,
managers and the control plane when the host is busy, without a hard quota on worker width. IOWeight affects only
devices whose scheduler honours weights, such as the BFQ-scheduled SATA member on host c. When a user systemd manager
cannot apply the slice's resource settings, Goal still attempts the protected scope with host defaults and logs the
reason. If the manager cannot create that scope before the worker starts, launch fails with recovery guidance; Goal
does not start an unprotected worker.

```sh
bun install --cwd tools/goal --frozen-lockfile
bun run --cwd tools/goal check
bun tools/goal/src/cli.ts dispatch .temp/goal/brief.md
bun tools/goal/src/cli.ts status
bun tools/goal/src/cli.ts attempts --json
bun tools/goal/src/cli.ts attempts --all --json
bun tools/goal/src/cli.ts attempts --task <task> --json --limit 25
```

`attempts --json` remains the complete record export; `--all --json` makes that choice explicit for scripts. To inspect
one task, `attempts --task <task> [--after <attempt>] [--limit <count>] [--json]` returns at most 25 attempts by default
(up to 100). Pages are ordered by attempt number. JSON pages keep each record's existing fields inside `records` and
include `hasMore`; when more records remain, `nextAfter` is the attempt number to pass to the next `--after` request.
The text form also prints whether more attempts remain and the continuation attempt number.
Attempt inspection only retrieves the requested data; the manager host handles orphan recovery.

Run dispatch from a checkout of this repository after configuring local pools and writing a brief. The main checkout
must have main checked out. Workers commit source changes on their assigned branches, do not rebase and never edit frozen
acceptance files. A clean unchanged claim must not add an empty or unrelated commit; the controller runs the unchanged
acceptance on its retained source, while dirty or changed source or contract and failed or unavailable acceptance stay
non-green. When a contract changes a behaviour an existing test asserts, the worker updates that test.
Historical empty commits and controller-frozen acceptance files alone count as unchanged: acceptance records the retained
head, and completion uses its existing target ancestor without advancing dev.
Workers do not merge, except that a product worker integrating into dev in its own worktree merges or
cherry-picks a branch or commit its contract names explicitly.
If initial dispatch preparation fails before a task is registered, Goal removes the worktree and branch it created when
Git confirms ownership, preserves the original error, and names any artifact retained for recovery.
The controller rebases detached candidates onto the integration branch (by default `dev`), checks scope and
fast-forwards that branch without running a gate. Promotion to `main` is a separate step. A passing attempt record is
finalized through the real integration outcome sink.

Workers run their acceptance command once after their last relevant edit. When the branch has
`scripts/worker-check.ts`, the wrapper starts the check and returns its UUID. If the check is still running, the worker
returns the required `waiting` exit object with that UUID as a bare string in `checks`, then ends its turn. It does not
invoke `--wait`, poll status, inspect logs or processes, or start a duplicate. Goal owns check continuation: it waits for
the terminal result or records that the run ended without one, then resumes the same session with the actual result
records. The waiting result has the shape `{"status":"waiting","checks":["<bare UUID>"]}`; replace the placeholder with
the exact UUID and do not add a label or prefix to that string. A resumed worker does not return another waiting result
for the same check ids; it uses the supplied records as evidence and runs a new acceptance check only after relevant
edits when the current contract requires it. A terminal success result has an empty `checks` array; only still-running
checks appear in a waiting result. If `scripts/worker-check.ts` is absent from the worktree and the contract
does not name another existing wrapper path, the worker runs the command in the foreground from the worktree root and
does not add a wrapper. Workers do not run the root typecheck or other regression suites. After their last edit they
run the tests in the test files they created or changed once, with the command the landing's verification uses for
them: `bun test <files>`, the kernel check for kernel tests and the focused Web runner for Web tests. The prompt names
these commands for the files the branch already changes, including the sibling tests of changed sources. Waits use one
call with a yield of at least 300 seconds. A supplied acceptance command defines the worker's check. For an ordinary
dev product brief without one, the worker chooses focused validation and reports its exact command and actual result;
the missing command never counts as a pass.

A task whose paths touch `apps/web` or `packages/ui`, or an interface task without either, works against Storybook
served from its own worktree (`storybook.ts`). Each catalogue gets a loopback port derived from the worktree path, so
resumes reconnect and concurrent worktrees never share a server; a Web task also gets its own UI catalogue for the
`STORYBOOK_UI_URL` ref. The prompt names the start commands and `/mcp` endpoints, and the Codex adapter adds those
endpoints as MCP servers on fresh launches and resumes. The account's own MCP servers, such as the browser and
Playwright, stay enabled; consultations still ignore the account configuration.

The dev landing train runs exactly one mandatory root typecheck on each final candidate: once for a combined batch or
once for an individual landing. It does not run affected, sibling, acceptance, native, import or page-story checks
before dev advances. Those checks run through the independent verifier after integration. Promotion runs the full
gate on the candidate before advancing `main`.

Batching avoids repeating the same typecheck and affected checks for every worker in the batch. Historical check counts
and costs are recorded in [the check cost report](../../docs/research/check-cost.md).

Every landing command runs in its own process group, including the mandatory typecheck, acceptance, integration,
affected, sibling and derived regeneration commands. The train gives the group a bounded graceful shutdown before
forcing any remaining processes to exit. Control-plane tests set affected checks explicitly; when omitted, train
fixtures use no affected or sibling checks and never inherit the repository's live check defaults.

Derived files declare an `integration` or `promotion` stage in `defaults.json`. Rebase conflicts regenerate declared
files from either stage, including on dev landings and retries. Promotion-stage files may declare `inputs`; a dev
landing that changes one of those inputs runs the declared generator against the rebased candidate and includes changed
outputs in its landing commit. Promotion runs promotion-stage generators on the captured integration head before its
final gates. The verifier's `dev-verified` ref records verification progress and findings; it does not select or pass a
release candidate.

Briefs can carry frozen acceptance files in fenced blocks whose info string includes `path=<relative-path>`, such as
` ```ts path=tools/example.test.ts `. Each path must be inside the brief's declared paths. The controller runs the
configured `formatCommand` on exactly these files before committing them and records their formatted SHA-256 hashes. If
the formatter rejects a file, the controller restores the brief's original bytes, commits those, and reports the
formatter output so the manager can repair the brief. The train checks hashes before formatting a landing and refuses
integration if a worker changes a frozen file. This immutable-input refusal names the changed paths and goes directly
to the manager as a specification conflict; it does not enter the Git rebase conflict retry path.
When a retry reshapes a brief and drops a previously frozen path, the controller restores that file from the task's base
commit when it existed there; it removes the file only when it was absent from the base. Paths still frozen by the new
brief continue to be written and formatted from that brief.

Dispatch waits without a model for the child to exit, records its tokens and quota observations, saves its evidence,
enqueues its landing request, and starts the train. Requests targeting `main` use the `train-main.lease`; other
requests use `train.lease`. The two lanes select and order their own requests. Existing dev backlog drains first. An ordinary control-plane
release, while holding the main lane, borrows the existing dev lane only when its queue is empty, before capturing
refs or forming its candidate. With no new dev work it retains both leases through all required checks and the final
atomic main/dev/stabilize compare-and-swap, including verification of the accepted source ref.

While that proof is running, its controller observes the native dev queue every 50 ms and checks custody before each
proof command and publication. A newly queued dev request interrupts the controller's own proof. Per-invocation
`GateRunner` cancellation kills only that proof's command groups and awaits the complete runner, including terminal
cleanup supplied by the receiving tree; parallel proof commands all settle before the controller releases its
positively owned dev lease. The same existing dev drain then takes a turn,
even if the initial idle dev drain returned or found another live owner. No manager signal or extra enqueue is needed.
The main request stays pending and unpublished; it is not retried again in that drain. Another live dev owner is never
removed or replaced. Stale code cancels its own proof and uses the existing current-code handoff.

`control-plane-proof-<queue-id>.json` retains each ordinary attempt's exact source, candidate, captured refs, status and
separate log. An interrupted or crashed proof remains non-green, with no reusable proof or release record. A later
controller may readmit it only after source or captured refs change, at most three admissions for one source and five
candidate validations across those admissions. Exhaustion reaches the ordinary failure sink for an owning source
decision. An observed assertion failure stays failed even when dev also progresses; it never becomes an automatic
proof retry. Every readmitted candidate runs the entire mandatory proof, captured-dev installed-script compatibility
and real-boundary lifecycle checks afresh. Immutable-tree evidence never certifies a different capture.

Contention waits asynchronously for at most 30 seconds, preserves the live owner and leaves the request pending for a
later pump on timeout. Cancellation and every exit release only owned leases. External ref changes retain the existing
ref guards and finite retry budget. Other main and dev work retains independent
lanes. Each lane remains serial. A train releases its lease and checks its lane's
queue again, reacquiring the lease to drain a request that arrived during shutdown. Detached train processes wait for
the lane lease and recheck the control-plane version while they wait. Every process records the Git object id for
`main:tools/goal` when it starts; a stale train finishes its active landing, releases its lease and hands the remaining
queue to current code before it can take another request. Pumps used by short commands still return quietly when
another process holds the lane lease.
Failures return to the same profile and session, trigger one consultation, or reach the owning manager's inbox as
described under [integration](#integration-promotion-culprit-isolation-and-attempt-fencing).
A stale manager host restarts after finishing its active request and recovers persisted sessions. Restarts are limited to
one per ten minutes. Requests retry transient socket absence during handoff, and long recovery sweeps yield between
small batches so manager requests continue to be serviced. Watchdog and settlement scans read at most the last 256 KiB
of an attempt log, beginning at a complete line boundary; the recent commands and final failure events remain visible.
Startup failures identify the exited code or signal and the manager-host log path. Diagnostics read at most the final
4,000 bytes appended by that launch, report whether that launch's output was truncated or unavailable, and exclude prior log
history from the failure evidence.

Check slots remain shared across workers and the landing train. A detached check's terminal result stays controller
owned: a worker returns while it is running, and Goal wakes that session after reading its result record. The wrapper's
single permitted infrastructure rerun remains inside that acceptance invocation; an infrastructure failure after
that rerun stays a failure, not a pass or a reason for an extra worker rerun. Landing checks are grouped around the batch
candidate to avoid duplicate regression runs while preserving acceptance as each task's definition of done.

Each launch records the byte offset where its output starts in the appended attempt log. Exit-result parsing uses only
the current run from that offset, so a resumed CLI that fails before writing a new exit object cannot reuse the
previous turn's `waiting` result. Attempt measurements still include the available log history. A waiting attempt gets
up to three resume launch attempts; if all fail before opening a session, Goal stops the attempt and sends one
environment notice with the launch error line to the supermanager.

Only a completed agent message is a Codex answer; started or streamed items and rollout echoes never replace it. A
worker that exits 0 with a resumable session but without its exit object is asked for it once, in the same session and
attempt: settlement leaves the attempt waiting with a `final-report-requested` event, and the host resumes it like a
check wake with only a short report-only prompt (no edits, commands or checks). If that run still gives no report, the
attempt ends as an ordinary missing-report failure.

Every fresh launch, retry, held-task release and check wake renders a bounded controller launch context from the current
task generation under its lease. It records the current contract hash and path, task base and worktree identity, and one
line for each declared `after:` dependency: whether its integrated commit is in the prepared task base, in the current
source only, or unobserved. An unavailable observation is not described as proven absence. Lifecycle completion alone
never renders as present: prepared-base and current-source presence each require the integrated commit to be an ancestor
of that tip. A new context supersedes future-tense instructions in an older prompt, retry manifest or
attempt result; recovery does not reuse an older attempt's context.

When a waiting session wakes on a finished failed check, Goal includes the exact result identity, command, exit status
and original log path. It reads only a UUID-owned log in that task's check directory and includes at most 4 KiB of its
tail. Missing, unreadable, mismatched or truncated evidence is identified as unknown; other check logs and the worker's
attempt log are not used as substitutes.

When the configured state directory's `verification-mode` file contains `minimal`, every launch and continuation
receives the current source-completion policy alongside its canonical contract. Workers finish their contract and the
typing of the workspaces they changed, run the tests of the test files they changed once, then commit and return
`success`, `blocker:null`, `checks:[]`, naming the code completed and the original acceptance/native obligations
deferred until after integration. This source result does not claim whole-feature, native or Goal completion.
Unfinished work is not a blocker: a worker whose contract does not fit commits a coherent working part and returns
success with the remainder listed as follow-up (for product work on dev, a continuation brief). Deferred acceptance
alone is neither blocked nor waiting. Waiting requires running registered bare UUID checks owned by that task and
attempt; an empty list, completed command or product blocker cannot justify it. A retry manifest that records a tool
or host failure has that command rerun once before the worker reports a `tool` blocker. Normal mode retains the wrapper
continuation protocol above.

Minimal mode permits the existing Kernel/Auth compiler database or check-host placement only for typechecking and for
the tests of the test files the worker changed, with its real leases, results and terminal status preserved. It grants
no acceptance, native, browser, root or worker-check permission. A foreground compiler must finish through its already-open tool command/session handle; workers must not
invent check ids, return `waiting` with no checks, run process/help/status polling loops, duplicate commands or interrupt
live compilers. The controller forwards this policy through its existing prompt seam; it does not steer live sessions.

Ordinary contracts can be amended before their first worker starts:

```sh
bun tools/goal/src/cli.ts amend <task> --expected-attempt 0 --brief <file>
```

`WorkerTasks.amend(taskId, { expectedAttempt: 0, brief }, actor)` is the same receiving boundary. It requires the live,
unambiguous persisted provider session of the owning manager or configured operations manager. Only ordinary
generation-zero tasks in `ready`, genuinely dependency-held `held`, or deliberately selected never-started `stopped`
state are eligible, with no attempt, check, settlement or completed state. A zero counter alone is insufficient:
stopped tasks refuse any historical attempt, result, landing, integration, proof reservation/registration, worker
run/evidence path or known or unknown check custody. Retained metadata with no readable ownership cannot establish
absence of custody and refuses replacement. The submitted full brief passes ordinary path, risk-area and dependency validation, keeps
the same Goal and manager, preserves normal priority and its grant/history bytes, and retains frozen acceptance
blocks unchanged. Operations can deliver this same-priority amendment directly; no owner impersonation or priority
grant is required. Verification registration continues to use its separate existing proof entry.

Under the task lease and SQLite write transaction, amendment saves an immutable current brief and archives both
contracts, paths and hashes in the existing task events. Identical input returns `unchanged`; accepted changes return
`amended`, each with the task, generation and current contract hash. Identical stopped input stays stopped. A changed
stopped contract records its prior stopped state, retains existing stop history and branch/worktree/base/source,
and enters `held` while any genuine dependency remains unmet, otherwise `ready`. This explicit authenticated full
replacement is the only stopped-zero transition added here; it does not restart other stopped tasks. A pending first-start intent and capacity ticket
remain the same single intent and ticket. Amendment does not dispatch, retry, create an attempt, start a provider or
bypass capacity. The waiting launcher rereads the accepted task under its lease after capacity admission, so the first
native prompt contains the full latest canonical contract and current verification policy. Removing a held task's last
dependency uses that same first-start path. Advanced/live generations refuse with their actual current identity and
log/process handle, without changing them. This command does not steer an active worker.

Each actual worker prompt boundary records its log offset and accumulated check-wait baseline in the existing
`worker-run-started` event. Recovery uses that boundary's original timestamp rather than restarting its clock. Silence,
startup and elapsed-limit accounting exclude earlier-turn output and waits, while retaining the current prompt's
recorded waits across controller restart, capped to its silent interval for adoption.

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
`<worktreeRoot>/modules/<module>`, on `ws/<module>`, created from the integration head on first use. Matching includes exact paths,
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
worktree. Before advancing dev, it runs exactly one direct root typecheck on the final combined candidate, including
any conflict resolution and formatting. `TYPECHECK_CHANGED` contains the actual paths from the batch base to that
candidate. This guard is mandatory for single, shared-workspace and batched landings, including when
`integration.devLandingChecks` is false. A compiler failure leaves dev unchanged and returns its full diagnostic to
the affected task; unrelated batch members remain queued. A passing check advances dev with the expected-head check.
Source commits remain intact. Each task's trailer commits determine which changes belong to it and whether all its
commits are on dev; those tasks become integrated. A task with no trailer commits cannot finish by claiming a peer's
work. Main promotion retains its existing workflow.

A rebase conflict enters the existing same-profile retry path with its conflict files and evidence. The train
records the full effective target commit, source worker commit and sorted unresolved path set at the conflict. A
bounded no-progress guard stops only when the current conflict and two of the six most recent prior conflicts have
the same complete Git context; redacted failure fingerprints and legacy outcomes without that context do not count.
The single stop notice records the target, source and paths durably. A batch uses the cumulative target commit after
earlier members, so a target advanced within the batch counts as progress. A batch drops members already integrated
before advancing dev, so one completed member cannot refuse the others. The manager-host sweep also repairs a current
`landing` task that has no pending queue entry after both train lanes are idle: it records a durable retry and sends
one environment notice to the supermanager.

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

Any object in the file may carry `note` or `$comment` annotations; they are dropped before validation, and every other
unknown field is an error. Validate an edit before replacing the live file with
`bun tools/goal/src/cli.ts config check [file]` (the live file when omitted): it applies the strict schema, never falls
back and changes nothing. Each valid version of a local file is kept in `<main checkout>/.temp/goal/configuration/`. When
the live file later fails to read or validate, every process, including a new CLI command, uses that file's last valid
version (revalidated with the current schema and environment) and reports the exact error once to the operations
manager and the supermanager; the next valid version is adopted normally. Without a valid version on record the error
stops the command as before.

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
pool. An unchanged file is not reparsed; the rest of the process settings retain their startup values. If a changed
file cannot be read or its pool entries are invalid, the process keeps the pools of the last valid version and sends one
error event per changed version to the supermanager inbox.

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

The lifecycle JSON and hourly snapshots include conflict telemetry. The current producer records unresolved rebase
outcomes and conflict retry setup, but does not identify every conflict, the original conflict occurrence time, or
owner/rerere/replay resolution. Owner-landing capability is therefore `unavailable`; total conflicts, actual
conflict-to-landed duration, total open conflicts and their age, and resolution-method counters remain unknown.
An empty recorded window does not establish zero conflicts or zero conflict-created attempts.

`conflicts.recordedOutcomes` counts complete Git contexts from failed `gate-outcome` rebase events in the trailing
hour. A task/attempt contributes once, using the first persisted rebase outcome; replay cannot add a count or move it
into a later hour. Legacy outcomes without a complete context remain unclassified. Its observation-to-landed
percentiles use the persisted outcome time and the first subsequent integration event for that task at the same or
a later attempt. Its unlanded count and oldest observation age describe only that hour's observed-conflict cohort,
not all open conflicts. These observation-clock figures do not substitute for the unknown occurrence-clock metrics.

`conflicts.createdAttempts` uses attempts' recorded creation times (`startedAt`). A valid `worker-source-baseline`
event, written only during conflict retry setup, establishes an observed conflict-created attempt. Retry intents
can be reconciled to a later current attempt and do not prove its creation cause. Mutable attempt escalation is not a
creation cause: the attempt that encountered a conflict also receives that escalation. Later attempts without
creation-cause evidence remain unknown. Neither a same-attempt resume nor duplicate events create another attempt.

Each reader returns at most 1,000 outcome or attempt candidates per trailing-hour window, plus one overflow sentinel;
an overflow sets `complete: false` and makes the observed counters lower bounds. Readers maintain time-window indexes
on the optional source tables, select scalar attempt fields, and use task/attempt event lookups rather than decoding
settled task and attempt bodies. They add no events or producer fields. Truncated timing percentiles describe the
sample, not the entire hour. The existing hourly emission remains first-write-wins. Historical snapshots without
conflict fields read back as unavailable, without backfilling today's observations. The existing lifecycle suite remains the postintegration
proof boundary for same-session/attempt/pass landing with one acceptance, rerere without a worker wake, exact-owner
wrong-resolution fixes and authenticated manager ownership guards; these counters do not certify those scenarios.

### Hourly delivery report

`bun tools/goal/scripts/efficiency-report.ts [--bucket <UTC-hour-start>]` prints the most recently completed UTC hour
by default. It joins timestamped integrations to task and attempt identities, names the last useful landing, and reads
current waits, orphaned landings, promotion state, quarantines and shared tool incidents from their existing durable
records. Missing source history is `unknown`; an empty counter is not inferred from missing evidence. Landing counts
are task outcomes, not changed-line volume. Worker diff churn is labeled separately and is not presented as delivered
product work.

Set `integration.hourlyReportNotifier` in untracked local settings to an argv array to enable one report per completed
UTC hour. Goal appends the report as the final argument, runs without a shell, discards notifier output, and stops the
notifier after `integration.hourlyReportTimeoutMs` (default `20000`, maximum `120000`). Keep credentials in the
notifier's secret store; Goal logs only a fixed delivery status and discards notifier output. Each hour's report and delivery outcome are stored
durably; a sent, failed or uncertain outcome is not retried in that bucket. The manager host starts the report runner
as a child and continues serving commands while it runs. Without a configured notifier, the report remains available
as a local command and the host sends nothing. Add `--send` to deliver a report manually; the default command only
prints it.

The manager host evaluates absolute flow targets each hour and sends one `environment` event to the configured
supermanager for each breached threshold: efficiency below 40%, any queue older than 60 minutes, landing p90 above
30 minutes, or more than 1.5 attempts per integrated task. `flow` in local settings can override `efficiencyBelow`,
`oldestQueueMs`, `landingP90Ms` and `attemptsPerIntegrated`; the defaults are `0.4`, `3600000`, `1800000` and `1.5`.
Alarm summaries name the stage, measurement and up to three oldest waiting task IDs. A threshold can alert again after
one hour. Flow alarms, daily audit notices, check-result reuse alerts and shared environment incidents go to the
configured supermanager; priority grants and scope decisions remain with the supermanager.

Once per UTC day the manager host dispatches the research brief at
[`templates/daily-step-audit.md`](templates/daily-step-audit.md), unless a daily audit task is already open. It
reviews failure prevention, recorded catch counts, time and allowance cost for each step from dispatch through
promotion, includes the prior day's flow report, and recommends one measured structural change. Unknown telemetry is
reported as unknown rather than inferred.

### Host-capacity admission

Ordinary starts that wait for host capacity and checks that decide whether an ordinary start can begin count running
attempts through the `worker_attempts_state` expression index. An admitted start keeps its queue ticket in an admitted
state while it prepares its worktree and launches; that ticket occupies one worker slot until the attempt is recorded
running or ends. Tickets are tied to the admitting process and are discarded when that process dies. Waiting check-wake
attempts do not count. The existing 15-second waiting interval, oldest-ticket-first order and critical-path half-hour
head start are unchanged. Replacing, updating or removing `capacity.json` wakes queued starts immediately, without
waiting for the periodic worker/memory poll.

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
Orphaned landings are repaired under the task lease only when no current pending queue entry or train-lane lease exists;
the retry intent and one-time supermanager report are written atomically.

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
`goal priority <task> critical|normal` changes it. Critical priority requires a task-bound grant from the task manager's
configured supermanager. Dispatch tasks with normal priority first; a brief with `criticalPath: true` or a derived
`critical-path` task class is refused at dispatch. Register the already-running configured supermanager from its resident
Claude Code session with `bun tools/goal/src/cli.ts manager register-supermanager`. Run this command inside that Claude
session so the control plane records its `CLAUDE_CODE_SESSION_ID`; it does not launch another manager, Goal, window,
app-server, pool reservation or token budget. The supermanager grants with
`bun tools/goal/src/cli.ts priority grant <task>`. The owning manager consumes the one-use grant with
`bun tools/goal/src/cli.ts priority <task> critical`, or by retrying with a critical brief after a grant exists.
`bun tools/goal/src/cli.ts priority revoke <task> <grant-id>` revokes an unused grant by its grantor. The owner may
demote with `bun tools/goal/src/cli.ts priority <task> normal` without a grant. Priority history records setter,
grantor, timestamp and manager-session provenance; older tasks without history remain unknown rather than receiving a
fabricated setter. Every retry with an amended brief requires the authenticated task owner, even when the effective
priority stays the same. Repeating the current priority preserves its history and any consumed grant without creating
another priority decision. A retry that changes priority uses the existing transition and grant rules. Priority
commands and amended-brief retries require the caller's Codex or Claude session ID to match a running persisted
manager session; `GOAL_MANAGER` alone is not authorization. Performance's `worker-check` reads this file and passes
`REMOTE_CHECK_PRIORITY=critical` for remaining checks when its contents are `critical`.
It writes command output to `.temp/goal/checks/`, records the check duration for the worker deadline and silence monitor,
then prints the check UUID and, when available, the exit status, a short failure summary and the log path. Goal uses
the recorded result to wake a waiting worker. See the
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
criticalPath: false
waiting: []
---

Operators can see why an example input was refused. Follow the diagnostic conventions in
[the CLI owner documentation](tools/goal/README.md#briefs-and-routing), and include the field and a repair hint.
Done means invalid input names the field to fix while valid input keeps its current result.
Choose the implementation and focused validation.
```

Use the actual declared files. `manager` defaults to `goal`. Additional observable features are `inseparable`,
`citesSources` and `hostileInput`. Kinds are `implementation`, `interface`, `bulk-text`, `claim`, `specification`,
`research` and `mechanical`. An ordinary dev product brief (including untargeted control-plane work, excluding
main/stabilize releases and verification work, and without frozen acceptance files) may omit `estimate` and `acceptance.command`. An omitted estimate uses the existing
routing ceiling of 1,500 lines and 24 files. With no command, acceptance is worker-owned: the worker chooses or adds a
focused check, runs it under the normal check protocol, and reports the exact command and observed result. The parser
does not insert a passing command. Under minimal verification, the worker supplies outcome tests and runs them with
the landing's command; broader acceptance stays deferred. The dev verifier keeps its affected and sibling checks and
executes only supplied acceptance commands; omission earns no task acceptance pass. Any supplied `acceptance` fields keep their existing behavior; a supplied command
still requires non-empty `tests`, and an implementation with supplied acceptance keeps the existing failing-test
requirement. Main/stabilize releases, verification, and frozen acceptance briefs continue to require an explicit
command and tests. `acceptance.placement` requires an explicit command. Mechanical work is refused
by model dispatch. Risk paths, source citations and hostile input take precedence over cheaper classes. Critical-path
classification additionally requires waiting tasks and `inseparable`.

### Acceptance placement

`acceptance.placement` is an optional brief field. Omit it, or set it to `default`, to keep the existing remote-capable
check policy. Set it to `local` only for the audited Web commands: `bun run --cwd apps/web typecheck`, explicitly
named Bun unit/component test files under `apps/web/tests/`, or the focused runner form
`bun apps/web/scripts/focused.ts --private-network -- bun test tests/<named-test>.test.ts` from its known `apps/web`
working directory. The focused runner may have the exact `env -u KERNEL_ORIGIN` and
`PUBLIC_ORIGIN=http://127.0.0.1:3000` prefix used by the Web command. `sh -c` may join supported commands with `&&`,
and only the audited `timeout 590 sh -c ...` wrapper is recognized. Local Bun tests may use `-t` or
`--test-name-pattern` with an explicit selector. Globs, broad test runs, unknown scripts, preloads, browsers, stack
wrappers, host/integration/database tests, native routes, shell expansion and unrecognized flags are rejected. The
focused runner uses `apps/web` as its working directory and prepares its local test runtime; it does not enter the Web
host or native check routes.

```yaml
acceptance:
  command:
    [
      bun,
      test,
      apps/web/tests/shell-menus.test.ts,
      -t,
      'the signed-out account action opens a sheet on phones and a dropdown on desktop',
    ]
  tests: [the signed-out account action opens a sheet on phones and a dropdown on desktop]
  failing: true
  placement: local
```

The local placement is persisted with the parsed brief and controls fresh, retry, adopted and wake prompts. If the
worktree contains `scripts/worker-check.ts`, Goal prints the concrete `bun scripts/worker-check.ts --local -- <argv>`
invocation. It also recognizes an existing absolute `scripts/worker-check.ts` named by the brief. When neither wrapper
exists, Goal prints the exact declared command and directs the worker to run it in the foreground. The wrapper's
`--local` option disables remote placement but retains its ordinary local admission and result recording.

Goal does not have a supported worker-check teardown-intent/receipt API. A retry using local placement is therefore
quarantined while any earlier registered check lacks a terminal exit record. The error names the unresolved check and
the missing teardown-intent/receipt API; Goal does not claim the check was cancelled, edit its record, or start a
replacement. Delivering that lifecycle seam remains separate work.

Declared paths support literals, `*`, `?` and whole-segment `**`. Absolute paths, traversal and unsupported glob syntax
are refused. Matching walks an explicit stack and refuses after one million visited states; each pattern shares the
64 KiB brief size bound. Risk ownership is checked by intersecting the path patterns, including broad claims such as `src/**`.
Every intersected risk area must be declared. Extend the ownership data when adding product modules. A `control-plane`
brief may declare only `tools/goal/` paths; dispatch refuses outside paths and asks that they be split into a dev task.

Routing records the table version on each attempt. Open experiments weight work toward cheaper models: implementation, interface and bulk text rotate Grok 4.7, Grok 4.7, Luna `max`; claims rotate Luna `max`, Grok 4.7, Sol `high`
by durable task sequence, starting with `high`; retries retain the original profile and version. Research is read-only.
Bulk text prompts prohibit translation services, scripts and character mappings. Workers return a structured result
using `worker-result.schema.json`, including any concrete blocker and the approaches tried.

### Research

Before deciding how a surface or mechanism should work, find out how established products, open-source projects and
standards already solve it. A worker does the research its work needs itself: it reads `.reference/`, the owner
documents and primary sources, and lists what it read in its summary. A manager dispatches a `research` task for a
question that needs a large survey: a product surface that mature apps have (shelves, readers, editors, forums,
catalogues), an external standard (SEO, accessibility, a protocol), or a library's current recommended practice across
many sources. A worker that meets such a question finishes with a `spec-conflict` blocker whose detail starts with
`Research needed:`, and its manager dispatches the research and returns the findings to the worker's contract.

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
or waiting for a check-host slot. A pending retry that waits by design is not reported: one whose `after` dependencies
are not yet integrated, whose backoff time has not come, or that waits out a check-host outage. `goal status` shows
such a retry's `pendingRetry` reason (`dependencies`, `backoff`, `check-hosts`, or `start` when it waits only for a
starter or capacity). It also reports a `stabilize` branch that has stayed out of the integration branch for
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
While a listed host is in outage, retries of check-host transport failures stay pending instead of relaunching.

## Integration, promotion, culprit isolation and attempt fencing

The tracked repository gate is `bun tools/goal/scripts/gate.ts`. It runs `bun install --frozen-lockfile` followed by
`bun run check` from an isolated checkout. Task acceptance commands are saved with the task. For dev landings, the
independent verifier runs them after integration; a failure is reported with the command and first failure and does
not hold the landing train. Main promotion retains its task acceptance gates. Integration rebases onto the integration
branch, checks declared paths, formats changes and fast-forwards that branch without moving `main`.
Promotion gates on correctness only: the root gate and the promoted tasks' own acceptance. Capability completion
(`docs/goals/<goal>.capabilities.md`) is reported by the completion checker on `main` and never blocks a promotion,
so `main` receives finished work while other In rows are still open.
The `integrationChecks` setting lists legacy `{ paths, command }` checks. Dev landings no longer run these checks in
the train. Unmigrated local checks are selected for the independent verifier after integration, except dependency
installation and root typecheck entries, which remain setup and the mandatory compiler guard respectively. Main and
stabilize workflows keep their existing gates. Gates and dependency installation never run in the main checkout or
the worker's checkout.

Task worktrees with the same dependency key share one read-only Bun install under the configured dependency-store root
(default `<worktree root>/../dependency-stores`). Each tree keeps its own small `node_modules` skeleton and workspace
links; only `.bun` points at the shared store. The key covers the Bun version, root and workspace manifests, `bun.lock`
and `bunfig.toml`.

Before an ordinary worker launches or resumes, the controller checks the final resolved manifests' dependency key and
the actual direct dependency and workspace links. Matching healthy installations are reused without installing. Private
receipts also bind the installed direct links and package manifests; old key-only receipts are refreshed once. Changed
manifests keep an existing private install private; stale shared workspace skeletons are replaced only in the owned
worktree. An incomplete store falls back to a private install without repairing shared bytes in place. Store
validation treats missing or malformed published store manifests as stale and uses this private preparation path;
invalid manifests in the worker's current source still fail preparation before launch. Lockfile
regeneration is not an installation receipt. Unresolved rebase paths stay with the same worker for source resolution;
preparation runs on the resolved source before its next ordinary launch. A shared module whose dependencies need
refreshing cannot launch while a peer holds live process, pending attempt or check custody; the controller reports that
custody error before starting the model.

For source declaring Bun, preparation also uses the existing pinned artifact contract to validate the source/lock
pin, selected store metadata, installed Bun and optional platform package, and actual `.bin/bun` bytes and runtime
identity. The old installed executable never supplies the expected revision for a new pin. A stale or incorrect
published store is preserved and repaired through the requesting worktree's bounded private install; healthy shared
installs still reuse the immutable store. A failed install or identity validation prevents launch and retains its exact
cause. Recovery uses the normal controller resume of the same current task/session after this preparation source is
released; source validation alone does not repair or restart retained consumers or prove their compilers pass.

Disposable train worktrees capture their directory identity when created. Before Git removes one, the train restores
owner access on its own directories, including immutable fixture stores left by checks. Cleanup rejects replaced roots
or parents, never follows dependency links, and never changes package file modes or outside store directories.

Store builds use `--backend=copyfile`; the `.bun` tree is made read-only before publication. Run
`bun tools/goal/src/cli.ts deps private` before changing a manifest or lockfile. A five-directory host-c comparison
created 69,426 `node_modules` entries per private install (median 4.956 s) versus 27 per shared worktree (median
0.016 s), after building one shared store.

Workers run their task acceptance command once after their last relevant edit. Each single, shared-workspace or batch
dev landing receives one mandatory direct root typecheck on its final candidate. Conflict resolution and formatting
are included in the checked tree. No affected, sibling, acceptance, native, import, or page-story validation runs
before the dev ref advances. Infrastructure failures may retry the same compiler command once; compiler errors leave
dev unchanged and go to their owner. Promotion continues to run the full gate.

`verifierChecks` is the canonical `{ paths: string[], command: string[] }` selection for checks that run after dev
integration. The defaults cover kernel affected mode, workspace imports, the Personal Library page, Web remote-browser
regressions and the client page-story/component check. Local `affectedTests` and `integrationChecks` remain compatible
inputs to this verifier when `verifierChecks` is not explicitly set; `bun install` and old typecheck entries are
excluded. An explicit `verifierChecks` array replaces those legacy selections. `siblingTests.command` selects sibling
tests after integration, excluding spec-tree files. Discovery uses the shared `siblingTestFiles` selection of existing
`.test`/`.spec` JS/TS module and JSX files beside the source and in workspace test directories, and still places a
`bun test` command in the workspace that owns those files. These settings cannot disable or add work to the mandatory
prelanding typecheck.

Main and stabilize train checks retain their existing baseline behavior. They compare recorded failing files with the
integration base, reuse a result for the same base and command, or run a separate base-worktree check. Failing files
added by the branch are introduced by definition; failures shared with the base are allowed. These checks retain their
existing transport retries, unverified environment classification and failure logs. Dev verification uses its own
captured `dev-verified..dev` change set and advances `dev-verified` only after its selected checks pass.

A `control-plane` brief may declare only `tools/goal/` paths; dispatch refuses outside paths and tells the manager to
split them into a dev task. A control-plane brief without a `target` line, including launch, settle, wake, retry, train
and emergency changes, starts from `dev` and lands there mechanically like product work, with unlimited retries in the
same session; [cp-sync](#control-plane-on-dev-cp-sync) is its release gate to `main`. A control-plane brief with
`target: main` or `target: stabilize` uses the main release path below. It starts from `main`, rebases onto current
`main`, formats its changes, installs root and `tools/goal/` dependencies, then runs
`bun run --cwd tools/goal typecheck` and the complete `bun test --timeout 30000 tools/goal/src` suite.

Changes to the worker launch path also run `tools/goal/scripts/launch-smoke.ts` on the candidate after the control-plane checks.
The smoke builds a disposable worktree with the candidate merged on top of current `dev`, dispatches one tiny task through
the real worker launch and settle path, starts a real `scripts/worker-check.ts` command, and waits for its result before
recovering the same attempt. It verifies the worker result schema, saved check id, resumed session, successful exit, and
both systemd-scoped launches. This catches provider schema refusals, start-form mismatches, and resume defects that
fake-agent tests cannot expose. It uses the cheapest configured Codex model at low effort, with the configured service
tier (Fast is refused), a five-minute deadline, and a prompt budget of 2000 generated tokens. Fake-agent protocol tests
use actual detached checks without provider calls. A failed step is returned to the task with its step output.
Before disposable cleanup, the real smoke retains a bounded, sanitized per-run record under
`.temp/launch-smoke-evidence/`: candidate, actual attempt/session/profile/pool, adapter argv and configured feature
booleans, current structured result, current-run event suffix, and check identities/results. Prompts, account settings,
raw tool arguments and tool output are omitted. Resuming clears the recorded current result until that turn exits;
an older waiting result cannot stand in for the current failure. Cleanup does not discard this evidence.

Workspace gate parity is a separate postintegration obligation. Minimal `launch-smoke` keeps the real provider
launch/wait/wake path and records `worker-root-workspace-gate-parity` as deferred and unverified. That entry is not a
required passing scenario for minimal smoke. It does not certify native parity.

The bounded consumer at `scripts/gate-parity.ts` requires two explicit checkout roots:

```sh
bun tools/goal/scripts/gate-parity.ts --input-root <candidate> --scripts-root <delivered-dev-checkout>
```

Without `--execute` this only plans: it captures each root's exact commit, tree and dirty status, reads the existing
check-script compatibility contract and discovers literal executable producer fixtures and their supported exports.
The supplied scripts root identifies delivered development scripts independently of an older main-based worker.
Discovery never imports a possibly unguarded root gate, guesses `--workspaces`, assumes a Git export, or claims a
runtime pass from source inspection. Missing boundaries appear once in the plan with their owning team.

Explicit postintegration execution adds `--execute`, or uses
`launch-smoke.ts --parity execute --scripts-root <delivered-dev-checkout>`. It reports the plan before execution,
clones both captured commits under this consumer worktree's `.temp/goal`, installs their frozen dependencies, and runs
only the discovered producer commands. The existing compatibility checker tests worker/remote command contracts;
selected-gate and persistence-ownership fixtures collect supporting evidence. Auth and native Web regressions enter
their delivered owner check commands. There is no full root gate fallback, raw native test or database injection.
Commands record actual argv, cwd, bounded output and outcome. The installed producer Bun owns command execution;
caller database/lane/explicit persistence overrides are cleared, while ordinary placement settings are retained.
A total 270-second execution budget bounds child process groups. Cleanup removes only nonce-marked clones and owned
children; Auth/Web retain their own native resource cleanup. Neither supplied checkout's refs or config are changed.

Producer fixture success is supporting evidence only. The current delivered contracts still lack an executable
comparison of actual worker/root workspace checks, usable Git metadata after sync, and genuine nested native Auth
placement. These are named unavailable results owned by the Git/gate and Auth teams, even when supporting fixtures
pass. The native concurrent Web persistence regression remains an explicit later obligation and is available only
with its placed Web check command. Execution exits nonzero for unavailable boundaries or failed producer commands;
minimal smoke defers it so missing producers do not disable every control-plane landing. Completion of this consumer
requires its workspace typecheck; native/browser/remote parity must be verified after integration.

Before any release ref moves, the train checks the executable main-consumer/dev-script contract against the exact
snapshotted dev script tree. It installs dependencies in a detached worktree at that dev commit, then runs
`bun tools/goal/scripts/check-compatibility.ts --scripts-root <dev-script-worktree>`. The contract verifies the
main-side worker-check consumer, pinned Bun artifact and remote-check invocation against those dev scripts. The train
also runs the complete real-boundary lifecycle suite through `tools/goal/scripts/launch-smoke.ts`, passing the expected
dev tree commit. The disposable scenario starts a real worker, runs and waits for `scripts/worker-check.ts`, wakes and
resumes the same attempt, and records named scenario and regression evidence. A recorded success names the exact main
candidate, dev script tree and scenario results. A failed, timed-out, capacity-waiting or incomplete suite or contract
is unverified and cannot certify `main`; no baseline allowance can turn a required failure into a pass. Candidate
mutation or a stale main, stabilize or dev ref invalidates the run and starts validation again.

The existing local-placement, compatibility and smoke test fixtures share `checkScriptFixture` in `src/test-support.ts`.
It captures the development ref as one immutable commit before reading files, including the manifest and lockfile
used by compatibility probes. It copies only the worker-check runtime dependencies: worker-check, remote-check,
check-git, check-ledger, stack-run, stack-lease, check-custody, check-artifacts, check-memory and the check-host Docker
wrapper. The stack-run and check-artifacts imports share that same snapshot, including their transitive custody
dependency. Negative probes transform those copied sources; package identity, pinned Bun verification and wrapper
policy remain part of the existing assertions.
These fixture copies do not replace the train's detached dev checkout or its release-ref validation.

The Bun artifact contract retains `bun@1.4.4-canary.20261027.1` and accepts the supplied exact
`bun@1.4.4-canary.20261031.1` artifact on Linux x64. The latter's installed package version is
`1.4.4-canary.20261031.1+34cbc70`; its runtime reports `1.4.4` and must match the recorded revision and executable
hash. Unknown pins and unprovided platforms remain incompatible. Fixture artifact caches are keyed by integrity so
different pins cannot reuse each other's archives. Metadata support does not certify executable compatibility or
native lifecycle parity; those remain controller release obligations.

The train precomputes merge candidates for `main`, `stabilize` when that branch exists, and `dev`, then publishes the
ref changes in one Git compare-and-swap transaction. If `stabilize` is absent, it prepares `main` directly into `dev`.
Moving refs are re-snapshotted and checked again, preserving unrelated work on `stabilize` and `dev`; branches are never
reset to `main`. A propagation conflict records its exact files and Git cause once, leaves all release refs unchanged,
and notifies the task manager and supermanager. Repeated identical conflicts are bounded and quarantined by the
controller. A durable release record lets a later train recover an interrupted landing, and it never reports the task
complete while a required branch is missing the recorded release.

Use the normal train for a local emergency patch: have the supermanager write a `control-plane` brief naming the
changed `tools/goal/` paths and a regression case, dispatch it, land it on dev through the controller, then run
[cp-sync](#control-plane-on-dev-cp-sync), which publishes dev's control plane to main. Do not patch `main`, `stabilize`
or `dev` directly.

```sh
bun tools/goal/src/cli.ts dispatch .temp/goal/control-plane-emergency.md
bun tools/goal/src/cli.ts land <task>
```

To reproduce the shared compatibility contract locally, use a detached checkout of the dev commit being checked:

```sh
bun tools/goal/scripts/check-compatibility.ts --scripts-root <dev-script-worktree>
bun tools/goal/scripts/launch-smoke.ts --expected-dev-script-tree <dev-commit>
```

The lifecycle smoke uses the cheapest configured Codex model at low effort, with the configured service tier (Fast is
refused), a five-minute deadline, and a prompt budget of 2000 generated tokens. Fake-agent protocol tests use actual
detached checks without provider calls. A failed step is returned to the task with its step output. Control-plane tasks
that change a file outside `tools/goal/` are not routed to `main`; historical tasks that declared such paths continue to
use their recorded target. Tasks from other Goals continue to integrate into the integration branch as before.

New tasks and retries branch from the integration branch, except control-plane briefs with `target: main` or
`target: stabilize`, which branch from `main`. The landing train routes such releases under `tools/goal/` to `main` and
measures their change set from their fork from `main`. If the integration branch does not exist, the controller creates
it from `main`.
Held tasks become ready when each `after:` dependency is integrated or merged. A dependency with the same target
satisfies the edge at integration; a dependency with a different target satisfies it when its integration commit is
already on the dependent's base branch, or when no integration commit was recorded. Integrated tasks remain in flight
until promotion completes; Goal completion still requires every scoped task to be merged and the gate to pass on `main`.
Task worktrees exist while an attempt can use them. A background control-plane sweep removes integrated, merged and
cancelled worktrees one at a time, under idle I/O priority, after waiting up to 30 seconds for `/proc/pressure/io` to
report `some avg10` at or below 20 (hosts without that file do not wait); sustained pressure defers the pass and lets a
later sweep retry. A retry recreates a missing worktree from its task branch and installs its
dependencies before launch. A permission-denied removal records the offending path and owner when available and sends
the task manager one durable notice for that path generation. The sweep continues with independent finished tasks; it
does not retry the blocked path until its ownership, permissions or filesystem identity changes. Cleanup leaves shared
dependency stores and symlink targets outside the worktree untouched.
Declared paths never hold a task: tasks that declare the same file run side by side and resolve any overlap when they
rebase. Only `after:` holds a task.

A `stabilize` branch (`stabilizeBranch`, default `stabilize`) is a frozen candidate cut from the integration branch. A
non-control-plane brief with `target: stabilize` starts and retries from that branch's head, and dispatch is refused
while the branch does not exist. The train rebases such a task onto the branch, runs the existing stabilize-lane
checks, and compare-and-swap advances the branch. It then merges that new head into the integration branch with
`git merge --no-ff` in a train worktree, retrying up to five times if the integration branch moves. Before compare-
and-swap advancing dev, the train runs the mandatory root typecheck on the exact merged candidate. A compiler failure
leaves dev unchanged and reports the diagnostic to the task owner. Task acceptance and other configured verification
run after integration. A merge conflict aborts only that merge: the stabilize branch and the task stay integrated at
the stabilize commit, and the task's manager and the supermanager receive an inbox notice naming the task, the commit
and the conflicting files. `goal retarget <task> stabilize` sets `target` on a task that is not integrated, merged or
cancelled when its recorded base is an ancestor of the stabilize head. A running attempt is left in place; only later
integration uses the branch. Briefs without `target` integrate into the integration branch as before.

The train promotes the `dev` head to `main` under a separate lease after the root gate and every task acceptance command
pass. If a gate fails, the promoter compares its first failure with `main`, then checks task prefixes concurrently up to
`promotionParallelism`. A failure shared with `main` is reported as an environment failure. Otherwise the promoter
reverts the culprit and its `after:` dependents in the batch in one forward commit on `dev`, sends the culprit through
the normal fix-round handling, holds those dependents, and promotes the remaining tasks.

When no stabilize branch exists, promotion first runs the root typecheck and compiles the bundled definitions
catalogue against one detached integration-head snapshot. It creates the initial stabilize branch only if both checks
pass and the integration ref still points at that snapshot; a failed preflight leaves stabilize absent for a later
retry. Once cut, that candidate is frozen while its long gate runs, even as the integration branch advances. While the stabilize branch exists, promotion gates its head
and does not bisect, because only fixes reach it. An
infrastructure-only failure (process timeout, Docker setup/run failure, or SSH/rsync transport failure) reruns the
failing workspace checks on the same candidate up to twice; each rerun is recorded in the promotion run. Assertion
failures block immediately. A passing gate merges newer control-plane-only commits from main into the candidate,
then fast-forwards main when possible; other main history changes still need a fresh gate. The branch moves to the
captured integration head, starting the next window. Deleting the branch starts a fresh preflight of the latest
integration head.

`defaults.json` `derivedFiles` declares generated path patterns, their pipeline stage and regeneration command; an untracked local `derivedFiles` setting can replace it. A rebase resolves a conflict in a declared generated path at either stage by keeping the integration side, running each matching command in the train worktree, staging its generated outputs and continuing through the ordinary landing checks. This includes `bun.lock`: the train keeps the integration lockfile and runs `bun install` against the merged manifests, stages the regenerated lockfile and continues. Retries use the same declarations and regeneration commands. The stabilize-to-dev merge applies the same rule and commits regenerated output in its merge commit. A mixed rebase conflict is resolved only when every non-generated conflict is Markdown, an already supported import-only conflict, or a configured flat JSON message catalog; any other conflict stays with the worker before regeneration runs. Markdown rebase conflicts use `git merge-file --union` to keep both sides' additions; the landing log and the owning Goal's integration notice name each such file for section-order review, including unions performed during a retry and in a batch landing. Configured `jsonMessageConflicts` patterns use a three-way key merge, retain the checked-out catalog's order and append keys introduced by the worker, and format the result with the repository formatter. A key changed to different values on both sides remains a conflict and the error names that key. Other non-generated conflicts stay with the worker. Other stabilize-to-dev conflicts keep the existing notification and recovery behavior.

After rebasing a single or batched landing, the train checks every path changed by that task against the current dev tree. If the task changed a path but the landing leaves that path's dev content unchanged, the train returns the task to its worker at the merge stage and names the path; a task diff already empty against dev is treated as already represented. Markdown and configured JSON message conflict resolution also stays with the worker when the resolved file keeps only dev's content and discards a worker change. A landing with no net tree change against dev is never reported as integrated on an existing commit.

Specification conflicts, tool failures and exhausted quota are attempt facts, parsed from a structured worker exit or
native CLI failure, and stored on the attempt. A usage-limit refusal with a fresh reading that shows allowance left
is retried on the same pool; a spent window, a stale reading, or three refusals within an hour routes the retry to a
different allowed pool. A provider capacity refusal continues after a short pause, however often it repeats.

Every other tool failure, including a CLI that fails before a session, a silent worker and a check-host transport
failure, resumes the same session after a backoff by its fingerprint: the failure's first line with worktree paths,
numbers, hashes and identifiers removed. The first sighting of a fingerprint across all tasks in the last hour waits two minutes, the second
ten and later ones thirty; each sighting is a `tool-blocker-retry` event. The delay is persisted as the retry intent's
`notBefore`, so a restarted host honours it. A check-host transport failure also waits while the watchdog's probes
show a listed check host in outage (two failed probes in a row, cleared by a success; see [Watchdog](#watchdog)), and
every relaunch waits for [host capacity](#host-capacity-admission); the manager host's recovery sweep tries the pending
retry again every minute. When three distinct tasks end on the same normalized line within 20 minutes, Goal opens one
environment incident, holds retries for those tasks and new tasks that hit the line, and sends one `blocker` to the
supermanager with the line, count, example tasks and the first tracked source match from `git grep`. Goal retries one
affected task every 10 minutes; a rerun that passes the blocker closes the incident and releases the other pending
retries. Incident notices are one line; an undelivered notice is retried during the existing recovery sweep without
reopening the incident or moving its probe cadence. `status` lists open incidents and identifies affected pending
retries. Without a shared incident, the same
tool blocker in two consecutive attempts parks the task and sends its manager one `environment` event, whether or not
the worker reran the failing command; two silence stalls in a row are reported as `stalled`. Work other than product
work on dev also stops as stalled when a tool failure follows another without a rerun of the failing command. A
repeated environment fingerprint at landing is escalated as stalled to the owning manager.

Integration does not run gates or classify assertion text. A specification conflict reaches the manager inbox directly.
Quota exhaustion chooses another allowed pool. Outside product work on dev, repeating the same first assertion after a
fix round triggers one read-only Sol `medium` consultation; the original profile receives its answer in a fresh session.
Scope growth, stalls, failure after consultation and the two-fix-round limit reach the owning manager. An early success
claim followed by a failed gate is recorded and continued.
Generated files marked `linguist-generated=true` are excluded from estimate totals, while every changed file remains subject to declared-path checks.

Work integrating into dev, including control-plane work without a target (not control-plane releases, stabilize-target
or verification work), has no retry limit and needs no approval to retry. A landing failure (a rebase conflict, or a type check or format failure at landing) or a
tool blocker resumes the same session with the error, without a manager turn: the two-fix-round limit and consultation
do not apply, each retry continues on the task's branch, in its session when the pool and model are unchanged, and
environment failures do not count toward the three-failure model switch. The task stops and notifies its manager only
when the attempts stop making progress: the same failure in two consecutive attempts (the same first assertion, rebase
conflict or tool blocker), or two consecutive attempts that end without a new commit. At its classification each failed
attempt records an `attempt-progress` event: whether its branch head moved from the head recorded at its first prompt,
or work was left uncommitted. Unknown progress never stops a task. A changed file outside its declared paths and a diff
beyond twice its estimate do not stop it either: the attempt record lists such files in `outsidePaths` and the size in
`estimateOverrun`. A scope-stage refusal for an undeclared risk area, a frozen acceptance change, a specification
conflict and a stall still reach the owning manager. Control-plane releases, stabilize-target and verification work keep
every limit above.

A product worker on dev whose outcome does not fit one attempt lands a coherent part and writes the rest of its own
outcome as a continuation brief at `.temp/continuation/<name>.md` in its worktree. When the attempt ends, settlement
moves each brief to `<state>/backlog/<goal>/continuation-<task>-<attempt>-<name>.md`, where the backlog is dispatched
like any other brief, and records a `continuation-queued` event. A name that normalizes or truncates onto a file
already holding the same brief is left in place. A different brief is published under a stable distinct name, and the
source is removed only then; when every distinct name is occupied the source stays and a `continuation-retained` event
is recorded. A brief moves only when it parses with the ordinary
brief parser, keeps the task's goal and manager, is itself product work on dev and names only known dependencies;
anything else is removed and its reason recorded in a `continuation-dropped` event. Workers in a shared module workspace
list the remainder in their summary instead.

Rebase-stage conflicts with the integration branch receive same-profile resolution attempts after the control plane
starts that rebase in the task worktree. Controller-only rebase commits do not count as worker progress. The bounded
guard sends one specification-conflict notice only after the same source worker commit, effective target commit and
sorted conflict paths recur without progress: a second time in a row for product work on dev, a third time otherwise. A
newer target, changed paths or a new worker commit remains retryable.

Attempts persist the driver process identity alongside the worker identity. Orphan recovery waits for the worker group to exit, then settles its run log under the task lifecycle lease; unexpected driver exceptions are recorded as environment failures and delivered to the manager.

Settlement runs Git (commit of leftover work, evidence bundles, branch checks) outside the store's write
transactions, so it never holds the SQLite lock while a child process runs. A settlement write that meets another
process's lock beyond the busy timeout is retried after 0.5, 1, 2, 4 and 8 seconds; a successful exit then lands once,
as if there had been no contention. If the lock outlasts every try, the attempt is not classified as a worker failure:
its driver is released and the host's orphan sweep settles the same exit again.

Each task's step in a recovery sweep (cancelled-dependency notice, dependency release, proof reservation release,
orphaned landing, pending or first start, worker adoption) is isolated: its failure is logged, reported once per
process to the supermanager with the task and step, and the sweep goes on with the other tasks. A store-wide failure,
such as reading the task list, still fails the sweep; store contention is only logged.

Process cleanup verifies the leader's PID, start time, boot and detached group before sending signals. A reused
leader PID may settle only when the original group has no live members and the kernel confirms it is absent with
signal zero. The replacement incarnation receives no termination signal. A vanished leader with surviving original
descendants is still followed and its identified members are reaped during terminal cleanup. Unreadable process state
or denied group inspection is an explicit operational condition: recovery records `process-cleanup-unconfirmed`,
notifies the manager once and retains the running attempt and its slot. A later sweep can settle it after visibility
returns. Stop and cancellation publish terminal records only after cleanup succeeds. Each termination signal uses a
pidfd and rechecks birth and group identity after opening it, so PID reuse between inspection and signalling cannot
redirect a signal to a replacement process.

Disposable Goal fixtures record each wrapper and pidfd waiter in an append-only ledger carrying their owner token.
Cleanup uses those identities, including wrappers no longer present in attempt rows; it does not select processes by
working directory. Tests that can leave children running must `await h.disposeAsync()`. It reaps the owned groups,
awaits tracked exit/follow continuations and waiter cleanup, then closes SQLite and removes the fixture directory.
Disposal seals the fixture against new workers before taking its child inventory; waiter registration remains available
until existing work finishes. Ownership and pending work are checked again immediately before removal.
Synchronous `h.dispose()` refuses live children or unfinished waits. A changed owner marker, unreadable state or failed
cleanup retains fixture state for inspection. An unrelated child is spared even when it runs inside the fixture root.

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

The CLI validates worker command arguments before runtime recovery or command recording. Invalid arguments return usage
feedback without settling unrelated workers.
The CLI and direct worker callers share the parsed argument contract; direct callers retain rejected usage errors.
Task attempt selection and page bounds use that same parser before runtime creation.

### Roles and delegation

The supermanager sets direction and the managers own the work. This applies to every supermanager and every Goal.

- **Workers own the how; managers own the what.** A brief states the outcome in user terms, its owner links and what
  done means. A product worker on dev verifies the brief's premises against its base, designs the change and writes
  the acceptance tests the brief does not name; frozen files stay untouchable and only cross-Goal contracts are frozen
  in advance. It decides ambiguities itself, including a product choice the brief does not make, by taking the
  reversible option most consistent with the owner documents and decided references; it records each decision in its
  summary and the owning document, tells its manager with
  `bun tools/goal/src/cli.ts inbox send <manager> info "<decision>" --task <task>`, and continues. A blocker is only a
  contradiction between existing specs or tests, or missing access; undelivered code from another Goal, absent
  receipts and unfinished work are not blockers. The worker does its own research and stops only for a large survey.
  It may change any file its outcome needs outside risk areas, merges or cherry-picks only branches its brief names,
  lands committed, type-checking increments, and writes the rest of a larger outcome as a continuation brief. Workers
  build on their brief and the owner READMEs and do not read other workers' tasks.
- **Managers keep the outcomes and drop the ceremony.** A manager keeps the ordered list of outcomes for its Goal and
  short outcome briefs in its backlog, cross-Goal contracts and their frozen acceptance, answers to escalations, and a
  review of a sample of about two landings an hour whose defects become briefs. It synthesizes what its workers report,
  including conflicts and duplicated or missing work across tasks, into decisions and the next briefs. It does not
  dispatch, approve retries, preflight briefs, write per-task acceptance, receive results, track custody, review
  evidence per task or send status messages and receipts.
- **Managers talk to each other first.** Any manager may message any other with
  `bun tools/goal/src/cli.ts inbox send <manager> instruction "<message>"`. A question about another Goal's contract goes
  to that Goal's manager. The producer decides its interface and the consumer adapts; the two settle it within one
  exchange and record it in the owner document.
- **Managers decide inside their Goal.** Contract details, frozen expectations the Goal owns, design choices within the
  maintainer's references, and which slices to run are the manager's decisions. When unsure, research primary sources
  first, then decide. Managers are resident roles. If the supermanager or maintainer is unreachable, concerned managers
  decide after one exchange: the producer chooses its interface and the outcome owner decides shared choices. Record
  reasons and proceed with independent work; park only items that genuinely depend on an unavailable decision.
- **Escalate rarely and once.** A manager sends the supermanager only a deadlock that one exchange between owners did
  not settle, a change to the maintainer's direction or scope, or something only the maintainer can provide, with the
  options and a recommendation.
- **Operations belong to the delivery-system Goal.** Manager-host liveness, stuck or stale checks, hung remote runs,
  worktree cleanup, recovery of tasks stopped by environment or tooling failures in any Goal and promotion
  are owned by the manager of the Goal that owns `tools/goal`; damaged host retry journals are replaced with the
  persisted maximum configured backoff before recovery. Check-host health is owned by the Goal
  that owns the check scripts. System alerts go to those owners.
- **Efficiency is measured by scripts.** The hourly report, operational alarms and the supermanager watchdog run without
  model tokens ([delivery ownership](../../docs/development/delivery.md#delivery-ownership)). The supermanager acts on
  alarms; Performance owns check-host health and its own Goal.
- **Visual review belongs to the design-authority Goal.** The Goal that owns the shell and design system reviews every
  visible slice by screenshot against the maintainer's references and reopens defects with the owning Goal; each
  product Goal owns its user journeys end to end, pages included.
- **The supermanager keeps direction.** [Resident supervision and recovery](../../docs/development/supermanager.md).
  Direction, priorities and scope with the maintainer, the allowance runway,
  critical-priority grants, deadlocks between owners, efficiency strategy, and a sampled review of the product, not
  every slice. When a detail reaches the supermanager, it forwards it to the owner instead of doing it.

#### Shared inbox

Any authenticated manager, including the registered supermanager, can inspect every recipient's conversation. Shared
queries use the persisted provider session identity (`CODEX_THREAD_ID` or `CLAUDE_CODE_SESSION_ID`); `GOAL_MANAGER`
alone and worker task identity do not authorize them. Log, thread and digest queries are read-only: they do not mark a
recipient's message read or acknowledged, set notification state, wake a manager, or deliver a message. Existing
`inbox wait` and `inbox ack` retain their per-recipient behavior. `inbox read` returns one bounded page of that
recipient's unacknowledged wakeable events, oldest id first, and marks only those rows read. Pages use the same size as
shared queries (default 50, maximum 100) and include `hasMore` and `nextCursor`. Remaining unread events stay pending.
`inbox wait` returns one unread page, so a later wait continues from the remaining work.

```sh
bun tools/goal/src/cli.ts inbox log [--from <manager>] [--to <manager>] [--goal <goal>] [--task <task>] \
  [--since <time>] [--grep <text>] [--limit <1..100>] [--cursor <id>] [--json]
bun tools/goal/src/cli.ts inbox thread <message-id|task-id> [--limit <1..100>] [--cursor <id>] [--json]
bun tools/goal/src/cli.ts inbox digest --since <time> [--limit <1..100>] [--cursor <id>] [--json]
bun tools/goal/src/cli.ts inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>] \
  [--reply <message-id>] [--document <path-or-JSON-reference>] [--escalation <reason-or-JSON>]
```

Pages default to 50 rows and stop at 100. Results are newest first for `log`; a page with more results returns
`hasMore` and `nextCursor`, which is passed back as `--cursor`. `thread` returns a conversation in message order and
uses the same continuation fields. `--since` accepts an ISO timestamp or Unix seconds/milliseconds. `--grep` searches
the stored summary without inferring links. `--json` prints the complete page object, including row metadata, the event,
the page limit, continuation cursor and `hasMore`. The exported `SharedInboxQueries` API provides the same `log`,
`thread` and `digest` reads to operations reports after they have actually been delivered; it does not schedule or send
an hourly report.

A delivery identical to one made to the same recipient within the last hour is not stored again: the earlier row's
`delivery_count` and `last_delivered_at` change, nobody is woken, and `inbox read` shows the count as `deliveries`.
Identity is the recipient, kind, sender, task, reply target and the summary's first line, so the same alarm for two
tasks stays two events. Records and completion results (`goal-met`, `goal-unmet`) are never folded. A worker's
`info` message (sender `worker:<task>/<attempt>`) reports a decision the worker already made: it is stored and
returned by the manager's next `inbox read`, but it sends no wakeup, starts no turn and does not end an `inbox wait`.
Worker questions, blockers and handoffs still wake. A Goal manager's `inbox send` is refused above six sends in the last
hour or 600 characters, with an error that says which limit was reached; the configured supermanager, workers and
system events are not capped. Only an authenticated pending Codex continuation-renewal handshake (asked, not yet
renewed, no in-flight renewal, sent to the configured supermanager) neither counts nor is refused by the hourly limit;
an ordinary decision, question or status that contains those words counts normally, regardless of recipient or letter
case.

Inbox kinds are explicit. `question` starts an open question. Only a direct linked `info` or `decision` reply answers
it; another `question` is a clarification and remains open. A `blocker`, `handoff`, `instruction`, system event, read,
notification or acknowledgement is not an answer. `--reply` takes an existing numeric message id, stores that exact
parent, and keeps its thread root and task/Goal provenance across managers. It is valid for a reply to be another
question, so nested clarifications remain visible. Decisions may repeat `--document` with either a path or a JSON
reference such as `'{"path":"docs/contract.md","change":"Added the retry rule"}'`. Escalation metadata can be a
one-line reason or JSON such as `'{"target":"supermanager","reason":"Owner deadlock after one exchange"}'`.
Only explicit escalation metadata is reported as an escalation; historical system kinds are retained as-is rather than
reinterpreted. Existing instruction and internal system events continue using the same durable per-recipient wake/read/
ack columns. A worker with a current persisted task attempt may send instruction, question, blocker, handoff or info
messages; the sender is recorded as `worker:<source-task>/<attempt>` with the source owner in structured provenance.
`--task` still selects the conversation task, so a cross-owner handoff can retain its target task separately. Worker
messages keep the recipient's existing delivery behavior and do not authorize shared reads or manager actions.

The digest groups known events by their stored Goal and includes decisions and their document references, blockers,
explicit escalations, open questions older than 30 minutes, and blockers older than one hour. A linked direct `info` or
`decision` resolves a blocker for intervention reporting. Its per-Goal and total counts cover every matching record;
bounded detail pages expose `hasMore` and `nextCursor`, so continuation does not change those totals. Overdue questions
and old blockers are considered even when their arrival predates `--since`. Historical rows receive an indexed metadata
migration where those values were already present, but their missing arrival timestamp stays `null`/unknown. Time
filters and age thresholds cannot classify a row whose creation time is unknown, and missing Goal/document metadata
stays unknown rather than being inferred from summary text, read time or row id.

#### Owner decisions at worker prompt boundaries

From the owning manager's live persisted provider session, submit:

```sh
bun tools/goal/src/cli.ts event <task> <current-attempt> owner-contract-decision \
  '{"decisionId":"composition-rule","summary":"Use the clarified composition rule.","documentRefs":[{"path":"docs/composition.md","change":"Clarified contributor ownership."}]}'
```

The JSON schema requires a nonempty `decisionId` (at most 128 characters) and `summary` (within the manager message
limit); `documentRefs` is optional, with repository-relative `path` and optional `change` per reference. No other
top-level fields are accepted. The command authenticates the persisted manager session using `CODEX_THREAD_ID` or
`CLAUDE_CODE_SESSION_ID`; `GOAL_MANAGER` alone grants no authority. Owner and current attempt are checked in the same
transaction as persistence. Authentication, task identity and decision time come from the controller, never the body.
Decision: accepted decisions use a reserved controller event; old unverified events remain pending until the owner resubmits through this command.

The controller reads `owner-contract-decision-accepted` events for the task's current attempt when it builds a normal worker
prompt. It carries the newest authenticated decision from the task's manager and its repository-relative document
references into that same worker session. A successful launch records `owner-contract-decision-delivery`; a referenced
document unavailable in the worker worktree remains pending and is named in the prompt. Replayed decision identities
and decisions from earlier attempts cannot supersede a later current-attempt decision. Recording a decision does not
start or replace an attempt; delivery waits for the next normal prompt boundary.
The event command does not sweep or resume workers. Acceptance and delivery events cannot be submitted directly.
The decision shares the existing 20,000-character total prompt limit and process input byte limit with the ordinary
prompt. References that do not fit remain pending; if the summary itself cannot fit, launch refuses the oversized
prompt without recording delivery. Only a successful launch records delivery against the accepted event sequence.

#### Native Storybook publication

`goal publication` is the single supported native ingress for the ordinary hourly Storybook publication. It is available
only to the currently authenticated manager configured as `integration.operationsManager`; `GOAL_MANAGER` alone,
worker sessions, a copied approval file, and direct deploy scripts do not authorize it. Configure
`integration.operationsManager` and the `dev` integration branch in the ignored local Goal settings before runtime
release. All command state, bootstrap input, logs and immutable receipts live below the ignored Goal state directory.

The Web owner first sends its retained conditional decision from its authenticated provider session. The inbox event
stores the sender session provenance with the decision and its single canonical owner document:

```sh
bun tools/goal/src/cli.ts inbox send control-plane decision "Retained conditional Storybook authority" \
  --document .temp/goal/web/resume-20261101/publication-0100-owner-decision.json
bun tools/goal/src/cli.ts inbox log --to control-plane --grep "Retained conditional Storybook authority" --json
```

The operations manager reads the message ID from that inbox page, supplies the host census at
`.temp/goal/publication/bootstrap.json`, then receives and runs only the returned authority identity:

```sh
bun tools/goal/src/cli.ts publication bootstrap
bun tools/goal/src/cli.ts publication receive <owner-inbox-message-id>
bun tools/goal/src/cli.ts publication status <authority-id>
bun tools/goal/src/cli.ts publication start <authority-id>
bun tools/goal/src/cli.ts publication status <authority-id>
bun tools/goal/src/cli.ts publication recover <invocation-id>
```

Legacy custody can be received before a complete inventory exists. The supported preparation journey is described
below; an unresolved capture or preview must use it instead of fabricating bootstrap identities. Receiving the
publication allowance and receiving physical custody are separate operations. Neither operation runs a workflow.

The bootstrap document is ignored runtime evidence, not an approval document. It has `version: 1`,
`visibility: "complete-native-publisher-capture-host-inventory"`, a current UTC `observedAt`,
`noUnregisteredPublisherOrCaptureGroups: true`, a nonempty `records` array, and `historyEvidencePaths`. The census must
come from the actual native host, include every retained publisher and capture handle, and be no older than five
minutes. Each record is `{ "kind": "publisher" | "capture", "path": "<state-relative retained JSON>" }`; old receipts
whose identity is in a companion record also use `identityEvidencePath` and `identityField`. For example, the retained
1940 publisher identity is `firstPublisher` in `control-plane/storybook-duplicate-cancellation.json`, while the
cancelled duplicate identity is `observed` in that same evidence. Those are the only supported companion identity
bindings: the 1940 terminal receipt's `workflowPid` must match `firstPublisher.pid`; the cancellation evidence must
bind `expected` and `observed` to the same PID/start/boot, retain the documented process-group transition and exact
owned-PID signal, and show its target absent after cancellation. The controller checks both recorded process groups
for complete visibility and refuses while either has members. Arbitrary companion-field pointers and mismatched
workflow PIDs fail closed. The record list must include those historical handles, the 2100, 2200 and 2300 publisher
receipts, and every other legacy publisher/capture still in the host census. Terminal publisher records need their
original log inside the Goal state directory. The bootstrap preserves the original bytes and hashes; it never rewrites
the legacy receipt.

The history list must retain these state-relative records: `control-plane/storybook-publication-20261031-2100.json`,
`control-plane/storybook-publication-20261031-2200.json`,
`control-plane/storybook-publication-20261031-2300.json`,
`control-plane/storybook-duplicate-cancellation.json`,
`control-plane/publication-0100-0500-disposition.json`,
`web/resume-20261101/publication-0100-owner-decision.json`, and
`web/resume-20261101/publication-1940.json`. Missing files, malformed identities, unreadable logs, reused PIDs,
surviving group members, unknown group visibility, or an asserted empty registry fail closed. The bootstrap does not
kill processes or infer absence. Capture custody is registered or retired only after an actual process exists or has
ended; registration does not start a capture:

```sh
bun tools/goal/src/cli.ts publication capture-register <pid> <retained-registration-evidence-path>
bun tools/goal/src/cli.ts publication capture-retire <custody-id> <terminal-evidence-path>
```

Receiving the same durable inbox message returns its original authority ID; another message for its slot is refused.
The start path atomically claims that authority under a cross-process directory lease, stores one invocation ID, and
keeps exclusive publisher/capture custody through the workflow. Unknown or active custody, stale inventory, a wrong
UTC slot, unelapsed hourly cadence, moved or stale dev ancestry, missing required integrated commits, modified
workflow blobs, unclean source, or an unavailable/mismatched pinned dependency store refuses execution. Preparation
uses an isolated detached Git worktree at the source commit and the existing exact shared dependency store. It never
resets an existing tree, runs an unmanaged install or falls back to system Bun.

The invocation uses the normal `storybook:deploy` workflow once with
`timeout --signal=TERM --kill-after=30s 1800s <worktree>/node_modules/.bin/bun run storybook:deploy --force` from
`<worktree>/apps/web`. The pinned workflow runs build plus all six unchanged smokes: signed-out account shell menu,
signed-in account shell menu, composed UI Cover Card, Japanese locale with dark theme, Subject Member, and Library
Copies Owner with its recorded cover media. The deploy script verifies the deployed live commit before it exits; the
controller also requires readable live build metadata naming the immutable source commit. A 403, missing commit,
mismatch, timeout, nonzero exit, lost process visibility, or interrupted spawn remains unavailable or non-green and
never authorizes a repeat. The log retains the original process output and the receipt records argv, cwd, deadline,
source and dependency identities, original PID/start/boot/group, exit/signal and live comparison.

`status` reports authority, original process handle, receipt and delivery state. `recover` observes that same process
identity and may redeliver its already durable terminal receipt; it never launches a replacement or signals an unknown
or reused identity. Durable delivery is tracked once per Web and operations inbox. Authority receipt, workflow
execution, terminal outcome, live equality and inbox delivery are separate evidence states. Exit zero without live
commit equality is not success, and a saved terminal result remains visible when delivery needs recovery.

The source change does not release this route for operations. The retained 01 UTC Web decision remains unconsumed,
and the current disposition has no actual 01 UTC process handle or fresh native publisher/capture host census. Runtime
bootstrap still needs that complete current census plus the exact retained evidence and logs above; source presence,
configuration defaults and this documentation are not a release or permission to invoke publication. The full native
controller lifecycle and compatibility checks remain deferred to the operations release.

##### Legacy reconciliation preparation

From its own authenticated provider session, the owning manager sends a `decision` with `--document` naming a private
document in its own state-directory namespace. The configured operations manager receives that inbox ID from its
current provider session. An operations-owned original uses an operations decision; Web never has to impersonate
operations, and operations cannot substitute its own decision for a Web-owned original.

```sh
bun tools/goal/src/cli.ts inbox send <operations-manager> decision "Receive unresolved legacy custody" \
  --document .temp/goal/<owner>/legacy-disposition.json
bun tools/goal/src/cli.ts publication legacy-receive <owner-inbox-message-id>
bun tools/goal/src/cli.ts publication legacy-status [inbox-message-or-preparation-id]
bun tools/goal/src/cli.ts publication legacy-prepare
bun tools/goal/src/cli.ts publication legacy-prepare <native-inventory-inbox-message-id>
bun tools/goal/src/cli.ts publication legacy-resolve <owner-resolution-inbox-message-id>
bun tools/goal/src/cli.ts publication status [authority-or-invocation-id]
```

The versioned receiving document has this bounded private schema. Paths in `records` are relative to the configured
Goal state directory; document references in inbox commands are repository-relative. SHA-256 is over exact file bytes.
Documents are regular files, at most 1 MiB, inside private state, with at most 16 referenced documents and 256 records
per request. Symlink escapes, arbitrary identity-field pointers and mismatched workflow PIDs refuse receiving.

```json
{
  "version": 1,
  "kind": "publication-legacy-disposition",
  "owner": "<owning-manager>",
  "controller": "<operations-manager>",
  "records": [
    { "key": "original-capture", "surface": "capture", "evidencePath": "<owner>/capture.json", "sha256": "<sha256>" },
    { "key": "original-preview", "surface": "preview", "evidencePath": "<owner>/preview.json", "sha256": "<sha256>" },
    {
      "key": "original-publisher",
      "surface": "publisher",
      "evidencePath": "<owner>/publisher.json",
      "sha256": "<sha256>"
    }
  ]
}
```

The genuine older unavailable disposition is also supported without editing its retained bytes. It has `owner`,
`reply` identifying the authenticated operations-to-owner agreement, the exact disposition
`unavailable-exact-capture-terminal-identity; unknown custody remains occupied`, and separate `capture`,
`previewCompanion`, `legacyPublisher` and `legacyKnownCustody` objects/array. Preview startup and refresh records are
received separately. The complete original document is retained with each selector and its SHA-256. An absent capture
terminal file, running metadata, partial identity, preview PID/session, refresh PID, historical provider handle or
historical publisher exit never becomes the capture's identity or terminal result. Known publisher and cancellation
history still goes through the existing strict bootstrap importer, including its exact companion bindings and logs.

The immutable inbox event, indexed sender/recipient/document references, retained provider-session provenance,
operations receiver session and exact raw documents are journaled in `publication_legacy_requests`. Related source
files are retained with their own hashes, or an explicit unavailable path; stdout includes hashes and receipt fields,
never those raw documents. Evidence-bound entries in `publication_legacy_entries` start as **UNKNOWN OCCUPIED**,
including complete historical identities until physical settlement is established. Original raw evidence never changes.
A new document hash adds distinct occupied
custody; it cannot replace an older unresolved entry. Restart, migration, refresh omissions and an empty host scan
preserve every entry. Concurrent receiving, preparation, resolution, bootstrap, capture registration and start share
the native `publication/custody.lease`. A live lease refuses the contender before an invocation is consumed.

Replaying an inbox ID with identical provenance returns its original receipt. Changed bytes or provenance for that ID,
an older owner decision overtaking a newer received decision, a foreign owner, or missing authenticated sender evidence
refuses. A delivery-file error leaves the original SQLite receipt intact; replay rematerializes it under
`publication/legacy/request-<message-id>.json`. Status exposes the immutable entry IDs, hashes, selectors, original
identities, resolutions and latest preparation. `recover <invocation-id>` continues to observe only its original
workflow and deliver its original terminal result; reconciliation never redispatches it.
`legacy-status <inbox-message-or-preparation-id>` exposes the exact original durable receipt even if its file could
not be materialized or the originating document has since changed.

`legacy-prepare` records a durable **unavailable** receipt with host, controller incarnation/session, observation time,
exact retained-set hash, known identities, unresolved IDs and per-field/per-operation blockers. It observes known
groups through the existing native process API without signaling or adopting any process. Optional inventory input
must be an operations-authenticated decision with a single document: `version: 1`,
`kind: "publication-native-inventory"`, `owner`, actual `host` and `boot`, UTC `observedAt`, `retainedSetSha256`, and
`controller: { manager, sessionId, identity: { pid, start, boot, group } }`. Its host/boot/controller and exact retained
set must match, including the current receiving operations session; observations older than five minutes or more than
30 seconds in the future refuse. All supplied bytes
and provenance are retained. A caller's `noUnknown`, visibility flag or release marker never certifies completeness.

The current native API exposes incarnation and process-group membership. It does **not** supply a complete host-wide
native/legacy publisher/capture discovery producer, or recover a missing original capture/preview terminal and its
child/pipe settlement. Preparation reports those exact unavailable capabilities instead of repeatedly demanding a
nonexistent original PID. It also reports that the installed controller's lifecycle/compatibility release receipt and
private Wrangler deployment/account credential availability have not been verified. It does not read or disclose
credentials, contact a provider or treat a public GET as custody evidence. Even when all individually known originals
settle, a reconciled journal cannot make launch eligible with the old caller-authored bootstrap attestation. Complete
native inventory capability and validated runtime remain required; source presence is neither.

Resolution is a separate owner-authenticated decision with `version: 1`, `kind: "publication-legacy-resolution"`,
`owner`, `controller`, and `resolutions: [{ id, evidenceSha256, originalIdentity: { pid, start, boot, group },
nativeInvocationId, terminalReceiptSha256 }]`. Positive resolution currently requires the **actual original** managed
publisher invocation and exact terminal receipt in the native database, its recorded close/descriptor and complete
known-member settlement, original source/identity equality, terminal custody and fresh empty groups for every retained
member. Reused PIDs, surviving members, unknown children/visibility, mismatched preview/capture identities and arbitrary
terminal JSON refuse. The descriptor assertion covers the controller's own log descriptor; it does not certify unknown
inherited descriptors or host-wide visibility. Identity-less publisher evidence also needs an original native producer
binding it to its invocation; a supplied identity cannot create that link. Capture and preview lack an existing managed
terminal producer that can certify their original child/pipe settlement; the route durably returns the concrete
unavailable field and keeps them occupied. There is no
administrator override, TTL, dropped field or stopped-task shortcut. Resolution replay returns its original receipt;
conflicting resolutions cannot rewrite it.

Receiving returns zero for truthful durable acceptance, including occupied custody; status is observational. Preparation
returns one with its unavailable receipt; a resolution with unavailable originals also returns one. Every preparation
receipt states `launchReady: false`, `authorityChanged: false`, `workflowInvocations: 0`. These receipts are separate
from publication execution, live-source equality and owner delivery. The retained single allowance and all failed-no-repeat
history remain intact. Original acceptance, native lifecycle, installed compatibility, complete host visibility and
release checks belong to the native controller after source integration; typing cannot establish that journey.

#### Width governor

The independent manager-host sweep checks worker width every minute and delivers at most one wakeable width event per
Goal in each UTC 15-minute bucket when fewer than ten current attempts have live process identities and known ready,
pending-start, held or stopped work exists. The event reports the current running and Codex counts, unknown process
evidence, and known work counts. Ready, held, waiting and stale-identity attempts do not count as running. The manager
is alerted based on confirmed live workers only; unknown process identities remain explicit evidence and do not
suppress a low-width notice. Events retain their Goal metadata for shared inbox queries. The event tells the manager
to recover, reshape or dispatch real work, to act on each stopped task within an hour (retry with a rewritten brief,
split or cancel) and to keep at least eight ready briefs in its backlog. Runtime metadata cannot observe unsubmitted
work, so Markdown files outside the task inventory are not counted. The notice uses the existing manager turn
allowance, with at most one width event per Goal per 15-minute bucket; an identical event within the hour folds into
the earlier one (see [shared inbox](#shared-inbox)). Paused, budget-limited and completed managers are protected.

#### Goal backlogs

A manager's output is ready briefs; the controller dispatches them. Each Goal has a backlog directory,
`<state>/backlog/<goal>/`. Every minute the manager host starts one backlog run, `goal backlog dispatch`, as a child
process, like promotion: dispatch runs Git and dependency installation synchronously, which must never block the
host's socket. The host skips the minute while the previous child is still running, and the run holds the
`leases/backlog` lease, so only one run exists even across a host restart. Each run:

- **Dispatch.** While running and ready tasks are fewer than the cap (`maxWorkers` in `<state>/capacity.json`, else
  32), the sweep dispatches up to four of the oldest `*.md` briefs, by modification time, round-robin across Goals,
  starting with the Goal served longest ago. A brief changed in the last ten seconds waits for the next run. It uses
  the `goal dispatch` path to create the task and records its first start as a durable start request, which the host's
  next orphan sweep runs and follows; the run itself never waits for host capacity or a worker. The brief moves to
  `dispatched/<task-id>-<name>.md`. Research briefs dispatch the same way. A refused brief moves to `failed/<name>.md`
  beside `failed/<name>.reason`, and the event names the archived brief. Decision: keep the first failed name and use
  the next numeric suffix for later collisions; write the reason first and resume it only when its brief fingerprint
  matches.
  A brief
  left in `.dispatching/` by a host that stopped after creating the task is archived once as
  `dispatched/<task-id>-<name>.md` when exactly one unarchived task in that Goal has the same brief text; with no such
  task the claim returns to the ready backlog and ordinary dispatch continues; several matches move the brief to
  `failed/` with a reason that names those tasks. Decision: match interrupted new-task claims by exact Goal and brief
  markdown among tasks that have no `dispatched/<task-id>-*` file yet.
- **Continuation.** To resume an existing stopped task, put its rewritten brief in the same Goal backlog with
  a `continuation` object in the YAML front matter containing the task ID and current attempt number. For example:

  ```yaml
  continuation:
    taskId: 550e8400-e29b-41d4-a716-446655440000
    expectedAttempt: 3
  ```

  Decision: require the exact expected attempt and make interruption replay reuse only that owner's pending retry.
  The controller authenticates the current owner session, checks the exact Goal, manager and attempt, then records a
  normal pending retry under the task lease. It keeps the task's branch, worktree and provider session; the host starts the retry
  through its existing recovery path. The consumed brief moves to `continued/<task-id>-<attempt>-<name>.md`. A valid
  claimed continuation returns to the ready backlog after a controller interruption so the pending retry can be
  recognized idempotently. Stale, foreign, cancelled, live or otherwise ineligible tasks move to `failed/` with a
  reason. Briefs without this marker continue to create new tasks.

- **Stopped tasks.** A product task that has been `stopped` for more than 60 minutes since its last event, with no
  pending retry, is cancelled through the `goal cancel` path, at most 20 per Goal per run, longest stopped first. Its
  brief is written to `failed/<task-id>.md` and its blocker and branch to `failed/<task-id>.reason`; each owner
  receives one event per run listing those tasks. Control-plane, stabilize and verification tasks are exempt.
- **Low backlog.** A running, active Goal manager whose backlog holds fewer than eight ready briefs receives at most
  one event an hour asking it to keep at least eight. Only non-hidden `*.md` files directly in the Goal's backlog
  directory count as ready; at eight or more, no low-backlog event is sent.

`goal backlog status [--json]` prints ready, dispatched and failed brief counts per Goal. It reads only the
directories. The run's one-line JSON results are appended to `<state>/backlog-runner.log`.

#### Cost: backlog run

- **Touches:** one indexed count of running and ready tasks, the stopped tasks through the task-state index with one
  latest-event lookup each, the running manager rows, and the backlog directories' entries.
- **Bound:** at most four dispatches and 20 cancellations per Goal per run, outside the host process; the stopped scan
  is proportional to stopped tasks, not task history.

### Check result reuse

Landing and promotion checks record only clean, successful runs. Each result is keyed by the normalized command, the
allowlisted environment (`CI`, `DATABASE_URL`, `NODE_ENV`, `PATH`, `PLAYWRIGHT_BROWSERS_PATH`, and `TZ`), the Git tree
ids for the command workspace and its `workspace:` dependency closure (or the whole tree for a root command), global
inputs such as the lockfile, root package manifest, scripts, contracts, specs, patches, and lint/format configuration,
and the Bun revision, service images, OS/architecture, and key schema version. Results expire after seven days.
Lookup and record reuse a stored row only when its schema is current and its time is a finite timestamp in that window ending at the read or insert instant; incompatible rows are declined rather than deleted.

Failures, timeouts, interrupted or partial runs, infrastructure failures, dirty or modified worktrees, install and
generator commands, and checks that depend on external live state (including mail, payments, clocks, and capability
reports) are never reused. `integration.checkResultReuse` defaults to `false`. In this shadow mode a matching result is
logged as `check-results: hit <key>`, but the check still runs; misses are logged too. If a fresh run fails after a hit,
the supermanager receives one alert with links to the earlier and fresh logs.

```sh
bun tools/goal/src/cli.ts status [task]
bun tools/goal/src/cli.ts retry <task> [--brief <file>] [--fresh-session]
bun tools/goal/src/cli.ts stop <task>
bun tools/goal/src/cli.ts cancel <task>
bun tools/goal/src/cli.ts consult <task>
bun tools/goal/src/cli.ts attempts --json
bun tools/goal/src/cli.ts report [--json]
bun tools/goal/src/cli.ts land <task>
bun tools/goal/src/cli.ts train
bun tools/goal/src/cli.ts verify
bun tools/goal/src/cli.ts manager start <goal> --engine codex --budget 20000
bun tools/goal/src/cli.ts manager register-supermanager
bun tools/goal/src/cli.ts manager renew <manager>
bun tools/goal/src/cli.ts manager stop <manager>
bun tools/goal/src/cli.ts manager complete <manager>
bun tools/goal/src/cli.ts inbox wait <manager>
bun tools/goal/src/cli.ts inbox read <manager> [--limit <1..100>] [--cursor <id>]
bun tools/goal/src/cli.ts inbox ack <manager> [id ...]
bun tools/goal/src/cli.ts inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>]
```

`status`, `attempts` and `report` are read-only: they do not recover orphans, record manager commands or drain queued
work. For held tasks, `status` keeps `waitingFor` as the blocking dependency IDs and adds `dependencies` entries with
their state and readiness. Missing or malformed dependencies have state `unknown`; readiness follows the same target
and integration-commit policy used to release held work.

`retry <task> [--brief <file>]` retries a task, optionally replacing its brief after checking that its Goal and manager stay the same. Brief comparison canonicalizes line endings to LF and ignores trailing end-of-file whitespace. If the supplied brief matches the current contract after that normalization, the command reports that the contract is unchanged and exits without starting another attempt. A changed brief records SHA-256 hashes of the previous and new contract on the new attempt; a stopped task can still be restarted with plain `retry <task>`.

For an attempt that has started, `stop` and `cancel` persist the requested disposition before signaling its recorded process groups. `status <task>` shows `terminationRequest` as requested, unknown or complete; missing process identity stays unknown and is never reported as physical termination. Host recovery resumes that same request and records its terminal result once. A stop abandons any retry already queued for that attempt; a later explicit retry queues a new one.
The request fences worker settlement and replacement until its disposition is committed (`settledAt`). Physical
confirmation alone does not authorize a retry. Recovery leaves a later explicit retry of a settled stop queued.

A retry resumes the previous attempt's provider session while the pool, CLI and model stay the same. `--fresh-session`
starts the next attempt in a new session instead, keeping the branch, worktree, commits and uncommitted work; the
choice is kept on the task through capacity waits, dependency holds and restarts, and the attempt it creates consumes
it, so later retries resume again. It combines with `--brief` but not with the proof options.
Explicit retries are recorded with their amended brief as pending host start intents and return without waiting for capacity. The host consumes pending intents on recovery ticks in their saved order, starting each once as capacity becomes available.
Product work integrating into dev can be retried at any generation: `retry <task>`, with or without
`--expected-attempt 0`, also starts a never-started task, and `--brief` also amends a retry that is still waiting to
start, which keeps its place in that order and its options. Other work refuses a second retry while one is pending;
before its first start it is amended with `amend` or, for verification, registered with the proof start below.
`cancel <task>` stops a running task, marks it cancelled, and removes it from its Goal's completion scope. Tasks held
after it remain held because cancellation does not satisfy `after`; each manager that owns those held tasks receives one
instruction naming the held tasks and cancelled dependency. During host recovery, a held task with a cancelled
dependency that predates this notification is reported once to its manager. The manager decides whether to revise the
dependency.
Cancellation notices use the committed cancelled generation without reopening ordinary worker writes; genuinely stale command generations still refuse.
A held amendment keeps its old live attempt's ownership until settlement, even if its dependencies integrate first.
The next host sweep can then release it under the task lease and start the amended contract from the updated base.
An unstarted held task can use `retry --brief` on the same task id to replace the brief and dependency edges while keeping attempt 0, its branch, worktree and uncommitted files. The host creates its first attempt once the new dependencies are merged.
An amended held contract starts a fresh provider session after its old worker settles. A check waiter with saved checks
and no terminal attempt record can continue its original session with the current contract; retained check IDs on a
terminal attempt do not make it a check continuation. An unchanged held retry retains its supported session resume.

`inbox read` prints a JSON page (`entries`, `limit`, `hasMore`, `nextCursor`) in existing oldest-first event order.
Continue from `nextCursor`. Only returned events become read. `inbox ack <manager>` acknowledges every already-read
event for that recipient; passing ids acknowledges only those rows. Unread later-page events stay pending. `inbox wait`
returns one unread page so a later wait continues from remaining work. Decision: reuse the shared-inbox page size rather
than a second wake scheduler.

`inbox send` delivers a one-line decision event to another manager and records the sending manager as its source.

`land` and `train` use the same queue and sink as dispatch. Every `manager` command starts the manager host when needed;
the host persists until stopped and exits when its 60-second sweep finds its state directory missing. An untracked
`<managerDirectory>/<goal>.json` can select a local `pool`, `objective`, `brief`, `effort`, `supermanager` and `limits`;
otherwise scoped task briefs and a matching local manager pool supply the defaults. Termspaces owns the tmux windows.
Each manager host starts a loopback WebSocket app-server for its Codex pool and records the process identity. The host
stops those app-servers on shutdown, and a replacement host stops any surviving app-server before resuming persisted
threads. Recovery reopens each Codex viewer on the current endpoint with `codex resume <thread> --remote <endpoint>`.
The neutral host and shared app-server start with inherited provider session markers removed. Each manager launch then
uses its selected provider account: Codex pool processes receive that pool's `CODEX_HOME`, while Claude receives its
configured `CLAUDE_CONFIG_DIR`. Managed manager recovery follows the normal host code-version handoff: after Goal code
changes, the host reexecutes from the current checkout, reopens persisted sessions, and resumes each stored provider
session while keeping its manager history and budget. An already-running provider keeps its original environment until
that handoff; the host does not edit a live process environment. A resident supermanager remains an external session
and is never launched or resumed by host recovery. Codex managers use a goal budget. Claude uses its configured
executable and configuration directory, interactive window and turn-accounting hooks.
Every Codex manager `turn/start` pins `gpt-6.1-sol` and the manager's configured effort, including the opening,
idle inbox wakes, and renewed continuation threads. The app-server `turn/steer` request accepts input and an
`expectedTurnId`, but no model or effort override, so steering keeps the active turn's pinned settings. Recovery and
turn-race rejoins pass the same model plus the manager's effort and `compactTokens` through `thread/resume`. Forwarding
the threshold does not prove that compaction occurred.

The host listens before it resumes persisted managers, and recovers managers independently so one provider request
cannot prevent another manager from using the socket. Commands from a recorded manager session store a deduplicated
decision against its active turn in local SQLite; turn accounting uses that durable record without a manager socket
round trip.
An authenticated Goal manager can run `land <task>` for a task it owns once the current worker attempt has settled as
`landing`. This readiness state requires the current attempt to have exited successfully, reported success without a
blocker, and retained its `pending-gate` record; the branch must contain committed work and have a clean worktree.
`ready` means work is available to start or retry, not that it has passed worker acceptance. The command records the
accepted branch commit and the exact acceptance command from the task brief, upgrades that attempt's existing durable
queue request, then hands the ordinary train to the controller. A foreign manager, a worker process, an old attempt,
or caller-supplied evidence is refused. Repeating the command after authorization or integration does not enqueue or
handoff again. In manager context, worker settlement records the ordinary queue request without starting the train; the
manager's `land` command authorizes that same request and hands it to the controller. The manager does not run gates or
merge Git refs itself.

The train keeps its current-attempt fence, source ref and commit checks, scope and protected-path validation, candidate
attribution, lineage checks, target compare-and-swap, and durable outcome record. It retains the original worker
acceptance evidence instead of scheduling that same task acceptance again before integration. The post-integration
development verifier runs acceptance on its captured `dev` head, alongside typecheck and affected checks; that
verification is recorded separately from the worker's original acceptance. A control-plane release still runs the full
mandatory control-plane lifecycle checks on its `main` candidate before the controller advances `main`; promotion
always gates its own frozen integration candidate.

### Development verification

Landing on `dev` is a mechanical integration step. A single leased verifier checks each new `dev` head independently
after the merge train has landed its batch; it cannot hold the train lease or block later ready landings. It starts
from `dev-verified`, runs the root typecheck with the exact `TYPECHECK_CHANGED` closure, matching `verifierChecks`,
non-spec sibling tests and each landed task's acceptance command (except specification and research tasks). Checks
use normal remote admission. Passing verification advances `dev-verified` with a compare-and-swap. Workers, retries
and rebases use that verified ref as their base, and promotion cuts stabilize candidates from it. `status` reports the
verified commit, how many landings `dev` is ahead, and whether verification is pending, running or current.

When a check fails, the verifier narrows suspects by the failing command's workspace closure and bisects only those
landings. For an affected-check failure after a conflict resolution, it attributes the failing integrated resolution
commit to that resolution task's original manager, even if an earlier owner's source commit passes the check. It reverts
only the culprit's integrated changes in one commit, returns the task to its manager with the exact failing log, and
keeps the worker's source branch available for the owner's fix. It then advances the verified ref past the culprit so
the fix can start from that verified base. A transport or other recognized infrastructure failure during a culprit
probe is retried up to twice and remains unassigned if it still cannot run; it is not treated as an assertion. This
moves expensive checks after integration and lets a batch share them while keeping unstable `dev` separate from
promotion's verified input.

When a Codex manager reaches 90% of its token budget, the host delivers one instruction to replace
`.temp/goal/<manager>/CONTINUATION.md` with at most 8,000 characters (live task IDs, decisions in force as links to
owner documents, and next actions), without appending to the old file, then message its supermanager with
`continuation written`. A confirmation or a `budgetLimited` Goal
automatically pauses and renews the manager with a fresh thread. If the continuation file exists, the new thread's first
prompt names it; the supermanager receives one environment event with the old token count and new thread. A manual
`manager renew` also accepts Codex Goals in `budgetLimited` or `blocked` status without a separate stop.

Manager events are committed to SQLite and signaled through filesystem notifications. Inbox waiting has no sleep loop.
The control plane's manager wakeup path is event-driven: the opening tells a manager to end the turn when no decision
is pending. When an event is delivered, the host steers it into the manager's active turn or starts a new turn on the
persisted thread; if the app-server has not loaded that thread, the host resumes it once and starts the turn there. The
opening also states the manager's outputs (ready briefs in its backlog and decisions), the stopped-task hour, the
message limits, and that the brief and continuation are read once per session. The host counts `clock.sleep` items per manager and UTC hour;
the eleventh in an hour sends the supermanager one `environment` alarm and the manager one correction. For the
turns-without-decision limit, a turn in which a ready brief in the Goal's backlog was written or moved back (by
modification or status time), or a brief the backlog run dispatched was written, counts as a decision, as any
control-plane command already does.
This controller behavior does not disable native Goal continuation. The installed `codex-cli 0.164.0` experimental
bindings, generated with `codex app-server generate-ts --experimental`, expose no persistent idle-continuation setting
in `ThreadGoalSetParams` or `ThreadSettingsUpdateParams`. `ThreadForkParams.deferGoalContinuation`
only delays the fork's first continuation; automatic continuation resumes after the next explicit turn. Regenerating
those bindings from this installed CLI still yields only `threadId`, `origin`, `objective`, `status` and `tokenBudget`
on `ThreadGoalSetParams`, and no continuation field on `ThreadSettingsUpdateParams`. The provider
must add a persistent policy that keeps an active Goal and its budget tracked while waiting for an explicit controller
turn. That policy must survive thread resume and explicit inbox turns without changing the objective, budget, usage,
thread or worker sessions; it must leave autonomous controller work running. Integration requires a provider API that
acknowledges the policy and restores it after host recovery. Until that prerequisite is available, retain active Goals
and the supported inbox wakeup path; do not send an invented configuration key or treat the opening prompt as scheduler
control. Resident startup and recovery send only those five `thread/goal/set` fields, keep the existing thread through
resume, and parse 0.164.0's ANSI-colored `readyz:` line (`NO_COLOR=1` and CSI stripping) so the host can connect.
The recovery test covers controller dispatch, not suppression of native provider turns. See the
[official OpenAI Goal lifecycle documentation](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
for the independent native continuation behavior.
Managers receive only decisions requiring judgment; gates, merges and mechanical reruns do not wake them. Completion is
a proposal: `manager complete <goal>` records the request and returns immediately while the host checks that all scoped
tasks are merged and the main gate passes in an isolated checkout. The gate checks the main commit captured when it
starts; its result remains valid while that commit is an ancestor of main, since the landing train gates every later
commit. When the check finishes, the manager and its supermanager receive a waking `goal-met` or `goal-unmet` event.
An unmet event includes the first gate failure in its summary and links to the completion evidence. A met event is
delivered after the manager stops. Manager events are attributed through `GOAL_MANAGER` or a registered Codex thread;
priority authorization requires the persisted provider session identity described above, so a worker-supplied
`GOAL_MANAGER` cannot grant or consume critical priority. Workers get fresh session identities.
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

## Control plane on dev: cp-sync

Control-plane changes iterate on `dev` with the products: a `control-plane` brief without a `target` lands there
mechanically, like product work. `cp-sync` is their release gate; it makes dev's `tools/goal` live on `main` without the
main-release proof:

```sh
bun tools/goal/scripts/cp-sync.ts --dry-run
bun tools/goal/scripts/cp-sync.ts
bun tools/goal/scripts/cp-sync.ts --rollback
```

Run it from any checkout; it finds the main checkout by its checked-out `main`, and requires `main` to be inside
`dev`. It adds a temporary worktree of the current `main` head in `../worktrees` beside the main checkout, replaces
its `tools/goal` with dev's (`git checkout --no-overlay`, so dev's deletions apply) and checks it there: root and
`tools/goal` installs, the `tools/goal` type check, a config smoke, and a CLI smoke. The config smoke runs
`bun tools/goal/scripts/cp-config-smoke.ts` with `GOAL_MAIN_CHECKOUT` and `GOAL_LOCAL_CONFIG` naming the live checkout
and its settings, and invokes the candidate's `checkSettings` and `readRouting` against those live files (the local
settings and the routing table they name). `checkSettings` is strict and writes nothing, so the gate cannot create
last-valid snapshots, launch workers, signal processes or touch live controller state. Numbered routing versions
parse as their labels. A mismatch names the file and field, with secrets redacted, and refuses before any ref or
checkout move. `goal status` loads settings but not the routing table, so it cannot catch this class by itself.

The CLI smoke is `bun tools/goal/src/cli.ts status` with the same live checkout and settings. Its state directory
holds a copy of the live `goal.sqlite` made by `VACUUM INTO` over a read-only connection, so the candidate's
migrations and orphan recovery act on the copy; `GOAL_MANAGER` keeps that recovery from handing a train to a
detached process that would act on live refs. cp-sync never writes the live database. Each step runs in its own
process group under a time box. Children otherwise get no `GOAL_*`, `CLAUDE*`, `CODEX_*`, Git location or
secret-named variables, and output is redacted before it is printed or written to `.temp/goal/cp-sync/<run>/`.

Before the checks it lists the root files dev's `tools/goal` loads by relative path (imports and `import.meta.dir`
joins, followed through their own imports) that differ from main's, as runtime or test references, and main's root
configuration that names `tools/goal` paths the candidate lacks. The checks use main's copies of root files;
`--include <path>` (repeatable) also syncs a named root path from dev. `tools/goal` has its own lockfile, so its
dependencies travel with it.

The candidate is committed as `control-plane: sync tools/goal from dev <short sha>` on the detached worktree before
the checks, so tests that read the checkout's HEAD see it, as in the main-release proof.

Every step must exit 0. `--full` adds the main-release proof's suite, `bun test --timeout 30000 tools/goal/src`,
stopped and reported after 30 minutes. The suite does not pass on an unmodified fresh checkout of main, so it is
gated on no new failures: it must finish with every counted failure named, and every failing test (keyed by file and
name) must also fail when the installs and suite run on a worktree of unmodified main. That baseline runs only when
the candidate's suite fails and is cached per main commit in `.temp/goal/cp-sync/baseline-<main>-<checks>.json`; a
full sync records the published commit's result as the next baseline, and `--fresh-baseline` reruns it. Failures
main lacks get one rerun of their test files; those that pass then are reported as flaky, and any that fail again
refuse the sync. Each run's step results are in `.temp/goal/cp-sync/<run>/results.json`. Processes still running in
a temporary worktree, such as detached test fixtures, are stopped before it is removed.

Only when the gate passes does cp-sync publish. It first moves the main checkout's index and files with
`git read-tree -m -u <old> <new>`, then moves the refs in one `git update-ref --stdin` transaction against their
captured values: `main` to the sync commit, `stabilize` (when present) to a merge of it that takes main's
control-plane paths, and `dev` to a merge that keeps dev's tree. Main stays inside stabilize and dev, so promotion
still fast-forwards and the next sync finds main inside dev. A failed transaction moves the files back.
(`git merge --ff-only` cannot do this step: once the ref has moved, the checkout's HEAD already names the new commit.)
Running processes hand over on the new `main:tools/goal` as after any control-plane release. If
`tools/goal/package.json` or its lockfile changed, cp-sync reinstalls in the main checkout. Each sync appends the
previous and new main, stabilize and dev heads to `.temp/goal/cp-sync-history.log`.

cp-sync refuses when the main checkout has uncommitted or untracked files under the synced paths, when `main`
moved, when stabilize changed control-plane paths that dev lacks, or while another run holds `.temp/goal/cp-sync.lock`.
`--dry-run` does everything except moving refs and the checkout, prints the diff stat, step results and the ref moves
it would make, and exits 1 when a real run would refuse. Unlike a real run, it runs the later steps after a failed
type check. `--keep-worktree` keeps the temporary worktree.

`--rollback` restores the synced paths of the main commit before the newest sync not yet rolled back, and refuses
if main moved since the last cp-sync. The repository's reference-transaction hook lets main move only forward, so the
rollback is a new commit holding that tree, published the same way. Dev keeps its code; stabilize takes the rollback
unless it already has newer control-plane code, which its next promotion republishes. Fix forward on dev, then sync.

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

## Promotion placement and observations

Future full promotion gates can opt into the measured one-host placement by adding this field to the untracked local
`.temp/goal/local.json`:

```json
{
  "promotionPlacement": {
    "ordinaryHostsFile": ".temp/goal/remote-check-hosts.json"
  }
}
```

The path is resolved from the main checkout. It must name the existing untracked ordinary remote-check host input in
the public `{ "hosts": [...] }` schema. Goal reads it through `scripts/remote-check.ts`'s `readHosts` export, checks
the measured a/b/c topology, then writes a c-only derived host file under the state directory. It preserves c's
address, SSH identity, slots, memory limit and CPU quota from that input; it does not edit or replace the ordinary host
file. Missing or changed input, a different host topology, a tracked source, or an invalid gate command fails closed.

For the existing full root gate, Goal derives the supported command
`env KERNEL_CHECK_CONCURRENCY=5 KERNEL_CHECK_REMOTE=<derived c-only file> GATE_REMOTE_SLOTS=3 bun scripts/gate.ts`.
The root script forwards those existing settings to its remote invocation. Both workspace groups keep full coverage;
the one-host gate uses c's existing four ordinary slots, so its two three-slot groups serialize. This is prospective
placement policy, not a measured throughput result. With one gate holding three slots, ordinary worker capacity is
11/14 slots (78.57%); counting only a and b leaves 10/14 (71.43%). The groups can take longer when serialized.

Root/controller owns the live migration: review the exact source path and local command, then add
`promotionPlacement.ordinaryHostsFile` to its untracked local settings. This implementation does not edit live
`local.json` or `gate-hosts.json`, interrupt an active gate, or run a gate. Ordinary verifier priority and concurrency
three stay as configured. Promotion still uses the frozen candidate and publishes only after the full gate passes.

Goal persists logical parent and group windows, including separate enqueue, wait, logical admission, preparation,
execution and terminal times, and stores bounded command metadata. Current public `scripts/remote-check.ts` exposes no
structured host/run/incarnation/cgroup custody descriptor or terminal custody event. Until its existing owner supplies
that public boundary, physical status and CPU/memory samples remain explicitly unavailable (`NULL`), never inferred
from nested log text, caller exit codes, or missing timestamps. The exact measured decision and current evidence are in
[`reports/delivery-lessons-20261030.md`](reports/delivery-lessons-20261030.md).

The logical candidate commit is not proof of the source revision that a remote client actually launched. Until the
producer returns an authenticated launch source revision, `scripts/remote-check.ts` hash, integrated producer
revision, and client cohort, those source fields also remain `NULL`; passing local producer tests establish source
integration, not rollout into an already queued client.

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

The control plane is agent-agnostic: CLI commands, session resume, exit parsing and agent-specific signals belong behind
`AgentAdapter` in `src/agents.ts`. To add an agent, implement an adapter under `src/agents/`, register it in the adapter
map, extend the `Cli` type in `src/types.ts`, and add tests for start/resume commands, output/session parsing and quota signals. Normalize provider events with
`parseEvent`; the control plane aggregates tokens, tool steps and final answers without knowing the provider event
format. `readSession` supplies optional session accounting, and `readAllowance` supplies pool observations. Existing
quota-parser exports remain available for historical imports. Test an adapter through the real worker lifecycle with
`withAgentAdapter`, whose binding stays local to that asynchronous lifecycle. Agents that cannot resume set
`canResume` to false; retries then start a fresh session with the retry manifest.

## Baseline findings and release gates

This policy supersedes the earlier `Development verification` overview above. `dev-verified` records verifier progress
and known findings; it is not a green release gate. For every captured `dev` head, the verifier compares every selected
head check with the exact previous `dev-verified` commit under the same command selection, environment and concurrency
limit. Selection uses `verifierChecks` (or legacy `affectedTests` when unset), the root typecheck with its exact
`TYPECHECK_CHANGED` paths, candidate sibling tests for non-specification files, and landed task acceptance commands
except for specification and research tasks.

A stable assertion that fails at both revisions is durably recorded as an existing finding. It does not block the
verification progress ref or earn a task a success receipt. A head assertion absent from the baseline is new and may
be attributed only to a task whose integrated range can affect that check. The verifier reconciles every head result
and its individual baseline comparison before advancing; a passing retry for one command cannot cover another
unresolved failure. Stable assertion evidence distinguishes an existing failure from a different new failure in the
same command. Unknown setup, absent commands, transport or other infrastructure errors, and incomplete output remain
unknown rather than clean baseline results. Findings and exact run evidence are bounded and stored in SQLite so an
unchanged finding does not start another sweep after restart. Baseline runs, probes and retries all share the ordinary
three-check concurrency cap.

Each fresh verifier tree installs its own dependencies, even after an earlier tree's setup passed. Installation uses
an available matching repository Bun or bootstraps with the verifier process's Bun, and logs the executable used.
Checks still require the installed pinned Bun; an actual installation failure remains infrastructure.

Promotion selects the latest eligible integration head by its expected ref identity. It does not use an older
`dev-verified` ref to pin a candidate. Each frozen promotion candidate still passes its full required gate, ancestry,
quarantine, stabilization, ref-race and publication checks; known verifier findings do not turn a failed promotion
command into a pass.

Daily audit validation and dispatch exceptions are contained in the host. A durable daily claim prevents retries on
later sweeps or host replacement; `flow_audit_failures` retains the original exception and stack. Its environment
notice and delivery acknowledgement commit together in the SQLite inbox, with failed notice delivery retried on a
later sweep. A new UTC day may dispatch again. The template grants only `tools/goal/reports/daily-step-audit-*.md`,
which passes the existing risk ownership validator without granting product risk areas.

The host also starts an independent supervisor, fenced by `manager-host-supervisor.lease`. It checks only its recorded
host process identity (PID, start time, boot and process group); it never scans or kills workers. A dead host is
relaunched through a shared startup lease and the existing host socket lease. Restart backoff starts at 250 ms,
doubles on repeated failures up to 30 seconds, persists across supervisor replacement, and resets after 60 seconds of
host survival. Detection polls once a second. Host startup errors remain in `manager-host.log`, supervisor errors in
`manager-host-supervisor.log`. Graceful shutdown disables restart, state-directory removal ends supervision, and code
handoff uses the same fenced launch path. Provider recovery and app-server cleanup remain owned by the host.
Supervisor launch waits for fenced ownership before host readiness; a late launcher leaves removed state absent.
Host startup, supervisor launch and code handoff remove inherited provider and task session markers through the same
neutral environment sanitizer, preserving configured Goal paths and the invoking working directory.

Integration, cancellation and stopping explicitly close pending flow stages without fabricating successful stage
completion or duration. Reporting also uses stored terminal task state to exclude legacy stale queue entries. An
integrated task may still await promotion; promotion remains visible until merging, cancellation or its recorded
completion. Live tasks and phases without observed end times retain their existing uncertainty.

### Original integrated journey proofs

Current receiving operations (authenticated owning manager or configured operations manager):

- `WorkerTasks.queueProofStart(taskId, { expectedAttempt, brief?, removeAfter? }, actor)` or
  `bun tools/goal/src/cli.ts retry <task> --proof-start --expected-attempt <generation> [--brief <file>] [--remove-after <lane>]`
  saves the exact registered original and one durable start intent. It returns `created`, `waiting` or `pending`.
  A stopped/exited current attempt can capture fresh current dev directly, including when old native reservations
  remain UNKNOWN; no separate logical-release operation or custody disposition is required.
- `WorkerTasks.releaseProof(taskId, expectedAttempt, actor)` or
  `bun tools/goal/src/cli.ts retry <task> --release-proof --expected-attempt <generation>`
  optionally reconciles the current stopped or exited run's logical reservation. It returns `status: released` and the retained check UUIDs;
  it never starts, stops or signals checks, replaces bindings, fabricates results or releases physical resources.

Ordinary proof policy supersedes mandatory native binding/custody admission: authenticated registered verification
runs its exact original acceptance once through the existing worker-check protocol. Native binding and custody are
optional evidence. Product and fix tasks retain minimal verification. Native and physical lease accounting remains
independent of logical admission. The implementation and local typing still require controller combined-release validation.

`kind: verification` is an ordinary Codex worker on the implementation route. It is a read-only proof record,
separate from a source task: it needs no declared source paths, source estimate, edit, commit, receipt or landing.
The authenticated owning manager, or `integration.operationsManager` when configured locally, registers it through
normal dispatch, converts an existing stopped task through `retry --brief`, or registers the first start of a
never-started task through `retry --expected-attempt 0`. A verification brief cannot
choose critical priority, frozen inputs, product paths, a different target or a local placement override.

For example, write `.temp/goal/original-proof.md` with the following front matter and a read-only journey description.
Replace the example source task and full commit with the retained original and captured integration head, and copy
that original's acceptance argv exactly (the example presumes that exact original command):

```yaml
---
goal: web
manager: web
kind: verification
proof:
  journey: Original navigation journey
  sourceTasks: [original-task-id]
  sourceCommit: 0123456789abcdef0123456789abcdef01234567
riskAreas: []
acceptance:
  command: [bun, test, apps/web/tests/navigation.test.ts]
  tests: [Original navigation journey]
  failing: false
criticalPath: false
waiting: []
---
Observe the original journey on the captured source. Source and tests are read-only.
```

From that authenticated manager session, register with
`bun tools/goal/src/cli.ts dispatch .temp/goal/original-proof.md`, or continue the same stopped task with
`bun tools/goal/src/cli.ts retry <existing-proof-task> --expected-attempt <current-generation> --brief .temp/goal/original-proof.md`.
Neither command reopens any integrated source original. All originals must belong to this Goal and owner and be
integrated or merged ancestors of the captured commit. A group retains every whole identical original argv, or the
ordered deduplicated union of explicit Bun test files or Kernel/Auth `bun run --cwd <service> check` files
with identical raw prefixes, including cwd/env arguments. Service file lists include every helper before, between and
after tests, starting at the first input. Exact whole original Auth/Kernel workspace checks require their same-Goal
integrated original provenance; they need no invented explicit test list. Mixed bare and `env -u` groups stay separate.
Shortened selections, changed flags and broad root/gate campaigns are refused. Explicit command files must exist in
the captured Git tree before execution can be granted. Advancing integration invalidates that capture.

For a never-started held task, submit the typed brief on the SAME task id:

```sh
bun tools/goal/src/cli.ts retry <task> --expected-attempt 0 --brief .temp/goal/original-proof.md --remove-after <obsolete-lane>
```

Repeat `--remove-after` for each obsolete dependency removed by the submitted brief, and omit it when none is removed.
The approved list must match exactly: conversion never implicitly drops an old dependency. Other dependency edges
remain effective. A typed READY0 contract already accepted with a valid capture needs no resubmission: normal
`WorkerJob.start(taskId, { expectedAttempt: 0 })` starts it once; the host also recovers dispatches that died before
that first start.

The public receiving method is `WorkerTasks.queueProofStart(taskId, options, actor)`, where `ProofStartOptions` is
`{ expectedAttempt: number; brief?: string; removeAfter?: string[] }`. The explicit CLI is
`retry <task> --proof-start --expected-attempt <current-generation> [--brief <file>] [--remove-after <lane>]`.
Generation zero also retains the existing `retry --expected-attempt 0` spelling. A retained exited product/claim
attempt does not itself constitute a proof start. The same API also accepts a stopped/exited verification generation;
its past reservations and command-ready events are retained evidence, not future-admission prerequisites. It returns `ProofStartRegistration` with
`{ taskId, attempt: number, status: 'created' | 'waiting' | 'pending', reason?: string }`. `created` means the normal durable
start intent was saved and is eligible; `waiting` means dependencies or owned proof capacity defer it; `pending` names
unavailable source or preparation, without a fabricated check UUID. These are registration outcomes, without a worker/check id or a model launch.
Missing inputs, stale generations, invalid captures, unauthenticated owners and invalid transitions are refused before
execution. No `queueRetry` at generation zero or duplicate task is needed.

Both boundaries authenticate the live owner or configured operations manager and persist authorization, typed contract
and intent together through the existing SQLite lifecycle under the task lease. A stopped current generation can
register without using the ordinary stopped-attempt write fence. Its raw attempts, sessions and reports stay intact;
its historical attempt classification never becomes a registered proof. Running owners, cancelled/integrated tasks
and stale generations cannot convert. Source refresh requires a new authenticated registration before the NEW attempt's
reservation, native intent or proof worker start. An exited historical product/claim generation is eligible: its raw
attempt, report, session, sequence and classification remain unchanged. For an already typed contract, refresh retains
the exact journey, sourceTasks and acceptance argv and updates the one existing pending start intent atomically under
the expected generation. A reserved incarnation's source/token never changes, even after release. A future capture
on the same task requires only normal authenticated stopped/exited receiving, with no live current worker/driver;
it preserves that old incarnation. Historical UNKNOWN custody and unreleased reservations do not prevent the new
registration. A retained legacy product record predating `taskKind` keeps that field absent. The host keeps the same intent through capacity waits and recovery;
capacity waits never launch a model; optional unavailable custody does not block ordinary execution. A stale capture refusal names the old/current commits and exact authorized
`--proof-start --expected-attempt` refresh needed; it never runs a doomed stale check.

The retained `bun scripts/worker-check.ts --local -- bun test <files...>` prefix, including an original env
prefix, runs directly as the one ordinary invocation. Goal preserves the raw wrapper argv and never double-wraps it.
Homogeneous file unions retain every helper/test member; nested/duplicate wrappers and arbitrary shell/flags remain
prohibited. No native producer port is required for this original ordinary wrapper path.

New verification starts reuse the ordinary worker preparation and launcher. Shared dependency installation prepares
the supported pinned Bun and workspace dependencies outside SQLite, before the worker can execute its command.
Setup failure is reported as an environment/tool error with bounded diagnostics, not as a product assertion.
A clean retained branch whose commits beyond its recorded base have an empty tree diff can prepare a separate
detached worktree at the newly authorized capture. The old worktree, branch, report commits and attempt history stay
intact. Dirty trees, real source changes or an already prepared/reserved CURRENT invocation refuse this preparation; it is
never a reset, rebase, source swap under a token or manager checkout operation.

The SQLite lifecycle admits at most three current proof runs per Goal, atomically before ordinary preparation.
Pending preparation occupies one slot across controller crashes. Running and waiting ordinary proofs occupy one
slot each. `historicalProofChecks()` inspects only each task's CURRENT running/waiting attempt; older generations,
labelled command strings, stopped/exited attempts and archived historical facts do not occupy new logical slots.
A current running/waiting check remains counted even when its optional custody is unknown. Capacity waits preserve
one durable start intent without launching a model. Normal host and physical check admission remain independent.

To register a future capture after a stopped/exited proof, use the authenticated owner or configured operations
session with the exact current generation; no release command is needed:

```sh
bun tools/goal/src/cli.ts retry <task> --proof-start --expected-attempt <generation> --brief .temp/goal/original-proof.md
```

The submitted brief captures current dev and retains the exact original Goal, manager, journey, sourceTasks and
acceptance. Registration archives the previous accepted contract and its hashes, keeps the SAME task ID and one
pending start intent, and launches nothing. Normal host start creates the next attempt and one distinct ordinary
invocation. `retry <task> --expected-attempt <generation> --brief <file>` also supports this authenticated
stopped/exited registration. Running/waiting current attempts and live current worker/driver identities refuse it.
No historical ownership scan, logical-release event, optional native status or old reservation consistency is an
admission/preparation prerequisite. The old optional binding cannot select the new attempt's protocol. Neither path
authorizes changing an old binding, token, check UUID, source, result or raw history.

The optional public logical release operation above and normal host reconciliation mark the current stopped/exited reservation `released`
with a `logicalRelease` policy reason and a `proof-logical-released` event. They preserve the original binding, token,
UUID, source, raw observation (including UNKNOWN) and physical history. Release does not declare a native pass,
terminal custody, cleanup, remote capacity or lease release. Existing historical archive events are retained as facts,
including `historical-proof-terminal` events whose status is `historical-unknown` and `passed` is false. They are never
promoted into native passes. No old check is signalled or restarted by reconciliation.

Optional native evidence remains available through the existing strict `ProofProducer`, `nativeProofBinding`,
`receiveProofStart`, `observeProof` and reservation readers. Their identity, argv, token, result-path and physical
custody validation is unchanged for consumers of that evidence. Optional history reading uses the configured
`integration.checkScriptReaderRoot`: a canonical, Git-clean captured integration ancestor containing the delivered
producer and its exact native module closure, validated before import. Historical cwd is data only; old/deleted
worker code is never imported. Missing/invalid readers record a bounded `historical-proof-reader-unavailable`
diagnostic, retain uncertain native observations and never abort unrelated orphan/wake/held/retry recovery.
They do not prevent ordinary original-proof admission or success. No private source path is hardcoded.

For that optional adapter, `ProofBinding` version 1 retains the reservation token, logical check UUID, Goal, task,
attempt, exact source commit/tree, original argv and canonical cwd. `nativeProofBinding` maps only
`reservationToken` to the native `token` field. `receiveProofStart` requires the exact binding and result path;
malformed or mismatched responses remain unknown rather than proving that execution never started. Native
registration and terminal observation use the producer's check fence. Every physical incarnation retains its
original argv, ownership and terminal custody evidence; the adapter never writes native result, runner or custody
records. These native evidence guards remain independent of ordinary logical admission and its three-run cap.

Authenticated registered verification receives its original-command protocol ahead of minimal mode. It invokes the
exact ordinary wrapper once and returns the actual bare UUID while active. Goal waits and wakes the same session
with the actual wrapper result; unknown/missing/nonzero results remain non-green. The wrapper record must name the
current task, attempt, cwd and exact original command (the recorded child for an already wrapped original), with
one invocation only. No producer token, physical receipt or terminal cleanup chain is needed to verify an ordinary
wrapper's successful exit. Terminal zero, unchanged captured source and structured worker success with `checks: []`
settle as `verified`, without a source commit, landing or main advancement. Optional native evidence stays separate.
Reports count `verifiedProofs` separately from landed source tasks; verification does not complete a Goal. Failures
retain exact assertion/setup evidence and log references for a separate owner product fix.

Product/fix tasks retain the exact compiler policy: Kernel/Auth compiler database or check-host placement is
permitted solely for workspace typing through its existing supported command, leases and terminal result. Workers
await the existing foreground session without polling, cancellation, duplicates or fabricated check UUIDs.
Acceptance/native/browser/root/worker-check verification stays deferred. Source success requires the complete own
implementation and permitted typing with `checks: []`; actual native/combined release remains a controller gate.

### Explicit control-plane cohort release

Concrete additional files in an accepted control-plane source require separate owning-manager authority for a main
cohort. The public receiving API is
`receiveControlPlaneScopeApproval(input: ControlPlaneScopeApprovalRequest, runtime, env?): ControlPlaneScopeApprovalReceipt`
in `src/control-plane-batch.ts`. Operations captures the actual current queue and original contract identities with
`controlPlaneScopeApprovalIdentity(source, runtime)`, then submits the exact additional files from its persisted
owning manager provider session. For an already manager-authorized queue source:

```ts
const source = { taskId, attempt, acceptedCommit }; // Actual accepted current source, never a historical generation.
const input = {
  version: 1 as const,
  managerId,
  ...source,
  ...controlPlaneScopeApprovalIdentity(source, runtime),
  additionalPaths: [
    { path: 'tools/goal/src/lease.ts', reason: 'Required native publication lease custody adapter' },
    { path: 'tools/goal/src/process.ts', reason: 'Required publication process custody adapter' },
    { path: 'tools/goal/src/tasks.ts', reason: 'Required accepted launch custody adapter' },
  ],
};
const receipt = receiveControlPlaneScopeApproval(input, runtime, managerEnv);
```

The CLI equivalent is `bun tools/goal/scripts/release-control-plane-batch.ts --approve-scope .temp/scope-approval.json`
with that exact serialized input. The returned receipt contains the source, original contract/request hashes,
concrete justified paths, authenticated actor/session, approval time and content digest. Exact replay is idempotent;
a conflicting set for the same attempt refuses. Native immutable queue storage and a matching store event retain
the receipt separately from the original brief, queue request, acceptance, result and source history. Generic events
and worker-supplied permission fields grant no scope. Stale or processed sources, other Goals, directories, globs,
symlinks, frozen files and protected risk areas refuse.

Only the exact member's combined main preparation consumes its approved additional paths. The journal, completed
proof and publication record bind the approval identity; the final current-source fence verifies it again. An
approval arriving after a journal captured its inputs requires a fresh cohort. Ordinary landing permissions are
unchanged. This API never grants native execution, critical priority, a retry, integration or a passing proof.
The corrected main cohort still needs fresh full Goal typing, the complete suite, exact dev script compatibility,
real provider lifecycle and atomic publication before its deferred dev handoff can be consumed. Retained negative
proofs, supersession generation mappings and unknown legacy physical inventory keep their existing meaning.

The controller receiving entrypoint is
`bun tools/goal/scripts/release-control-plane-batch.ts <manifest.json>`. Invoke it from the authenticated owning
manager's persisted provider session, after source completion. Worker sessions cannot invoke it. It uses the ordinary
runtime, main train lease, landing queue, worker store and outcome sink; it does not dispatch another worker or mark
the original Goal complete.

`ControlPlaneBatchManifest` in `src/contracts.ts` is the immutable input:

```json
{
  "version": 1,
  "managerId": "control-manager",
  "members": [{ "taskId": "<actual-task>", "attempt": 1, "acceptedCommit": "<full-accepted-source-commit>" }]
}
```

`captureControlPlaneBatch(store, queue, managerId, excludedTaskIds)` captures actual current `landing` requests with
completed successful attempts and clean accepted branches. `ready` tasks, historical attempts, processed requests,
other owners and already reserved batches are omitted. The manager explicitly selects the manifest; omit the live
control-plane migration source for the current release priority. No task, branch, command, scope or acceptance evidence
can be supplied through the manifest. `receiveControlPlaneBatch` authenticates the session and authorizes those same
native requests before calling `MergeTrain.releaseControlPlaneBatch`.

The train preserves source commits by merging them in an isolated tree with the delivered `TrainResolver`: actual
rerere and proven additive unions precede one bounded fresh `gpt-6.1-sol` high session. It applies
scope and frozen-file guards, formats the combined candidate, and runs the mandatory Goal installs, typing, suite,
main/dev script compatibility and complete real-boundary provider lifecycle proof on that final head once. Compatibility
uses the captured immutable dev tree; lifecycle evidence must identify the exact candidate and dev tree. An already
represented contribution is reported explicitly with no invented implementation commit. Unavailable, conflicting or
refused sources are reported with their source identity, log, affected files and required owning-manager fix; compatible
sources remain eligible.

Main, stabilize (when present), dev and every accepted source ref participate in the existing atomic Git transaction
under the shared all-member SQLite fence. Each member keeps its original worker evidence and receives the actual
combined merge commit with its own changed-file and line counts. Independent dev history is preserved.

`control-plane-batch-<digest>.json` persists the immutable manifest, candidate/ref retry budget, proof record and recursive
split decisions. Exact gate output remains in the cohort logs. A failed proof splits the cohort in halves; passing
subsets release together after their own required final-head proof. Whole failed cohorts are never automatically
retried unchanged. Selected queue entries are reserved against ordinary serial drain, including excluded sources;
preparation exclusions can be selected for exact readmission after the old controller releases the main lane and its
journal becomes terminal. In a new manifest, add `"readmitFrom": "<prior-batch-digest>"` to each selected excluded member;
keep its exact task, attempt and accepted commit, and include the fresh adapter source and other remaining sources in
the same combined cohort. The public API remains `receiveControlPlaneBatch(manifest, runtime, env)` and the CLI remains
`bun tools/goal/scripts/release-control-plane-batch.ts <manifest.json>` from the authenticated owning manager session.
The receiving path transfers only unprocessed preparation exclusions under the main lane and shared SQLite fence,
preserving both journals and claim history. It verifies the original request/contract generation and unchanged current
source; active controllers, other owners, changed generations, any candidate/outcome/delivery and any prior native
participation refuse readmission. Legacy journals qualify only through their exact pre-native conflict exclusions,
original native request/authorization events and persisted brief. No queue reset, worker retry or acceptance rewrite is
involved. Native assertion failures still require an actual owning-manager product fix.

Resolver evidence includes actual earlier cohort owners whose accepted sources are already in the cumulative target,
even while their tasks remain landing. Frozen/protected inputs, refs, source identities, index and outside edits remain
guarded; only the controller stages and commits verified edits. Actual compiler diagnostics in a resolved file may
trigger one bounded typing repair before the single suite/compatibility/provider proof on the final combined head.
The resolver never runs checks. Source delivery does not run this operation, advance live refs, or prove whole-Goal
completion; operations must perform that fresh native proof and atomic publication after the old cohort is terminal.

Resolver command support belongs to the agent adapter's optional `supportsResolver` capability and `start` command.
Unsupported adapters refuse before starting a process; the neutral launcher never falls back to an ordinary worker or
resumes a resolver.
The Codex adapter constructs a fresh workspace-write sandbox command with network tools disabled and no worker-result
schema. The existing controller still bounds input, output, time, allowed source paths and the single repair pass.

Native batch releases acquire the ordinary main lane, then wait at most 30 seconds for the ordinary dev lane.
Both lanes remain owned from before ref capture through the complete candidate checks, exact captured-dev installed
scripts compatibility, real provider lifecycle, propagation and atomic ref CAS. The dev owner is never evicted;
contention fails within that bound and releases the main lane. Workers can still complete sources, and ordinary dev
landings stay queued until the finite release returns. The dev drain never acquires main while holding dev; promotion
runs after dev lease release, so there is no inverse nested train order. External ref writers still invalidate captured proof and fail CAS normally.

The narrow same-source receiving API is
`receiveControlPlaneBatchRefContinuation(input: ControlPlaneBatchRefContinuation, runtime, env)`; Operations invokes
`bun tools/goal/scripts/release-control-plane-batch.ts --continue-ref-exhausted <request.json>` **once**, from the actual
owning manager's authenticated provider session, using the delivered controller and the existing private `mainBranch`
configuration. It does not change that branch setting or select a default main. The JSON contains `version: 1`, the
**unchanged** single-source `manifest`, `logHash` (SHA-256 of the retained root log), and `handoff` with the exact prior
`journalHash`, `controller` process incarnation, `ownedCommands`, `inventory` and retained terminal `evidence` reference.
The journal must retain exactly three positive, non-timeout full-suite results, their candidate proof refs and exact
source/scope snapshots; every attempt's native log must document all mandatory checks passing and captured-ref movement.
These partial positives grant no compatibility, lifecycle or publication proof. There must be no split, failure,
prepared/release record, outcome, delivery, candidate, source/contract/request/scope change or supersession. The exact
accepted source must still be clean and current with its original native claim. The prior controller/group and every
positively recorded owned operation must have exited, and both ordinary lanes must become available normally.
`legacy-inventory-unavailable` preserves unknown custody; receiving grants no physical cleanup or capacity evidence.

An immutable native queue receipt retains the full original journal bytes, exact input and manager session, old/new
controller identities and receiving time. The journal appends a separate `ref-continuation` node without rewriting the
old controller, three attempts, proofs, logs or results. That node admits **one** fresh stabilized candidate, requiring
all existing full checks, compatibility, real lifecycle and atomic CAS. Failure, interruption or external ref movement
cannot open another budget. Exact terminal replay returns/reconciles that result without gates; changed input or a
live/incomplete continuation refuses. Ordinary manifest submission cannot bypass the receiving port. Failed-source
supersession and preparation-only readmission retain their separate existing rules.

Each node allows at most three candidate/ref attempts,
including interrupted attempts. Reinvoke the same manifest to resume durable split decisions or recover a published
release. A published verified record survives interrupted outcome delivery and checkout/tree cleanup failure, so
recovery never needs another suite run. Individual releases remain supported for unreserved requests.

Completed cohort proofs now retain the exact candidate, captured refs, accepted sources, failed command and output in
that node's journal before ref movement can request a rebuild. The native controller retains candidate objects under
`refs/goal/control-plane-proof/`. A failed candidate is classified and split even when publication refs moved; restart
uses its retained negative rather than rerunning the unchanged candidate. Passing moved-ref checks still require a
fresh complete proof. Bisection may run one bounded probe of at most three failing Goal test files selected from the
parent's actual full-suite output. A conclusive negative can split a group early. A passing or inconclusive probe
cannot publish: every passing head still needs fresh Goal typing, the complete suite, dev script compatibility and
the real provider lifecycle proof before CAS.

For an interrupted, unpublished cohort with a retained completed native failure, the typed receiving operation is
`receiveControlPlaneBatchSupersession(input: ControlPlaneBatchSupersession, runtime, env)`. The existing CLI also accepts
that input in its JSON file. It returns `ControlPlaneBatchSupersessionResult` and only transfers claims; subsequently
submit its `replacement` manifest through `receiveControlPlaneBatch` or the same CLI to run the fresh combined proof.
Workers must never invoke either operation. Operations supplies the verified terminal handoff after actual controller
death and lease handoff. `handoff` binds the exact prior journal SHA-256, controller process incarnation,
known owned-command inventory and retained physical evidence reference. Every listed incarnation and known resolver process
must be dead, with no surviving owned group; the native main lease must be available. Legacy journals additionally
require `handoff.failures` naming the exact node, candidate, failed command and output already present in their native
logs. `inventory: 'legacy-inventory-unavailable'` explicitly preserves unknown legacy validation-child custody.
The logical unpublished draft can transfer after verified canonical publisher/group death and native lease handoff;
it does not release a physical host lease, check custody or capacity. Positively recorded live identities still refuse.
Omitting `inventory` retains the original complete-inventory contract. No result or physical terminal receipt can be
invented from missing evidence.

The supersession input has `version: 1`, `previousBatchId`, `replacement`, `handoff`, and `changedInputs`. Each changed
input names an omitted or added accepted producer's `taskId`, concrete `path`, and the owning manager's relevance `reason`. The
native fence verifies actual changed file content against every retained failed candidate; changing only manifest
metadata or a relevance label cannot qualify. Without `memberMapping`, the original exact-generation plus added-source
operation remains supported. With `memberMapping`, every prior member must appear exactly once as either
`{ previous, disposition: 'replacement', current }` or `{ previous, disposition: 'deferred-to-dev', cause }`.
Both identities have `taskId`, `attempt`, and `acceptedCommit`. A replacement can only name the same task's currently
accepted generation. A corrected generation must have actual public retry, brief hash and source settlement lineage;
its old accepted commit is checked as an immutable Git object, never as the current branch tip or current attempt.
Added producer tasks must be fresh accepted requests. Partial mappings and arbitrary replacement tasks refuse.

Deferrals require `deferralAuthorization: { order, expectedDeferredCount }`, binding the owning manager's retained Root
order and exact number of preparation exclusions. For the main-first migration order, map the seven main members to
their current accepted generations and explicitly defer all thirteen preparation exclusions; do not construct another
all-source main cohort. A deferred source must still have its exact current request, contract, source and old queue
claim, with no native participation, candidate, outcome or delivery. Retained native-failed members cannot be deferred.
`result.devHandoff` retains the exact task/attempt/source, owner, request, contract identity, queue entry/claim and cause.
Corrected generations claim their new current rows; old stale rows and all old claims stay historical.

The replacement composes real producer edits relevant to the failure.
An old preparation-excluded member can supply those producer edits because its source was absent from the failed
candidate. Before new native checks, the controller verifies those inputs actually survive composition; omitting them
again cannot rerun the unchanged failed head. Old request/contract
identities and current source acceptance remain exact. An old native-failed source can therefore participate with
actual omitted producer fixes; its old proof stays failed and the replacement receives no inherited pass.

Claim transfers and the authoritative supersession closure commit atomically in the existing SQLite fence. Both
claim histories and the entire prior journal, nodes, results and evidence remain retained; the old draft is marked
`superseded/interrupted` with explicit failed/unknown member dispositions. Journal materialization recovers from that
same immutable transaction after interruption. Old controllers cannot resume a superseded draft. Published releases,
processed rows, unproved generation changes, live controllers/commands/leases, other owners and unchanged producer inputs refuse
supersession. No tasks, attempts, outcomes, acceptance or prior failed proofs are reset. Normal terminal preparation-only
readmission remains separate. Source delivery and local typing provide no native acceptance or runtime authorization;
operations must supply the actual handoff and execute the combined validation/publication later.

The public migration receiving declaration is:

```ts
receiveControlPlaneBatchDevHandoff(
  input: ControlPlaneBatchDevHandoffRequest,
  runtime: { train: MergeTrain; receiveDev(handoff: ControlPlaneBatchDevHandoff): void },
  env?: NodeJS.ProcessEnv,
): Promise<ControlPlaneBatchDevHandoff>
```

`ControlPlaneBatchDevHandoffRequest` is `{ previousBatchId: string; replacementBatchId: string }`. The native owning
manager calls it immediately after the replacement root's complete fresh proof and publication. Passing split subsets
or probes cannot unlock migration. `receiveDev` is the migration source's synchronous native store receiver, called
inside the existing SQLite transaction. It must migrate every handed-off current task to the normal dev lane while
preserving the accepted request/source/attempt and owner. Only then does the queue transfer those exact reserved claims
to normal dev processing, retaining an immutable consumption receipt and both original histories. Failed or incomplete
receivers roll back; identical consumption is idempotent. The normal dev resolver handles the deferred conflicts.
This source exposes no CLI that guesses a migration callback or performs physical cleanup.

For example, operations supplies actual accepted identities and verified retirement evidence:

```ts
const input: ControlPlaneBatchSupersession = {
  version: 1,
  previousBatchId,
  replacement: sevenCurrentMainSources,
  handoff: {
    journalHash,
    controller,
    ownedCommands: knownOwnedCommands,
    inventory: 'legacy-inventory-unavailable',
    evidence: retirementReceipt,
    failures: retainedLegacyFailures,
  },
  memberMapping: [
    ...previousMainMembers.map((previous) => ({
      previous,
      disposition: 'replacement' as const,
      current: currentAcceptedByTask.get(previous.taskId)!,
    })),
    ...thirteenPreparationExclusions.map((previous) => ({
      previous,
      disposition: 'deferred-to-dev' as const,
      cause: 'Preparation conflict deferred to dev under the retained Root order',
    })),
  ],
  deferralAuthorization: { order: retainedRootOrder, expectedDeferredCount: 13 },
  changedInputs: relevantCorrectedProducerInputs,
};
const closure = await receiveControlPlaneBatchSupersession(input, runtime, managerEnv);
await receiveControlPlaneBatch(input.replacement, runtime, managerEnv);
await receiveControlPlaneBatchDevHandoff(
  { previousBatchId, replacementBatchId: closure.replacementBatchId },
  { train: runtime.train, receiveDev: migrationReceiver },
  managerEnv,
);
```

The existing supersession JSON CLI receives the same mapping fields. Workers must never invoke these operations.
Old negative proofs remain failed. The corrected combined head still requires full Goal typing, the complete suite,
dev script compatibility, real provider lifecycle evidence and CAS; source typing alone grants no native pass.
