# Verification

Verify the promised outcome through the real boundary that owns it.

API acceptance covers the personas and permission rules the outcome changes, through the real boundary. Test
rejection of invalid input where outside input enters, and lifecycle, replay or dependency failure only where the
outcome promises behaviour for them. Use native Access and production contracts. A permissive stub cannot prove
authorization or disclosure.

Keep specified, implemented, exposed, tested and promoted distinct. Report unavailable evidence as unavailable.

## Capability evidence

Verification follows the [architecture](../architecture.md): prove backend capabilities through the API before
building their interfaces. Write per-persona acceptance from user jobs on real-shaped, released fixture data before
implementation, with no frontend and no mocked owner modules. Freeze missing user cases red first; use the
[API acceptance gap inventory](../research/api-acceptance-gaps.md) to find them.

Each Goal maintains `docs/goals/<goal>.capabilities.md`. For every capability record the user job, personas, released
fixture data, every applicable surface cell with frozen scenarios or an explicit reason it does not apply, and the
native acceptance command. Completion and promotion refuse incomplete manifests. A manifest entry or parallel
specification without its passing native binding is not proof.

Build and prove frontend surfaces in Storybook 11 with `addon-vitest` and `addon-a11y`. Every route has page stories using recorded API
responses for populated, empty, long or overflowing content, preparing or unavailable, and error states, for each
applicable viewer (anonymous, member, owner or curator, suspended), on desktop and phone. Cover every control state
on library, Collection, subject, search and Zone surfaces: filters, selection, each status chip, curated and dynamic,
private/unlisted/public, Liked and Continue progress kinds. Fakes may inject interaction or failure; they do not replace native API evidence. Page data is compared with the seeded running product under the same anonymous or member identity at the page and native API; see [the checker contract](../../scripts/README.md#page-data-check). Fixture coverage alone is not acceptance.

Every interface brief lists the page stories it adds and their API evidence. Track exact story exports in the
[page story coverage map](page-stories.md); a story proves only what it actually renders. Existing primitive stories
remain, but receive no further workflow effort. Play functions prove behaviour; accessibility checks and visual
snapshots support review by eye. The development publication is `https://storybook.rezics.com`.
[Web recording and screenshot procedures](../../apps/web/README.md#storybook-and-page-recordings) own the commands.

## Check selection and failures

Dev's floor, in order: development continues, and dev runs, so problems can be debugged. A broken dev never holds
landings. The dev verifier's boot smoke catches a dev that does not start and dispatches an urgent repair to the commit
that broke it.

Decision: an ordinary product attempt proves that every changed workspace type-checks, plus the tests of payment, payout, order settlement, points and balance code when it changed them. All other tests, including native, browser and growth suites, run after landing in the dev verifier, which batches dev heads, runs acceptance and sibling tests, and attributes failures by bisection. A failing test there is a repair for the owning manager, not a revert.

Decision: typecheck repairs preserve existing test assertions and update fixtures, helper signatures and response shapes to current contracts; add behaviour tests only for concrete runtime defects.

Decision: under minimal verification a type error blocks a worker's success, and a failing payment, payout, order settlement, points or balance test blocks it when those paths changed. Other tests are not part of the attempt check; the wrapper refuses a test file, native, browser or growth command before any upload, with a message that tests run after landing in the dev verifier. Type errors, boot failures and payment-path failures keep current verifier handling: type errors and payment-path failures revert the landing, boot failures dispatch an urgent repair without reverting. A test failure outside those paths creates or updates one repair for the owning manager and never reverts the landing.

Decision: environment walks run per Goal, not per outcome. An implementation brief declares no `native` or `browser`
`acceptance.requires`; its outcome lands on typing like any other. Each Goal keeps at most one walk task running; it
walks dev on a seeded stack as each persona. Goal dispatch and retry refuse a second such brief while one of that Goal
is ready, running, held or landing. Outcomes that each carried their own walk rarely landed: on 2026-11-06, 2 of 81
tasks integrated after 12:00 UTC carried one, while 14 of 29 running tasks did, at 17 hours and 3.7 attempts on average.

Decision: a walk repairs only what it needs to keep walking. It sends each failing journey, and each blocker that is
separable or lies in another owner's code, to the owning manager. That manager dispatches it at once as an urgent repair
brief, which runs in parallel with the walk. While managers read the walk as the owner of every repair, walks repaired
serially and backlogs stayed empty. From 03:00 to 04:00 UTC on 2026-11-07, 9 workers ran and 284 product lines landed.

Decision: ordinary product worker-check commands typecheck changed workspaces before landing and refuse test, native, browser and growth commands before upload. Urgent, control-plane, proof-run and acceptance-requires briefs keep their declared checks when the host-run budget is off.

Decision: remote run custody admission and updates use the reader's 64 KiB serialized JSON character limit; initial admission reserves 12 KiB for host and terminal transitions. Generated typing commands retain their existing 3,000-character argv chunks and exact argument boundaries. Tests separately pin per-argument binding rejection, aggregate serialized-record rejection, and terminal retention of the canonical binding, including compressed argv, hosts file and returns.

Decision: per-physical remote checks publish native receipts and settlement details once as immutable evidence artifacts keyed by logical check, physical generation, host/run and SHA-256; bounded custody and result records retain byte-counted references and verify identity and content before accepting a verdict. Settlement references omit the native receipt and terminal cleanup remains separately recorded. Version-1 inline records remain readable.

Decision: the worker owns and completes the private-follow host fixture, Auth-persona served journey, and 64/512/4096
fixed-neighborhood growth measurement case in the feature worktree. Capability promotion still waits for the installed
controller-owned native/browser run after integration; the worker's minimal check covers changed-workspace typing
and selected outcome tests. Typed transport, FULL withhold, frozen command frame and list-frontier return remain
ordinary clean-workspace checks. Private follow native/browser/growth capability stays open until that installed
controller-owned driver and Auth-persona walk pass after integration.

Decision: Web's focused runner (`apps/web/scripts/focused.ts`) canonicalizes explicit test-file selectors to the child
`apps/web` working directory before isolated per-file execution. Repository-relative (`apps/web/tests/foo.test.ts`),
application-relative (`tests/foo.test.ts`) and absolute paths that resolve inside that directory all run the same
child file. The runner chooses shared-server wrapping separately for each isolated file: `post-editing.test.ts`
owns its issuer-bound Vite server and must not retain an unused default Vite/Worker graph beside it. Its private
network and process-group cleanup remain. Ordinary and mixed selections retain shared-server preparation. Option operands and their values stay unchanged. Each named file still gets a fresh runtime. A zero-match
log is not execution evidence. Pin current-reader recovery in the existing Subject community, CollectionList, Copies
session and Person Location tests; Auth metadata uses the existing protocol cases plus a consumed-body fallback.

Decision: the focused CLI treats Bun's consumed `--` as the command boundary and also accepts a retained delimiter.
`--private-network` and routed selection keep their existing bindings, and command arguments pass through unchanged
to selection normalization.

Decision: test dependency admission uses the consuming workspace's declared packages and the syntax parser owned by
root tooling, including type-only imports. Web fixtures import their DOM tools directly, preserve the full public
exports of mocked modules, and explicitly restore module replacements; `mock.restore()` alone does not retire those
replacements. Locale transitions in mounted fixtures change the browser's locale-bearing URL as well as locale state.
Keep credential preparation and reached-work assertions on the real producers. Run retained multi-file selections
through the focused runner's fresh runtime for each file, in the original selection order.

Decision: mapper-enabled workspaces (Kernel, Auth, Web) typecheck one at a time inside an admitted slice so their
tsc/Reylo runs cannot stack past the per-run memory cap. Independent checks may run concurrently in separately
admitted slices; leaf packages may run in parallel within their admitted resources. Check producers before their
consumers. When a prerequisite check fails, return that failure for repair before running checks that depend on it.
Unreached checks remain unverified, and success still requires every changed workspace and required money-path test
to pass. Reuse unchanged valid passing evidence rather than rerunning it to complete a batch.

Acceptance names the narrowest command that proves the change. Managers name a full web or kernel check only for a
workspace-wide change; the train and promotion own whole-workspace checks.

Run acceptance once after the last relevant edit, plus the root typecheck (`bun scripts/typecheck.ts`).
Write missing contract tests and preserve frozen acceptance. A discretionary check must target a reachable failure
whose result changes the next action; name at most twelve nearby test files and reuse valid receipts. Broaden only
for shared contracts or unresolved failures. Run the full Kernel check for a runtime contract every module relies on,
and the control-plane gate for executable changes there. Documentation alone requires neither. A successful exit
is evidence only when the intended check actually ran.

For every operation, document one Cost entry with Operation, Touches, Bound and Growth check. Use one operation
subsection with the bullets `Touches:`, `Bound:` and `Growth check:`; its heading supplies Operation. Existing Cost
tables remain readable evidence; migrate them when touched rather than introducing a competing new format. Derive the bound before
implementation. Measure native examined rows, buffers, statements and other relevant work at three seeded scales.
Grow unrelated data and history independently while holding the selected neighbourhood fixed.

Include authorization, denied and empty paths, deep pages, projections and cleanup. Charge rereads, lookahead and
discarded work to the shared budget. A bounded returned array or request count does not prove bounded engine work.
The control plane follows the same rule.

Do not weaken a growth bound to fit a failure. Distinguish an algorithm defect, a fixture defect and a classifier
question; route each to its owner. A counted `limits` ceiling applies to every repetition at every scale and reports
the unit, scale, 1-based repetition, value and limit; counted `bounds` continue to compare medians.

Review interfaces in the running product. Compare phone and desktop, both themes, representative content and important
empty, loading and failure states. Compare shared components across surfaces. Fix the defect class. Automated tests
support this review; they do not establish visual quality.

Review screenshots after interface landings. During active interface work, publish reviewed evidence after each round
and at least every three hours through the configured channel. Check within an hour that a requested visible fix is
actually running.

Admit heavy checks through shared resource controls. Slice admission counts inactive file pages as headroom and may
reclaim them once through `memory.reclaim` before treating a host as full; a missing or unwritable reclaim file keeps
the previous probe and does not fail the run. After dependency-artifact eviction, a host below its configured free-disk
floor takes no new run; the slot-wait status reports that free space and the run is placed on another host. A check waiting for a slot is queued; let it run. Park workers until completion or meaningful output instead of
waking the model for “still running”. Worker admission and heavy-check admission are separate controls.
Remote-check stderr splits connection work, Git snapshot staging, GitHub fetch and rsync; overlay rsync after a
successful fetch is the expected upload. Remaining command-time cost is `bun install` and the admitted command.
Connection count is bounded by configured hosts, not by polls or concurrent runs: one ControlMaster socket per host
under `$XDG_RUNTIME_DIR/rezics-ssh` (relocated under `/tmp` when OpenSSH's unix_listener suffix would overflow). A
placement-probe timeout recovers only an affirmatively dead ControlMaster, at most once per host per minute, under the
same exclusive lease lock that acquisition holds shared; a delayed control check remains uncertainty. Five minutes of
probe-timeout skips report one environment event and do not retire a live master.
Slot and marker SSH admission drains stderr concurrently with stdout and retains a scrubbed 4 KiB byte tail.
Transport failures identify the host alias, allocated run, connection, local SSH PID, actual exit or signal and any
progress timeout separately. Configured addresses and identity paths are redacted. A zero-exit SSH EOF without the
required admission marker is an incomplete protocol response, not capacity-busy; the explicit busy status keeps
ordinary slot waiting. Before this boundary retained stderr, a missing marker could silently wait or report only a
generic transport failure. Retry diagnostics now survive the existing bounded backoff and failed-host preference,
which can continue on a healthy configured host. Neither these diagnostics nor termination of the local SSH child
establish a native command result or remote physical cleanup. EOF alone does not identify a network or shell cause;
that diagnosis requires the retained boundary evidence from the next already-required admitted check.

A stopped stale run can outlive its transient systemd scope. `systemctl stop` returns exit 5 for an unloaded unit;
that remote command exit must not be diagnosed as an SSH network failure. Existing exact-birth supervisor
terminality remains required: a started run with missing supervisor custody is retained, without deletion or a
cleanup claim. Unit absence is only a component observation. After that ownership check, owned-unit cleanup observes
`LoadState` and `ActiveState`: `not-found` plus `inactive` is already absent. Loaded owned units are stopped and
re-observed; query failures, unsuccessful stops with an active unit, or unknown states retain cleanup uncertainty
and their diagnostics. Only the `rezics-check-*.scope`/`.slice` namespace is eligible. Marker descriptor probes scope
their stderr redirection so a failed later command cannot become silent. These changes establish admission health,
not a native product result or cleanup proof for a different original invocation.

Throwaway Kernel/compiler PostgreSQL uses `--rm` plus exact owner and create-nonce labels. A timed-out removal is a
request, not observed absence: ordinary cleanup retries a bounded number of times and verifies the container and its
nonce-labelled volume are absent. A failed Docker listing or inspect stays an unsettled cleanup result with its actual
error; it never certifies absence. Native command status and diagnostics remain separate from cleanup failures, and
terminal result publication follows observed cleanup. `docker run`, `volume create` and `rm -f` use Auth's 120-second spawn timeout,
including host-lifetime Python cleanup; inspect/exec/ps/port probes use 5 seconds. Signal-path removal is detached so
a 200ms SIGKILL cannot abort it. Failed creates reconcile each nonce before retrying with a new one. Data stays on a
labelled volume, not a 1 GiB tmpfs. Compiler/Kernel create named volumes with the physical check-run label so host
lifetime cleanup can recover a volume after its container disappears. It reconciles containers and volumes independently
in three attempts; a successful fresh listing is the only absence proof, while Docker command failures retain stderr and
keep settlement unknown. Unsettled host cleanup records `.owned-resources-incomplete.json`, retains the root exit and
does not publish terminal `exit-status`. A later listing that proves removal still retains the earlier request error as
cleanup evidence. Isolated-stack databases attach with `container:<id>`, never `ns:/proc/...`, and publish
PostgreSQL through an independent TCP-to-Unix child rather than a same-process proxy, and wait for in-container
`pg_isready` plus a protocol reply before migrations. Empty-directory source and result manifests share the
`directory\0` digest.
Owned compiler databases are rechecked inside their exact container and at the host-facing endpoint before each mapper
workspace. The first post-failure readiness error includes the container identity, later mapper consumers stop when it
fails, and the compiler result remains primary.
Diagnostic reruns remain visible. A load-sensitive diagnostic rerun may address an actual load signal in a mixed
failure; cleanup failures are not eligible. Do not scale security TTLs, explicit deadlines or work budgets to hide
failures. A proposed test deadline multiplier is not evidence of deployment. Distinguish a reproducible
product failure from an infrastructure failure; never count an unverified baseline as a pass.

Infrastructure failures, including check transport, rsync exit 24, SSH drops and killed Git processes, are retried
by the tools without consuming a worker attempt. Preserve their exact errors; do not classify them as flaky product
assertions or weaken a check. Follow the bounded escalation in [maintenance](maintenance.md). A fresh worktree's
check must pass without manual preparation of generated output, Vite pre-bundles or test-only Worker variables;
check runners own that preparation. Once a remote command starts, its recorded exit status remains the result.

When a required whole `tools/goal` suite fails under host load, rerun each failing file alone. A file that passes
alone is load evidence, as in the landing check; a reproducible assertion remains a defect. Report completion once
acceptance, root typecheck and the applicable individual reruns pass. This exception does not excuse transport,
setup or cleanup failures and does not authorize a discretionary whole-suite run.

Check-host dependency garbage is reclaimed by a continuous systemd service, independent of routed runs. Inspect
physical bytes, alarm, deletion progress and observation validity using the exact commands in
[dependency garbage maintenance operations](../../scripts/README.md#dependency-garbage-maintenance-operations).
Missing/stale measurements and cleanup errors remain unhealthy; command success does not prove cache health.
Deployment must replace the legacy captured timer/program on each configured host before claiming live recovery.

Check fixtures invoke the current erasure producer-list function and define each Search service method once. Fixture
repairs of this kind align trusted producers with the current contracts; they add no authorization rule and change no
account custody.

## Temporary files

Workers use `.temp/worker-tmp` in their task worktree; deleting the worktree deletes their scratch files. Each gate,
local check and test invocation gets a separate directory in its checkout's `.temp`. Remote checks use
`.temp/tmp` inside their disposable run. Child processes inherit `TMPDIR`, `TMP` and `TEMP`. Node's compile cache is
disabled in these environments, including tools such as Vite that enable it programmatically.
`tools/goal` fixture helpers register teardown after every test, including failed tests, and make read-only
directories writable before removing them. Fixture process teardown precedes directory deletion.
These use Bun's [temp environment](https://bun.sh/docs/runtime/environment-variables) and
[global test teardown](https://bun.sh/docs/test/lifecycle) interfaces.

Decision: keep the pinned runtime, confine markers, expire inactive `.hm` entries after one hour and other recognized
entries after 24 hours, and run maintenance with permission to inspect every process's `/proc` references.

The control plane's maintenance timer should invoke `bun scripts/tmp-janitor.ts` hourly once available; use
`--dry-run` to preview. The service needs permission to inspect `/proc`, including nondumpable user daemons; a
privileged service selects the owner's numeric UID with `--owner-uid=<uid>`. An unprivileged invocation cannot select
another UID. It examines only entries belonging to the selected UID with the patterns in
`scripts/tmp-janitor.ts`. It checks both modification and metadata age, including descendants. It preserves
unrecognized entries, top-level symlinks, foreign-owned descendants, and entries referenced by a live cwd, descriptor,
memory mapping or inherited temp/cache environment. Failure to inspect a live process refuses the
pass. Shared stack and memory lease directories are never janitor candidates. A stale globally shared compile cache
with active users remains protected; new check and worker processes do not refill it.

### Cost: temporary cleanup

- Touches: one `/tmp` directory listing, one process reference snapshot, and each eligible stale tree once.
- Bound: linear in process references plus recognized entries and their descendants; active processes reserve
  ancestor paths in a set, so each marker needs a constant-time lookup. Normal teardown removes run scratch and
  an hourly pass bounds inactive recognized host leftovers to their retention period plus one hour.
- Growth check: `scripts/tmp-janitor.test.ts` covers retention, ownership boundaries, live references, failed tests
  and read-only teardown. A full day of workstation load and timer integration remain integration checks.

## Check placement

`scripts/check-placement.ts` is the shared conservative classifier used by worker checks. Root and Web typecheck
scripts, pure compiler and formatter commands, and explicit small unit selections are local. A small unit selection
has at most 12 explicit test files; each file and its statically imported relative source is at most 256 KiB, within
64 files total, and has no browser, server, database or native-stack dependency. Discovery, globs, preloads, shell
commands, full Kernel checks, browser work, database/container work and commands the classifier cannot prove local
go to a performance-approved check host. Package-script, `--cwd` and ordinary `env` prefixes use the same classification.

The dev train's serial prelanding root typecheck is a bounded placement exception: the train runs it on its local
landing host, after selecting the changed workspace dependency closure. Kernel's incremental compiler state is copied
from the base dev commit into a candidate-keyed entry, with the compiler, lockfile, project configuration and both
Kernel/Auth migration sets in the compatibility key. A passing batch publishes that entry only after the throwaway
database cleanup succeeds. The batch log reports elapsed seconds and selected workspace count. At three batch sizes,
the landing acceptance records those durations; this worker did not run that deferred acceptance.

Root typecheck outcomes distinguish compiler diagnostics from infrastructure. Database setup or cleanup failures,
host loss, timeout and compiler startup without file/line diagnostics produce an infrastructure result; a type failure
includes the compiler's complete file/line diagnostics.
Kernel check runs selected tests after owned TypeScript, Reylo, lint, format and module CREATE EXTENSION product
failures, then fails once with those diagnostics and the exact failed files; named `*.test.ts` arguments run,
including `scripts/check.test.ts`. Compiler startup without file/line diagnostics, future or duplicate migration
versions, schema dump mismatch and other infrastructure failures still return that stage and run cleanup.

Kernel typecheck and kernel check command phases are `database-image`, `migrations`, `sql-schema`, `compiler` and
`cleanup`, written to `REZICS_CHECK_PHASES`. Kernel typecheck nests `client-emit`, `tsc`, `construct` and `openapi`
inside `compiler` so one receipt can split those commands. Slot wait and rsync remain transport-owned and must not be
folded into those durations. Compare like command/source classes using command phases plus admission `inactive_file` /
IO pressure; do not treat wrapper wall time as compiler work. Cache-aware admission counts reclaimable file cache as
headroom (`3afee00d49` / `b1841e43808feae3d6f1c1f8617bc8ffdde2512f`) on current dev; that commit is not an ancestor of
`main`, and a dev commit is not deployed behavior. A single host-a Kernel typecheck can inform command diagnosis but
cannot establish a representative per-run transfer distribution or a postdeployment result. It does not identify the
10–25 minute host-b symptom, and a failed compiler cannot establish a successful full typecheck. Ledger Kernel
typechecks on 2026-11-04 used revision
`7a651ea717c21e8c659dc7f447d371e556a973d4`, ledger host `remote`, compiler exit 2, command 269–591s and wrapper
330–1375s. A passing 2026-11-02 Kernel typecheck had command 223s and wrapper 1591s at slot wait 4.6s. File-cache
pressure remains a correlation until a like-class b-host receipt records nested compiler phases, live producer hash,
host, concurrency, slice memory/IO and compiler outcome. Available receipts do not establish the deployed
remote-check transport hash or whether the supermanager's reclaim stopgap remains active. The handoff needs those two
facts and a comparable b-host receipt with command/source identity, concurrency, readable slice anon/file/inactive_file
and IO pressure, nested phase durations and compiler outcome. The one-run Kernel compiler database uses a labelled
volume in the run slice, matching kernel check storage.

Auth SQL preparation and Auth tsc have separate command phases. The prepared cache covers Auth SQL and the shared
Kernel SQL source set imported by Auth, keyed by the migrated schema, compiler/mapper toolchain, SQL contents and
database configuration. A compatible Kernel snapshot seeds Auth's private cache; schema or source changes regenerate
the affected analysis. The database remains owned until tsc exits, and explicit owner Reylo configurations retain
their existing behavior.

For the host-a transfer question, use genuine required-check receipts from the deployed class, bound to the deployed
`remote-check` hash, cp-sync point and periodic check-reclaim stopgap state. Compare the same command class, host, source
and dirty-tree state, snapshot/base reuse and concurrency. Keep snapshot staging, shared-store lock/fetch, per-run
checkout, delta rsync (actual bytes, file count and mode), dependencies, slot wait, command and return transfer
separate. Report the observed sample and its selection limits; keep detailed run artifacts under `.temp`. The retained
comparison is recorded under Wall-time measurements. Source integration, fixtures and one-off timings are not deployed
throughput evidence. A native compiler error may still yield transport measurements, but it is not successful
full-check acceptance.

`worker-check`, `stack-run`, `check-run` and `remote-check` derive the performance pool from hosts explicitly marked
`"performance": true` in the private hosts file. Missing or false flags exclude a host, including a or b; there is no
name-based placement allowlist. Host names use letters, digits and hyphens, with a letter or digit first
and at most 64 characters. Local flags, off markers, learned memory weights, local leases, an absent host pool and
a transport error cannot replay heavy or unknown work outside a physical check run. A failed or unavailable remote run remains non-green. A command is already on a check
host only when its working directory is inside that run's directory, its cgroup names the matching run scope, and
the run has a valid supervisor marker; environment flags alone do not establish remote custody. This applies equally
to a, b and the loopback workstation c; ordinary workstation workers and managers are outside check runs. The marker
validates physical identity, while the configured performance flag authorizes admission.

For managed remote `worker-check`, the wrapper writes a per-physical custody binding for the exact logical check,
task/attempt owner, original argv and handed-off remote argv before it starts `remote-check`. `remote-check` persists
each allocated host/run identity before probing, upload, admission or command execution. It retains the native
command receipt, final settlement, returned results and cleanup evidence in separate fields. If the detached wrapper
worker disappears, recovery observes and settles only the exact stored host/run and the same original logical check;
an exact terminal result with verified settlement can finish that check once. A pending reservation remains pending.
Missing or mismatched binding, no reservation identity, ambiguous attempts or incomplete terminal evidence stay
unknown with custody retained. Do not reconstruct a host/run from log text, host names or timestamps, and do not
signal another run or launch a replacement check during recovery.

Provision c with `performance: true`, 10 slots, `memoryMaxGiB: 20`, `cpuQuotaPercent: 3200` and
`processorsPerSlot: 1`. These admission limits apply in addition to its `rezics-check.slice` limit of 24 GiB and
4800% CPU; preserve at least 12 GiB of workstation memory for worker admission. Keep addresses and identity paths
in the private hosts file outside Git. A worker-local private file may be selected explicitly with
`KERNEL_CHECK_REMOTE`; updating the shared file is an integration operation when the main checkout is read-only.

`scripts/check-run.ts` is the trusted generic driver for caller-owned checks. Its `--hosts`, `--workspace`, `--cwd`,
`--source-revision` and private `--env-file` arguments are explicit, and the original command is passed after `--`
as separate argv tokens. The driver requires a full candidate commit match, freezes and hashes the candidate's Git
index and admitted tracked, modified, deleted and untracked source, then transports that snapshot through
`remote-check`. It does not borrow the trusted driver's checkout or candidate `node_modules`, caches or `.temp`.
Web and Auth generated inputs are prepared from the frozen candidate after the remote frozen install. Declared return
paths are cleared before transfer, bounded and checked on return, and restored only from the terminal physical run.
The private environment overlay cannot replace host runtime, placement or task-custody authority; `NODE_OPTIONS`,
`NODE_PATH`, Bun runtime controls, dynamic loader injection, and unsupported host-absolute file settings fail closed.
Web routing omits every inherited `KERNEL_CHECK_` variable, including `KERNEL_CHECK_AFFECTED`. An explicit driver
`--env-file` may still supply `KERNEL_CHECK_AFFECTED`; direct kernel `--affected` selection is unchanged.
Each producer invocation is durably registered outside the candidate before remote admission. Its final binding covers
the exact commit, index and source fingerprint, original argv and cwd, hashes of the semantic and relocated
environment, trusted producer closure, selected host configuration, declared preparation and returns. Secret values
never appear in invocation status records, descriptors, FD 3 messages, stdout or stderr. Prepared mode keeps the
original and relocated values only in a separate owner-only execution file outside candidate source.

The native receipt is an intermediate event. A bounded version 1 FD 3 channel can send a `native-terminal` message,
then a distinct `final-settlement` message bound to the caller's UUID invocation and nonce. The final message reports
the native outcome, actual prepared file manifest, returned artifact digests, source verification, SSH child state,
remote cleanup, local frozen-worktree cleanup, and separate primary and cleanup failures. Only `cleanup.disposition`
`settled` certifies a fully verified lifecycle; missing evidence or any unknown cleanup remains non-green and keeps
consumer custody. The decoder rejects foreign, replayed, duplicate, partial, oversized and out-of-order messages.
The additive status-only `finalCustody` schema 1 keeps the authenticated final immutable while tracking its canonical
digest, delivery state, private-file cleanup state, exact invocation identity, aggregate custody, and bounded
observations. It retains up to 16 exact observations, then uses a fixed-size continuation with a rolling digest and
exact first/latest overflow entries. The continuation preserves the old observation chain without unbounded
invocation-record growth. An unknown original final can settle only from a later exact observation for the same
invocation, eleven-field binding, physical host/run, source and prepared inputs, returns and private-file references;
that accepted observation is appended or committed in the continuation and never replaces or re-emits the original
final. Rejected evidence cannot change snapshot custody or prior cleanup authority.

Aggregate custody is the authoritative producer-side result: it is `unknown` if any custody dimension is unknown;
otherwise it is `pending` while delivery or private files are pending, and `settled` only after delivery has a completed
outcome, private files are settled and reconciliation is settled. Pending/unknown FD 3 delivery remains non-green even
after successful physical cleanup. A returned FD 3 writer callback records `delivered`, not receiver persistence;
durable receiver admission is recorded separately as `received`. The invocation phase is never `settled` while aggregate
custody is pending or unknown.
This metadata is status-only: the prepared descriptor and normal `native-terminal`/`final-settlement` FD 3 schemas
remain unchanged. Consumer handling belongs at the ordinary result/status boundary; this producer work does not claim a
Web or control-plane bridge.

`registerCheckRunInvocation`, `getCheckRunStatus`, `cancelCheckRunInvocation`, and
`reconcileCheckRunInvocation` are the supported API. The `check-run-settlement.ts` CLI provides `status <id>`,
`cancel <id> [--signal 1|2|15]`, and `reconcile <id> [--hosts <absolute-hosts-json>]`, with an optional
`--state-dir <absolute-dir>` for every command. Use the durable invocation ID in a prepared descriptor for process-loss
status, cancellation, and reconciliation. Cancellation is durable before signal delivery and fences queued starts.
An fsynced queued-to-admission transition is the linearization point: cancellation that wins while queued prevents host
probing and later physical allocation. Reconciliation observes or cleans up only the stored host/run and local
transport-child identity; it never repeats the command or chooses another host/run. Local transport identity is
`live-same`, `gone-or-replaced` or `unknown`. Only boot replacement, PID absence/`ESRCH`, or a well-formed changed
process start identity proves the old child is gone; unreadable, malformed or unsupported identity evidence remains
unknown and never authorizes a signal. Signals revalidate identity and use bounded cancellation. A failed unlink retains
the exact private execution/intent file reference until absence or removal is verified. If source, producer, host,
process or transport identity is missing or stale, the state stays unknown and the frozen inputs remain available.
Preparation writes a private version 1 intent sidecar before creating the frozen worktree. A lost process can recover
before registration with `reconcile --descriptor <absolute-private-json>`; after descriptor exposure, the same route
reconciles only the registered invocation. The descriptor remains the private replay-resistant caller handle; the
sidecar contains paths and input names, not environment values. The producer pins the exact final durably before FD 3
emission and records delivery afterward, so a failed or interrupted write leaves a pending/unknown non-green record
that rejects any contradictory final. This producer protocol does not claim that a consumer's
`RemoteGateCustody` or verifier `NativeReceiptBridge` is installed.

Check-run snapshot inventories allow 50,000 paths. Invocation records remain bounded to 8 MiB; their JSON parser
allows arrays up to that inventory size and 400,000 values, rejects depth beyond 64 and duplicate object keys, and
validates every path before custody transitions.

For a separate prepare and execution process, `scripts/check-run.ts` exports
`prepareCheckRunInvocation(args, descriptorFile, dependencies?, processEnvironment?)` and
`runPreparedCheckRunInvocation(descriptorFile, dependencies?, signal?, processEnvironment?)`. CLI usage is
`bun scripts/check-run.ts prepare --descriptor <absolute-private-json> <existing check arguments>` followed by
`bun scripts/check-run.ts run-prepared --descriptor <same absolute path>`. The descriptor has schema 1, type
`check-run-preparation`, invocation ID, nonce, the complete eleven-field binding and durable cancellation file/id.
Its exact closed JSON shape is documented in [Scripts](../../scripts/README.md#out-of-process-prepared-handoff).
Preparation stores the original frozen snapshot and execution inputs once, then persists the descriptor path and digest
before exposing it. `run-prepared` requires a matching caller-established FD 3 invocation ID and nonce, checks the
current candidate, environment, priority, host configuration and trusted producer closure, and atomically claims the
same saved preparation at most once. Cancellation before claim or while queued fences later start. Reconciliation
without a physical identity cancels the start and removes that exact snapshot after verified cleanup; a recorded
physical run still needs the host file and retains unknown custody when evidence is unavailable. Status returns a
final record for replay; the descriptor cannot start a second physical run.

## External integrations

Prove deploys, provider configuration and integrations such as Cloudflare or Stripe through the real tool's validation
with the real configuration and account. For example, use `wrangler deploy --dry-run` against the actual deployment
configuration; a mock or weaker substitute cannot prove it. Include a first real deployment in task acceptance where
safe. Verify tooling fixes against the actual operating condition before reporting them fixed.

## Review

Inspect the changed diff against the owner contract, capability manifest and evidence. Ordinary delivery uses its
required gates; it does not gain repeated model review rounds. For implementation in declared risk areas, use one
independent review with the configured reviewer profile. Consolidate duplicate findings and investigate the defect
class across the change. A blocking finding needs a failing outcome test on the reviewed head or a concrete,
reproducible contract violation; record other observations for follow-up. Distinguish setup failures from reached
outcome assertions before charging a repair round. The controller's [retry and consultation
procedure](../../tools/goal/README.md#integration-promotion-culprit-isolation-and-attempt-fencing) owns escalation.

Review interface evidence in addition to automated checks. Record the reviewed revision, scenarios, screenshots,
findings and remaining limits. Integration is not promotion: confirm recorded checks cover the promoted commit
before declaring the Goal complete.

# Verification toolchain

Use the exact `bun@1.4.4-canary.20261031.1` npm distribution pinned in the root
`packageManager`, development dependencies and lockfile. Its Linux x64 binary reports
`1.4.4-canary.1+da867c60b` with `bun --revision` (full revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`). `bun --version` reports only `1.4.4`, so it
cannot distinguish this canary from the stable release.

`bun install --frozen-lockfile` installs this runtime into `node_modules/.bin`.
The remote runner puts that directory first on `PATH` after installation. The root gate and root typecheck
invoke the installed executable by path, because `Bun.spawn("bun")` selects its caller
even when `PATH` points to a newer Bun;
an older host Bun can bootstrap the install without selecting the runtime used for checks.
The check-host provisioner pins the same distribution and checks its full build revision.
Provision hosts with `scripts/provision-check-host.sh` as described in
[the check-host operations guide](../../scripts/README.md). No shared host runtime needs
to be changed while evaluating a candidate checkout.
Remote placement reads that pin from the candidate workspace `package.json` and the matching
installed `node_modules/bun` from that workspace, or from the original candidate when
`check-run` has frozen a snapshot without dependencies. The trusted driver's checkout is not
the pin or artifact source. Missing or mismatched candidate artifacts fail before a host slot
is acquired.

Run `bun scripts/gate.ts` for the landing gate and `bun run typecheck` for the root
typecheck. The gate also runs `scripts/toolchain.test.ts` and `scripts/toolchain-workspaces.test.ts`, which check formatter
compatibility, all six configured lint rules and their options, TypeScript diagnostics,
and the SQL mapper fallback, every workspace's checker selection and the declaration compiler.
Declaration generation continues to use tsc. The npm `latest` and `canary` tags were rechecked on
28 October 2026: stable is 1.4.4 and the canary remains the exact distribution pinned above.

## Switch decisions

### Formatting

Keep oxfmt 0.74.0 for `bun run format`, `bun run format:check` and workspace gates.
On a temporary copy of the base tree, oxfmt formatted all 3,170 eligible files in the completed comparison. Then
`bun fmt --check` used the same `.oxfmtrc.json` and reported exactly two differences:

| File                                         | Difference from oxfmt output                                                              |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs/research/throughput-audit-high.md:546` | Bun escapes the leading `=` before a code span as `\=`.                                   |
| `specs/imported-field-driver.ts:139`         | Bun puts `coverReference(key: string): Promise<{` on one line; oxfmt wraps the parameter. |

This is the formatter swap decision: two differences prevent the switch. The existing
configuration and source files stay intact. Representative TS, TSX, JSON, CSS and
Markdown fixtures match; the two exceptions have a regression check. Existing
formatting issues elsewhere in the base tree were normalized only in the temporary
comparison copy, never in the checkout or frozen files.

### Type checks

Use `bun check --no-script -p tsconfig.json` in the eleven workspaces below, both in
their check commands and their root-invoked typecheck scripts. `--no-script` is required
because each workspace defines a `check` script. Leaf packages `access`, `bounds`, `money`,
`operations`, `progress` and `search-text` define the same `check` script so a root-file
typecheck can gate them. Keep generation before checking the websites. Both checkers
reported zero errors for every workspace in the paired run.
The regression fixture also compares diagnostic locations, error codes and messages
for incompatible imported types, exact optional properties and indexed access, and
checks that the corrected source passes both tools.

| Workspace                | tsc seconds | Bun seconds | Diagnostics            |
| ------------------------ | ----------: | ----------: | ---------------------- |
| `apps/auth`              |       2.429 |       6.346 | Identical: zero errors |
| `apps/web`               |      13.259 |       6.975 | Identical: zero errors |
| `packages/auth-contract` |       0.374 |       0.263 | Identical: zero errors |
| `packages/client`        |      19.357 |       4.879 | Identical: zero errors |
| `packages/composition`   |       0.966 |       0.684 | Identical: zero errors |
| `packages/conversion`    |       3.784 |       8.238 | Identical: zero errors |
| `packages/definitions`   |       3.307 |       1.725 | Identical: zero errors |
| `packages/document`      |       0.611 |       0.350 | Identical: zero errors |
| `packages/filter`        |       0.458 |       0.467 | Identical: zero errors |
| `packages/ui`            |       5.786 |       2.663 | Identical: zero errors |
| `services/importer`      |       3.240 |       1.539 | Identical: zero errors |

Keep tsc 7.1.0-beta for kernel and auth, which use Reylo `contentMappers` to type SQL
imports against a migrated PostgreSQL database. The pinned Bun rejects
`--runExternalCode` with `Unknown flag "--runExternalCode"`. Without that flag, the
auth project reports 885 errors (655 unresolved SQL imports), and kernel reports
1,266 errors (900 unresolved SQL imports), while tsc passes both against the compiler
database. Bun is not applying the content mappers. Declaration emit, including
the kernel client's declaration generation, stays on tsc. The generic root typecheck
fallback also stays on tsc for workspaces that do not explicitly select a checker.

### Lint

Use `bun lint --no-script --config .oxlintrc.json` in the root lint script and the
kernel/auth check runners. Keep oxlint 1.89.0 installed as the differential reference.
`bun lint --doctor` reports six native rules and zero JavaScript fallback rules. Against
the whole tree, Bun and oxlint reported exactly the same 80 JSON diagnostic objects,
including rule, severity, source position and message, after sorting. These existing errors were
not hidden or fixed as part of a toolchain switch. The regression fixtures require
each configured rule to reject a witness, compare diagnostic spans and severity, and
check the configured null comparison, unused argument, rest sibling and underscore
exceptions. No permissive unsupported-rule flag is used.

## Native growth evidence

Performance measurement establishes bounded work, not machine speed. Keep one folded capture for the operation and all
tracked nested native work. Apply the existing [shared, notice and entry ceilings](../../services/kernel/performance-contract.md#native-growth-capture-memory),
and await read-only post-drain verification before another preparation. Retain growing `progress_session` scan guards
and exact doomed/retained assertions. State administrative work outside the capture.

A failed raw or folded capture preserves the initiating thrown value. Call `growthFailureEvidence(thrown)` from
`services/kernel/test/support/growth.ts` to retrieve its explicit incomplete diagnostic; this also works when the thrown
value is not an `Error`. The record retains observed foreground/background statements, plan occurrence ownership,
available costs, SQLSTATEs, database/backend attribution, write targets, transaction tokens, and bounded primary and
secondary causes. Object throws are weakly keyed; because primitive values cannot own metadata, the helper retains the
most recently recorded primitive failure. `checkGrowth` adds check name, source revision when available, failure phase,
scale and repetition.
Cause summaries use one bounded-safe descriptor throughout capture accounting and profile export. If a thrown error has
hostile `name`, `message` or SQLSTATE accessors, its exact value remains primary and the unavailable fields are listed
under `omittedDescriptionFields`.

When `GROWTH_PROFILE` is configured, `checkGrowth` appends the diagnostic as a separate JSONL record. `GROWTH_PROFILE_REQUIRED=1`
continues to require normal profile export. If diagnostic export itself fails while preserving a native failure, the
export error is retained as a secondary cause and the original native failure remains thrown. The profile serializer
applies its byte, depth and value limits before writing a whole line. `readGrowthProfiles` exposes diagnostic records
in its `diagnostics` result field; these records have no measurement identity or three-scale repetitions and do not
enter calibration series. `GrowthProfileExportError` remains distinct for export-only failures.

The evidence names its derivation: SQL text and SQLSTATE come from the instrumented pg wire occurrence; backend and
database names come from that connection and native notice; each plan owner is the statement occurrence active when
the notice arrived; raw mode retains the native document and folded mode retains native occurrence cost summaries.
Relation write targets come from native `ModifyTable` plan nodes, transaction state from `ReadyForQuery` tokens, and
pending failures from draining every registered task before attribution is restored. Missing plans and folded cost
omissions are marked from the observations that were actually retained. Forced plans, tolerance changes, larger capture
caps and fixture-only passes do not close a failure. Root SQL admission requires actual supported Reylo types through
affected Web/root checks; fast copy-on-write preparation does not establish SQL closure.

Existing cache and Git preparation retain their owner-defined locks, identity and cleanup. Deployment, process
reconciliation, mechanical retries and check execution remain with their controller or host owner.
