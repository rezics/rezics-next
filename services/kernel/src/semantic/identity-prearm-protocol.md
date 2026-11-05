# Indexed pre-arm before native identity claims

This is the implementation decision for the claim-to-Source visibility boundary in the
[identity publication contract](identity-epoch-contract.md#required-registration-arm-and-finish-protocol).
It specifies native transactions and required evidence; it does not attest runtime feasibility or Cost.
Source owns its capture, inverse directory, summaries and repair implementation. Semantic owns preparation,
claim admission and reconciliation. No new engine, public method, intent shape or participant is selected.

## Decision and necessary internal distinction

Before the FIRST actual pending group claim, retain a cap-checked PREPARING plan, close enrollment for its
immutable input generations, and finish bounded pre-arm delivery to every previously enrolled relevant scope.
Only then may native claims commit. Final job-home admission consumes complete enrollment and native receiving
custody for the SAME intent, attempt and input generations. Asynchronous post-admission arm delivery only
reconciles an already established barrier. A queued callback, fanout count or successful RPC is never that barrier.

Keep `IdentityJob.state = 'preparing'`; add an internal phase:

```text
prearm-open -> prearm-sealed -> claiming -> pending -> existing apply/publication
      \              \             \
       +--------------+-------------+-> cancelling -> cancelled
```

`prearm-open` reserves existing P capacity and excludes overlapping writers through PREPARE gates, but creates
no pending claim, mapping change, canonical publication or successful structural mutation. Its durable work and
receipt/history/outbox effects are real and recoverable. It cannot return public merge 202, successful verify/
reversal, effect-free overflow or `not_applied`. The existing original receipt locates this same preparation.
`claiming` starts with the first genuine pending claim; even partial claims have their existing pending meaning.
Only `pending` admits structural effects. Cancellation and promotion serialize on the retained job-home CAS.

This minimally refines “PREPARING is affected pending from its first native claim”: preparation now has an
earlier, expressly claim-free phase. It DOES NOT rename a committed pending claim as harmless preparation.
Before a claim-free plan is sealed, an unchanged Source not yet pre-armed can remain current. From the first
actual claim onward every relevant ready Source is already unsafe, including excluded/NOT/order dependencies.
The existing stale-page assertions retain their force at that real claim boundary.

Initial authorization, effects-free coherent double collection and 4097 refusal still precede ALL new effects,
including this plan, reservations and gates. Retain exact source routing, incarnation, published basis version,
generation, counts, native owner epochs and immutable transform; distinguish gate CAS versions from published
basis versions. Later drift cancels/reconciles this attempt; it cannot become an effect-free overflow response.
Use the original receipt binding and intent across recovery; a new attempt requires closed old delivery custody.

The falsifiable invariants are:

- Any committed pending claim implies a committed pre-arm seal for its exact attempt and unchanged inputs.
- That seal implies a closed, exhausted enrollment prefix and exact native unsafe/retirement custody for EVERY
  issued relevant inverse ticket. No missing page, unresolved item or newly granted ticket can coexist with it.
- A ready Source has complete current registration and zero exact active obligations. Its ready CAS cannot
  overwrite pre-arm, repair, retirement or a newer incarnation. No pre-arm obligation clears without terminal custody.
- Any accepted arm/finish/cancellation state change advances the local committed revision; an old observation
  cannot compare equal after a clean-to-clean transition, regardless of allocated job epoch order.

## Native keys and serialization surface

These are required indexed records, not claims that these tables already exist. All keys lead with their actual
native partition/route. Resolve a group's control home from the current original/source basis, never a terminal
hash, previous-home walk or 4096-home search. `h` is that home; `a` includes job ID, epoch and receipt-binding
attempt generation. `s` is `(sourceRoute, sourceId, incarnation, scopeId)`, using the actual native Source plan.
Library binds Collection/account/authority and accepted meaning; public Sources bind their native configuration
and complete normalized read definition. Do not derive scopes from positive returned IDs.

- PREPARE bridge: `(h, groupGeneration)` with current group basis/owner, monotone bridge version, `open | closed`,
  owning `a`, retained directory frontier and seal. Lock this SAME row for enrollment, group preparation,
  membership/routing change, retirement of inverse tickets and reopening. First absence uses a unique insert
  and locked recheck; an absent row cannot stand for an open bridge.
- Structural inverse: `(h, groupGeneration, original, sourceRoute, sourceId, incarnation, scopeId, registration)`.
  Its B-tree prefix supports one generation and original range; the full suffix is the unique continuation tie.
  `registration` is a non-ABA source registration generation. Retain one structural dependency per original/
  scope, not one row per session, fact or result. The source-local forward index leads with
  `(sourceRoute, sourceId, incarnation, scopeId, registration, original)` and names its exact inverse ticket/custody.
- Input enumeration uses existing flat `(controlPartition, generation, original)` membership, including self,
  or the generation-prefixed inverse range directly. It never joins remote member/source tables. Empty proof
  is a bounded prefix seek, not a count/aggregate over all members or inverse rows.
- Plan pages: `(h, a, groupGeneration, pageId)` retain start/end keys, native export receipt and exact bounded
  enrollment rows. Page items keyed by that prefix plus ordinal retain each receiving receipt/disposition;
  a partial index on unresolved items supports the first unresolved point. No OFFSET or unbounded vector.
- Source summary: `(sourceRoute, sourceId, incarnation, scopeId)` retains committed reader revision, registration
  frontier/version, repair state and an exact active-obligation count maintained with its obligation rows.
  Obligations/receipts lead with that key plus `a`; source-local attempt tombstones reject resurrection.
- Job-home custody: `(jobHome, a, inputGeneration, pageId, ordinal)` receives the exact directory/source proofs.
  Completed page prefixes are folded by a locked monotone frontier; the final seal references at most two
  input-generation seals. A unique receipt key prevents duplicate delivery from advancing that frontier twice.

These are additional indexes/custody for the existing original/source/scope inverse, not a second membership
authority. Source capture must cover full expanded query support, false/excluded candidates, order and first
apply. Group membership publication/repoint/restore must transfer inverse routing under these same gates.
A broad catalogue scope can be affected by every group without gating a disjoint finite owner Source.

## Registration and writers: close the lower-key hole

Registration starts source-locally UNREADY. Native OLD/NEW dirty capture and its writer generation protect the
finite raw scan, including deletions and new keys below its cursor. A complete capture receipt alone is not
complete inverse enrollment or readiness. Each discovered dependency obtains an inverse ticket at its actual
current group home in a separately released transaction:

1. Lock the bridge, verify the current original/group/source owner and generation, then insert the exact inverse
   ticket only while the bridge is open. Commit its native receipt before returning it. A closed bridge grants
   no new ticket. The registration retains bounded source-local repair work and stays unready instead of waiting
   while holding a remote transaction. It need not append to an indefinitely growing preparing plan.
2. Release the group home; take the ticket into source-local custody. Seal registration only after scan exhaustion,
   dirty drain and final native writer-fence validation. A source-local locked frontier proves every dependency
   has its exact ticket; callbacks and counts alone cannot seal it.
3. Publish Source-ready under the SAME summary/header lock used by pre-arm, repair, edits and retirement. Require
   the exact capture/registration generation, current authority/owner/pins, complete enrollment frontier, no
   repair and no active obligation. This is a local CAS, with no page-time remote dependency enumeration.

An inverse ticket issued BEFORE bridge closure stays in the closed scan even if its Source has not yet published
ready. Tickets cannot be physically removed or made invisible to that scan while the bridge is closed; retain
retirement tombstones/pins until that plan takes custody. Thus a delayed ready CAS races the source-local pre-arm
lock: ready-first is subsequently made unsafe before any claim; pre-arm-first forbids ready. A ticket issued
AFTER closure is impossible. Reopening requires the plan's final reconciliation; a waiting registration then
captures/validates the current mapping and re-enrolls, never reuses an obsolete generation's ready certificate.

Every source writer either updates complete registration atomically or commits UNREADY plus exact OLD/NEW repair
under the source fence in its own mutation transaction. New dependency/membership creation, including a lower
key, cannot publish ready first and enqueue registration later. The repair's inverse insertion takes the bridge
lock above. Existing ready tickets remain discoverable; fresh dependencies wait unready behind a closed bridge.
Changes to group membership/current-original routing use the group PREPARE gate: reject/defer conflicting work,
or transfer its exact retained custody while both old/new observations stay unavailable. They cannot change a
sealed input in place. Native birth keeps same-transaction revision-1/self evidence and must enroll before any
dependent Source becomes ready. Ordinary privacy, account and terminal fences remain independent.

## Released-home transaction sequence

Each box is a committed home-local transaction followed by release. Arrows transfer locators; the receiver
independently resolves native evidence. Never hold a source/control connection while acquiring another home.

```text
receipt home       ordered control homes       affected Source homes       job home
bind exact intent
     ->            reserve PREPARE / close bridge
                   export bounded inverse page
                         ->                    commit unsafe + pre-arm receipt
                   <- receive exact receipt / advance page custody
                   seal closed enrollment
                         ------------------------------------------------> receive seals
                                                                           seal pre-arm
                   <- receive pre-arm seal / commit actual pending claims
                         ------------------------------------------------> receive claims
                                                                           CAS pending + wake
```

1. Bind the original receipt after the cap cut. Reserve PREPARE resources in the existing deterministic native
   home/key order INCLUDING job home first. Charge P=1 once per `(home, job)`; the same reservation later holds
   the real claim. Preserve every planned home, including an RPC with unknown outcome. Closing each input bridge
   locks/revalidates its exact immutable basis and freezes issuance of inverse tickets; no group pending fields
   are written yet. Prepare reservations prevent overlapping structural writers/admissions. Acquisition receipts
   now distinguish `prepared` from `claimed`; the existing `acquired` pending-claim receipt cannot do both jobs.
2. After all required PREPARE reservations/holds, export a bounded page from each closed inverse prefix. Retain
   its exact native receipt, continuation and rows before delivery. A closed bridge provides a stable enrollment
   set across transactions; an MVCC snapshot over a changing directory would not. Empty exhaustion also gets
   native receipt custody. Finish an original's range before advancing to the next; no uncharged 101st row.
3. At the Source, verify the released immutable plan/page and actual retained native capture/registration binding.
   Lock the summary and attempt fence; compare incarnation, native owner epoch, registration and source versions.
   Atomically insert the exact pre-arm obligation, set unsafe, advance the committed reader revision, and retain
   a native pre-arm receiving receipt in that SAME transaction. Duplicate delivery returns that receipt without
   a second transition. Unknown/changed binding cannot return armed; it stays unavailable and forces repair or
   cancellation. A retired Source may return only an exact durable retirement fence that prevents old readiness.
4. Release Source; reread its committed receipt and native owner/capture custody, then release before retaining
   it at the directory home. The receipt binds `a`, intent/input generation, full `s`, registration/capture ID,
   bridge/page/item, summary version, owner epoch and native `(partition, epoch, position, transactionId)`.
   Same position with another transaction, serialized metadata or a caller's armed bit is insufficient. One
   Source receipt can cover duplicate structural tickets only by exact persisted references to the same scope/
   attempt; every expected page item still needs its native disposition.
5. Advance the closed directory frontier only after every item in that page has exact receiving custody.
   Check the indexed unresolved prefix; never infer coverage from equal send/receive counts. Each accepted page
   extends the previously custodied contiguous prefix, so end-of-range plus no unresolved item proves complete
   enrollment inductively. Seal the bridge under its original owner/basis/version lock, with native receipt.
   Retain Source unsafe obligations and bridge closure after sealing; neither can expire before admission.
6. Transfer page evidence to job-home custody in bounded steps, then transfer each directory seal. The job-home
   frontier checks each exact exported item/receipt and native seal against its planned immutable generations;
   a seal cannot skip a page. CAS `prearm-open -> prearm-sealed` only with all required seals, all page custody,
   current pinned input/source bases and no cancellation. This constant final command reads retained frontier
   heads and at most two seals, not all Sources. Native source receiving custody is now retained at control.
7. Only a real committed pre-arm seal permits `prepared -> claimed` at ANY control home. Deliver that seal using
   the existing released-home handoff, lock the local attempt/owner/group gates and revalidate the SAME bases.
   This transaction installs the actual pending descriptor/claim and native claim receipt. The first such claim
   already has complete Source coverage. Cancellation's irreversible local closed-attempt fence wins against
   delayed claim delivery; a stale pre-arm seal cannot reopen it.
8. Reconcile every real claim receipt and retained source validation at job home. The exclusive final CAS binds
   those exact claims, pre-arm/enrollment seals, immutable intent/inputs and native receipt, then commits `pending`
   plus the existing durable wakeup. Missing custody leaves preparation pending/unavailable. Mapping and the two
   fixed participants must not start from a prepared/coverage-sealed row or from fanout progress.

Receipt read-to-copy is safe only because the producer pins the immutable record and its unsafe/closed gate until
receiving custody and a terminal decision are reconciled. It is not a reusable allow. Source edits preserve active
obligations across generation changes and invalidate readiness; they cannot delete the obligation named by a held
receipt. Input source holds retain their exact existing basis and native validation semantics. Owner movement
must inherit holds/gates with native handoff custody or remain unavailable; a released stale owner receipt alone
cannot establish a new current owner. No distributed transaction or remote SQL join is assumed.

## Completion, cancellation and recovery

Scope finish still requires exact scope-specific OLD withdrawal, NEW addition, first-apply, source-handoff and
fixed participant effect custody. Publication alone is not permission to drop a Source obligation. A finish
transaction removes only its exact attempt obligation, advances the source's committed reader revision by a
local transactional increment, and publishes clean only if registration/repair and all other obligations allow.
A lower allocated epoch finishing after a higher one advances this revision again; never use `max(job.epoch)`.
Arming and cancelling also change the revision when their visible summary state changes. Delayed duplicates
cannot advance or regress it. Preserve exact unfinished obligations when folding a summary.

Job-home cancellation chooses an irreversible disposition before any cleanup. Close every planned home's native
attempt, even an apparently absent/uncertain prepare or claim. Retain the closed fence against delayed deliveries.
Before clearing an armed Source, it must take the exact cancellation and all applicable local cleanup custody;
it installs its own closed-attempt tombstone under the summary lock. A pre-arm arriving before cancellation
there is cleared only by that reconciliation; arriving afterward is rejected. No admitted `pending` job can be
cancelled by stale preparatory work. Clear PREPARE reservations only after closed-home and Source receiving
custody, using existing reserve-free cancellation/reclaim paths. Reopening a bridge cannot strand a live claim.

Crash recovery follows the retained next unresolved key, not DBOS return values: after binding resume the same
first resource; after reserve reconcile that native attempt; after export replay the saved page; after Source
commit reread its exact receipt; after directory custody replay without double advancement; after seal transfer
reconcile the same seal; after a partial real claim resume claims or close them; after final pending commit
resume ordinary effects. A crash between ANY two boxes preserves either the producer pin or receiving custody.
Lost responses/deadlines never imply rollback or authorize a new job. Rejected-attempt watermark minimization
still requires custody of all registered delayed deliveries, not time/lease expiry.

Source move/retirement transfers or fences its summary, registration and every pre-arm hold before releasing old
custody. Destination readiness requires current owner/incarnation and complete inherited obligations. Restore
has a new non-ABA incarnation/registration and repeats enrollment; an old arm/finish cannot clear its state.
An unconfirmed handoff is unavailable. Exact retirement can discharge an old inaccessible scope, but cannot
certify restored readiness or participant completion. Existing undo, original visibility, current user replay
authorization, native account fences and participant-owned erasure/minimization remain unchanged.

## Two probes and falsifiable schedules

The existing batched start/final Source probes read only the source-local summary/header and the existing
observation basis. They require clean registration/repair, zero active obligations and the same committed
revision, incarnation, authority, query/order/projection/meaning and accepted pins. Candidate IDs and broad fact
mutation alarms are insufficient. No dependency/home enumeration, per-page group lookup, activity epoch,
per-job cursor vector, new statement/client/snapshot or permission certificate is introduced.

A final observation must use the existing current final-validation boundary. Repeating a SELECT in one old RR
snapshot cannot observe a later commit; this protocol does not claim otherwise or add a snapshot to conceal it.
The native Source owner must bind its existing final observation correctly within the unchanged inclusive page
capture. The provisional unavailable scoped/public adapters on this base provide no such runtime proof.

Required native schedules below are implementation acceptance, not executable tests or passing evidence supplied
by this specification. Keep existing frozen tests intact; drive actual preparation, native admission and worker
receipts. Do not insert prepared summaries, fake native records or relabel a PREPARING return as an admitted claim.

- Relevant claim before capture seal: registration either already owns a discoverable inverse ticket and is
  pre-armed, or cannot obtain one behind the closed bridge and stays unready. After capture seal: the issued
  inverse ticket is already in the closed scan, and source-ready/pre-arm serialize on the summary lock.
- Register before inverse closure: pause after ticket commit and before source-ready; complete the plan scan.
  The ready CAS must not erase its arm. Register after closure, including a lower original/scope key: insertion
  grants no ticket and final readiness refuses until current mapping/re-enrollment. Neither race is repaired by
  a page-time remote lookup. Run source writer, group-membership writer and first-apply variants in both orders.
- Hold ordinary post-admission arm messages after a REAL relevant native claim; pre-arm must already be in
  source-local custody. With returned positive IDs/fact version unchanged, excluded/NOT/order-only claims reject
  page start/final and old continuation. Pausing BEFORE pre-arm completion must instead show no actual claim
  admitted and no structural effects. This distinguishes the new preparation boundary without weakening the red.
- Arm, effects and finish all between existing start/final observations: even clean-to-clean changes the committed
  revision and rejects the old page. Complete epoch 12 before 11; finishing 11 must change it again. A later
  cancellation of 10 cannot restore an earlier revision or erase 11/12 obligations.
- Cancel before/after every prepare, pre-arm, seal and claim delivery; reorder duplicates and resume after each
  home commit in the diagram. Assert exact immutable receipts, closed-attempt fences, no double frontier advance,
  no pending/apply from a callback/count, no P leak and no resurrection after custody minimization.
- Move/restore between Source commit and control copy, and between coverage seal and final admission: retain
  unsafe state or refuse under the new owner, never accept old-owner readiness. Repeat with native retirement.
- Continuously run unrelated group jobs while paging a finite unchanged owner Source. Its summary/revision stays
  unchanged and useful pages continue; a broad catalogue scope's active state is not consulted. Relevant finite
  fanout settles under fair default WorkModule service and eventual I/O; no starvation promise for infinite
  relevant edits. Capacity wait edges keep the existing strictly increasing control-home order, including home
  reservations, and Source delivery acquires no additional P slot or cross-home held lock.

## Cost and custody ledger

Use [bounded job steps](../../README.md#bounded-job-steps) and the existing
[identity Cost definitions](identity-epoch-contract.md#cost), including actual Source WorkAllowance. Every durable
step has at most 100 RAW examined rows, including metadata, rejects, lookahead, retries and receipt/FK/index work;
at most 100 pages per workflow segment, 5000 ms or shorter caller deadline, eight-scalar/2048-byte frontier and
4096-byte workflow arguments/results. A full inverse suffix can be stored in its retained page; pass a scalar
page/item locator rather than squeezing an unbounded key/vector into workflow input. Deadline bounds waiting,
not scan work. One page or one original need not fit an entire delivery unit; retain in-unit continuation.

Account separately for every physical object and command:

- The existing binding/history, full preparing job, immutable input refs, planned-home records and P reservation
  are retained once in their actual homes. PREPARE bridge fields add gate/index bytes, not a free job/generation.
  Membership/input copies still fit `Gq+4P` and `Aq+4P*4096` at every crash/abandon step; pre-arm creates no fifth
  full generation. Native allocation/counter and owner/source-hold work remain charged.
- Forward and inverse structural tickets each cost their payload, primary/secondary indexes and native export/
  receiving copies in D/S/R/L/H as applicable. Pages retain bounded locator/evidence rows, never full source bodies
  or per-fact witnesses. Source obligation plus immutable receiving receipt, directory receipt copy and job-home
  copy each cost rows/indexes/bytes separately. Folding acknowledged page payload needs receiving/minimizer
  custody first; fixed frontier heads cannot hide an unbounded receipt array or history walk.
- Reservation/bridge close, page export, Source pre-arm, directory custody, job-home custody, directory seal,
  pre-arm seal, each real claim, final admission, cancellation/finish/reopen/reclaim and each handoff are separately
  committed commands. Each pays its actual `K=7` unreceipted or `K=8` fresh receipted framework plus all body SQL,
  current authorization/account gates, native receipt validations, locks, FKs, wakeups and actual extra outbox/
  write-basis statements. The standard fence already includes normal receipt/outbox/basis writes; do not count
  them twice or omit their physical work. Released reads pay `BEGIN/SET/COMMIT` plus owner/proof statements.
- For n actual raw units, charge existing O(n(log D+log S+log A+log(R+L+H))) indexed work for enrollment/pre-arm,
  plus input membership seeks and each cross-home proof copy. Fixed final seals use maintained prefix heads,
  exact at-most-two input seals and indexed first-unresolved seeks; they do not scan fanout under an aggregate.
  Choose n from captured metadata/per-item cost so the entire step fits existing raw/row/point/SQL/byte limits;
  no invented coefficient, new numeric allowance or time-based work oracle certifies the fit.
- Both public probes stay within direct <=12 statements/backend or composed `8+4R_reads`, one connection/backend,
  existing candidate/Access/native raw budgets and the same inclusive capture. Background pre-arm is charged to
  its own actual steps and retained storage; moving it before admission does not subtract it from Cost.
- Add every account role to the existing indexed erasure inventory for plan/gate, forward/inverse tickets,
  page items, obligations, receipt copies and shared receipt/outbox/write-basis/DBOS copies. Semantic, Source and
  shared-history retain their own minimizers and exact receiving ACKs. Terminal fences apply before cleanup;
  clearing Semantic refs cannot certify Library or shared-copy purge. No new erasure participant is introduced.

No queue, budget, timeout, P reservation class or fixed-topology scan is added. Default existing WorkModule must
schedule finite retained preparation through bounded resumable steps; admission can remain pending/unavailable
until complete. The fixed 4096-home layout gives no page/request permission to enumerate homes. Exact native
SQL/bytes/row coefficients, owner integration and default-worker progress remain required runtime evidence.

## Smallest Store change and primary evidence

`identity-epoch-store.ts:admit` currently writes a pending job/control/groups directly;
`admitBoundIdentityEpoch` in `identity-epoch-admission.ts` currently calls `acquire.sql` during first preparation
and has an immediate colocated promotion path. Native `acquire_identity_epoch_admission` writes group/control
pending fields; `identity-epoch-admission-promote.sql` checks only planned acquired receipts. These are the exact
places to split PREPARE reservation from claim and require the new pre-arm seal before any pending write.
`stepIdentityEpochAdmission` must advance retained enrollment/custody before claims, then final promotion;
`identity-epoch-binding.ts` keeps its original immutable binding and authorization-before-replay behavior.

Keep all existing public callable/intent signatures. `prepareAdmission(pool, authority, input)` still returns
durable preparation, never a successful operation. `admit(tx, input)` can consume an already custodied sealed
plan, or a genuinely bounded colocated empty-directory proof; otherwise it must report retryable unavailability
and the pool-level caller uses preparation after releasing its transaction. It cannot synchronously fan out or
open foreign homes. Public callers wait for actual admission/publication at their existing boundaries. Internal
pre-arm receiving receipts have a distinct preparation purpose; they are not admitted effect receipts or mapping/
participant ACKs. The Source owner supplies that native internal producer; the current provisional `arm` adapter
and receiving selection alone do not supply it. No public Source method or new user authority is inferred.

The design follows these inspected primary sources, read 2026-10-31:

- Retained PostgreSQL source at `library-shelf-maintenance/postgres`, revision
  `0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89` (REL_19_RC1, PostgreSQL License), read with `git show`:
  [`GetTransactionSnapshot`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/utils/time/snapmgr.c#L278)
  retains the transaction snapshot in RR/Serializable;
  [`ExecLockRows`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/executor/nodeLockRows.c#L181)
  uses tuple locking and raises serialization failure on concurrent changes under transaction snapshots.
  Therefore a locked common gate plus whole-command retry is required; an old directory snapshot is no seal.
- The same revision's [`mvcc.sgml`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/doc/src/sgml/mvcc.sgml#L318)
  and official [isolation documentation](https://www.postgresql.org/docs/19/transaction-iso.html)
  distinguish statement snapshots in RC from fixed RR snapshots. Official
  [row locking](https://www.postgresql.org/docs/19/explicit-locking.html#LOCKING-ROWS)
  explains transaction-scoped row locks; locking returned rows does not guard absent future keys. The explicit
  unique bridge row closes that insertion race across released transactions, without relying on predicate locks
  as a blocking range fence. [`_bt_first`](https://github.com/postgres/postgres/blob/0b8bff042a997fe50fcd1c4c83b9ef1cc9ed8a89/src/backend/access/nbtree/nbtsearch.c#L960)
  supplies the B-tree boundary-key implementation behind the required equality-prefix/keyset access shapes;
  it does not prove any future SQL plan meets its budget.
- Repository sources inspected: `identity-epoch-contract.ts/.md`, Store/admission/binding and their acquire/promote/
  pending/source-hold SQL; command `runCommand`/`fence.sql`; `identity-scope-types.ts`, scoped observations/public
  capture adapters and public Source binding/contract; Library `native-source-custody.ts`, finish/proof SQL and
  `collection-source-native.ts`; `docs/collection-source.md`, `docs/filtered-lists.md` and Library owner requirements.
  Native admission, cutover, home-binding, Source-support and Source-custody cases were read as required proof
  boundaries. Current capture/hold receipts provide provenance, not automatic inverse completeness or pre-arm.

There is no remaining logical visibility conflict with this explicit pre-claim phase. Retaining the old
postcondition “first reservation already commits pending” would contradict the two local probes during delayed
fanout; the split above is necessary. Native feasibility, unchanged page budgets and complete producer/custody
integration remain unproved, not waived or reported as passing by this document.
