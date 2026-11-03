# Verification

Verify the promised outcome through the real boundary that owns it.

API acceptance covers the relevant personas, each permission operand, invalid and hidden resources, lifecycle changes,
replay and dependency unavailability. Use native Access and production contracts. A permissive stub cannot prove
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
private/unlisted/public, Liked and Continue progress kinds. Clearly identified contract-shaped fakes may support
interaction or failure injection; they do not establish a new backend state or replace native API evidence.

Every interface brief lists the page stories it adds and their API evidence. Track exact story exports in the
[page story coverage map](page-stories.md); a story proves only what it actually renders. Existing primitive stories
remain, but receive no further workflow effort. Play functions prove behaviour; accessibility checks and visual
snapshots support review by eye. The development publication is `https://storybook.rezics.com`.
[Web recording and screenshot procedures](../../apps/web/README.md#storybook-and-page-recordings) own the commands.

## Check selection and failures

Acceptance names the narrowest command that proves the change. Managers name a full web or kernel check only for a
workspace-wide change; the train and promotion own whole-workspace checks.

Run the acceptance command once after the last relevant edit, plus the root typecheck (`bun scripts/typecheck.ts`).
Write missing acceptance tests named by the contract. Preserve existing frozen acceptance. Add focused checks for
concrete risks, naming at most twelve nearby test files per discretionary check. Run a whole-workspace or full web
check only when the contract requires it; do not repeat a passing acceptance to obtain a success summary. Broaden checks when shared
contracts or unresolved failures require it. Use the full kernel check for a change to a runtime contract that every module's tests rely on.
Use the control plane's own gate for executable control-plane changes. Documentation alone does not require either. Judge commands by their exit status.

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

Admit heavy checks through shared resource controls. A check waiting for a slot is queued; let it run. Park workers until completion or meaningful output instead of
waking the model for “still running”. Worker admission and heavy-check admission are separate controls.
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

## Check placement

`scripts/check-placement.ts` is the shared conservative classifier used by worker checks. Root and Web typecheck
scripts, pure compiler and formatter commands, and explicit small unit selections are local. A small unit selection
has at most 12 explicit test files; each file and its statically imported relative source is at most 256 KiB, within
64 files total, and has no browser, server, database or native-stack dependency. Discovery, globs, preloads, shell
commands, full Kernel checks, browser work, database/container work and commands the classifier cannot prove local
go to a performance-approved check host. Package-script, `--cwd` and ordinary `env` prefixes use the same classification.

`worker-check`, `stack-run`, `check-run` and `remote-check` derive the performance pool from hosts explicitly marked
`"performance": true` in the private hosts file. Missing or false flags exclude a host, including a or b; there is no
name-based placement allowlist. Host names use lowercase letters, digits and hyphens, with a letter or digit first
and at most 64 characters. Local flags, off markers, learned memory weights, local leases, an absent host pool and
a transport error cannot replay heavy or unknown work outside a physical check run. A failed or unavailable remote run remains non-green. A command is already on a check
host only when its working directory is inside that run's directory, its cgroup names the matching run scope, and
the run has a valid supervisor marker; environment flags alone do not establish remote custody. This applies equally
to a, b and the loopback workstation c; ordinary workstation workers and managers are outside check runs. The marker
validates physical identity, while the configured performance flag authorizes admission.

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
because each workspace defines a `check` script. Keep generation before checking the
websites. Both checkers reported zero errors for every workspace in the paired run.
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

## Wall-time measurements

Measured on 28 October 2026 on this machine: Linux x64, AMD Ryzen Threadripper 3970X,
32 cores / 64 logical CPUs, 64 GiB RAM. Baseline runtime: Bun 1.4.3. Candidate runtime:
the pinned canary above. Times are elapsed wall seconds, one observation per command,
including startup. The paired workspace table runs tsc then Bun per workspace. The
machine also runs other workers; caches and load are uncontrolled, so these observations
are evidence of this attempt, not isolated benchmark guarantees.

Full checks use the loopback check host through the normal admission protocol, with
all other hosts excluded from this attempt's local hosts file. Queueing, synchronization,
installation and browser setup are included in their end-to-end times. No busy slot is
bypassed. The gate's per-workspace times are reported separately from admission wait.

| Check                                                                     | Before seconds | After seconds | Result / interpretation                                                              |
| ------------------------------------------------------------------------- | -------------: | ------------: | ------------------------------------------------------------------------------------ |
| Tree format check                                                         |          0.882 |         2.552 | oxfmt retained; both detect existing base formatting issues.                         |
| Eleven non-SQL type checks, sequential sum                                |         53.571 |        34.129 | Identical diagnostics; 1.57 times faster in this paired observation.                 |
| Root typecheck, including generation, compiler DB and kernel construction |        302.044 |       150.699 | Both passed; includes database and generator costs.                                  |
| Tree lint                                                                 |          1.290 |         0.195 | Identical 80 JSON diagnostics; 6.62 times faster in this observation.                |
| Full kernel check                                                         |    Unavailable |   Unavailable | Local comparison cancelled after the gate proved incompatible acceptance assertions. |
| Full web check                                                            |    Unavailable |   Unavailable | Local comparison cancelled on the same specification conflict.                       |

The candidate formatter also took 0.615 seconds to check the oxfmt-normalized 3,170-file
temporary copy and rejected the two files above. An initial canary lint observation
under heavier load took 3.086 seconds; the final installed-runtime observation is in
the table. The retained formatter's slower observation likewise illustrates load
variation rather than a formatter implementation change. On the unchanged checkout, the final
paired formatter observation was 2.638 seconds for oxfmt and 0.324 seconds for Bun;
the two output differences still prevent adoption. The component and per-workspace
typecheck observations are complete; full-check comparisons are not. The focused
toolchain and root-typecheck regression run passed all 27 tests across three files.

The root gate's kernel check completed in 4,298.43 seconds on host a and failed;
that remote observation is separate from the requested local comparison. In that run,
`test/commerce/http.test.ts` passed and `test/commerce/exposure.test.ts` failed.
The former requires `summary` among the exact keys returned by `POST /v1/offers`;
the latter forbids that key for the same input shape (an unseeded target subject,
title `Book`, USD 1,200 minor units and the same tax code). Their public offer reads
also require different shapes: the former replaces `summary` with `subject`, while
the latter requires the creation response unchanged. Both assertions already exist
on the pre-migration commit. Changing runtime tools cannot satisfy both fixed
response contracts, and existing acceptance tests were preserved. The remaining
checks started by this attempt were cancelled after establishing this conflict;
queue time and cancelled runs are not reported as completed benchmark times.

## Sources and reproduction

The [Bun 1.4.4 release notes](https://bun.com/blog/bun-v1.4.4) describe the formatter,
checker improvements and canary-only lint command. Exact npm metadata and tarballs
were read from `registry.npmjs.org/bun/canary` and `@oven/bun-linux-x64`. A preliminary
GitHub canary download reported an older `11c367163` revision; only the newer npm
canary is pinned and used for final compatibility checks. No reference-project code
was ported.

For future upgrades, repeat the formatter comparison on an oxfmt-normalized disposable
copy, compare each workspace's diagnostics, exercise the SQL content mappers and
compare lint diagnostics before changing a command. Run the equivalence tests and
root typecheck, then the root gate. Preserve the fallback when the comparison differs;
do not suppress diagnostics or reformat frozen files to make a replacement pass.
