# Scripts

## Check hosts

### Check cost ledger

Physical worker check runs are recorded as JSON under the main checkout's
`.temp/check-ledger/<UTC date>/<run id>.json`. Entries contain the logical check and rerun number, host, argv,
revision, start/end timestamps, exit and terminal status, and available slot wait, phase, memory, swap, pressure and
CPU measurements. Entries are first written with `terminalStatus: "running"` and atomically replaced at completion;
ledger write failures are warnings and do not change a check result.
Set `REZICS_CHECK_LEDGER_DIR` to override the directory for both recording and `summary`; relative paths resolve
from the main checkout, and test suites use temporary directories.
`slotWaitSeconds` is monotonic time spent waiting for local memory or remote host admission. It is independent of
`phases.command` and `phases.wrapperTotal`: the first measures the admitted command, while the second includes the
whole physical wrapper attempt, including admission and remote setup. A remote transport failure is never replayed locally.

Commands may append phase markers to the file named by `REZICS_CHECK_PHASES`, one per line:
`<phase name>\t<start|end>\t<CLOCK_MONOTONIC nanoseconds>`. Paired markers are returned as phase durations; malformed
or unmatched markers are ignored and reported.

Use `bun scripts/check-ledger.ts summary --since <ISO> [--until <ISO>]` to report check-hours, GiB-hours by command
class and phase, and the infrastructure share of terminal runs. Window totals clip runs at both edges and count a
running entry through the window end. Memory outside the run slice, including host-shared services, is not counted;
memory integral sampling error is bounded by the recorded interval and sample count.

A check host is a Linux machine reached over SSH. It runs a disposable copy of a checkout.
It needs systemd, cgroup v2 accounting, Docker and an SSH account with permission to manage them.
Checks share the capped `rezics-check.slice`. A loopback host uses this same protocol on the caller's machine.
Runs share the host's package cache through hardlinks. A run that writes into an installed package in place fails and
its cache entry is removed. Patch a dependency through `patchedDependencies` in `package.json`, never at run time.

This section owns the operational rules. The implementation is in [remote-check.ts](remote-check.ts),
[stack-run.ts](stack-run.ts), [stack-lease.ts](stack-lease.ts),
[provision-check-host.sh](provision-check-host.sh) and the [Docker wrapper](check-host/docker).
Their adjacent tests exercise placement, admission, accounting and cleanup.
`GROWTH_PROFILE`, when set to a file inside the workspace, is forwarded to stack runs on check hosts as a
workspace-relative path and returned with the run result. Existing local profile lines are preserved when the
returned file is merged.

| Check        | Placement                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker       | The shared classifier keeps only proven typecheck, formatter and bounded small-unit commands local. Heavy and unknown commands use hosts a/b; `--local`, off markers and learned memory weight cannot force local execution. Missing hosts and remote transport failure return nonzero without local replay. |
| Kernel       | Kernel checks and SQL-mapped typechecks use hosts a/b. Only pure compiler commands without a Kernel/Auth database stay local. Missing hosts fail closed instead of starting a local database or suite.                                                                                                       |
| Auth service | `bun run --cwd services/auth check [files...]` places the database, compiler and test work through `stackRun`. `bun run --cwd services/auth typecheck` follows the kernel typecheck placement rule above, using a throwaway migrated Auth database when `DATABASE_URL` is absent.                            |
| Browser      | The isolated runners in `apps/auth` and `apps/web` use the shared placement layer. The web check returns its browser report. UI browser tests in `packages/ui` also run on hosts as part of the remote gate.                                                                                                 |
| Landing gate | Root `bun run check` splits all workspace checks into two duration-balanced remote groups when `KERNEL_CHECK_REMOTE` names a readable file. The lighter group also runs the control-plane gate.                                                                                                              |

Remote worker checks preserve any existing local `GROWTH_PROFILE` lines and append the returned profile when that variable names a file inside the worktree. The returned prefix is validated and merged once per physical run.

### Trusted check-run settlement

`bun scripts/check-run.ts` writes private invocation records under `${XDG_STATE_HOME:-~/.local/state}/rezics/check-runs` (or the absolute `REZICS_CHECK_RUN_STATE_DIR`). The state directory is owner-only, outside the candidate workspace, and each JSON record is replaced atomically and fsynced while holding the existing check-custody lock. A caller can register its invocation before launch with `registerCheckRunInvocation(binding)` or `bun scripts/check-run-settlement.ts register --binding <absolute-private-json>`. The returned `invocationId` and 256-bit `nonce` identify the run. To bind a launched producer to that registration, set `REMOTE_CHECK_INVOCATION_ID=<uuid>`, `REMOTE_CHECK_RECEIPT_FD=3`, and `REMOTE_CHECK_RECEIPT_NONCE=<nonce>`; the launcher must provide fd 3 only to the trusted producer.

The version 1 `CheckRunInvocationBinding` has exactly these fields: `sourceRevision`, `indexTree`, `sourceSha256`, `argvSha256`, workspace-relative `cwd`, `semanticEnvironmentSha256`, `relocatedEnvironmentSha256`, `producerClosureSha256`, `hostsSha256`, `preparationCommandsSha256`, and `returnsSha256`. Hashes are SHA-256 over canonical JSON or the trusted source closure. Environment values never appear in invocation status records, descriptors, FD 3 messages, stdout or stderr. The separate owner-only prepared-execution file stores the exact original and relocated environment privately so a later process can run the same preparation. The source manifest verifies each frozen file or symlink, mode, deletion, candidate commit and index before preparation. A separate host receipt hashes the actual prepared source and generated file bytes after preparation; an unavailable receipt stays unavailable.

### Out-of-process prepared handoff

The additive producer API is:

```ts
prepareCheckRunInvocation(
  args: CheckRunArguments,
  descriptorFile: string,
  dependencies?: CheckRunDependencies,
  processEnvironment?: NodeJS.ProcessEnv,
): Promise<CheckRunPreparedDescriptor>

runPreparedCheckRunInvocation(
  descriptorFile: string,
  dependencies?: CheckRunDependencies,
  signal?: AbortSignal,
  processEnvironment?: NodeJS.ProcessEnv,
): Promise<number>
```

The normal CLI callers stay supported. An out-of-process caller prepares with the same options and command argv:

```text
bun scripts/check-run.ts prepare --descriptor <absolute-private-json> --hosts <absolute-hosts-json> --workspace <absolute-candidate-root> --cwd <workspace-relative-directory> --source-revision <full-candidate-commit> --env-file <absolute-environment-json> [--returns <workspace-relative-path>]... -- <original-argv...>
```

The version 1 descriptor is a closed JSON object with exactly this schema; `binding` is the complete eleven-field
`CheckRunInvocationBinding` above and `cancellation` is the durable file/id returned for the invocation:

```json
{
  "schema": 1,
  "type": "check-run-preparation",
  "invocationId": "<uuid>",
  "nonce": "<64 lowercase hex characters>",
  "binding": {
    "sourceRevision": "<full commit>",
    "indexTree": "<full tree object>",
    "sourceSha256": "<sha256>",
    "argvSha256": "<sha256>",
    "cwd": "<workspace-relative path>",
    "semanticEnvironmentSha256": "<sha256>",
    "relocatedEnvironmentSha256": "<sha256>",
    "producerClosureSha256": "<sha256>",
    "hostsSha256": "<sha256>",
    "preparationCommandsSha256": "<sha256>",
    "returnsSha256": "<sha256>"
  },
  "cancellation": { "file": "<absolute private file>", "id": "<same uuid>" }
}
```

The descriptor is at most 64 KiB, owner-only, a regular non-symlink file inside an owner-private directory, and outside
candidate source. Its exact path and byte digest are recorded before the descriptor is exposed. The private execution
file is at most 16 MiB, owner-only and outside candidate source. It holds the one relocated snapshot, source manifest,
host and environment selections, preparation commands and original argv; the invocation record stores only its path
and digest. `run-prepared` accepts only `--descriptor <absolute-private-json>`, requires the matching caller-established
`REMOTE_CHECK_INVOCATION_ID`, `REMOTE_CHECK_RECEIPT_NONCE` and `REMOTE_CHECK_RECEIPT_FD=3`, and atomically claims the
matching `prepared` record once. It reuses the saved snapshot and identities without creating another worktree or
reconstructing the binding. Before cancellation can bind the workspace or allocation can begin, execution establishes
that same claimed registration as the sole authority. Queueing rejects an unclaimed `prepared` record and preserves the
claimed snapshot, returns and cancellation fence. Changed candidate/frozen inputs, environment file, priority, host file
or trusted producer closure fail before remote admission. Preparation itself imports no candidate code, starts no check
and emits no FD 3 receipt.

For process loss or abandonment, callers use the durable invocation id from the descriptor:

```text
bun scripts/check-run-settlement.ts status <invocation-id> [--state-dir <absolute-dir>]
bun scripts/check-run-settlement.ts cancel <invocation-id> [--signal 1|2|15] [--state-dir <absolute-dir>]
bun scripts/check-run-settlement.ts reconcile <invocation-id> [--hosts <absolute-hosts-json>] [--state-dir <absolute-dir>]
```

Reconciliation without `--hosts` handles a prepared/queued invocation with no physical run: it durably cancels the
start, then removes only the recorded snapshot and records that custody. If a physical host/run was already recorded,
reconciliation requires the host file and observes only that run; unavailable proof keeps the exact snapshot. A final
record is replayed by `status`; `run-prepared` rejects its descriptor after the one claim and never starts a replacement.
For a preparation process lost before a registration record exists, use
`bun scripts/check-run-settlement.ts reconcile --descriptor <absolute-private-json> [--state-dir <absolute-dir>]`.
The private version 1 `.intent.json` sidecar names one invocation, descriptor, candidate and preallocated snapshot
paths. Recovery removes only that exact, owner-private snapshot. If the descriptor was exposed, the same command
routes to its registered invocation and never prepares a replacement. The sidecar contains paths and input names,
never environment values or command secrets.

After a final is recorded, `final` is immutable. The additive `finalCustody` status object has schema 1 and bounded
fields: `aggregate` (`pending`, `settled` or `unknown`), `delivery` (`pending`, `delivered`, `unknown`, `not-required`,
`received` or `reconciled`),
`deliverySha256` (SHA-256 of canonical compact final JSON without the wire newline), `privateFiles`
(`pending`, `settled` or `unknown`), `reconciliation` (`unknown` or `settled`), `originalFinalSha256`, `identity`, and
up to 16 exact `observations` plus an optional bounded `continuation` (`count`, rolling `sha256`, `first` and `latest`)
for later observations. The first 16 remain exact; the continuation commits each later observation without growing
the invocation record and retains its first and most recent exact entries. Delivery is `pending` after the final is
durably pinned but before the writer result,
`delivered` when the writer returns, `unknown` when it throws, `not-required` when no writer is configured, `received`
when FD 3 ingress accepts the original, and `reconciled` when recovery creates the first final for a missing original.
`privateFiles` covers the execution payload and preparation-intent sidecar; it is `pending` while either reference is
outstanding, `settled` after their verified disposal, and `unknown` if removal is not verified. The descriptor remains
as the caller's private replay-resistant handle.

`aggregate` is the authoritative producer-side custody result. It is `unknown` if any custody dimension is unknown;
otherwise it is `pending` while delivery or private files are pending, and `settled` only when delivery has a completed
outcome, private files are settled and reconciliation is settled. Pending or unknown FD 3 delivery remains non-green
after physical cleanup. `delivered` records that the writer callback returned; it does not prove downstream
persistence. A receiver records `received` only after accepting the original final. The invocation phase cannot be
`settled` while aggregate custody is pending or unknown.
Remote cleanup is `verified` only with complete failure-free proof, `failed` when a receipt claims verification while
retaining failure entries, and `unknown` when verification evidence is missing or incomplete. Each outcome other than
`verified` keeps overall cleanup non-green.

`identity` is `{sha256,bindingSha256,physical,sourceSha256,snapshotSha256,candidateWorkspaceSha256,returnsSha256,preparedExecutionReferenceSha256,descriptorReferenceSha256,preparationIntentReferenceSha256}`. Hashes are SHA-256; `physical` is `{host,run}`; source, snapshot, candidate path and private-file reference digests can be null when no such identity exists. The identity digest covers every identity field except its own `sha256`. An `observations[]` entry is `{observedAt,disposition,transportIdentity,final,reason}` where disposition is `unknown`, `settled` or `rejected`, `transportIdentity` is `live-same`, `gone-or-replaced`, `unknown` or null, and `final` is an exact candidate final settlement or null. A later exact accepted observation may settle custody while the original unknown `final` remains unchanged. Unknown and rejected observations cannot change snapshot custody or prior cleanup authority. Failed removal keeps its exact reference for later cleanup. Secret environment values do not appear in status or settlement messages.
`finalCustody` is additive versioned status metadata only. The prepared descriptor schema 1 and normal FD 3
`native-terminal` and `final-settlement` messages keep their installed closed shapes. Consumers should handle this
metadata at their ordinary result/status boundary; this producer change does not install a Web or control-plane bridge
or inject authority into the active invocation.

Ordering is durable: registration precedes remote admission; `queued` is the cancellation fence; an fsynced transition out of
`queued` precedes host probing and upload; the exact `{host,run}` is persisted before the native transport spawn; `running`
and its local SSH PID/boot/start identity are stored under the spawn fence; and `native-terminal` records the original exit
and lifetime outcome before final settlement. FD 3 uses one bounded newline-delimited version 1 JSON message per event.
The optional intermediate `native-terminal` message has `invocationId`, `nonce`, the exact binding, physical identity and
original `receipt`. It is not final authority. The final message is `{schema:1,type:"final-settlement",invocationId,nonce,binding,physical,native,preparedInputs,returns,cleanup,failures}`. `native` carries the original exit code, lifetime-timeout flag and receipt digest. `preparedInputs` carries `status`, `sourceSha256`, `manifestSha256`, `fileCount` and `totalBytes`. `returns` carries `status`, declaration digest, restored artifact `{path,size,sha256}` entries, missing paths and failures. `cleanup` carries overall disposition, remote cleanup, transport-child, source and frozen-worktree dispositions plus cleanup failures. `failures` keeps primary and cleanup causes separate.

The final `cleanup.disposition:"settled"` message is emitted only after the SSH child is positively gone or replaced, the host command group and run containers are verified stopped, returns are copied and checked, frozen and caller source checks pass, and the frozen worktree removal is verified. Local process identity is `live-same`, `gone-or-replaced`, or `unknown`: only boot replacement, affirmative PID absence or `ESRCH`, or a well-formed changed start identity proves absence. Permission, I/O, parse and unsupported-platform uncertainty never grants signal authority; every signal revalidates the same identity and cancellation is bounded. An `unknown` final reports which part could not be verified; a missing or malformed message, FD 3 write failure, output mismatch, or unavailable identity/evidence is non-green and leaves the invocation occupied for its caller. Native nonzero, 75, 124 and signal exits remain in `native`; settlement never turns one into exit 0. The decoder rejects oversized messages and collections, duplicate JSON keys, foreign IDs, nonce/binding/physical mismatches, early or repeated native events, partial lines and final replay. Only the trusted producer callback plus the registered ID and nonce establishes wire provenance; child stdout and candidate JSON do not.

The producer fsyncs and pins the exact final before writing FD 3, then records `delivered`, `unknown` or `not-required`.
A write error leaves the original final and its digest pinned with delivery `unknown`; the producer cannot admit a
different final or replay the message. A crash between pinning and recording delivery leaves `pending`, which is also
non-green. These are sender-side observations of the write callback, not proof that a downstream consumer installed
or persisted the final.

`getCheckRunStatus`, `cancelCheckRunInvocation` and `reconcileCheckRunInvocation` expose status, durable cancellation and reconciliation. The CLI provides `bun scripts/check-run-settlement.ts status <id> [--state-dir <absolute-dir>]`, `cancel <id> [--signal 1|2|15] [--state-dir <absolute-dir>]` and `reconcile <id> [--hosts <absolute-hosts-json>] [--state-dir <absolute-dir>]`. Cancellation is stored before its signal intent is published and the start fence refuses a later queued spawn. Reconciliation uses only the persisted host, run and exact local transport-child identity. It stops or observes that same run, verifies returns and cleanup, and never allocates a second command. Missing host state, stale process ownership, changed producer/host bindings or failed transport leaves custody unknown and frozen inputs retained. A final message alone does not install or claim an external `RemoteGateCustody` or `NativeReceiptBridge`.

### Bounded returned artifacts

`stackRun({ returns: [...] })` and worker-check's `--returns <path>` declare workspace-relative output files. Each physical run accepts at most 64 unique paths and 256 MiB total. Absolute paths, dot or parent components, control characters, and symlink escapes are rejected. For a nested stack runner on an outer remote check host, worker-check prepares a staging directory keyed by the outer physical run ID; `stack-run` writes only the declared files and manifest there, and the outer remote transport returns that one directory before deleting its run directory.

Returned bytes are checked against the manifest size and SHA-256 before they replace the declared local destination. A new physical run removes prior declared output so a stale image cannot prove a later result. Missing, oversized, unsafe, or failed staging is logged with the physical run identity; it does not rewrite the command's exit status or turn a missing output into a pass. A failed command may still return declared bytes that were written before failure. Returned files remain in the caller's workspace after remote cleanup; the per-run staging directory is removed after restoration.

### Durable worker-check custody

`worker-check` freezes `GOAL_TASK_ID` and `GOAL_ATTEMPT` when a task-owned check starts. Both variables must be valid together. When `GOAL_CHECK_REGISTRY` names an available absolute directory, the detached runner publishes a version 1 registration containing the task attempt, logical check ID, result path, physical run UUID, host, and Linux boot/start/group identity before the command may begin. Registration failure terminates the new runner and makes start fail. Standalone checks without task identity keep working but cannot be stopped as task-owned checks.

Each detached incarnation and automatic rerun has a fresh physical UUID and an immutable history record under `.temp/goal/checks/`. The logical result file remains at `.temp/goal/checks/results/<check-id>.json`. The public script API exports `CheckRecord`, `CHECK_RECORD_CUSTODY_VERSION`, `readWorkerCheckRecord(id, cwd?)`, `readWorkerCheckHistory(id, physicalRunId, cwd?)`, and `stopWorkerCheck(id, cwd, expected)`. The stop expectation binds ownership, physical UUID, host, PID, boot ID, process start time, and group ID. Stop returns a `CheckCleanupReceipt`; `readWorkerCheckCleanupReceipt` and `readWorkerCheckCleanupHistory` expose the current receipt and immutable receipt events. A stop refuses unknown, stale, mismatched, reused, or foreign-host identity without signaling it. Local terminality, the original result, and every owned remote run must be confirmed before the receipt reports terminal cleanup.

The supported launch is `bun scripts/worker-check.ts -- <command...>`. The documented compatibility launch is only `bun scripts/worker-check.ts --run -- <command...>`. `--run <check-id> [--physical-run <physical-run-id>]` is the detached runner entry, not a command-launch fallback. Malformed IDs and an empty compatibility alias are refused. `--wait <check-id>` resumes observation of the existing logical check; it never starts a fresh command for an unknown or cancelled check.

`cancelWorkerCheck(authorization, cwd?)` accepts a version 1 Root authorization bound to an exact result path and digest, command argv, task attempt, and bounded receipt path and digest. It persists an idempotent logical cancellation tombstone without sending a signal or inventing physical cleanup. A legacy record with unknown process custody keeps its original bytes and remains physically unknown; later waits and detached runner starts return a nonzero cancellation result, and no retry or local fallback is allowed. Exact stop and cancellation receipts are separate facts.

### Test lanes

Kernel, Auth and web test lanes run each test file in a separate `bun test` process and print its output when it
finishes. The runner uses Bun's dot reporter so stdout and stderr arrive on their original streams as tests complete.
Files with recorded times run longest first, followed by files without a record. Timings use the shared main-checkout directory; set
`<SERVICE>_CHECK_TIMINGS` to choose another directory. Remote check commands explicitly set the kernel and Auth
timing directories under their disposable rsynced checkout because it has no `.git`; other callers without git
metadata must set their service's variable if they need timings. It prints a heartbeat every 60
seconds with the file name, elapsed time, silence and wall bounds, and time since output. The silence bound is the
larger of 10 minutes and three times the longest recorded test or hook time; files without a timing record get 30
minutes. The wall bound is the larger of 30 minutes and three times the recorded wall time; files without a record
get 2 hours. Reaching either bound stops the process group, drops its database, and fails that file as its own task
failure with the bound, recorded times and last 40 output lines. Such a stopped file is not retried as a load or
growth failure, and its prior timing record is retained.
Capture observes child exit and stream completion once each, allowing either to finish first. It keeps one active
wait timer while work remains. After a bound sends SIGTERM, the process group receives SIGKILL after 10 seconds
even if its leader has exited; output draining is limited to one further second before the readers are cancelled.

`bun scripts/worker-check.ts -- <command...>` prints `check: id <id>` after the detached runner has published its
physical identity and, when task registry is configured, its registration. The only command-launch compatibility
alias is `bun scripts/worker-check.ts --run -- <command...>`. `--run <id> [--physical-run <uuid>]` is reserved for
the detached runner and validates both identifiers; a malformed ID never falls through to launch a command.

Use `bun scripts/worker-check.ts --wait <id>` to wait for up to 10 minutes. Exit status 75 with
`check: still running` means resume with the same `--wait <id>`; never start the check again. The log path and its
latest non-empty line are printed when the wait yields, including while admission is queued. A runner is live only
when its recorded host, boot ID, process start time, group, and command line match its immutable physical record.
Unknown or legacy custody is quarantined rather than inferred from cwd or log timestamps. A dead or silent runner
is eligible for its one infrastructure rerun only after its exact local process group, remote run, and result have
terminal proof. A second infrastructure failure ends with exit status 1. The rerun receives a fresh physical UUID,
log, and history entry; prior physical evidence is retained. Treat the infrastructure line as a `tool` blocker,
even if the rerun passed. A completed command that exits 75 prints `check: exit status 75`, while a wait that yields
prints `check: still running`.

Memory admission and remote slot waits write capacity state to stderr and the check log immediately and at least
every 60 seconds. `slotWaitSeconds` records monotonic time spent in actual local memory or remote slot admission;
the wait-hint integer file remains separate. Command execution phases and `phases.wrapperTotal` keep queue time
separate from admitted command time. The silence monitor measures log growth across waits. Quiet commands stay
alive through CPU progress lines. A local command that is idle (no output and no CPU) for 10 minutes follows the
same verified stop and drain path as an explicit task stop. Unknown remote teardown keeps the physical check
quarantined and prevents replacement.

When the command runs `scripts/typecheck.ts` without an existing `TYPECHECK_CHANGED`, worker-check prefixes it with the
same `env TYPECHECK_CHANGED=<newline-joined changed files>` form as landing, using tracked changes since the merge base
with `dev` plus untracked files. It reports the file count and merge base in the check log; without a `dev` ref or merge
base it runs unscoped and records that reason. This scope is computed before placement, so local and remote checks use
the same command arguments.

The gate requests four slots per group by default (`GATE_REMOTE_SLOTS` overrides this).
It partitions eligible hosts between groups when at least two qualify by configured slot count.
Otherwise both groups use the original hosts file. Admission still checks actual slice capacity.
`GATE_CONCURRENCY` controls workspace concurrency inside each group. Group results return to `.temp/gate/`.

`stack-run.ts` and worker-check use a nonempty `KERNEL_CHECK_REMOTE` first. Otherwise they look for the readable shared file
`<main checkout>/.temp/goal/remote-check-hosts.json`. An unreadable explicit path does not use that fallback.
Once a host answers, a busy run queues. Later probe silence does not send it back locally.
Slot locks own the host's reserved descriptor range, and admission also bounds the sum of recorded slots for live runs by the host's slot count.
With no approved host, heavy and unknown runs fail closed; they never start locally.
A run already inside `/srv/rezics-check/runs/<id>` is considered remote only when its physical directories and unified cgroup v2 slice/scope match and its live supervisor marker passes the exact producer schema: version 1, exactly `schema`, `host`, `run`, `pid`, `started`, `group` and `uid`, host `a` or `b`, matching run/current uid, safe pid/start bounds and `group == pid`. The producer, producer control reader and receiver share that schema representation. A lexical run candidate that fails recognition reports its bounded predicate and stops before nested host discovery or local/native execution. Caller-set environment flags do not establish remote placement; see [check-host recognition](../docs/development/check-host-recognition.md) for proof limits.
The caller's environment is not copied to the host; callers must pass required values in the command. A client renews each run’s `.alive` file every 60 seconds; the next host run stops a run whose file is older than 10 minutes before taking a slot. The slot holder also stops its run's systemd scope and slice and removes that run's labelled containers if its SSH input ends before the run writes `exit-status`. The slot and its processes therefore end together; the stale-file sweep remains a backstop. Every physical run has the estimate-derived host deadline described below, capped at two hours; `--max-ms <n>` can shorten it. A host lifetime timeout exits 124 with a durable infrastructure receipt; transport failure exits 75.

Kept outputs require declared workspace-relative return paths; stack-heavy runs remain on a or b.
Local/off markers such as `REZICS_STACK_REMOTE=off`, `REZICS_STACK_SLOT`, `KERNEL_CHECK_ON_REMOTE` and `REZICS_STACK_LEASE` do not change heavy-check placement.

`KERNEL_CHECK_ON_REMOTE` and `REZICS_STACK_LEASE` do not decide shared stack placement.
The root gate has its own placement rule: it uses the explicit hosts file and suppresses remote recursion with
`KERNEL_CHECK_ON_REMOTE`.

Auth's standalone typecheck reuses its check's compiler database preparation: one throwaway container receives
both the kernel and Auth migrations, since Auth's imports also reach kernel SQL. It removes that database after
tsc exits or fails to start. An explicit `DATABASE_URL` does not bypass placement: it is accepted only inside an
already admitted physical check-host run because credentials cannot be relocated. Outside that run, typecheck exits
75 before placement. Inside an admitted run, the supplied URL is used and the throwaway database is not started.

### Controller-reserved proof binding

`startControllerWorkerCheck(binding)` in `worker-check.ts` and
`bun scripts/worker-check.ts --controller-proof <token> -- <exact original argv...>` consume the same
`ControllerProofBindingV1` declared in `check-custody.ts`. The controller publishes the closed
`ControllerProofReservationV1` at `controllerProofReservationPath(GOAL_CHECK_REGISTRY, token)` after its own durable
reservation, and serializes publication/revocation with `withCheckFence(cwd, checkId, ...)`. The wrapper never allocates
a controller token or logical UUID. It verifies the reservation, exact task attempt environment, canonical initiating
Git root, full HEAD commit/tree and clean captured tracked blobs. Argument boundaries, empty arguments and literal
characters are retained; arguments are limited to 1,024 entries, 4,096 characters each and 16 KiB of encoded JSON.
Untracked logs and generated returns are outside the captured tracked source; tracked gitlinks are unsupported.

`controllerProofExecutionArgv(binding): string[]` is the pure, shape-validating execution derivation. Plain originals
retain every argument. The sole admitted saved wrapper prefix is
`bun scripts/worker-check.ts --local -- bun test`, followed by safe explicit test/spec paths. It derives
`--local -- bun test <files...>` for the existing option parser; the shared classifier still requires the bounded small-unit rules for local placement. Execution also
requires the canonical tracked repository wrapper and tracked test files under the exact captured source validation.
Foreign or aliased wrapper paths, recursive wrappers, extra flags, shell text and other wrapper shapes are refused
before physical intent. The original wrapper argv stays in binding, registration and the logical record; the producer
derives execution internally on start and rerun, without invoking another wrapper or allocating another logical UUID.

A bound runner registers before probing the pinned runtime and acknowledges startup after that owned setup succeeds,
before memory admission or command execution. A failed pin probe retains its exact raw diagnostic and nonzero result,
closes its log descriptor and wait recorder, and reports failed startup. The launcher drains that same owned runner
through the existing startup/stop lifecycle. Only validated registration, a terminal original result and positive local
and any required remote cleanup permit terminal proof/history and a bound `started` result for the failed check.
Missing or uncertain custody returns `unavailable`; a setup exception cannot turn execution intent into a capacity-free
refusal. Absent PIDs and failed procfs observations cannot establish local cleanup. Historical records are untouched.

Exclusive registry token/check claims and monotonic custody under the existing logical check fence prevent duplicate
execution and revival. Exact replay returns the existing result path. `refused-never-started` requires a durable
pre-intent refusal that prevents every physical incarnation; loss of registry, claims, intent, registration or result
returns `unavailable` with unknown custody and retains controller capacity. Intent is retained before detached launch,
including native preparation. Binding metadata accompanies the existing logical record, physical histories and
registration; `validControllerProofRegistration` checks it against actual custody records. It is additional metadata,
not admission, cancellation authorization, a terminal proof or controller settlement. Existing bounded physical reruns
keep the token, logical UUID and original source/argv, while recording their own IDs and physical argv; an overload
subset is derived only from the actual failure log and captured tracked test files. Ordinary unbound API/CLI behavior
is unchanged and cannot satisfy the bound registration predicate. The CLI prints `ControllerProofStartV1` JSON and
exits 0 for started/replayed, 1 for durable refusal and 2 for unknown custody.

### Hosts file

`KERNEL_CHECK_REMOTE` names local JSON configuration. It must contain a nonempty `hosts` array:

```json
{
  "hosts": [
    {
      "name": "check-small",
      "address": "root@check.example",
      "identity": ".secrets/server/check-small/operator-ed25519",
      "memoryMaxGiB": 10,
      "cpuQuotaPercent": 800,
      "slots": 4,
      "processorsPerSlot": 2
    }
  ]
}
```

| Field               | Meaning                                                                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`              | Nonempty host name used in logs and gate targeting. Use distinct names.                                                                                                                                          |
| `address`           | SSH destination in `user@host` form. It identifies the machine, not a resource limit.                                                                                                                            |
| `identity`          | Nonempty path to the caller's SSH private key. SSH uses only the specified identity and batch authentication.                                                                                                    |
| `memoryMaxGiB`      | Positive memory limit in GiB. Admission uses this for capacity when slice memory cannot be read. Provision the slice with the matching value.                                                                    |
| `cpuQuotaPercent`   | Positive CPU quota; 100 means one processor. This is the admission fallback when slice `cpu.max` is unreadable or unlimited. Provision the matching quota.                                                       |
| `slots`             | Positive integer ceiling on concurrent slot units, including the express slot. Slot counts in the hosts file are a processor bound and do not change systemd limits.                                             |
| `processorsPerSlot` | Positive finite processor count required per slot. Defaults to 2.                                                                                                                                                |
| `fallback`          | Optional boolean. Non-gate checks prefer hosts without this field or with `false` whenever one can start now. A `true` host is selected when no other host can start the run; gate placement ignores this field. |

Editing JSON alone does not resize the slice. Provisioning takes memory and CPU values as arguments.

### Admission and queueing

Each slot requires the host's configured `processorsPerSlot` (default **2**). Slot counts in the hosts file are a
processor bound. Runs reserve their command class's measured memory: `worker-check` passes its class weight with
`--memory-gib <positive integer>`, while other callers without a request retain the **2.5 GiB** default per slot.
Multi-slot requests retain one reservation per requested slot. For each answering host, compute:

```text
C = min(configured slots, floor(slice processors / processorsPerSlot))
O = max(0, C - 1)        ordinary capacity
G = max(0, O - 1)        gate capacity
```

Slice processors are the quota divided by the period in `cpu.max`.
Slice memory is `memory.max`; configured values supply the fallbacks above.
Admission also needs 2.5 GiB of current memory headroom for each requested slot. A host is skipped when its 1-minute
load exceeds 1.5 times its slice processors, its machine `MemAvailable` is below 4 GiB, `/tmp` has less than 4 GiB
free, or `/tmp` has fewer than 65,536 free inodes. These thresholds apply to gates and multi-slot runs too; skipped
hosts are logged and the check waits for capacity. Because check-host `/tmp` is tmpfs, the byte floor protects the
same RAM needed by checks, while the inode floor catches exhaustion before the byte limit is reached.

Under the host reservation lock, each held slot contributes its recorded per-slot reservation. A new request for
`n` slots at `m` GiB per slot is admitted only when held memory plus `n * m` fits the same host memory maximum used
by physical take (`memory.max`, or configured `memoryMaxGiB` when that counter is unavailable). A priority head is
ranked with this total reservation too. A free slot's stale reservation file does not count.
Headroom is `max(0, memory.max - memory.current)` in the shared slice.
When slice memory cannot be read, it uses the machine's `MemAvailable` instead. Every run also sets Node's compile cache to a directory inside its run directory; cleanup removes the cache with that run.
Slots reserve admission capacity. They do not impose a separate CPU or memory cap on each run.

One slot is express capacity. Only a non-gate, one-slot run with an explicit estimate of at most
120,000 ms qualifies. It takes an ordinary slot first, then express if needed.
Long and unestimated runs cannot take express. Estimates classify runs; they do not stop overruns.
When its memory reservation fits, express lets short work proceed while ordinary work is full.
There is no enforced 120-second command deadline; `--estimate-ms` classifies slot eligibility and sets the independent physical lifetime described below. A live landing/critical waiter gets one configured admission poll of first opportunity on its chosen host. If it has not taken capacity by then, native slot admission and client ranking backfill capacity that fits later eligible requests while preserving actual slot, memory, gate and express limits. Abandoned marker files are removed only after the marker lock proves the holder has exited.

A waiting gate holds a host's `gate-wait.lock` over SSH. While that marker is held, non-gates may occupy
at most `O - G` ordinary slots (one when `O` is positive). Short runs may still take express.
This reservation uses the host's full gate capacity, even if the gate requests fewer slots.
The gate itself uses ordinary slots only. Its request is reduced to the largest answering host's `G` if needed.
No host with positive `G` is an error, so gates need capacity of at least three.

The gate's drain wait is bounded by the remaining lifetime of the original slot holders on its reserved host,
plus probing and acquisition overhead. Later non-gate arrivals cannot fill the reserved capacity.
This assumes the holders finish, the host stays reachable and enough reserved memory becomes available.
It is not a fixed wall-clock timeout. The bound starts when the gate obtains its marker;
competing gates may first wait for that marker.

Multi-slot requests take all slots together on one host or take none.
The host-wide `reserve.lock` protects only the atomic take. A waiting non-gate holds no slots or reservation.
Ordinary requests are capped at half the smallest eligible answering host's capacity, rounded down,
with a minimum cap of one and a further ceiling at its ordinary capacity.
Hosts with no ordinary capacity are excluded if any ordinary-capable host answers.
An excessive request fails before waiting; lower the run's concurrency and slot request.

Hosts rank by resource-backed free slots, then by measured memory headroom.
Single-slot acquisition first prefers hosts without a waiting gate.
Free slots account for held locks, express eligibility, gate reservations and whether the requested memory reservation fits.
Admission retries races against other callers. The default probe interval is five seconds;
`REMOTE_CHECK_POLL_MS` overrides it.

### A run's life and measurements

1. Select a responding eligible host and verify a run-private SSH control connection with a trivial command before
   using it. The probe is bounded to five seconds. On failure, close that run's master, replace its control path and
   probe once more; the second failure is `RemoteTransportError` for the host and `control probe` stage. A check never
   closes another run's control path.
2. Rsync existing tracked and unignored untracked files into `/srv/rezics-check/runs/<run-id>` without an execution
   slot.
   Omit Git metadata, `node_modules` and root `.temp` files. For Bun-backed commands, stage a native Git snapshot in
   an ignored, unique directory under root `.temp` and include its manifest and pack in the same upload. Snapshot
   boundary: `merge-base(HEAD, dev)`, or `HEAD` without a usable `dev` merge base (affected-test selection then runs
   unscoped). The snapshot retains the checkout's real `HEAD`, staged index tree and commit paths from
   `HEAD` and `dev` to their merge base. It does not transfer `.git`, the mutable index, configuration, remotes,
   credentials, hooks, reflogs or object alternates. A
   reusable immutable pack is accepted only when its object format, `HEAD`, `dev` base, shallow boundary, index tree
   and manifest/pack integrity match. Snapshot staging reports artifact bytes and the rsync upload reports its
   duration and bytes sent; the per-run local staging directory is removed after transfer, including on failure.
   Uploads use zstd compression when both rsync endpoints support it, and checksum against the host's
   `/srv/rezics-check/bases/current` tree so unchanged files are copied on the host. A missing base means a full upload.
   After upload, a base older than 30 minutes is refreshed from the run tree and `current` switches atomically;
   older runs can keep reading the previous tree. Bases older than two hours are removed during host cleanup, except
   for the current base. The configured hosts file is re-read on every admission wait round. A valid update takes
   effect immediately; a removed or unresponsive upload host is discarded and the workspace is selected and uploaded
   again on an eligible current host. While the uploaded host still answers, the wait stays on that host even if it is
   busy. Its admission probe refreshes the uploaded directory's liveness marker, preventing stale-run cleanup during
   long queues. A missing directory forces re-upload before execution. A missing or malformed rewrite keeps the last valid list for that round and logs once. An answering but busy
   host never triggers local fallback.
3. Acquire the requested slot locks on the uploaded host immediately before starting the remote run. Its generated
   entry point runs through the host's SSH shell and explicitly execs the provisioned Bash interpreter, so multi-digit
   slot descriptors work when `/bin/sh` is dash. Provisioning installs Bash on both supported package families. The
   slot holder remains live until the command is terminal. If the command connection is lost, its recorded exit status is checked;
   an unverified live run is stopped through the run-specific systemd slice or the slot holder's orphan cleanup before
   capacity is released. Abort follows that same stop-before-release path.
4. Every admitted physical run starts an independent host monitor before base refresh or dependency work. Its absolute
   monotonic lifetime is `min(2 hours, explicit maxMs, max(1 second, 3 * estimateMs))`; missing/zero estimates use a
   40 minute estimate. An explicit positive maximum can shorten this limit and cannot raise the two-hour cap. Safe
   integer validation and saturating multiplication apply to ordinary, multi-slot, gate, standalone and try-once runs.
   Nested commands inherit the enclosing physical run rather than acquiring another lifetime. Queue and upload time
   precede this deadline; returns retain their separate transfer bound. No environment setting raises the cap.
   The host monitor uses a detached session, Linux subreaper adoption and identity-checked pidfds. It forwards no
   command output, so an unread/backpressured SSH pipe cannot block its deadline. Neither output, CPU progress nor
   heartbeats renew it. On expiration it sends TERM, escalates after 200 ms, reaps all owned descendants (including
   fork/setsid children), removes only exactly labelled run containers, and verifies the run cgroup is empty before
   publishing terminal admission state. Abort/orphan stop also waits for the recorded monitor to stop its tree.
   A timeout exits 124 and durably writes `run-lifetime-status.json` in the run and
   `/srv/rezics-check/receipts/<run-id>/`, which run-directory cleanup never removes. Its versioned infrastructure
   receipt names the host, run, `phase=run-lifetime`, effective limit, elapsed time and a bounded executable/subcommand
   identity with argument count; argument values and shell source are omitted. The marker is
   `remote-check: infrastructure failure: remote run timed out ` followed by that JSON receipt (`schema=1`).
   The controller retrieves it independently of command output before returns, saves it under
   `.temp/remote-check/receipts/<run-id>/`, and retains the timeout cause if returns fail. Worker-check records the same
   reason in its physical ledger and terminal result, without local fallback or a timeout retry. A command's own exit
   124 or test timeout is not this infrastructure classification. The later controller timer is only a recovery guard.
   For Bun-backed commands, before dependency installation the bootstrap verifies the transferred manifest and pack,
   then restores a genuine independent repository with a private writable index and worktree registry. It does not
   check out over the synced files, so tracked, staged, unstaged and untracked bytes remain intact. Missing or corrupt
   artifacts fail preparation before `command-started`; the manifest and pack are removed after restore and excluded
   from refreshed bases. Prepare dependencies at the copied checkout root, then run the command in its requested directory. A Python 3
   supervisor inside the run's systemd scope and the independent host monitor apply an absolute **180,000 ms** preparation deadline, starting before base refresh and
   pinned-runtime verification/download and including cache lock waits, installation, lifecycle children, artifact
   verification, publication and restore. Output and CPU activity never extend it. Override it with
   `RemoteCheck.preparationTimeoutMs` or `REMOTE_CHECK_PREPARATION_TIMEOUT_MS` for finite fixtures.
   A cold artifact miss runs `bun install --frozen-lockfile`, preserving every lifecycle script. The shared
   `BUN_INSTALL_CACHE_DIR=/srv/rezics-check/bun-cache` remains a download cache; it does not substitute for lifecycle outputs.
   Verified installation artifacts live in `/srv/rezics-check/dependency-artifacts`. The key includes the complete uploaded
   workspace inputs (including manifests, lockfile, patch and lifecycle sources), Linux platform/architecture/libc,
   runtime build and exact pinned Bun revision. Successful installation's changed/generated files, symlinks and deletions
   are recorded, including native binaries and workspace lifecycle outputs. Disposable compile caches are excluded.
   Cold publication also verifies each installed workerd binary's exact dated version and each Bun package binary's
   pinned revision, since workerd's own installer can swallow binary execution errors. These subprocesses remain under
   the same absolute bound. Every cache use verifies file hashes, modes and symlink targets. Each run gets private copies, never shared mutable
   `node_modules` inodes. A per-key kernel lock serializes publishers; its wait is part of the deadline. Publication is
   a verified atomic directory rename. Failed/aborted publishers leave no consumable partial entry, and a timed-out waiter
   cannot delete another publisher's cache. Changed inputs/platform/revision or a damaged entry rebuilds it.
   A second immutable native-artifact layer is keyed by lockfiles, workspace manifests, patches, platform/libc, runtime build and exact Bun revision. It contains only installed workerd/Bun and their platform packages, verified binaries and links. On an unrelated source edit these artifacts seed a private install while frozen installation still runs all lifecycle scripts to regenerate source-dependent outputs. The complete source cache remains independently invalidated. Native identities compare by package name and version, so a verified older publication with a different traversal order remains reusable. Both layers use bounded per-key locking and verified atomic publication; a tarball cache alone is insufficient.
   Source and native artifacts share an eventual LRU maintenance target capped at 10% of filesystem capacity and
   reduced to preserve 10% free space. Publication derives allocated bytes from its verification inventory and never
   scans legacy entries, takes a cache-wide lock or waits for eviction. ENOSPC skips optional publication without a
   sweep or retry; install validation and the actual command result still apply. Partial staging stays inside the owned
   run for normal post-command cleanup.
   After terminal status is durable and the run tree is reaped, the host registers the independent systemd
   `rezics-check-cache-maintenance` timer/service with `--no-block`; registration failure leaves the result unchanged.
   The timer starts after one second and repeats 60 seconds after service exit. Its self-contained program survives
   run-directory cleanup; systemd owns its control group, 256 MiB memory limit, 20% CPU quota, idle I/O priority,
   three-second runtime limit and one-second stop timeout. Controller deployment must restart this timer to update it.
   Each sweep admits two seconds of monotonic work, at most 128 namespace records, eight detachments and 128 deletion
   steps. Directory cookies persist scan progress; completed passes restart to reconcile concurrent mutations.
   Accounting reports measured bytes and unknown entry counts separately. Decision: unmeasured or malformed legacy
   entries are conservatively eligible for incremental eviction, without recursively measuring them.
   Hits/publications refresh directory mtime. Maintenance takes global and per-key locks nonblockingly, revalidates
   inode and last-use snapshots, then atomically detaches eligible entries into `.garbage` under the per-key lock.
   Lock files remain stable. Recursive deletion runs afterward under a separate garbage-directory lock, with neither
   the global nor per-key lock held; interrupted deletion resumes on later ticks. Active entries and newly reused or
   replaced snapshots are skipped. Backlogs and unknown sizes may temporarily exceed the target; maintenance never
   makes that target a preparation or result-delivery condition.
   Preparation failure returns infrastructure status 70, writes `preparation-status.json` and `exit-status`, and streams a
   bounded diagnostic receipt with host, run, phase, elapsed time and actual active package names/versions from owned
   process working directories and package metadata. Unknown package identity stays unknown; previously observed packages
   are separately identified. No command or successful-install marker is produced on failure, and installation failure
   cannot trigger local fallback. Signal/transport teardown retains systemd custody and stops/reaps the owned installer
   descendants (including detached grandchildren) before releasing capacity. Successful cache reuse writes
   `preparation-install.json` with its key, hit/miss, `nativeCache` hit/miss (null on a complete-install hit), package versions and verified native identities. These files can be declared as return paths.
   After preparation succeeds, teardown of residual command descendants preserves the command's native exit status;
   it does not relabel a native failure as an installer failure. Local command custody also reacts to runner death
   and reaps detached descendants before their inherited capacity locks become free.
   The existing transfer timeout does not apply to preparation or a quiet command.
   Pinned Bun runtimes are cached by version and build under `/srv/rezics-check/pinned-bun/<version>-<build>/package/bin/bun`.
   The host verifies the cached binary's revision on every run and downloads a replacement when it is missing or stale.
   Remove `/srv/rezics-check/pinned-bun` only when no run is active on the host and the host can download the pinned
   runtime from the npm registry; the next run needs that download to recreate the cache.
   `BUN_RUNTIME_TRANSPILER_CACHE_PATH=<run-directory>/bun-runtime-transpiler-cache` isolates runtime transpilation.
   Chromium uses the shared `/srv/rezics-check/browsers` installation.
5. Execute inside a transient `rezics-check-<run-id>.scope` in a nested per-run slice under `rezics-check.slice`.
   The slice name replaces run-ID hyphens with underscores. `REZICS_CHECK_SLICE` names that slice.
   Remote runs set `REZICS_STACK_LEASE=off`; remote admission has already reserved their slots.
6. Once the remote run is terminal, release its execution slots before checking or copying declared return paths and
   before removing the run directory. Return paths are copied after success or command failure; missing paths are logged
   and skipped. Output streams to the caller. The command's exit code becomes the caller's exit code.

Workspace upload, the returns probe, returns copy and slot take each stop with a `RemoteTransportError` after 120 seconds
without measured I/O progress. Rsync progress comes from bytes actually transferred. Tests can inject shorter bounds
through `RemoteCheck.transferTimeoutMs` and `RemoteCheck.controlProbeTimeoutMs`, or through
`REMOTE_CHECK_TRANSFER_TIMEOUT_MS` and `REMOTE_CHECK_CONTROL_PROBE_TIMEOUT_MS`. These transfer limits do not apply to a
quiet live remote command; command deadline and liveness rules remain in force.

`RemoteCheck.completed(receipt)` receives the outer physical result (`RemotePhysicalRunReceipt`, schema 1):
`host`, immutable `run`, `exitCode`, `lifetimeFailure` and `resources`. The callback runs after terminal custody and
slot release, before returns/cleanup. Resource observation failure supplies null and cannot change a command verdict.
`parseRemotePhysicalRunReceipt` validates structure; parsing arbitrary output does not establish provenance.
The CLI sends this result over an optional inherited **fd 3** only when `REMOTE_CHECK_RECEIPT_FD=3` and
`REMOTE_CHECK_RECEIPT_NONCE` are both set by its launcher. Each newline-delimited envelope contains that nonce and
`receipt`; genuine transport exceptions send `transportFailure: {schema:1,message}` on the same channel. The SSH child
and native test command do not inherit that descriptor or nonce. Worker-check validates this channel and saves
`physicalRun` in its original result record. Printed markers, malformed/nested receipts and a test's own 124 cannot
set `infrastructureFailure` or authorize transport fallback. A failed returns copy retains an already recovered lifetime cause.

`PhysicalResourceReceipt` schema 1 records the configured host/run, observed host boot, owning supervisor
PID/start/group and observed per-run slice cgroup path/device/inode and actual scope systemd invocation. The owner samples only that cgroup's
`cpu.stat:usage_usec` and `memory.peak`, on a fixed 5-second cadence plus preparation, command and terminal edges
(at most 1444 rows / 500000 returned bytes under the two-hour cap). Rows contain host-monotonic `monoMs`, phase,
raw counters, `intervalMs`, interval `cores`, and explicit `unavailable`. `sampledMaxCores` is the maximum delta
CPU usage divided by its measured interval, not cumulative CPU or a host processor peak. Missing counters,
generation changes and counter regression are unavailable, never zero. `memoryPeakBytes` is the native cgroup
lifetime peak; it is not RSS. `startedMonoMs`, nullable `commandStartedMonoMs` and `terminalMonoMs` expose coverage;
an early failed install has no command start. A terminal handshake samples before normal scope removal; forced
teardown samples before stopping owned work and reports later unavailable counters honestly. The monitor owns all
sampling, so no detached sampler can survive it. Receipts persist at `/srv/rezics-check/receipts/<run>/physical-resources.json`
and return independently over the verified current host/run boundary to `.temp/remote-check/receipts/<run>/`.
Host boot and supervisor generation are verified during recovery. Observation cannot extend a deadline, certify
termination, delay slot release or start another command.

Cancellation uses `ExecutionCancellation = {file,id}`. An execution owner calls
`requestExecutionCancellation(token, signal=15)` **before** its supported owned-process stop. Atomic first-intent
publication is durable and immutable (`{schema:1,id,signal}`, signal 1/2/15). `RemoteCheck.cancellation` and
`StackRun.cancellation` accept this token; CLI launchers use `REMOTE_CHECK_CANCELLATION_FILE` and
`REMOTE_CHECK_CANCELLATION_ID`. Admission, upload completion and the immediate command boundary check it; a bounded
observer also aborts active operations. Cancellation cannot become transport unavailability, retry, re-placement or
local fallback. `workerCheckCancellation(id,cwd)` supplies the supported logical check token and
`requestWorkerCheckCancellation(id,cwd,signal)` publishes intent without killing processes or changing task state.
Detached waiters honor this intent without rerunning or overwriting original terminal custody. Linux local commands
reuse the identity-safe subreaper/pidfd teardown, including detached TERM-resistant descendants, before returning
capacity. Uncancelled remote transport failure remains non-green and does not start a local replay.

The run puts its Docker wrapper first on `PATH`. It adds `--cgroup-parent=$REZICS_CHECK_SLICE` to
`docker run`, `docker create`, `docker container run` and `docker container create`.
It also adds `rezics.check.run=$REZICS_CHECK_RUN` labels. Other Docker commands pass through.
The wrapper finds the real Docker later on `PATH`, so a preceding test shim can call it without recursion.
The run and its containers therefore share accounting and the parent slice's resource limits.

Worker processes also put the worktree's `scripts/check-host` wrapper first on `PATH` when it exists. It places worker
containers in `rezics-check.slice` and labels them `rezics.worker.attempt=<task>/<attempt>`; settlement removes only
containers with that attempt label. Remote runs do not receive worker identity and retain their run label and cleanup.

A worker check reruns once under the same admission when every reported test failure is HTTP 503 `deadline_exceeded` or
`overloaded`, retrying only attributed failing files or the whole command when attribution is unavailable.

Stderr reports `remote-check: slot wait`, `rsync`, `bun install` and `command`, each with seconds and host name.
Set `REMOTE_CHECK_PRIORITY=landing` for a landing check to wait ahead of multi-slot and ordinary runs, while gates keep first priority.
`.temp/goal/task-priority` is the control plane's per-worktree priority file (`critical` or `normal`), read at every worker check; the per-run record makes any other use visible.
The `rsync` line also includes the bytes sent from rsync statistics. If zstd is unavailable, the run reports that it
uses rsync's default compression. Returned outputs add `rsync back`. Slot wait measures admission after upload; the
`rsync` line measures upload separately.
Rsync exit code 24 is accepted for uploads and returned outputs, with the number of vanished files logged.

Uploads and returned-output copies have a 120-second no-progress limit by default, configured with
`REMOTE_CHECK_TRANSFER_TIMEOUT_MS`. The watchdog reads `--info=progress2` records from rsync stdout; only a valid record whose transferred
byte count exceeds the previous high-water mark restarts the limit. Repeated or decreasing counts, malformed records,
and stderr diagnostics do not count as progress. Stdout progress and stderr diagnostics are forwarded as they arrive;
only bounded line state is retained while the producer extracts rsync's sent-byte summary and vanished-file messages.
On expiry, remote-check stops and reaps the original local rsync child and reports the host, transfer step, limit and
last observed byte count, for example:

```text
remote-check: connection to check-small failed during workspace upload before a result; no-progress watchdog stopped and reaped the original local rsync child after 120000 ms without increasing transfer bytes (last observed byte count: 1048576)
```

An external rsync signal keeps its child exit status and is not described as a watchdog timeout. Caller cancellation
stops and reaps that same local child without converting the cancellation into a transport retry.
When cgroup counters are readable, the run also prints:

```text
remote-check: run used 12.000 CPU seconds over 3.000 s (4.00 cores), peak memory 1024 MiB on check-small
```

CPU seconds come from the run slice's `cpu.stat` `usage_usec`. Average cores divide CPU seconds by wall time
from install start through command completion. Peak memory comes from `memory.peak`.
These include the run's containers and installation, but exclude upload and admission wait.

Finally, cleanup stops that run's scope, removes only its labelled containers with their associated volumes,
stops its slice and deletes its directory. Slot locks are already released before this output and cleanup phase.
Signals also take this cleanup path. A failed cleanup connection leaves a warning.
Before taking a slot, the stale-run sweep also removes directories older than 60 minutes
whose corresponding scope is inactive and whose `.alive` file is absent or older than 10 minutes; a run without
that file keeps this directory rule for compatibility with older clients. It uses the same run-specific cleanup.
Never prune Docker or remove another active run's resources.

Both remote admission and the local stack lease append waits to `GOAL_CHECK_WAIT_FILE` when set.
They append positive elapsed-millisecond increments, each at most 60,000, while waiting and on exit from the wait.
The first timer fires after about 100 ms, then every minute; retry loops also flush elapsed time.
The silence monitor can account for queued time before the check starts. Recording is best effort.
Without the variable, neither records wait hints. Installation and execution time are not queue waits.

Local stack admission is separate: FIFO tickets and `flock` locks under `/tmp/rezics-stack-lease` span worktrees.
Its capacity is `max(1, min(floor(logical processors / 8), floor(total GiB / 7.5)))`.
`REZICS_STACK_SLOTS` overrides capacity; `REZICS_STACK_LEASE_DIR` overrides the directory, but `TMPDIR` does not.
Inherited `REZICS_STACK_SLOT` or `REZICS_STACK_LEASE=off` skips acquisition.
Waits have no timeout. Stderr reports held slots and tickets ahead every minute, then acquisition time.
Worker memory admission uses a separate FIFO lease under `/tmp/rezics-check-memory`. The worker acquires it only
before local execution or after remote transport failure. A nested `stack-run` recognizes the worker's memory lease
and remains local for that admitted command; explicit `--local` is propagated to nested stack runs even when no
memory lease is needed.

### Provisioning

Run from the checkout, with a root SSH account or equivalent privileges:

```sh
scripts/provision-check-host.sh root@check.example .secrets/server/check-small/operator-ed25519 10 800
```

The script detects Debian-family or Fedora/RHEL-family systems from `/etc/os-release`.
It installs missing Git, rsync, archive, download, certificate, locking, Bash and Python 3 tools with apt or dnf.
Python 3 must provide `os.pidfd_open` and `signal.pidfd_send_signal` (3.9 or newer), and Linux must support pidfds
and `PR_SET_CHILD_SUBREAPER`. Provisioning validates those primitives before admitting the host.
It installs pinned Bun and Node versions under `/usr/local` when their versions differ.
It installs the pinned Playwright Chromium once per version in the shared browser directory.
Debian uses Playwright's `--with-deps`; Fedora installs Chromium without that apt-based dependency step.
Docker and any remaining browser system libraries must already be available.
It removes the two old shared Bun runtime transpiler caches and creates the check directories.
It writes `MemoryMax` and `CPUQuota` into `rezics-check.slice`, reloads systemd when needed and starts the slice.
Rerunning with the same settings avoids rewriting unchanged configuration.

For this machine as a loopback host, choose a name and use its key only over loopback:

```sh
mkdir -p .secrets/server/loopback
ssh-keygen -t ed25519 -f .secrets/server/loopback/operator-ed25519
sudo install -d -m 0700 /root/.ssh
{ printf 'from="127.0.0.1,::1" '; cat .secrets/server/loopback/operator-ed25519.pub; } |
  sudo tee -a /root/.ssh/authorized_keys >/dev/null
scripts/provision-check-host.sh root@127.0.0.1 .secrets/server/loopback/operator-ed25519 10 800
```

Ensure key-based loopback SSH already works, including host-key trust. Add `root@127.0.0.1` to the hosts file.
The resource numbers above are examples; choose limits that leave room for the machine's other work.
The script recognizes `127.0.0.1`, `::1` and `localhost` as loopback destinations.
It still provisions tools, caches, browsers and the slice. It leaves sshd configuration unchanged,
and does not validate or reload sshd on loopback. Existing root-login and authentication policy stays in force.

For other destinations, `/etc/ssh/sshd_config.d/90-rezics-checks.conf` sets `MaxStartups 100:30:300`
and `MaxSessions 64`. These allow parallel connection starts and multiplexed sessions.
An optional fifth argument supplies comma-separated IPv4/IPv6 CIDRs for `PerSourcePenaltyExemptList`.
Use the check callers' source networks. Without that argument, existing exemption lines in this drop-in survive.
Every supplied CIDR is validated before connecting. Other old drop-in contents are replaced.
The script runs `sshd -t` before reloading `ssh.service` on Debian or `sshd.service` on Fedora.
Validation failure restores the previous drop-in and does not reload sshd.

### Adding, resizing and removing a host

Start with a small slice and slot count. Allow at least two effective slots for ordinary runs and three for gates.
Provision it, add its entry and run representative kernel, auth, browser and gate checks.
Read the per-run CPU seconds, average cores and peak memory lines, including container usage.
Measure complete runs on a quiet slice and repeat with the intended mix of concurrent checks.

Choose concurrent runs so their measured core demand fits the slice's processors and their memory peaks fit its memory.
For similar one-slot runs, start with the smaller of `floor(slice processors / measured cores per run)`
and `floor(slice GiB / measured peak GiB per run)`, leaving headroom for variation.
Set `processorsPerSlot` to the measured processor demand per run (default two). Set each caller's memory request to its measured class peak with reasonable headroom; callers without a request use 2.5 GiB.
Include express capacity when setting `slots`; ordinary concurrency is one lower.
Use multiple slots for heavier runs and keep their requests within the non-gate cap.
Increasing `slots` beyond slice capacity adds no usable capacity.

Drain runs before reducing limits. Reprovision changed memory or CPU limits and update the matching JSON fields.
To remove a host, delete its entry once its runs have drained. Do not stop other workers' checks.

## Check cost

The [check cost report](../docs/research/check-cost.md) observed 141 check-hours in one 24-hour window, led by
kernel checks and root typechecks. These totals show exposure, not savings; overlapping ceilings must never be added.

Run experiments in this order: first reuse compilation and typecheck work within each landing dependency closure;
second publish an assembled dependency tree per host; then reduce outbound sync and plan documentation-only
typechecks before placement. Two-lane browser scheduling is a separate latency experiment: it can shorten the
critical path, not host-hours. Defer one long-lived Postgres per host until phase timings establish its return.

Count a change as a saving only after matched cold and warm comparisons at controlled concurrency, with equal
diagnostics and test results. Report check-hours and memory GiB-hours from the run ledger. Cache keys must include
compiler and runtime revisions, configuration, generated inputs, dependency state and schema identity; a base commit
alone is not a cache key. Keep shared entries immutable and give each run a private copy.

Fix proven infrastructure failures as reliability work; do not claim saved hours for those fixes. The run ledger is
required for measurement, and memory outside a run slice is not counted.

### Comment disagreements

- `RemoteCheck.gate` says a gate can use all but one host slot. `rankHost` and `acquire` cap its request at `C - 2`:
  one slot remains ordinary capacity and one is express. The oversized-gate log also says only one slot is left free.
- The remote module header promises a short run waits at most one short run per host.
  The code reserves express capacity, but has no FIFO ordering, duration enforcement or unconditional time bound.
  The 120,000 ms value is an estimate threshold.
- The remote module header describes gate progress without qualifications.
  The implemented reservation bounds draining after marker acquisition; it does not bound competing-marker waits,
  unreachable hosts, nonterminating holders or insufficient memory headroom.

## Check cost

The [check cost report](../docs/research/check-cost.md) observed 141 check-hours in one 24-hour window, led by
kernel checks and root typechecks. These totals show exposure, not savings; overlapping ceilings must never be added.

Run experiments in this order: first reuse compilation and typecheck work within each landing dependency closure;
second publish an assembled dependency tree per host; then reduce outbound sync and plan documentation-only
typechecks before placement. Two-lane browser scheduling is a separate latency experiment: it can shorten the
critical path, not host-hours. Defer one long-lived Postgres per host until phase timings establish its return.

Count a change as a saving only after matched cold and warm comparisons at controlled concurrency, with equal
diagnostics and test results. Report check-hours and memory GiB-hours from the run ledger. Cache keys must include
compiler and runtime revisions, configuration, generated inputs, dependency state and schema identity; a base commit
alone is not a cache key. Keep shared entries immutable and give each run a private copy.

Fix proven infrastructure failures as reliability work; do not claim saved hours for those fixes. The run ledger is
required for measurement, and memory outside a run slice is not counted.

### Controller-bound held-child lifecycle

`check-lifecycle.ts` adds one fixed operation to the existing producer. It consumes the existing
`ControllerProofBindingV1` reservation, registration, check fence, owner attempt and physical history. It allocates
no controller identity and has no separate authorization registry. Ordinary classification places this operation on
a/b; `--local`, environment markers and arbitrary Bun eval do not gain local execution. If the initiating source is
already inside a natively recognized admitted check-host run, the existing worker placement executes the child in
that scope. That case controls its own physical filesystem directly; it does not turn an initiating workstation's
file into a remote release.

The exported interface is:

```ts
lifecycleProbeArgv(request: LifecycleProbeCommandRequest): string[];
startLifecycleProbe(request: StartLifecycleProbeRequest): Promise<StartLifecycleProbeResult>;
readLifecycleProbe(request: ReadLifecycleProbeRequest): Promise<LifecycleProbeResult>;
releaseLifecycleProbe(request: ReleaseLifecycleProbeRequest): Promise<ReleaseLifecycleProbeResult>;
waitLifecycleProbe(request: WaitLifecycleProbeRequest): Promise<LifecycleProbeResult>;
```

First call `lifecycleProbeArgv` with `{cwd, checkId, taskId, attempt, sourceCommit, sourceTree, nonce, exitCode,
lifetimeMs}`. `nonce` is 32 random bytes encoded as 64 lowercase hex characters; the UUIDs, attempt and full source
commit/tree are the controller's existing identities. `exitCode` is exactly `0 | 7`; `lifetimeMs` is an integer from
100 through 120000. The helper reads the installed pinned Bun's version/revision, packageManager and the tracked
child's SHA-256, then returns exactly `['bun', 'scripts/check-lifecycle-child.ts', '--probe', base64urlSpec]`.
Reserve that exact original argv in the existing controller reservation before starting. The child source must be a
canonical tracked regular file in the captured clean commit/tree. The fixed spec is a closed version-1 object with
`checkId, taskId, attempt, sourceCommit, sourceTree, nonce, exitCode, lifetimeMs, runtime, childSha256`;
`runtime` has `packageManager, version, revision`. No caller-supplied program or gate path is accepted.

Request schemas:

| Operation | Request                                                                                                     |
| --------- | ----------------------------------------------------------------------------------------------------------- |
| start     | `{binding: ControllerProofBindingV1, observeMs?: number}`; default 5000, range 0..5000                      |
| read      | `{binding: ControllerProofBindingV1, physicalRunId: UUID}`                                                  |
| release   | `{binding: ControllerProofBindingV1, gate: LifecycleGate, action?: 'release' \| 'cancel'}`; default release |
| wait      | read request plus `timeoutMs?: number`; default 30000, range 0..60000                                       |

Start returns `{version:1, admission:ControllerProofStartV1, observation:LifecycleProbeResult}`. Runner-ready or
admission alone is not a running-child observation. Start may return an unavailable observation while ordinary
admission/preparation is pending; read the same physical identity again. An exact repeated start replays existing
custody. A lifecycle reservation admits at most one worker physical incarnation and one remote transport incarnation;
ordinary wait/watchdog and overload paths cannot relaunch it.

`LifecycleProbeResult` contains `version, status, binding, physicalRunId, custody, physicalTerminal`, with optional
`child, childExitCode, wrapperExitCode, record, physical, reason, failure`. `failure` is
`{kind:'child-infrastructure'|'wrapper'|'transport'|'custody', reason:string}`. Status is `running | released | terminal |
unavailable`; custody is `running | terminal | unknown`. Running requires a live authenticated response from the
actual child, not a saved ready file or the wrapper. `child` is a version-1 receipt with `state` (`running`, `released`,
`child-result`, `infrastructure-failure`), `evidence`, and optional `action, exitCode, reason`. Infrastructure never
carries the requested child exit. Read and wait preserve unavailable evidence and do not restart, cancel or settle a
lost run.

`LifecycleGate` is `{spec, physicalRunId, host, remoteRunId, child}`. `child` is the actual child's
`{pid,start,boot,group}`; `host` is its hostname, and `remoteRunId` is its enclosing remote run or null for execution
inside the caller's already admitted native host scope. `spec` binds logical UUID, task attempt, source and nonce.
Copy the entire gate from an observed running child's evidence into the release request. Release verifies the current
owner attempt and still-reserved original controller binding. Wrong generations, PID reuse, foreign source/runtime,
symlink receipts, reused physical gates and contradictory releases refuse. Same-action retries recover the original
immutable acknowledgement/result. A release acknowledgement always reports `custody:'unknown'`; it cannot release
native or controller capacity.

Child evidence includes `runtime:{packageManager,version,revision,execPath,executableSha256,pinnedExecutableSha256}`,
`source:{commit,tree,childSha256}`, `gate`, loopback `port`, `startedAt` and `expiresAt`. The actual child measures these
fields itself, checks its full runtime revision and binary hash against the installed pinned executable, checks its
source, and only then publishes running. Runtime/source mismatch exits 78 as infrastructure, cancellation exits 125,
and unreleased expiry exits 124. None is application success0 or failure7. There is no timer-based application release.

Gate transport uses the selected configured host and its immutable remote run from existing remote custody. The
existing bounded SSH transport invokes only that run's installed Bun and tracked child `--control` operation; the
child authenticates the complete gate over a bounded loopback RPC. No release path is uploaded from the caller.
The `.temp/goal/checks/lifecycle/<physicalRunId>/` directory on the execution host holds exclusive `claim`,
`ready.json`, `release.json` and `terminal.json` receipts. These are anti-reuse/evidence files, not authorization.
All ancestors and receipt files reject symlinks; receipts are exclusive, fsynced and at most 16 KiB. Ordinary declared
returns retrieve the three JSON receipts after both exit0 and exit7. Live observation never trusts a caller-local
copy. Each child permits four simultaneous connections and at most 1024 authenticated observations; an RPC is bounded
to two seconds, SSH control to five seconds. Wait uses bounded observations of this one identity, with no history scan.

A terminal application result requires the exact child receipt, its structured foreground-log line, the wrapper's
actual OS exit and (for a forwarded command) its matching native remote receipt. `physicalTerminal` separately requires
positive whole-tree local and any required remote custody, recorded through the existing physical history. Merely
reading child-result, missing PIDs, a transport failure, expiry or caller death cannot establish application completion
or free capacity. The local admitted-host case also observes the child's detached group, since the subreaper starts
that child in its own session. The existing identity-checked stop protocol owns bounded cleanup; read/wait only observe.

The CLI uses the same request schemas in a bounded, canonical absolute JSON file:

```sh
bun scripts/check-lifecycle.ts argv /absolute/worktree/.temp/lifecycle-command.json
bun scripts/check-lifecycle.ts start /absolute/worktree/.temp/lifecycle-start.json
bun scripts/check-lifecycle.ts read /absolute/worktree/.temp/lifecycle-read.json
bun scripts/check-lifecycle.ts release /absolute/worktree/.temp/lifecycle-release.json
bun scripts/check-lifecycle.ts wait /absolute/worktree/.temp/lifecycle-wait.json
```

Each prints its typed JSON result. Foreground wait additionally prints the logical UUID, physical UUID, exit status and
original log path, and exits the independently verified child0/7 only with terminal whole-tree proof; otherwise it exits75.
Read/release return75 for unavailable observations/acknowledgements. Start returns its typed admission even when the
child has not reached running; inspect both fields. Start exits0 for started/replayed admission, 1 for a positive
never-started refusal and 75 for unavailable custody. The CLI never creates or revokes controller reservations.

Lifecycle acceptance is `bun test scripts/check-lifecycle.test.ts scripts/worker-check.test.ts scripts/remote-check.test.ts
scripts/check-custody.test.ts scripts/check-placement.test.ts`. It includes real bounded held children, actual pin
measurement, hostile gate/refusal cases, lost callers/acknowledgements, descendant cleanup, fake-transport unit cases,
and ordinary real a/b producer admissions for both exact exits. Missing native admission or proof fails those real
admissions; it is not a skipped success. Minimal source delivery defers this acceptance, native validation and runtime
release to normal control-plane validation before consumer use. `scripts/` has no workspace manifest or supported
scripts TypeScript compiler route; the root `scripts/typecheck.ts` orchestrates application/package workspaces and
does not typecheck these producer scripts. No scripts compiler command is implied by source delivery.
