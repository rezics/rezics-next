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
