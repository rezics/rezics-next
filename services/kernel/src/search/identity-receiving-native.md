# Native Search identity receiving

The native ABI is declared in [identity-receiving-native-contract.ts](identity-receiving-native-contract.ts).
It owns Search locators, selections, resolved sources, holds, context, results and the six native method signatures.
Semantic owns the binding, record, selection producer and common receiving ledger. The Search binding and record
aliases extract Semantic's canonical `search-canonical-index` variants; they cannot accept a Library binding.

[identity-receiving-native-store.ts](identity-receiving-native-store.ts) implements the Search-owned operational
transaction core. One additive Search migration creates partition-leading document locks, immutable plans,
accepted holds, retained writer operations and paged original-copy obligations. An outstanding-custody index keeps
each preparation, hold and uncertain operation counted until actual release, without scanning retired history.
It stores references and action
digests, not Semantic support bodies or another common receipt ledger. Bigints use explicit native decimal codecs.

The six-method factory is implemented in [identity-receiving-native.ts](identity-receiving-native.ts). Its trusted
configuration derives `Parameters<typeof createIdentitySourceSupportReader>[0]` and adds the actual Search client,
consumer and physical index. Search aliases extract the canonical native unions; the public Library aliases and
API remain Library-only. Common preparation and exact selection resolve committed native plan custody. A plan
receipt still grants no complete Source or publication authority.

Full composition remains incomplete. Source has not installed the writer prepare/copy/dispatch/visible/drain
hooks, complete original-support/copy-directory closure operand or coordinator configuration. The adapter refuses
terminal settlement without that genuine closure; structural close plus an empty local directory cannot mint it.
The fixed participant can apply an existing accepted scope and retain a `more` step in the same transaction. Whole
participant completion, cancellation and current-owner handoff remain unfinished. This is not native readiness.
It now retires genuinely released scopes through a same-plan-transaction operational queue and committed fixed
progress, rather than selecting the first already-applied scope indefinitely. Durable complete ACK replay verifies
its original native commit/frontier and current owner. The queue is not a complete-support or closure witness.

Each reconciliation invalidates earlier private release observations immediately. An overlapping reconciliation
or release also invalidates a terminal read still in flight; its eventual return cannot reinstall authority.
Consumed observations remain revocable while native release waits for locks or late verification. Invocation end
revokes unused and in-flight observations, and released replay checks revocation around its actual proof read.
Continuations accept only the bounded canonical four-field versioned encoding. Completing a copy page returns
an advancing progress cursor before attempting terminal Source closure on the next call, preserving that page
even when closure is unavailable. Source selection rereads the committed native plan after released Source reads
to detect owner or immutable-plan changes during resolution.
Definition resolution reads only the admitted immutable definition's release/type and configured Source route
digest. It does not decode its capture body or register a fresh Source/read definition as a read side effect.
The original Release and independent original/terminal Source projections are still required and separately funded.
Search frontiers snapshot plain scalar data before awaiting SQL, rejecting accessors, inherited fields, custom JSON
coercions and nonfinite numbers. The frozen snapshot is shared by native mutation and late common callbacks; the
canonical inclusive limit remains 1792 UTF-8 bytes. Library's API and 2048-byte limit remain distinct.

## Implemented transaction core

`createSearchIdentityReceivingNativeStore({pool,index,consumer})` binds the real receiving Pool and physical
generation. `preparePlan(tx,input,context)` verifies the actual live maintenance command, current active home,
document lock, writer generation gate, physical UUID/alias, enrollment/fence generations and exact original close.
It inserts an immutable per-original plan and its initial operational copy page, and registers the existing Search
native commit in the same T. The returned plan remains uncommitted. `readPlan` resolves only a committed native
component with the plan's same transaction provenance at the current owner; it cannot select a preparation from
its own transaction. Repeated preparation must match the original plan and initial copy page exactly.
Original/document closes and every registered copy receipt must have a valid native home, positive epoch and
bounded position, and a transaction UUID before persistence. Malformed immutable locators are refused before the
writer or insert probes; syntactic validity still grants no Source authority. A plan cannot name itself as its
handoff predecessor.

`registerOriginalCopies` appends at most 100 operational locators under the document and writer locks, before any
hold exists. Its expected last-copy cursor makes lost-response replay compare the original committed batch rather
than append duplicates. Copy keys span pages; no generation or original is dropped at page 100. This directory
is sealed by acceptance. Neither its page boundary nor its empty state certifies complete Source discovery.

`readAndHold` and `revalidateHold` take the actual receiving `CommandTransaction`. They require the identical
`currentCommandResources(tx).pool`, maintenance basis, original deadline, home and owner epoch. Replay resolves
the original common accepted transaction before demanding fresh writer eligibility. A new hold reserves a late
callback that requires the exact common Search accepted record, gate and `identity-receiving-record` component in
that same T. The callback binds the native hold to the actual accepted component. Missing common registration
rolls back; acquiring a native hold never registers a conflicting Search purpose.

`recordDispatch` records only a same-T update of the actual writer's dispatched enrollment, retained repair locator
and exact action digest. `recordVisible` requires that original enrollment's same-T actual writer settlement and
retained native bulk/recovery evidence. It validates the existing writer's receipt and exact physical/action/native
identities. No method sends engine requests. `recordApplied` advances the committed visible native operation and
frontier; a late callback requires the common effect and fixed Search scope step with the same T, native component,
frontier and transaction provenance. Missing registration rolls back the operation mutation. Applied replay
resolves the original committed effect rather than remutating.

`readOriginalCopies` pages at most 100 keyed obligations. `observeOriginalCopy` releases the receiving read before
reading the exact current original owner. It requires the original close, physical allocation and enrollment to
match, with genuine writer settlement and visibility. Dispatched originals cannot be satisfied by cancellation,
a different action, refresh or engine GET. Missing provenance is unavailable, not an empty page. An owner change
requires genuine handoff and remains closed. The returned observation is a store-private capability from that
actual read, not a callback or caller certificate. `reconcileOriginal` verifies those observations against the
original directory and persists their settlement under native commit provenance. Its result describes only the
registered directory, never whole-Source settlement.

`readDrain(tx,context)` locks the exact current closed native generation gate and probes one outstanding plan by
the `(partition,physical target,plan)` pending index. Unknown owner/gate is unavailable; genuine native empty is
distinct. The pending row is inserted with preparation and removed atomically with genuine hold release. Native
empty covers only this operational custody, not Source first absence, support completeness or publication.

`observeRelease` first resolves the committed native/common applied effect and fixed step, releases the receiving
home, then reads actual applied control custody for that exact effect/native transaction. `releaseHold` requires that actual observation,
the same applied operation and no pending original copies, then retains a native release component. Replay verifies
the original release. It never clears Semantic's publication gate. Terminal common-gate removal separately requires
the actual published job and all sibling scopes, through Semantic's existing publication protocol. Native applied
hold release can precede publication without opening that gate. Cancellation and owner-handoff adapters remain
dependent on their authentic common/Source branches; this core releases only actual applied control custody.

All mutating methods poison their live transaction on failure, so catching a refusal cannot commit partial writes.
The caller must return the existing `searchIdentityWriterChanged()` event; these methods are not `noEffect` work.
Remote observations reject an inherited receiving read snapshot and finish each real read transaction before
entering the next home. Engine work belongs exclusively to the existing Source writer outside SQL transactions.

## Custody boundary

A plan UUID and its native receipt are locators. Selection requires an immutable committed per-original plan at
its document's receiving home. OLD selects the original document; NEW and first-apply select the terminal document;
handoff retains the predecessor's document. Each plan must preserve independent original membership, exact effect
and scope, current owner, consumer, physical UUID, allocation alias, physical generation, enrollment/fence
generations, original close and the bounded complete-support/definition/release/preparation/copy references.
A support page, prepared array, ordinary drain or returned native receipt does not establish these obligations.

The six methods retain the selected ordering:

- `resolvePlanned` resolves committed native and released Source/control witnesses, then rereads the plan.
- `readAndHold` locks native custody on Semantic's actual receiving `CommandTransaction`, Pool, home, epoch and T.
  The native hold and common accepted record commit together under `identity-receiving-record` provenance.
- `revalidateHold` resolves that original acceptance before fresh business eligibility; retained custody alone
  cannot authorize a fresh write. An owner move requires the retained handoff chain.
- `recordApplied` verifies the owner mutation and native frontier on that same client and T after external work.
  Native operation, common effect, fixed step and frontier must commit together, with rollback if registration is
  missing. Dispatch/refresh/visibility provenance precedes settlement; engine work runs outside SQL transactions.
- `reconcileOriginal` consumes at most 100 original operational keys per indexed page. It retains dispatched or
  ambiguous obligations until their actual owner recovers them. A newer write, timeout, GET or refresh cannot
  settle an uncertain original. One page or one receiving receipt cannot finish the job.
- `releaseHold` requires committed common applied/cancelled custody and settled original obligations. Publication
  gate removal separately requires all sibling scopes and actual publication. Replay verifies original release.

Native storage must own operational custody only, with partition-leading keys and one additive UTC migration.
It must not mirror Semantic support or introduce another receiving receipt ledger or engine sink.

## Required owner installation

Semantic must install its actual separately discriminated Search variants and the two named preparation/selection
exports, dispatching the existing common lookup/admit/record/reconcile/release operations to the declared native ABI.
The Library source, capture, hold and native purposes must remain separate. No foreign declaration is copied here.

`createIdentitySourceSupportReader` is present and uses the exact `PublicFilterSourceFactory` configuration
`{pool, routeKey, access, clock}`. The adopted participant receives only `{search, prefix, routeKey}` and its
`IdentityEpochStep` receives `(pool, job)`. There is no installed Source configuration accessor for this participant.
Trusted Source composition must supply that exact configuration for the same Pool before this participant can
construct the real support reader. Creating another Access instance or replacing the reader with `subjectSource`
would change authority. Neither is an implementation of this boundary.

The existing writer owns enrollment, dispatch, settlement and retained copies. Its `SearchWriterBarrier` reports
`firstApply: 'unavailable'` and `prepared: 'unavailable'`; no first-apply receiving preparation/dispatch hook is
installed. The Source writer owner must receive the following disjoint native integration before readiness:

- Before a plan can be selected, register its actual per-document preparation under the existing writer's
  publication-admission lock, native generation-gate lock and original writer lock, on the same live transaction
  used by enrollment/structural close. Operands are the admitted job/original, mapped terminal/document, configured
  consumer/physical UUID/alias/generation, exact complete support build/definition/release locators, original close,
  planned action, predecessor for handoff and the caller's remaining `NativeStepWork` reservation.
- Dispatch must consume the committed plan and accepted original hold through the existing guarded
  `writeIndexActions` path with external versions, allocation alias, refresh and pre/post physical verification.
  Retain the actual dispatch and visibility/recovery operation before local settlement. Never add a native adapter
  bulk sink or use a current engine GET as lost-response settlement.
- Enrollment, close, drain and retirement must count these pending preparations and original uncertain copies.
  The local applied mutation must register its exact plan/hold/action/frontier with common receiving in the same T.
  Final release must compare original applied/cancelled/control custody and all original copy obligations.

These are missing installed authority, rather than an empty population. No reserved Source writer, runtime,
coordinator, schema, Semantic or scoped body is modified here.

## Cost

Every store call takes the caller's original finite `NativeStepWork` reservation and deadline. The store creates
no new allowance. It captures an immutable copy at entry; mutating the caller's context during an awaited probe
cannot refill the reservation or extend either the meter or subsequent read transactions' deadline.
Before each named SQL dispatch it charges the literal logical row/point/byte upper bound below,
one statement and zero engine requests. Empty results, repeated probes and failed SQL have the same dispatch bound.
Exhaustion refuses before that dispatch. `SearchNativeReceivingError.work` preserves all prior charges on refusal
or storage failure. Late callback SQL and the native insert are reserved before callback registration and included
in the method's returned work. No MVCC tuple count is used for metering; transaction provenance uses `xmin` only to
reject separately committed records.

| Named SQL | Rows | Points | Bytes |
| --- | ---: | ---: | ---: |
| owner | 1 | 1 | 256 |
| plan | 3 | 3 | 20480 |
| prepare | 2 | 4 | 20480 |
| document / lock | 1 | 1 | 512 |
| writer | 2 | 2 | 4096 |
| action / receipt | 1 | 1 | 1064960 |
| hold / peekHold | 1 | 1 | 1024 |
| accept | 1 | 2 | 1024 |
| accepted | 4 | 4 | 12288 |
| bindAcceptance | 1 | 1 | 512 |
| operation | 4 | 4 | 12288 |
| dispatch | 1 | 2 | 10240 |
| visible | 1 | 1 | 1024 |
| apply | 1 | 1 | 4096 |
| applied | 4 | 4 | 4096 |
| copy | 3 | 3 | 4096 |
| copyLast / pending | 1 | 1 | 256 |
| copyOwner | 4 | 4 | 4096 |
| reconcile | 1 | 1 | 4096 |
| control | 5 | 5 | 4096 |
| release | 2 | 2 | 1024 |
| releaseProof | 2 | 2 | 1024 |
| drain / drainGate | 1 | 1 | 512 |

For an explicit page limit `n` (0 through 100), copy reads reserve `3*n` rows, `1+2*n` points and `256+2560*n`
bytes; inserts reserve `n` rows, `n` points and the same bytes. Each is one statement. A real read transaction
reserves four statements before acquisition: BEGIN, SET LOCAL, COMMIT and possible failed-COMMIT ROLLBACK.
Each mutating call reserves one rollback statement before entering its body, including replay/refusal. The existing
native commit callback reserves one row, one point, one statement and 128 bytes. These cleanup reservations are
conservatively charged even when unused; no refund or retry allowance is minted. Writer payload SQL caps each
retained action/receipt at the existing 1048576-byte ceiling and refuses unavailable evidence beyond that bound.
Those payloads have separate keyed probes; preparation, hold revalidation and drain never fetch them.
The common eight-axis SQL inventory uses these same explicit raw sizes for the two exact page statements,
before dispatch. It preserves additional configured transitive costs on every axis. Invalid limits or encoded
pages refuse before SQL; empty results and SQL failures retain the admitted page cost. A one-copy step is funded
as one raw copy rather than the maximum hundred-copy page, without reducing any original frame ceiling.
Malformed close/copy receipts or a self predecessor detected after the preparation owner probe return one row,
one point, two statements and 256 bytes, zero engine requests, including the reserved rollback; no writer or
insert query is dispatched.

The Source hook's delta is the sum of the exact store methods it invokes and the existing writer's own actual
enrollment, publication locks, Source/listing/physical probes, engine dispatch/refresh/recovery and settlement costs.
Those foreign costs are not included in, or funded by, the store. Common accepted/effect/fixed-step inserts likewise
remain separately charged by Semantic; native callbacks reserve their verification probes only. The original frame
must fund all of them before dispatch. Existing raw100, Source and child ceilings remain unchanged. No all-home
census, unknown-SQL fallback, engine sink or hidden child funding is introduced. Native acceptance remains deferred.

The common composer also observes actual Pool acquisition and named SQL in the original five-axis frame.
SQL inside a native call must fit its already reserved native cap; common/executor work outside that call
additionally debits the same original residual. Eight-axis SQL reservations remain independent. The composer
awaits already-dispatched native promises, real client-query promises and async driver callbacks before settling
the child receipt, including callbacks which dispatch more SQL. Inherited contexts refuse SQL after that child
ends. Refusals, failed SQL and unused native operation caps retain their original charges.

The common composer's installation function now selects the capture-enabled literal inventory and same-client
pre-COMMIT planner in `semantic/identity-search-receiving-capture.ts`. The original local subtotal still omits
capture-producing writes and cannot admit them as zero. An additive migration provides the actual indexed
home/epoch/position source-commit lookup, transaction-bound funding events and complete indexed keyset traversal
of both original/native copy and source roles and both write-basis effects. A shared transaction is traversed
once. Each basis retains its own transaction, source position and provenance. It preserves the original seal,
native delivery, current-xact and other-caller semantics. No maintenance-role count or successful empty page
proves completeness.
The [eight-axis capture ledger](../semantic/identity-epoch-contract.md#search-original-role-capture-and-funding)
includes immediate writes, FKs, both queues/sequences and complete nested/deferred effects, with retained
failure/rollback and repeated charges from the same original frame. The actual default frame cannot fund its
five-empty-seek fixed deferred reservation. Missing Source/release/binding/projection and engine composition
operands remain unavailable. This is source implementation with authored connected regressions UNRUN, not a
native pass or complete aggregate fit.

The exact-origin source directory and its deletion cursor, refresh, hold, page and terminal consumers now
retain distinct transaction/source-position origins even when their native delivery and physical key agree.
The planner gathers both complete copy prefixes before checking carried source roles. Explicitly registered
copies can retain both authentic origins at one account/role. A carried source role with an unregistered
conflicting origin still returns `identity_epoch_unavailable` before arming: complete Source support/copy
closure is not installed. This conservative refusal neither drops an explicit copy nor proves Source closure.
There is no role-count cap. The physical locator remains a shared queue entry; its latest provenance is not
authority for the original-specific directory or custody consumers.

In axis order candidateKeys/nativeRows/identityMetadataRows/nativePoints/witnessKeys/statements/bytes/emptySeeks,
the added planner bookkeeping reservation is `(0,0,0,0,0,0,1024,0)` per event before constructing
its map/control closure, plus `(0,0,0,0,0,0,512,0)` for **each visited role**, including
same-origin repetitions and the conflicting role. It precedes key construction and map access. A key
contains only the projected 36-character account UUID and at most 12-character legal role; its origin is
a 36-character transaction UUID. The 512-byte role bound includes those strings, temporary key construction
and map-entry bookkeeping. The event map is discarded after that event; spent funding is never restored.
The existing per-role deferred footprint is reserved before this additional reservation. Both remain
charged on refusal, and subsequent SQL, arming and deferred work are not dispatched. All existing SQL,
control, failure and rollback declarations remain additional; this is not a complete original quote
or a change to the historical deferred formula or its five-empty-seek failure.

The dedicated planner guard, native same-actor provenance, both write-basis and complete copy-prefix
regressions are authored UNRUN. The native cases use genuine command fences and deferred capture, including
after-plan basis/copy changes that must roll back every new native origin while preserving prior originals.
Copy-prefix cases cover 1, 10 and 100 overlapping account/role pairs per origin and equal authentic native
delivery. Their generous isolated ledgers and planner doubles do not establish configured original funding,
Source closure or the physical 24-point/two-empty-seek bound. Existing acceptance tests, including the two
narrowly authorized capture-oracle cases, remain unchanged.

The per-operation cost is the sum of these named literals; all mutating calls additionally reserve rollback, and
each externally owned read transaction reserves the four statements above:

| Operation/path | Named charges, in dispatch order |
| --- | --- |
| prepare new | owner, writer, document, lock, prepare, insertCopies(n), native commit |
| prepare replay | owner, writer, document, lock, prepare, plan, copies(n) |
| register copy page | owner, plan, writer, lock, hold, copyLast, insertCopies(n), native commit |
| register page replay | owner, plan, writer, lock, hold, copyLast, copies(n) |
| read plan | read transaction, plan |
| native drain | owner, drainGate, drain |
| acquire new hold | owner, plan, peekHold, writer, lock, hold, accept, accepted, bindAcceptance |
| acquire replay / revalidate | owner, plan, peekHold, accepted, writer, lock, hold |
| dispatch | revalidate, operation, action, dispatch, native commit |
| visibility | revalidate, operation, receipt, visible, native commit |
| apply | revalidate, operation, apply, native commit, applied |
| applied replay | revalidate, operation, applied |
| copy page | read transaction, plan, copies(n) |
| observe original | read transaction, plan, copy; released home; read transaction, copyOwner |
| reconcile n originals | owner, plan, writer, lock, n*copy, at most n*reconcile, at most one native commit, pending |
| observe release | read transaction, plan, operation, applied, peekHold, accepted, pending; released home; read transaction, control |
| release | owner, plan, peekHold, accepted, writer, lock, hold, operation, applied, pending, release, native commit, releaseProof |
| release replay | owner, plan, peekHold, accepted, writer, lock, hold, operation, applied, pending, releaseProof |

Visibility/dispatch replay stops after `revalidate, operation`. Empty registration stops before insertion/native
commit. Every refusal retains all earlier dispatch/reservation charges in its error; no later SQL is sent. The
explicit page limit allows the caller to fit the combined logical join costs inside its original raw/row ceilings.

The exact Source call sites still owed are:

```ts
store.preparePlan(tx, input: SearchNativeReceivingPreparation, context: SearchIdentityReceivingContext)
store.registerOriginalCopies(tx, locator, after: number, copies: readonly SearchNativeReceivingCopy[], context)
store.recordDispatch(tx, locator, holdId: string, operationId: string, context)
store.recordVisible(tx, locator, holdId: string, operationId: string, context)
store.recordApplied(tx, locator, holdId: string, operationId: string, frontier: IdentityFrontier, context)
store.readDrain(tx, context)
```

Preparation is called inside the sole writer's existing publication-admission, generation/enrollment and original
close locking transaction after real support admission. Lock order is publication admission, generation gate,
original document writer, native document lock, native hold/operation/copy. A nonlocking original acceptance peek
precedes fence acquisition on replay; it is compared again after acquiring the locks. The Source hook must use
this same order, including structural-close preparation, to avoid an inverted writer/document lock acquisition.
The actual writer must retain that prepared action and
enrollment before dispatch; the dispatch hook shares its genuine update transaction, while visibility shares its
genuine retained receipt/settlement transaction. Existing transport, pre/post UUID/allocation alias, external
version and refresh handling remain the single engine path. Final application shares Semantic's actual receiving
effect and fixed-step registration transaction. Existing drain/retirement probes must invoke `readDrain` under the
same publication-admission lock and original work frame. This adds exactly three rows, three points, three
statements and 1280 bytes, zero engine requests, including its actual current owner and closed-gate probes. The
pending index covers unreleased native plans/holds/operations and original uncertain copies. A complete
support/first-absence/predecessor witness and its current-owner recovery remain Source-owned;
none is inferred from the store's local directory. These are integration operands and cost deltas, not installed
Source hooks or a request to amend an active owner.

## Verification boundary

The current foreground `bun run --cwd services/kernel typecheck --emit-client` used the supported placement and
the genuine generated-client output transport after the implementation commit. Input staging and transfer
completed. The existing command retried transport on both configured hosts, then exited 75:

```text
remote-check: retrying transport failure on b with code 75
remote-check: retrying transport failure on a with code 75
error: script "typecheck" exited with code 75
```

No compiler diagnostics or compiler pass were produced, and the chained client/Web typing was not reached.
No duplicate command, alternate placement, local database, acceptance, unit or native command was used.
Original acceptance remains deferred to controller/verifier custody. The Source lifecycle and complete numeric
composition gaps above remain implementation gaps independently of this transport failure.
