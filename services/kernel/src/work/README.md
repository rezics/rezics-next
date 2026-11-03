# Installed queue controls and cleanup replay

`WorkIntent` forwards `queuePartitionKey`, `deduplicationID`, `priority` and `delaySeconds` to the installed
`DBOSClient.enqueueInTransaction` on the source transaction. The existing effects, locator-effects and import queues
already set `partitionConcurrency: 1`; the installed SDK treats those as partitioned queues. Their worker-wide
limits remain eight, eight and two respectively. Producers identify the source partition with `queuePartitionKey`.
Priority and delay use the SDK's normal admission, execution-owner and recovery paths.

Decision: keep installed queue-wide deduplication with rejection on collision; partition keys do not scope a
deduplication ID, and a caller does not silently receive another partition's workflow.

The production retention workflow records its starting time and retention configuration in one durable step. Each
subsequent batch is a separate durable step using the registered `DBOSClient`; replay skips committed batch results.
A batch that fails before its checkpoint reselects work and repeats the supported SDK deletion without descendants.
There are at most 60 batch steps per scheduled invocation, each with at most three attempts, plus the starting step.
Each batch returns at most 1,000 workflow IDs. The scheduled path uses the repository indexed selector, not
`listWorkflows`.

Decision: scheduled retention selects `client.applicationName ?? rezics-kernel` through
`createWorkflowRetentionSelector` on WorkContext's existing pool, so recovery can isolate an application without a
new WorkClient signature. Repository bootstrap waits for Postgres, creates the database if needed, installs the SDK
schema, then applies dbmate migrations so `workflow_retention_selector` is created only after `dbos.workflow_status`
exists. `dbos schema` reruns leave that index in place.

The production query and matching partial index:

```sql
SELECT workflow_uuid FROM dbos.workflow_status
WHERE application_name = $application AND completed_at < $cutoff
  AND status IN ('SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
ORDER BY completed_at, workflow_uuid LIMIT 1000;
```

```sql
CREATE INDEX workflow_retention_selector
  ON dbos.workflow_status (application_name, completed_at, workflow_uuid)
  WHERE status IN ('SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED');
```

The seek is on `(application_name, completed_at)` and stops after `LIMIT 1000` or exhaustion, so examined keys are
the returned batch plus logarithmic index descent. Unrelated applications, nonterminal rows (absent from the partial
index), recent completions and long-lived terminals completed after the cutoff are outside that range. Eligible
backlog beyond 1,000 stays unvisited. SDK `deleteWorkflows(ids, false)` is charged separately: six transaction
statements (BEGIN, four exact-ID DELETEs, COMMIT) plus owned payload rows and FK cascades, which grow with those
payloads rather than with unrelated history. Permanent writer fences stay. MVCC visibility work is excluded.

`test/work/growth-retention.test.ts` measures empty, short (10) and full (1,000) batches at scales 64, 512 and 4,096
history units (16 rows each) with selected work fixed, and a fourth series that grows selected-application eligible
backlog with the returned batch fixed at 1,000. Plans must use `workflow_retention_selector` with no sequential scan.
The full-batch series bound retires the former `GROWTH_BASELINE` step exemption for `workflow retention batch`.
Measured rows/statements/blocks are logged from that native check.

Remaining limits: deletion still follows owned payload/cascade rows, so a batch with large per-workflow payloads is
not bounded by workflow count; interrupted recovery still uses the production selector and frozen cutoff. The
installed SDK `listWorkflows` path stays creation-ordered and is unused by scheduled retention. No custom scheduler
or cancelled reporting producer is introduced.

Sources inspected: the indexed `native-scheduler-funded-design/dbos-transact-ts` reference at
`627990fc59619d3584ce88511ab546bc7483f4b9`, `src/enqueue_options.ts`, `src/client.ts`, the outcome/cancellation/deletion
sections of `src/system_database.ts`, and migrations 108–112; installed SDK client/queue declarations, deletion and
native migration implementation. Payload `retention_timestamp` indexes do not decide workflow eligibility.

## Bounded legacy membership child discovery

`WorkClient.discoverLegacyLeaveChild(workflowId)` resolves a strict `realm:leave:<realm-id>:<member-id>` locator to
the newest retained `community.leave` workflow's `accounts.membership` child with the same realm, member and
reservation. It returns the child workflow ID or `null`; callers can then use the normal indexed status and step reads.
The existing `listWorkflowSteps` legacy fallback remains the compatibility path and retains its linear diagnostic.

`createWorkClient` installs both indexes idempotently before returning, under a PostgreSQL advisory transaction lock.
The native indexes are `dbos.work_legacy_leave_parent_input_identity` on the input JSON paths
`realmId/memberAccountId/reservationId` and `dbos.work_legacy_leave_child_input_identity` on
`principal.id/memberAccountId/reservationId`. Both include `workflow_uuid`. Discovery is one SQL statement; for a
fixed matching population, each index seek and each joined `workflow_status` primary-key check reads a constant
number of rows and logarithmic index blocks. The growth fixture holds the matching parent and child count at one
while growing unrelated status, input and step history. Repeated matching histories add candidate work and are not
covered by that fixture's constant-row claim.

# Native workflow writer retirement

The pinned SDK extension declares `DBOSClient.retireWorkflow(actualWorkflowId)` and
`getWorkflowWriterFence(actualWorkflowId)`, also available on `DBOS`. The Work wrappers are
`retireSdkWorkflowWriters` and `readSdkWorkflowRetirement` in [sdk-retirement-fence.ts](sdk-retirement-fence.ts).
The actual, unchanged workflow ID is the native identity. The receipt contains that ID, its permanent writer
generation, a native closure UUID and the native closure timestamp. Repeated retirement returns the same receipt.

The declaration commit preceded the implementation for consumer integration. The patch now supplies both the
native implementation and declarations; declaration-only revisions establish no closure. Native proof and
participant completion remain separate from source integration and typing. The native cases in
[sdk-retirement-fence.test.ts](../../test/work/sdk-retirement-fence.test.ts) await post-integration execution.

Retirement establishes technical SDK writer closure only. Genuine Source, consumer and root admission belong to
their owners. SUCCESS, cancellation, an empty status read or a caller boolean cannot supply that authority. This
wrapper neither cancels nor deletes. After genuine owner readiness and native closure, owners use the existing
supported SDK deletion API without descendants, then all exact physical family probes. Unknown original or foreign
custody remains pending. Closure is permanent and survives SDK deduplication and execution/history deletion.

The Bun patched dependency stays on `@dbos-inc/dbos-sdk` 5.5.3-preview. Its SDK-owned migration installs one permanent
`workflow_writer_fences` control row per actual ID, outside deletable execution/history rows. Generation 1 admits
writes; generation 2 carries an immutable native closure UUID and timestamp. There is no reopening API. The control
row contains no execution payload and does not increase the existing execution budgets: 64 operations, eight event
keys, 64 history rows, 64 KiB payloads, 4 KiB metadata, 139 execution rows and 10 MiB remain unchanged.

Every INSERT and UPDATE of `workflow_status`, `workflow_input`, `workflow_output`, `operation_outputs`,
`workflow_events`, `workflow_events_history`, `notifications` and `streams` passes an SDK-installed native row guard.
The guard upserts the actual ID's control row and holds its native row lock through the writer's COMMIT. A conflicting
tombstone is checked against the current locked tuple; an older transaction snapshot cannot admit a stale writer.
The same guards therefore cover previous executors, transactional enqueue, SQL enqueue, queue claims/recovery,
status/output/error updates, steps, messages, events, history, streams, rewind and input restoration. Notifications
guard their actual destination ID. New child/fork status rows also guard their parent/source ID. Existing children
retain their independent lifecycle. Resume, rewind and fork explicitly guard their IDs inside their native
transaction, including otherwise empty or terminal no-ops.

Retirement joins the original native workflow-owner lock and the permanent control-row lock. It revokes the current
execution token before closing the control row in the same transaction, without changing status or payload. This
also fences the unchanged old `sendFromStep` path: its native owner check shares that lock through notification
COMMIT, so a message to a different live destination must either commit before closure or roll back. SDK deadlock
retry applies to the entire retirement statement. No process shutdown, global mutex or application callback supplies
the fence. Running JavaScript and application side effects still require their owners' admission; the receipt
establishes SDK writer closure only.

The native guards are `ENABLE ALWAYS`, including control-row immutability guards. Ordinary COPY/restore replay into
the live schema cannot recreate a retired ID. Database recovery must preserve the permanent control table and
guards alongside the SDK schema; rolling the entire database back to a pre-fence backup is outside this receipt's
guarantee. Product modules use only supported SDK methods to fence and delete; they install no foreign SDK triggers
or SQL mutations. Any lawful cancellation must precede closure, since cancellation itself updates SDK status.
Remove the patch when the pinned upstream primitive provides equivalent permanent guards and receipts, including
old executors. The patch header records the missing primitive and its reproducer.

Source inspected before implementation: the installed SDK's `client`, `system_database`, `dbos`, `dbos-executor`,
workflow management and native migration runner/history; and the indexed read-only
`search-worker-outcome-harness/dbos-transact-ts` reference's `client.ts`, `system_database.ts`, `dbos.ts` and
`dbos-executor.ts` at revision `980dc55095f445b189aecb59e7f3334345179f65`.

## Current fence in a Source command

The SDK also exports `WorkflowWriterState`, exactly readonly
`{workflowID:string, generation:string, restoreGeneration:string, closureID:string|null, closedAt:number|null}`.
`DBOSClient.getWorkflowWriterState(actualWorkflowId)` observes that state, or returns null for a missing original
identity. It does not create an identity or grant readiness. Generation 1 has null closure fields; generation 2
has the unchanged permanent receipt fields. `restoreGeneration` is the SDK-owned current native domain UUID,
independent of History's receiving/source domain. None of the previous API/receipt shapes change.

`lockSdkWorkflowWriterState(tx, expected, sdk)` is the Work producer's supported **current** interface for a live
`CommandTransaction`. It derives the pool from `currentCommandResources(tx)` and invokes
`DBOSClient.checkWorkflowWriterStateInTransaction(tx, pool, expected)`. The SDK refuses a different pool object
before IO, even when its URL matches. It executes only on `tx.query`; there is no independent SDK checkout, detached
callback, transaction, savepoint, statement retry or commit. The native function locks the current SDK domain
`FOR SHARE`, then the exact original workflow's permanent fence `FOR UPDATE`, compares every expected field and
returns the current tuple. Both locks survive the function return until the caller's COMMIT/ROLLBACK. Under an old
SERIALIZABLE/REPEATABLE READ snapshot PostgreSQL refuses a changed locked tuple rather than certifying stale state.
Serialization/deadlock errors must roll back and retry the entire owning command under its existing policy.

Physical placement is established by the existing worker composition: `worker.ts` passes its one configured pool
both to `createWorkClient(databaseUrl, pool)` and Work registration; `registry.ts` passes that same pool to DBOS.
`runCommand` binds its query to its actual checked-out client and records that pool in its live resources. SDK tables
are in `dbos` in this database; the receiving custody is partition zero in `core`, as established by
`history-enqueue.ts`. A Source command can use this port only when its genuine current home is served by that same
configured native pool. A client made with `createWorkClient(databaseUrl)` alone owns another pool and is refused.
A matching hostname, copied schema, workflow receipt or caller-supplied pool assertion cannot replace this Work
executor binding. Dynamic pools spanning databases and sharded SDK databases are outside this supported placement.
No foreign SDK SQL belongs in History or Semantic. There is **no cross-home durable bridge** in this implementation.
A Source moved to another database must remain pending until original-owner physical authority supports a design.

The append-only SDK migration adds the single `workflow_writer_fence_domain` row and the native check function,
after all existing pinned migrations. Existing migration bodies and positional versions are unchanged. Domain
DELETE/TRUNCATE and non-advancing updates are refused by ALWAYS triggers. The supported offline restore operation
`DBOSClient.advanceWorkflowWriterRestoreGeneration()` increments its revision and installs a fresh UUID under its
native UPDATE lock, serializing against current checks. It must finish before admitting restored work. Permanent
writer fences and their ALWAYS guards must be preserved from current custody through restore; a pre-retirement
backup cannot replace them. Ordinary live-schema INSERT/COPY/replay cannot overwrite a closed fence or reuse a
retired workflow, including when execution deduplication/history has gone. A restore/domain change invalidates
previous writer-state observations. A full database rollback that discards current permanent fences remains
unsupported, as before: this operation cannot reconstruct lost closures or authorize such recovery. History must
also revalidate its own current restore/receiving generations and exact physical custody; this SDK UUID is not their
replacement. The SDK restore operation is a technical owner primitive, not a new application restore permission.

Consumers must keep two guarded stages distinct. Before retirement, a current generation-1 check can serialize an
otherwise legitimate durable readiness transition in the same Source command; it does not assert writer closure
and must not require generation 2 as its own prerequisite. After the owners establish readiness, use the unchanged
retirement API on a released checkout. A subsequent final Source/receiving command must check generation 2 and the
exact native closure, original immutable workflow mapping, original source tuple/digest, role/barrier, claim and
all native source/receiver generations under their own guards. A readiness receipt or released observation cannot
replace that final check. After supported SDK deletion the same check still locks the surviving permanent fence;
it does not probe or certify physical execution-copy absence. History owns the actual receiving-copy guard and
physical family probes. This producer changes none of those consumer transitions and confers no legal cleanup
permission. The existing fail-closed History guard remains closed until its owner consumes these prerequisites.

### SQL and funding

New writer-state ports refuse empty IDs and IDs over 1024 UTF-8 bytes before SQL. The original APIs/IDs and all old
execution limits remain unchanged. The domain has one primary key and the fence lookup uses the exact existing
primary key. The current check has no scan, payload read, write, descendant walk or alternate ledger.

| Operation                | SQL dispatched, including nested SQL                                                                                                                                                   | Rows | Points | Statements | Bytes | Engine work |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | -----: | ---------: | ----: | ----------: |
| Released observation     | `SELECT f.*,d.restore_generation FROM dbos.workflow_writer_fences f CROSS JOIN dbos.workflow_writer_fence_domain d WHERE f.workflow_uuid=$1 AND d.singleton`                           |    3 |      2 |          1 |  8192 |           0 |
| Current command check    | `SELECT * FROM dbos.check_workflow_writer_state($1,$2,$3,$4,$5)`; domain keyed `SELECT ... FOR SHARE`; fence keyed `SELECT ... FOR UPDATE`; `RETURN QUERY SELECT` of the locked values |    4 |      2 |          4 |  8192 |           0 |
| Offline restore rotation | `UPDATE dbos.workflow_writer_fence_domain SET revision=revision+1,restore_generation=gen_random_uuid() WHERE singleton RETURNING restore_generation`                                   |    2 |      1 |          1 |  1024 |           0 |

Rows conservatively include the two keyed inputs and repeated result production; rotation counts both the old and
new row. Bytes include bounded ID/receipt tuples, bindings and repeated results, with no workflow payload. Points
count keyed accesses; engine work is zero product-level expansion (ordinary MVCC/locking/index maintenance remains
engine work under architecture rules). Trigger branch comparisons/assignments add no nested SQL. A changed domain
fails after the first nested lookup; a changed/missing writer fails after both. The entire current-check allowance
in `SDK_TRANSACTION_FENCE_COST` must be reserved **before every dispatch**, including failures, repeated checks and
whole-command retries, without refunds. Local malformed-state, absent-command or pool refusal dispatches no SQL;
reserving before entering the port is still conservative. The released observation is separately funded; calling
it twice doubles its allowance. Migration DDL is installation work, never part of a per-artifact check.

The new current port never calls retirement, deletion, enqueue, retained-copy probes, Source or History verifiers;
none of those nested costs are hidden in this table. Existing retirement still uses its original owner-status lock,
fence upsert, owner-token UPDATE (including its native row guard) and permanent closure UPDATE; repeated retirement
omits the two updates. Those unchanged operations and all physical family probes retain their original separate
funding and writer coverage. Semantic owns the matching Source footprint and aggregate reservation; no sufficiency
is asserted for the existing aggregate and no default, child cap or ceiling is changed here.

Additional source inspected for this interface: the pinned `client.js`, `system_database.js`, `dbos.js`,
`sysdb_migrations/internal/migrations.js` and `sysdb_migrations/migration_runner.js`; the indexed reference's
`client.ts`, `system_database.ts`, `dbos.ts` and `dbos-executor.ts`; and current Kernel `command/command.ts`,
`database/pool.ts`, `worker.ts`, `work/registry.ts`, `work/history-enqueue.ts` and original identity History staging.
The new existing-database fixture cases in
[sdk-transaction-fence.test.ts](../../test/work/sdk-transaction-fence.test.ts) cover current locks through command
commit, original transactional enqueue refusal while a live fence is locked, post-delete permanent closure,
independent-pool refusal and stale/wrong identity/closure/restore refusal. Their native execution is deferred to
integration; source and typing alone do not establish that evidence or whole-feature closure.

## Bounded selected identity maintenance

`maintainSdkWorkflowOnce(pool,sdk,expected,action,deadline,reserve)` consumes the pinned SDK's additive
`DBOSClient.maintainWorkflowOnce` port. It requires the actual same configured Pool and original exact current
writer tuple. `retire` accepts generation1; `delete` accepts generation2. The caller must establish genuine native
History readiness before retirement and bounded eight-table physical custody before deletion. This is the original
retirement function and original four-table deletion body, children=false. Permanent fences/domain and ALWAYS
writer guards are never deleted or disabled. The wrapper does not assert legal Source/History authority.

The owner opens ONE READ COMMITTED transaction and makes ONE attempt. Every dispatch calls the caller's existing
Source reservation before IO. It does not use `withDbRetry`, create a frame, refund failures, retry statements,
change IDs, launch an SDK executor or install dependencies. Rollback is prepaid before checkout/BEGIN. Native
current domain and exact workflow locks survive all owner work through COMMIT. Refusal of a later reservation
rolls back the original transaction. An ambiguous commit propagates; later ordinary admission must read the exact
current durable state and original binding. Old methods retain their original semantics and retry policy.

| Dispatch identity / literal SQL                                                                    | rows / points / statements / returned content bytes / engine |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| rollback: `ROLLBACK` prepaid                                                                       | 0/0/1/0/0                                                    |
| begin: `BEGIN ISOLATION LEVEL READ COMMITTED`                                                      | 0/0/1/0/0                                                    |
| settings: `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','200ms',true)` | 1/0/1/128/0                                                  |
| lock: original `checkWorkflowWriterStateInTransaction`                                             | 4/2/4/8192/0                                                 |
| retire: `SELECT * FROM dbos.retire_workflow_writers($1)`                                           | 8/5/9/32768/0                                                |
| delete-workflow_input: `DELETE FROM dbos.workflow_input WHERE workflow_uuid=ANY($1)`               | 1/1/1/0/0                                                    |
| delete-workflow_output: same predicate                                                             | 1/1/1/0/0                                                    |
| delete-operation_outputs: same predicate                                                           | 64/1/1/0/0                                                   |
| delete-workflow_status: same predicate, four native FK cascades                                    | 73/5/5/0/0                                                   |
| commit: `COMMIT`                                                                                   | 0/0/1/0/0                                                    |

Retirement's nested allowance includes original status lock1, fence upsert1, status owner-token update1, row-guard
DISTINCT ID selection1, guard invocation/upsert, closure update and native/outer return. Deletion's status bound
is status1 + events8 + history64, with notifications/streams required zero by the independent physical inspection;
its five statements/points include all four actual FK cascades. Inputs/outputs/operations use the original separate
non-FK deletes. No DELETE calls the INSERT/UPDATE writer trigger. Control, locks and rollback are charged once per
attempt; full retirement bound is13/7/17/41088/0, deletion144/10/16/8320/0. Partial/refused dispatches retain all prior
charges and rollback's reservation. An unknown dispatch identity refuses before SQL.

The wrapper and pinned patch are source-delivered here; dependency installation is controller-owned and was not
run. A runtime without the actual bounded owner method refuses before retirement. Native existing-fixture journey,
refusal/rollback and late-writer cases remain UNRUN pending integration. This additive method needs no SDK migration:
it consumes the existing producer's permanent fence, restore domain and native functions. History's compatible
forward migration owns only its own original association and receiving guards. The detailed default wiring and
same-frame Source cost handoff are in [Access](../access/README.md#cost-complete-selected-identity-unit).

## Private Auth Kind enrollment participant

The default `WorkContext` exposes the additive synchronous
`getKindConsentParticipant(deadline)` getter. It reads the existing
`KERNEL_AUTH_CONSENT_URL`, `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` group. An absent group returns `undefined`; a partial
or invalid group fails closed through the existing config validation. The URL
continues to name `POST /internal/v1/consents:read`; enrollment derives the fixed
`POST /internal/v1/kind-consents:enroll` path on that exact origin. No caller URL,
Auth runtime, Pool or signing key enters Kernel.

The returned Auth-contract participant closes over the same absolute deadline.
Kernel sends the unchanged `{ input, deadline }` JSON and adds the enrollment-only
`X-Rezics-Kind-Deadline` header whose value is exactly `String(deadline)`. That
header carries only the caller's resource deadline; it is not identity or
admission authority. Auth requires its canonical positive integer form and exact
equality with the JSON number before native dispatch. Auth reads it before JWT
verification or body I/O, then uses one cutoff, `min(originalDeadline,
arrival+3000ms)`, through JWKS, body, pool checkout, transaction, rollback and
response. No stage renews a window. Owned JWKS fetch/body streams and the
transaction are cancelled at that cutoff; a raced promise alone is not used.

The shared declaration is derived from the literal native query trace. Source is
candidateKeys=1, nativeRows=2, identityMetadataRows=0, emptySeeks=3,
nativePoints=4, witnessKeys=3 and statements=11. Access is keys=1, rows=2,
emptySeeks=3, points=4 and witnesses=3. A new insert is 10 SQL statements;
duplicate enrollment is 9; a closed-frontier refusal is 7; a current-client
refusal is 8. The full 11-statement ceiling includes attempted COMMIT and
ROLLBACK after a late failure. It counts BEGIN, the one combined timeout
configuration statement, each of the three frontier/client/consent locks,
no-open-transition, current client/consent metadata, existing consumer lookup,
INSERT and transaction completion. Pool wait has no SQL. Dispatched failures or
uncertain commit effects have no reusable actual receipt and retain the full
reservation.

Let `I = 128 + UTF8(accountId, clientId, route, ownerAccountId, collectionId,
preparationId, originId, requestedScopes)`. For one admitted input, the native
byte ceiling is `I + max(2*JSON([])+JSON([currentRow])+JSON([insertRow]),
3*JSON([])+JSON([currentRow]),
JSON([])+JSON([currentRow])+JSON([existingRow]),
2*JSON([])+JSON([currentRefusalRow]), JSON([{ "?column?": 1 }]))`. Every
nonempty query result is the JSON array actually measured by
`JSON.stringify(rows)`; each empty query result is `JSON([])`. The current row
maximum uses `first_party=false`, `ready=true`, `reducing=false`, three maximum
stored scope arrays and the 19-digit signed-BIGINT revision ceiling. A current
refusal uses `first_party=false`, `ready=false`, `reducing=false`. The existing
consumer row maximum uses `active=false`, both requested and effective scope
arrays and a 36-byte UUID text reference. The left-joined consent arrays and
revision may be null; those shorter forms are included by the array and
19-digit maxima. Each stored array admits at most 512 scopes of 128 ASCII
bytes (67,073 JSON bytes). A 1,024-byte visible identifier
can be 1,024 backslashes, which serializes as 2,050 JSON string bytes. Complete
metadata-result path maxima are 203,482 bytes for a new insert, 203,427 for a
suppressed insert, 352,144 for a duplicate/inactive/refused consumer, 203,426
for a current refusal and 16 for a closed frontier. The native result maximum
is 352,144 bytes before adding `I`; at maximum admitted identifier and scope
lengths, `I` is 72,832 bytes. This max selects mutually exclusive paths without
adding their rows together. A successful new insert has two empty results; a
suppressed `INSERT RETURNING` has three and returns an unavailable result from
the committed transaction.

Auth's verified actual adds the exact Access JWT bytes, JWKS request bytes, JWKS
response body bytes and Auth-side HTTP control bytes (incoming URL/method/headers
except the separately counted JWT, JWKS response headers and Auth response
headers). Their ceilings are 16,384, 4,096, 65,536 and 8,192 bytes. Kernel's
one-use `enroll.actual(input, result)` adds the measured JSON request/response
bodies, bounded at 90,000 and 80,000 bytes, and its measured private URL/method/
explicit-header control, bounded at 8,192 bytes. Thus both byte axes reserve
`I + maxNativeReturnedMetadata + 16,384 + 4,096 + 65,536 + 8,192 + 90,000 +
80,000 + 8,192` (native plus 272,400 transport/verifier bytes). It validates
the Auth receipt against every native and verifier axis and consumes that
invocation once. Missing, malformed, late, dispatched-failure and repeated-call
receipts leave the full existing reservation spent; a retry needs another paid
reservation. No child refund, local ledger or guessed parent allowance is added.
Any consumer parent that lacks this complete declaration remains unavailable.

This composes only the private Auth enrollment leg. Source invalidation and
verification, Library adoption and restore fences, and native consent-erasure
receiving remain with their original owners; an enrollment reference does not
establish currentness or authorize those operations.

## Selected execution producer

`selected-runtime.ts` adds an opt-in server-only producer. Existing registration and operational callers retain
one ordinary enqueue. Commerce's installed Members specification stub is unchanged. This source delivery does
not install a Commerce caller or establish native acceptance.

The exact consumer ABI is `WorkContext.getSelectedRuntime?(): SelectedRuntime`, then
`registerMembersStep<R>(body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>,
children?: SelectedChildren): (locator: SelectedLocator) => Promise<R>`. Registration must happen in trusted Work
composition before launch. The returned function is the actual registered `library.membersPreparation.step`.
The actual registered workflow remains `library.membersPreparation`. A locator contains `route`, `ownerAccountId`,
`collectionId`, `episodeId`; workflow names, deterministic IDs and `accounts:[owner]` carry no authority.

`SelectedInvocation` has one immutable `deadline`, `select(locator): Promise<SelectedEpisode>`,
`source<T>((deadline) => Promise<T>): Promise<T>`, and `apply(episode, body)` / `failure(episode, body)` returning
`Promise<SelectedOutcome>`. Each body receives the genuine `OperationalTransaction`; it returns
`{kind:'continue'|'failure'|'obsolete'|'complete', version:string, continuation?:string}`. A complete outcome currently
refuses `selected-runtime-final-source-physical-authority-unavailable`. Commerce owns real Source, conditional
native update, subject/exhaustion checks, failure and continuation SQL. No synthetic Source observation is accepted
as final authority by this producer. A selected episode is opaque and private to its original invocation. Replay
exposes only its committed `result` data. It cannot restart Source or apply.

The intended sequence is `select` (native first transaction), `source` (after that transaction releases), `apply`
(second native transaction). A reached failed apply may use `failure` in a third transaction on the same balance
and deadline. The complete Source child must be declared before registration and must use its own authentic Source
port with this absolute deadline. `SelectedChildren.native` enumerates exact literal SQL, finite invocation-wide
multiplicity (1..64), and complete nine-field child costs; up to 64 distinct statements are supported. `source`
is a complete child cost including its reached cleanup. These declarations describe dispatch; they grant no
Source or user authority. Unknown SQL, unknown Source cost and repeated phases refuse before dispatch. Native SQL
cannot consume an exempt local string: local queries require the same private identity recorded by the executor.

The pinned SDK patch adds `DBOS.registerSelectedStep(func, config, lifecycle)` and `DBOS.getSelectedExecution()`;
`DBOSClient.selectedExecutionIdentity(selection,pool)`, `consumeSelectedExecutionAdmission(selection,pool)` and
`checkSelectedExecutionInTransaction(rawClient,pool,selection)`. The `SelectedExecution` type is opaque. Only the
private executor body site in `callStepFunctionAt`, after completed-output replay, constructs its value. It binds
the real function registration, actual owner token, committed workflow/input, function index, argument bytes,
private attempt generation, restore UUID and deadline. A completed step replay never opens the lifecycle. Calls
outside genuine selected execution supply no capability. All completion/error/abort paths revoke escaped values.
Work's private original pairs this issuance with the exact `createWorkClient(url,pool)` enrollment. Matching URLs,
a copied object, another client pool, sharded/dynamic homes and a structural query object are refused. The native
held check also requires the actual pg PoolClient enrolled in that Pool; operational.ts alone checks it out and
constructs/live-registers the transaction. No other-home checkout happens while that client is held.

The append-only SDK migration is `20261102110241_selected_step_execution`, after all existing migration positions.
It adds `selected_step_executions`, `select_step_execution`, `hold_selected_execution`,
`consume_selected_execution`, `release_selected_execution`, and ALWAYS admission-preservation guards. Issuance
locks restore domain SHARE, actual workflow status SHARE, permanent writer fence UPDATE, then completed output/input
and the selected attempt. Held validation uses domain SHARE -> status SHARE -> permanent fence UPDATE -> attempt
SHARE -> committed input SHARE, and compares the locked current records and registration/input bytes. Queue recovery/replacement changes `owner_xid` by updating status;
that update conflicts with SHARE until the operational COMMIT. Retirement's unchanged status-before-fence ordering
also conflicts with that lock. Restore's domain UPDATE conflicts with domain SHARE. Reissuance advances the selected
attempt and conflicts with its held SHARE. A second held validation occurs before each COMMIT. Existing permanent
writer-state APIs retain their original meaning and are not selected execution proof.

Before the first operational transaction, native `consume_selected_execution` commits a once-only admission bit.
It never refunds on rollback, recovery or uncertain commit. Recovered execution may reconcile an actual committed
Accounts result; a pending/missing association with a spent bit refuses. Reissuance cannot clear the bit. This
chooses safe poisoning over a new allowance when the preceding commit outcome cannot be established. The local
prepaid original starts at actual body execution with a fixed five-second deadline, following the existing private
operational-original allocation convention. A selection claim identifies execution and does not fund foreign work.
No request capability, original deadline or postcommit transfer is reused or renewed. In-process operations drain
before SDK release, and no private live map or heap committed flag is evidence of native COMMIT.

### Selected local declarations

Every row below also has `candidateKeys=identityMetadataRows=witnessKeys=engineRequests=0` and
`emptySeeks=nativePoints`. These are literal LOCAL bounds, not whole Members, Source, Access or physical prices.
They are prepaid cumulatively; misses, collisions, failed prefixes, SQL exceptions and poison never refund.

| Local dispatch                       | nativeRows | nativePoints | statements |   bytes |
| ------------------------------------ | ---------: | -----------: | ---------: | ------: |
| issue                                |          8 |            9 |          8 |   49152 |
| release                              |          2 |            2 |          2 |    4096 |
| durable consume                      |          9 |            9 |          8 |   24576 |
| continuation lookup/association      |         10 |           12 |          7 |   49152 |
| SDK enqueue with exact-input capture |         10 |           10 |          9 |   18432 |
| held native check                    |          7 |            7 |          6 |   24576 |
| operational controls/fences          |          7 |            3 |         12 |    1024 |
| reserved two rollbacks               |          0 |            0 |          2 |     128 |
| immutable original verification      |          5 |            5 |          5 | 2097152 |
| actual native tuple verification     |          4 |            4 |          3 | 6291456 |
| durable selection association        |          6 |            8 |          5 | 6291456 |
| conditional result                   |          2 |            4 |          2 |   49152 |

`SELECTED_LOCAL_DECLARATION` is issue + consume + enqueue + four continuation branches + three times
(controls + two held checks + original + two tuple verifications + association + result) + cleanup.
Its full axes in the order candidateKeys/nativeRows/identityMetadataRows/nativePoints/witnessKeys/statements/bytes/
emptySeeks/engineRequests are **0/195/0/204/0/187/63505792/204/0**. Disjoint cleanup is release + three two-rollback
partitions: **0/2/0/2/0/8/4480/2/0**, removed from usable balance before any IO. Three phases is an absolute bound,
not three new grants. Foreign declarations are summed with checked safe-integer arithmetic at registration, never
inferred from an example or a measured parent. Missing foreign declarations close their dispatch.

Rows/points include full-key probes, negative seeks, insert/conflict/update index operations and FK checks.
Statements count outer function calls and nested SQL, both transaction BEGINs, time/settings, partition/account
fences, held checks, final setting, COMMIT and the separately reserved time/native ROLLBACK paths. Catalog lookup
and exact Collection/episode locks are counted in tuple verification. Continuation includes SDK status/input,
its insert, both FKs and deferred parent result validation. Release includes its outer call and UPDATE; native
functions bound lock waits to 200 ms. Issuance includes bounded input (8192), registration projection (4096),
step arguments (4096) and their serialization. The original declaration allows its existing bounded 262144-byte
projection, <=196608-byte canonical binding and repeated validation/digest projections within 2 MiB. Tuple basis
is bounded by that same original input limit before projection; JSON escaping plus fixed scalars, checkpoint and
observation fit 2 MiB. Three copies (projection/serialization/comparison) give 6 MiB for each tuple/association
partition. These generous byte partitions include empty/replay/collision branches; they are not measurements.

The native fixture covers actual issuance, completed-step fork replay, real cross-Pool/copied-client rejection,
owner-update lock contention through sequential COMMIT/ROLLBACK, attempt replacement, restore, permanent spending
and escaped-capability rejection. Source fixtures pin issuance and native lock interaction. All new native/unit/
source/growth/full acceptance remains UNRUN at delivery; the controller owns integration and acceptance.

Remaining receiving prerequisites: current Commerce native episode schema/body and its complete literal SQL prices;
genuine complete Source child and currentness/physical operands; bounded repair with changed incarnation/generation;
and separately authentic selected cleanup authority/admission. Neither autonomous idle cleanup funding nor final
physical/retention acknowledgment is supplied. Selected control/association records must be preserved across restore;
the new retained selected records are not an all-copy absence receipt or a substitute for owner physical accounting.
Existing Source refusal remains closed. Installing the updated dependency patch and applying the forward core
migration belong to receiving integration; this source edit does not mutate the shared installed dependency.

Source read for this surface: pinned installed 5.5.3-preview `dbos`, `dbos-executor`, `client`, `decorators`,
`system_database`, `serialization`, and SDK migration sources; existing patch; reference
`.reference/search-worker-outcome-harness/dbos-transact-ts/src/{client,dbos,dbos-executor,system_database}.ts`.
The reference is context only; the pinned installed package determines this port. Retained Members work/native
SQL/migration were read with git show only as receiving operands, never composed into this worker.

The native first-issuance `admission_generation=1` is immutable. Consume additionally requires that generation to
equal the actual current attempt. Thus interruption before the first consume also poisons foreign dispatch on
recovery, even if `admission_spent` is still false. Recovered attempts can only reconcile an already committed result.
A selected transaction handle is frozen, and a returning body must have reached a durable apply/failure result or
replayed result. Escaped or unawaited phases cannot turn an incomplete invocation into a completed SDK checkpoint.

Delivery typing receipt: exactly one `bun run --cwd services/kernel typecheck` ran through supported ordinary
placement on host `b`, terminal exit 2, command duration 231.153 seconds. It reported TypeScript control-flow
narrowing and exact-optional-property errors in the two new producer modules. Those errors were corrected with
explicit never-returning function declarations and explicit optional value types; the same post-check fix also
hardens first-issuance poisoning, transaction immutability and the table-specific native immutable guard.
These later fixes are UNVERIFIED. The compiler was not repeated. No authored/native/unit/growth/full acceptance
was run, and no passing compiler or native completion is claimed.

Held validation also rereads the actual committed SDK input and status registration projection under native locks;
changed arguments/name/queue/creator/serialization refuse. These bytes remain immutable in the selected native row.
The interrupted-before-consume native retry fixture proves that an unspent bit cannot create a recovered grant.
These additional source-hardening changes are also post-compiler and UNVERIFIED.
