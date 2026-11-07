# Work domain inversion

Decision: Work follows Access. Contract, core and application load no downstream behaviour. Native SDK, SQL, clock,
authorization, receipt association and selected-admission adapters are bound by ordinary `createKernel` /
`createKernelRuntimeDefaults` / `server` / `worker` composition. Existing facades call that composed application.
Product module assembly lives in `composition/work-modules.ts` and imports each domain work module through a
declared public entry, including `ratingNativeWorkModule`. Compact `domain-composition` tests are the fewest pins
for fake-port enqueue, registration, selected admission and retirement; worker and kernel landing tests use
`workerTestEnv` so receipt keys travel with ordinary `createKernel`/`server`/`worker` composition. The existing
growth-work-client, selected-runtime-native, sdk-transaction-fence, sdk-retirement-fence and growth-retention
fixtures remain the causal native set. Search keeps both `search_account_erasure` and `search_erasure` tombstone
effects.

Decision: ordinary composition supplies the native worker authorization factory before registering product work.
The first Accounts registration must not synchronously load the Kernel module graph from inside a lazy
`getAuthorization()` call. The installed worker lifecycle and default discovery journeys cover that startup path;
authorization still uses the worker's original pool, client, clock, environment and receipt keys.
Worker authorization and HTTP hosts share Kernel route assembly and catalogue validation. The worker resolves native
Access from that completed assembly; only HTTP hosts compile request handlers and schemas. Worker startup never
spends its registration budget compiling a transport it does not serve. The existing authorization tests retain
native Content roles, action refusals, consent freshness and no-I/O assertions; installed lifecycle tests retain
readiness, link convergence, failure cleanup and graceful drain under their original deadlines.
The completed assembly reads Elysia's composed route view once for write rates, viewer bindings, guest security,
path declarations and the native action catalogue. Those consumers share the same final declarations instead of
recomposing hooks and schemas for each validation; HTTP handler compilation keeps its own transport lifecycle.
Decision: direct WorkContext hosts supply the real pool, queue catalogue, client, clock and effect collector before
registration, start every owned service, and drain them before closing the client. Search derives worker Access from
the complete native action catalogue instead of compiling an unused HTTP host.

Public entries: `work/contract/index.ts`, `work/contract/bounds.ts`, `work/contract/vocabulary.ts`,
`work/contract/cost.ts`, `work/core/index.ts`, `work/application/index.ts`, `work/adapters/index.ts`,
and the stable facades `client.ts`, `registry.ts`, `retries.ts`, `queues.ts`, `selected-runtime.ts`,
`selected-runtime-cost.ts`, `history-enqueue.ts`, `sdk-retirement-fence.ts`, `authorization.ts`, `retention.ts`.
Adapters stay in `kernel-platform` so Work does not form a new module cycle with Command, History and Events.
Contract leaves are literal-only so core and facades may read those values at load.

# Installed queue controls and cleanup replay

`WorkIntent` forwards `queuePartitionKey`, `deduplicationID`, `priority` and `delaySeconds` to the installed
`DBOSClient.enqueueInTransaction` on the source transaction. The existing effects, locator-effects and import queues
already set `partitionConcurrency: 1`; the installed SDK treats those as partitioned queues. Their worker-wide
limits remain eight, eight and two respectively. Producers identify the source partition with `queuePartitionKey`.
Priority and delay use the SDK's normal admission, execution-owner and recovery paths.

Decision: keep installed queue-wide deduplication with rejection on collision; partition keys do not scope a
deduplication ID, and a caller does not silently receive another partition's workflow.

The production retention workflow records its starting time, retention days and application name in one durable step.
Each subsequent batch is a separate durable step using the registered `DBOSClient`; replay skips committed batch
results. A batch that fails before its checkpoint reselects work and repeats the supported SDK deletion without
descendants. There are at most 60 batch steps per scheduled invocation, each with at most three attempts, plus the
starting step. Each batch returns at most 1,000 workflow IDs. The scheduled path uses the repository indexed selector,
not `listWorkflows`.

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
backlog beyond 1,000 stays unvisited. SDK `deleteWorkflows(ids, false)` is six transaction statements (BEGIN, four
exact-ID DELETEs of input/output/operations/status, COMMIT) plus owned payload rows and FK cascades into events,
event history, notifications and streams. Nested FK SQL is four engine statements inside the status delete (five
points including the parent). Those cascade and payload rows grow with the selected neighbourhood's owned copies
and admitted payload bytes, not with unrelated history or with the selected workflow count. Permanent writer
fences stay. MVCC visibility work is excluded. The growth harness counts BEGIN/COMMIT as control statements, not
`Cost.statements`. Empty batches are the selector only (one application statement, zero control, zero deletion
rows). A nonempty batch is five application statements plus two control (seven). A two-batch sweep of 1,000 then
10 is ten application plus four control (fourteen). A failed batch before its checkpoint prices the same five
application statements plus BEGIN/ROLLBACK; replay repeats that envelope on the remaining identities.

`test/work/growth-retention.test.ts` measures empty, short (10) and full (1,000) batches at scales 64, 512 and 4,096
history units (16 rows each) with selected work and unit payload fixed; eligible-application backlog with the
returned batch fixed at 1,000; the already-passing `operation_outputs` fanout 1/8/64; independent copy axes for
every variable family within owner limits (operations/history/notifications/streams 1/8/64, events 1/8 capped at
8); payload-byte axis 1,024/8,192/65,536 on harness scales 1/8/64 (`retentionAdmittedByteScale`) with single-copy
families held at one row; mixed maximum admitted neighbourhoods; unrelated payload history; sparse/deep selected
identities; and a 1,010-row two-batch sweep. Inventory before deletion is unmeasured `prepare`; after deletion is
`verify` on the admin pool so owned-row/byte/fence readback is not product cost. Growth scales cannot exceed 4,096,
so the admitted 65,536-byte axis cannot be the harness scale.
Each check uses `captureMode: 'cost-folded'` so nested SDK-delete auto_explain notices stay inside the 32 MiB
and 20,000-entry telemetry caps; raw retention of those notices overflowed on eligible-backlog, payload-fanout and
two-batch sweep. Folded captures recycle each notice envelope and plan-walk occupancy after charging summaries;
unmeasured prepare/warmup records only top-level write plans.
The 32,768-row planner floor owns unit copies of every payload family so exact-ID deletes keep indexed seeks when
fanout is 1, 8 or 64; a selected-only payload table seq-scans at small N and the linear blocks family cannot fit
that plan change. Cascade inserts pack by parent so each FK nested loop reads adjacent heap tuples. The derived
envelope is affine in owned copies: a constant per-parent index probe plus linear heap pages. Packing or a plan
transition is retained in relation pages, sequential-scan evidence and the affine residual; it is not removed by
holding cascade families at one copy. Bound revision `e06e70f8c26d1f3175633ca1ecf08507f0ccd5b0` passed the
selected-count series (empty 0/1, short 90/5+2, full/backlog 107304/5+2, operations fanout 90→160→720, sweep
41868/10+4); this complete outcome adds the family/byte/mixed/sparse series on top of that envelope. Selector-plan
notices are sampled from acquired pool clients after the auto_explain probe. Selector plans use
`workflow_retention_selector` (Index Only Scan, no sequential scan); folded lists classify the four exact-ID
deletes and nested FK kinds. Statement pins are `Cost.statements + Cost.controlStatements` = 1/7/14. Native
recovery `test/work/retention.test.ts` interrupts before and after the durable batch checkpoint, resumes the same
workflow identity on the frozen cutoff/application, reads owned rows/bytes/fences before and after, and finishes
on repeated empty. A 1,000-id delete seq-scans the 32,768-row selected payload neighbourhood; fanout stays indexed.
The full-batch series retires the former `GROWTH_BASELINE` step exemption for `workflow retention batch`.

### Cost: workflow retention batch

- Touches: the tagged indexed selector on `dbos.workflow_status` plus SDK `deleteWorkflows(ids, false)` — BEGIN, four
  exact-ID DELETEs of input/output/operations/status, COMMIT — and FK cascades into events, event history,
  notifications and streams. Permanent writer fences are not deleted.
- Bound: empty batch 1 application statement, 0 control, 0 deletion rows; nonempty batch 5 application + 2 control
  (7); a 1,000-then-10 sweep 10 application + 4 control (14). Deletion/examined rows are selected IDs plus owned
  payload and cascade copies, constant in unrelated workflow/payload history and in eligible backlog beyond 1,000,
  linear in each variable family within owner limits and in admitted payload bytes with single-copy families held
  at one row. Nested FK work is four engine statements / five points inside `DELETE workflow_status`. Selector
  blocks are logarithmic; cascade-fanout blocks are affine (per-parent index probes plus heap pages), declared
  `indexProbes` for depth/packing staircases. Interrupted batches price BEGIN/ROLLBACK in the same operation
  context; replay repeats the remaining identities. Fences are not deleted.
- Growth check: `test/work/growth-retention.test.ts` empty, short, full, eligible-backlog, operations fanout,
  per-family cascade, payload-byte, mixed-maximum, unrelated-payload, sparse/deep and two-batch sweep titles.

Test choice: extend the four named native suites with observed-statement, rollback/replay, family-count,
single-copy-byte and engine-envelope pins; keep the already-passing operations fanout distinct; native evidence
stays open after typing.

Decision: pin complete installed retention cleanup with the four named native suites only — compact selector and
migration pins, registered interrupt/resume with frozen cutoff and application, and growth empty/short/full/backlog
plus independent family-count, payload-byte, mixed-max and sparse/deep series — rather than extra stories. Each
growth series uses its own application and seed identities so a selected count cannot borrow another series'
payload. Nested FK work is four engine statements for every nonempty neighbourhood, including empty cascade
tables. A healthy batch commits; a failed attempt before the checkpoint prices BEGIN/ROLLBACK and replay repeats
the remaining identities. Single-copy families stay one row while admitted payload bytes grow. Packing and plan
transitions stay in the affine residual and `classifyEngineWork`; the linear family is unchanged. Growth capture is folded; a selected 1,000-id delete cannot keep every nested auto_explain document under
the shared 32 MiB or 20,000 retained-entry caps. Payload-family planner floors are part of that pin: fanout 1/8/64
must remain an indexed equality delete of owned copies, not a sequential scan of a tiny selected-only table.
Cascade copies are packed by parent; packing residuals stay in the affine envelope and relation-page evidence.
Installed `retireWorkflow` uses unlimited `withDbRetry`; the funded one-attempt producer is `maintainWorkflowOnce`
with `SDK_MAINTENANCE_DISPATCH`. Finite invocation and same-identity recovery stay open until Accounts SDK owner
e18b admits attempt/deadline. This complete cleanup outcome measures healthy deletion and cascade fanout, not
retry closure. Do not reproduce SDK SQL or infer that bound from a timeout.

A selected workflow count cannot bound deletion: owned payload/cascade rows are the deletion operand. The installed
SDK `listWorkflows` path stays creation-ordered and is unused by scheduled retention. No custom scheduler or
cancelled reporting producer is introduced.

Sources inspected: the indexed `native-scheduler-funded-design/dbos-transact-ts` reference at
`627990fc59619d3584ce88511ab546bc7483f4b9`, `src/enqueue_options.ts`, `src/client.ts`, the outcome/cancellation/deletion
sections of `src/system_database.ts`, and migrations 108–112; installed SDK client/queue declarations, deletion and
native migration implementation. Payload `retention_timestamp` indexes do not decide workflow eligibility.

## Bounded workflow-status scan

Decision: Auth retention and copy retirement consume a payload-free SDK status scan on the static `DBOS` and
`DBOSClient` boundaries. `GetWorkflowsInput` keeps inclusive created ranges, OFFSET and eligibility filters before
LIMIT, so pending and recently completed prefixes can starve later eligible copies and cannot resume a stable tie.
Remove the scan patch when upstream supplies the same bounded keyset producer. Performance keeps the Auth callback,
native 256/1024/4096 proof and retirement integration; this producer does not decide custody readiness.

The installed methods are `openWorkflowStatusScan({ applicationName, createdBefore })` and
`readWorkflowStatusScanPage(continuation, { rawLimit })`. Opening fixes one application, an inclusive `created_at`
cutoff and the indexed upper key then present in that range. Pages walk `(created_at ASC, workflow_uuid ASC)` with an
exclusive last-examined key, `rawLimit` at most 1000, and no OFFSET. The persistable continuation repeats the
application, cutoff and upper key plus the last examined key. Terminal eligibility
(`SUCCESS`/`ERROR`/`CANCELLED`/`MAX_RECOVERY_ATTEMPTS_EXCEEDED` and `completed_at <= createdBefore`) runs after the
raw limit. Those statuses are the SDK `StatusString` literals; the scan module does not import `workflow.js`, so
`dbos schema` can load the package through the existing CJS cycle. Returned copies are status metadata only: id,
name, status, created/completed timestamps and application. Examined count is the raw rows of that page, including
pending custody and ineligible recent completion. Exhaustion is explicit.

The key is the SDK `workflow_status` invariant: `created_at` is a bigint assigned at insert and `workflow_uuid` is the
immutable primary key. The SDK-owned covering index `idx_workflow_status_scan` on
`(application_name, created_at, workflow_uuid) INCLUDE (name, status, completed_at)` is an append-only migration after
selected execution; existing positional fence migrations stay put. Fresh schema install and an upgraded
`dbos_migrations.version` both create that index. Application anchoring and seeks use that range: keys after the
captured upper bound or behind the last examined key are outside this sweep.

Concurrent visibility is READ COMMITTED under the fixed horizon. Inserts with keys `<= upperKey` and after
`lastExaminedKey` can appear on a later page of the same open. Inserts after the upper key, and inserts already
behind the continuation, wait for the next `openWorkflowStatusScan`. Completing or deleting an already examined row
does not rewind the continuation; a later pending copy becomes eligible on a subsequent open, which Auth owns.
Timestamp ties split across pages by `workflow_uuid`. Deleting the previous key does not loop or skip later keys
because continuation is exclusive on the stored key, not on a live row.

Auth must not query private SDK tables. Ordinary resolution receives this producer without a dependency hold.

### Cost: workflow status scan

- Touches: one indexed upper-key seek at open; each page one indexed exclusive range on `workflow_status` with a raw
  limit of at most 1,000. No input/output/operations joins and no OFFSET.
- Bound: open examines one row; a page examines at most `rawLimit` status rows and returns only those eligible copies.
  Unrelated applications, keys after the upper bound and keys already examined stay unvisited. Prefixes of pending or
  recently completed copies consume the raw budget and advance the continuation, so they cannot hide later eligible
  copies behind a filtered LIMIT.
- Growth check: `test/work/sdk-workflow-selection-growth.test.ts` grows pending, old-created/recent-completed and
  unrelated-application prefixes independently at 256/1024/4096 with selected eligible copies fixed, and captures
  plans, examined rows, buffers and payload projection for opening and each page.

Pin with `test/work/sdk-workflow-selection.test.ts` (ties, full/short/empty pages, prefixes, unrelated applications,
serialized restart, previous-key deletion, concurrent insert/completion, later pending recovery, fresh and upgraded
schema) plus the growth file. Existing `sdk-retirement-fence.test.ts` remains the native retirement producer.

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

Decision: caller-funded retirement is `retireWorkflow(id, invocation)` on `DBOS`/`DBOSClient`, returning
`{ fence, attempts, failedWork }`. `invocation` is `{ deadline, maxAttempts, reserve, signal? }`: `deadline` is
absolute epoch ms and is never reset; `maxAttempts` is an integer 1 through 8; `reserve` is called before every
dispatch including failed attempts, recovery reads and backoff; ambient `AbortSignal` only supplements that budget.
Work maps dispatch names through `SDK_RETIREMENT_DISPATCH` in [bounds.ts](contract/bounds.ts) and exposes
`invokeSdkWorkflowRetirement`. One-argument `retireWorkflow(id)` remains the compatibility path Auth currently
calls; Auth re-exports the invocation, outcome and budget-error contract from its retirement fence. Performance
owns funded Auth consumption on `closeAuthSdkWriters`. Failed work is the reserved
dispatches of unsuccessful attempts and is not refunded when a later attempt converges.

The bounded attempt reuses `maintainWorkflowOnce` semantics: prepaid rollback, one READ COMMITTED transaction,
statement and lock waits set to the remaining deadline, no `withDbRetry`, no identity change and no payload
deletion. Connection admission is reserved and raced against the same deadline. A lost COMMIT response is not a
receipt: the next funded attempt rereads the permanent fence for that workflow ID and restore domain, or retires
again if closure is still absent. Exhausted attempts leave custody on the existing maintenance lifecycle.

The declaration commit preceded the implementation for consumer integration. The patch now supplies both the
native implementation and declarations; declaration-only revisions establish no closure. Native proof and
participant completion remain separate from source integration and typing. The native cases in
[sdk-retirement-fence.test.ts](../../test/work/sdk-retirement-fence.test.ts) await post-integration execution.
Decision: pin the funded bound on that same file with five cases (persistent connect failure, lock deadline,
transient recovery, exhausted attempts, lost COMMIT); keep original fence, scan and transaction assertions; no stories.
Decision: Work contract bounds/index unions Performance payload-family copies and FK cascade/statement/row/byte
declarations with this producer's funded-retirement constants and types; Auth re-exports the SDK invocation,
outcome and budget-error contract, and Performance owns `closeAuthSdkWriters` consumption. Existing retirement,
fence and selection assertions stay. J18 Goal walk owns native receiving. No duplicate retention producer.

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
COMMIT, so a message to a different live destination must either commit before closure or roll back. Installed
`retireWorkflow` wraps that statement in unlimited `withDbRetry`; complete cost includes those failed native
attempts once a funded attempt/deadline producer is admitted. `maintainWorkflowOnce` is the received one-attempt
path (`SDK_MAINTENANCE_DISPATCH` rollback/begin/settings/lock/retire-or-delete/commit). Finite invocation
acceptance stays open with Accounts SDK owner e18b. No process shutdown, global mutex or application callback
supplies the fence. Running JavaScript and application side effects still require their owners' admission; the
receipt establishes SDK writer closure only.

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

## Caller-funded SDK retirement

`invokeSdkWorkflowRetirement` is the supported failure-bounded producer. Each attempt reserves connect, prepaid
rollback, begin, settings, reconcile, retire when still open, and commit. Backoff between retryable failures is
reserved and sleeps at most the remaining deadline. Full success with no predecessors is
13/7/16/41120/1 including the connection; a closed-fence reconcile omits retire (8/2/8/8320/1). Failed attempts keep
every dispatch they reserved. `WorkflowRetirementBudgetError` exposes `attempts` and `failedWork`.

| Dispatch  | SQL / wait                                                     | rows / points / statements / bytes / engine |
| --------- | -------------------------------------------------------------- | ------------------------------------------- |
| connect   | pool checkout, raced against remaining deadline                | 0/0/0/0/1                                   |
| rollback  | `ROLLBACK` prepaid                                             | 0/0/1/0/0                                   |
| begin     | `BEGIN ISOLATION LEVEL READ COMMITTED`                         | 0/0/1/0/0                                   |
| settings  | `statement_timeout` and `lock_timeout` both remaining deadline | 1/0/1/128/0                                 |
| reconcile | keyed closed-fence read                                        | 3/2/1/8192/0                                |
| retire    | original `retire_workflow_writers`                             | 8/5/9/32768/0                               |
| commit    | `COMMIT`                                                       | 0/0/1/0/0                                   |
| backoff   | sleep capped by remaining deadline                             | 0/0/0/0/0                                   |

Auth composes this installed finite SDK overload through one caller-owned invocation;
its copies share the original deadline, signal and irreversible dispatch reservations.
It retains success/error attempts and failed dispatches. Technical and personal payload
removal uses the installed `maintainWorkflowOnce` native pool/restore/fence boundary;
Auth's [retention cost](../../../auth/README.md#cost-derivation) adds admitted custody,
recorder, request-trigger and artifact minimization work. The legacy one-argument
`retireWorkflow` overload retains its old retry behavior; it is not Auth's maintenance path.
Auth native/growth acceptance remains revision-qualified after integration.

Pin with `test/work/sdk-retirement-fence.test.ts` (persistent connect failure, lock/deadline, transient recovery,
exhausted attempts, lost COMMIT then same-identity convergence and old-client refusal). Original one-argument
fence assertions stay in that file and `sdk-transaction-fence.test.ts`.

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

Work's shared History module and receiving compatibility export come from `history/application/index.ts`;
`HistoryRegistry`, selected-runtime shapes and durable locator scopes come from `history/contract/index.ts`.
`work/adapters/history-store.ts` records a durable locator through the History facade, and
`composition/work-modules.ts` installs the same shared History module used by native composition. History is
installed before worker dispatch by server and worker startup and the shared runtime defaults; these entry changes preserve existing admitted Work
bounds.

The exact consumer ABI is `WorkContext.getSelectedRuntime?(): SelectedRuntime`, then
`registerMembersStep<R>(body: (invocation: SelectedInvocation, locator: SelectedLocator) => Promise<R>,
children?: SelectedChildren): (locator: SelectedLocator) => Promise<R>`. Registration must happen in trusted Work
composition before launch. The returned function is the actual registered `library.membersPreparation.step`.
The actual registered workflow remains `library.membersPreparation`. A locator contains `route`, `ownerAccountId`,
`collectionId`, `episodeId`; workflow names, deterministic IDs and `accounts:[owner]` carry no authority.

`SelectedInvocation` has one immutable `deadline`, `select(locator): Promise<SelectedEpisode>`,
`source<T>((deadline) => Promise<T>): Promise<T>`, and `apply(episode, body)` / `failure(episode, body)` returning
`Promise<SelectedOutcome>`. Each body receives the genuine `OperationalTransaction`; it returns
`{kind:'continue'|'failure'|'obsolete'|'complete', version:string, continuation?:string}`. The selected Members
producer declares its complete released Source child in `scope-members-source-declaration.ts`; the declaration
composes Library metadata, bounded Search work, repeated Collection source-state reads and the source transaction's
commit/rollback envelope. It permits dispatch only. The producer rechecks current Source, Scope, owner fence and
episode before applying exhaustion. A selected episode is opaque and private to its original invocation. Replay
exposes only its committed `result` data. It cannot restart Source or apply.

The useful-work sequence is `select` (native first transaction), `source` (after that transaction releases), `apply`
(second native transaction). A reached failed apply may use `failure` in a third transaction on the same deadline.
Terminal SDK release follows lifecycle close and drains useful operations first; it retains the original native
identity and owner binding and remains available after useful-work expiry. The complete Source child must be
declared before registration and must use its own authentic Source port with this absolute deadline.
`SelectedChildren.native` enumerates exact literal SQL, finite invocation-wide
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
`consume_selected_execution`, `release_selected_execution`, and ALWAYS admission-preservation guards. The lifecycle
sequence is issue, useful work, close and drain, then one terminal release for that issued identity. It refuses issue
after close and duplicate release. Useful selection, Source, apply, failure, and escaped handles remain revoked or
deadline-bound. Issuance locks restore domain SHARE, actual workflow status SHARE, permanent writer fence UPDATE, then completed output/input
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
original starts at actual body execution with a fixed five-second deadline. Dispatch admits declared SQL and
multiplicity against that identity; it does not debit a remaining ledger. A selection claim identifies execution
and does not fund foreign work. No request capability, original deadline or postcommit transfer is reused or
renewed. In-process operations drain before SDK release, and no private live map or heap committed flag is
evidence of native COMMIT. The admission-consume query joins the same drain before it is awaited, so an early
body failure cannot release while that native operation is pending.

### Selected local declarations

Every row below also has `candidateKeys=identityMetadataRows=witnessKeys=engineRequests=0` and
`emptySeeks=nativePoints`. These are documented static LOCAL bounds, not whole Members, Source, Access or physical
prices, and not a prepaid remaining balance.

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
partitions: **0/2/0/2/0/8/4480/2/0**. Three phases is an absolute bound, not three new grants. Child declarations
are copied and validated at registration. Dispatch checks exact SQL and finite multiplicity; foreign cost fields and
local sums remain descriptive ceilings and never become remaining dispatch authority. Missing foreign declarations
close their dispatch. Dispatch uses the documented static ceilings; it does not debit a ledger.

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

Remaining receiving prerequisites: bounded repair with changed incarnation/generation and separately authentic
selected cleanup authority/admission. Neither autonomous idle cleanup funding nor final physical/retention
acknowledgment is supplied. Selected control/association records must be preserved across restore; the new retained
selected records are not an all-copy absence receipt or a substitute for owner physical accounting. The selected
Source body now admits its declared bound and requires current Source, Scope, owner and episode checks before
completion. Installing the updated dependency patch and applying the forward core migration belong to receiving
integration; this source edit does not mutate the shared installed dependency.

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
