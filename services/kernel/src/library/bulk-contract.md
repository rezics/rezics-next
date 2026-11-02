# Private library bulk operations

This is the owning native contract for one private Library operation over an admitted explicit or filtered
selection. Prepare, enumerate, capture intentions, seal a complete preview, explicitly confirm, execute exact
independently receipted targets, inspect outcomes, cancel and expire through that same operation. Its sole effect
manifest is `library.bulk_target`; compatible target-home evidence uses `library.bulk_effect`. A fresh preview is
a new operation, never replacement membership under an old confirmation. Execution never reruns selection.

The [bound-selection research](../../../../docs/research/library-bulk-bound-selection.md) supplies the complete
evidence and cross-home race. The earlier [query-bulk research](../../../../docs/research/library-query-bulk.md)
supplies compatible action, receipt and recovery detail. Discovery-time matching alone, no-confirmation delivery
and the closed five-state request are superseded. Shared meaning, admission and lifecycle remain owned by
[Library and Collections](../../../../docs/library-and-collections.md),
[Collection Source](../../../../docs/collection-source.md), [filtered lists](../../../../docs/filtered-lists.md),
[profile consumers](../../../../docs/library-profile-consumers.md) and the [Library module](README.md).

The complete [capture comparison](../../../../docs/research/search-bulk-confirmation-capture.md) and
[independent comparison](../../../../docs/research/search-bulk-confirmation-capture-independent.md) supply evidence
for the conditional finite-preparation direction and its unresolved capture, cut and inclusive cost boundaries.

## Installed source and unavailable runtime

Native common confirmation is unavailable. Complete-population validation bound to the confirmation transition
is missing, and shared Source/filter/Search and identity owners must supply its actual bodies and costs. The temporal rule
below is an adopted requirement, not an installed ABI or proof of feasibility. Preview storage alone cannot enable
confirmation. Existing stopped producers, Source/Kind/identity receiving, creator-sales accounting and physical
custody keep their own contracts; this adoption neither restarts them nor releases an old handle.

- [`bulk-contract.ts`](bulk-contract.ts) declares the old ports and constants. `createBulkStore`,
  `createBulkOperations`, admission, discovery/page commit, occurrence transfer, all four target functions,
  reconciliation/ACK, cancellation, expiry, segments and `registerLibraryBulkWork` literally throw. `BulkOperations`
  has admit/get/outcomes/cancel, without a seal or confirm port. `BulkSource`, `Checkpoint`, `EntryExpectation` and
  occurrence shapes retain proposed high-water/admission-sequence fields, not installed common producers.
- [`bulk-schemas.ts`](bulk-schemas.ts) contains old explicit arrays, state/primaryType query and five-state wire
  schemas. Actual [`EntryState`](entry-model.ts) is `string`. These declarations and their historical schema/HTTP/
  client tests are compatibility work, not implementation of this contract. Exact schema/test amendments belong
  to their owners after shared ABI agreement; this document defines no new exact seal/confirm fields or routes.
- [`20261027114520_library_bulk_targets.sql`](../../db/library/migrations/20261027114520_library_bulk_targets.sql)
  and [`schema.sql`](../../db/library/schema.sql) install `bulk_target` and `bulk_effect`, including ordinal,
  subject/occurrence uniqueness, state/pending and effect-expiry indexes. There is no `library.bulk_operation` DDL.
  [`20261030071949_erasure_owner_keys.sql`](../../db/library/migrations/20261030071949_erasure_owner_keys.sql)
  already installs account-leading target/effect erasure indexes; these are not missing header/late-disposition
  producers.
- [`pageBulkOutcomes`](bulk-outcome-page.ts) is real: an independently authorized caller supplies its source
  repeatable-read client and exact operation-owner proof; one indexed statement fetches at most 21 rows for
  20 outcomes. It does not implement admission, header summary, encrypted wire cursors, receipts or effects.
- [`createCollectionSource`](collection-source.ts) has real prepare, canonical prefix, membership and raw stored/
  ordinal bodies. `CollectionSourceObservation` retains source identity/incarnation/revision/authority, native stamp
  and basis components for identity/query/profile/projection. The stamp is not a cross-page snapshot, and its
  prepared handle is factory-local WeakMap state. Ordinary ready reads support curated/private built-ins; the
  private canonical producer refuses unsupported activated/frozen output rather than certifying it.
- [`owner-filter-plan.ts`](owner-filter-plan.ts), [`owner-filter-native-binding.ts`](owner-filter-native-binding.ts),
  [`owner-filter-native-closure.ts`](owner-filter-native-closure.ts) and
  [`builtin-runtime-query.ts`](builtin-runtime-query.ts) contain native binding, original/fact closure, shared
  Boolean evaluation and scoped identity checks. They prove bounded reads, not a durable whole-selection seal.
- [`members-preparation.ts`](members-preparation.ts) declares an immutable release/filter/id-or-ordinal definition
  and native locator. Reserve/touch/admitStep throw; readWorkDefinition requires genuine same-client admission
  and cannot supply the absent producer. The registered [`members worker`](members-preparation-work.ts) is
  provisional and explicitly fails. No completed-result reader, durable bulk attachment or confirmation binding
  exists. [`ScopeWorkContext`](../search/scope-work-context.ts) keeps exactly three installed roles: members-preparation,
  collection-kind-preparation and collection-publication, each with a live operational transaction and locator.
- [`libraryWorkModule`](work-module.ts) is in [`KERNEL_WORK_MODULES`](../work/modules.ts) and registers maintenance,
  source and provisional members work, but no bulk work. No Library operation routes are mounted by
  [`http/kernel.ts`](../http/kernel.ts); its `bulkRoutes` is Semantic bulk. Default API/worker/client/Web delivery
  remains missing. Extend this existing composition; add no scheduler, worker process, second manifest or export ABI.

The concrete native delivery boundaries distinguish local operands from complete producers. None of these
missing bodies or their whole prices is supplied by selecting the finite-preparation direction.

| Delivery boundary                     | Existing operand and missing body                                                                                                                                                                                                                                                                                                                                                                                                                                              | Inclusive cost still due                                                                                                                                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admission and native operation reader | `admitBulkOperation` and `createBulkStore` throw. Supply the one operation header, owner/phase/due/expiry/erasure indexes, immutable source/meaning/action provenance, authentic native `DurableInitiatorReader` and exact creation commitment.                                                                                                                                                                                                                                | Source and creation-receipt verification, capture, consent/restoration/Access, rate admission, fences/controls/outbox, retained bytes and failures. Capture's zero extra account reads and one delegated assignment seek are local operands, not an admission price.         |
| Canonical result and manifest page    | `discoverBulkPage` and `commitBulkPage` throw; `BulkStore.commitDiscovery` is a declared port without an implemented store. Genuine finite result/reader adoption must verify exact page/source/owner/equality/provenance and atomically commit immutable targets, checkpoint and registered continuation, with real source adoption/ACK.                                                                                                                                      | One candidate multirow insert plus one CAS omits Source/Semantic/Access children, receipt/event/control and equality costs. Include raw, negative, empty and replay work. Page size `k` derives from every remaining coordinate and the original deadline; 100 is a ceiling. |
| Slot and action expectations          | [`readEntry`, `readEntryFact`, `updateEntryState`, `deleteEntry`](entry-store.ts) supply present incarnation/revision operands. A complete indexed non-ABA absent-slot witness and all lifecycle-writer closure remain missing. Relevant expectation writers must stale pre-cut capture even when the desired final value and query membership are unchanged.                                                                                                                  | All writer, present/absent probe, constraint, control, failure/retry/rollback and retained-witness costs. Existing entry CAS is not a complete slot producer.                                                                                                                |
| Actual occurrences                    | `captureCollectionPage` and `acknowledgeOccurrencePage` throw. Native [`collection-store.ts`](collection-store.ts) changes `member_revision` on delete/restore and preserves it on move/note. Complete stable all-occurrence capture, selected-subject probes, negative/behind-frontier/lifecycle coverage and exact page/transfer/adoption/ACK custody remain missing.                                                                                                        | Raw excluded, moved, tombstone, duplicate and replay work, probes, witnesses, verification, transfers and all retained/control copies. Canonical pages are not occurrence pages and cannot supply their price.                                                               |
| Confirmation root and actions         | No complete cut/confirmation body exists. It must bind the operation transition to all complete captured dependencies/expectations on their actual homes. `executeStatusTarget`, `executeLibraryRemovalTarget`, `executeCollectionAddTarget` and `executeCollectionRemoveTarget` throw. Active-add lookup/atomic append, occurrence CAS and all required native writers remain due.                                                                                            | All actual-home/root/fence/receipt/restoration/authority work and writer participation. Existing parent locks and entry CAS do not establish the common cut; its whole price remains unavailable even for zero targets.                                                      |
| Delivery, outcomes and disposal       | `registerLibraryBulkWork`, `runBulkSegment`, `reconcileBulkTarget`, `acknowledgeBulkOutcome`, `cancelBulkPage` and `expireBulkPage` throw. The selected outbox/effect route still needs the source-bound Library event/consumer/continuation, exact original receipt/ACK, currently authorized reads and indexed late-disposition/erasure retirement. Protected post-revocation evidence and terminal abort/no-inflight authority remain unavailable original-owner producers. | `pageBulkOutcomes` is one seek, at most 21 fetched/20 emitted, before authorization/source/cursor/bytes; it is not the whole price. Delivery, unknown/noEffect, retention/minimization and peak overlapping copies remain charged.                                           |

## Four independent bindings

1. **Frozen selection and intentions.** Retain canonical admitted definition bytes, explicit original references,
   canonical subject identities, actual occurrence identities when applicable, immutable action/expectation bytes,
   receipt locators and manifest generation. Never append, replace or re-query into a sealed generation.
2. **Structural, semantic and identity currentness.** Retain source incarnation, filter/order, immutable accepted
   meaning/release, complete original/dependency observations and output/preparation generation. Coverage includes
   exclusion, NOT, order, foreign/privacy dependencies, canonical groups and arrivals behind the frontier. A hash,
   source revision, cursor, complete traversal or positive-ID set alone proves neither completeness nor currentness.
3. **Current admission and disclosure.** Retain provenance and exact source/mount/resource identities, never an allow
   token. Reauthorize source gates, viewer/account lifecycle, original AND terminal subjects, consent, delegation,
   foreign facts and permitted mounted use on every relevant read and attempt. A retained observation grants nothing.
4. **Native target execution.** Freeze exact entry incarnation/revision or a complete absence witness, occurrence
   lifecycle expectation, command/key/digest and target home. Fresh execution needs current action/resource authority,
   current acceptance of new profiled values and exact native CAS. A conflict never redefines selection.

Everything/state selection uses actual accepted `(profileId, stateSetId, stateId)` and immutable release pins.
Historical facts retain their meaning. New status intentions use the actual current native validator, not a
five-state enum, type-name inference, active-head position or legacy/default fallback. Profile/state display labels
are presentation, not identities; a label-only edit need not change membership, though a stricter source fence may stale.
A changed accepting meaning is never silently substituted. Historic clearing and generic curated membership
retain their ordinary profile-independent permissions and semantics.

## Selection, finite preparation and capture

An operation admits either explicit subjects, actual curated member IDs, or one server-admitted source/filter/order
definition. Explicit arrays contain 1–100 IDs before deduplication; subject selections deduplicate canonical subjects
while preserving original references and first occurrence, and occurrence selections deduplicate member IDs.
Canonical subjects and occurrences are different units: `[x,y,x]` has two subjects and three editable occurrences.
Dynamic/built-in sources supply unique subjects, never invented member IDs, notes or added times.

The request is a strict closed object of at most 16 KiB; malformed, mixed or unsupported selections are rejected.
The browser never fetches all matches into a request. Listing layout, current page contents and presentation cursors
do not identify all matches. Admission binds the actual source, shared filter and semantic order together; retained
order dependencies can affect currentness even though a browser layout cannot redefine membership. There is no new
per-identifier cap, population cap or type allowlist; shared representation and request-byte admission still apply.

Consume [`createSearchScopeForService`](../search/service-scope.ts) on the actual registered Search runtime,
CollectionSource and native owner/filter bodies. Search prepare binds released grammar/profile/source/reader/order;
prefix/sourcePrefix enumerate admitted candidates, evaluate supplies current three-valued evidence, and work
receipts settle usage in the same root allowance. `not_proven` is neither a miss nor a target. Canonical Source prefix
coverage is complete before filtering, not proof that every candidate matches. Raw stored rows are not canonical
membership; raw ordinal subject output is not a complete occurrence action manifest.

Admission covers every Boolean leaf and foreign resource, including true OR and NOT branches. `self` is the actual
verified principal, never the curator. A mount grants neither subject access nor owner-private fact access. Existing
native preparation authority covers a viewer-owned Collection or admitted positive own presence; it does not grant
arbitrary mounted/foreign preparation. Unsupported public/frozen/mounted/native-work placement remains unavailable
or rejected before enumeration. Do not use injected services, a reconstructed Actor, fabricated authoritative time,
a cast into another work role or a restored WeakMap handle as a native producer.

The selected direction is conditional genuine finite members preparation plus an explicitly admitted bounded
durable reader through the existing Source/filter/Search and Library preparation owners. Actual supported-placement
reservation, immutable result, reader, restoration, custody, retention and inclusive price bodies are prerequisites.
This selection supplies no result, reader, role, durable ABI or confirmation-cut capability by declaration. No
distinct same-client bulk work role is selected; `ScopeWorkContext` retains its three installed roles. A cast,
forged locator, borrowed kind/publication episode or WeakMap restoration grants no authority. Semantic supplies
the actual scoped original/terminal observation through its normal owner boundary; a committedRevision alone is
not the full observation, and identity revalidation alone is not arbitrary filtered-population confirmation.
Privacy reduction invalidates admission/disclosure immediately; repairing or acknowledging a reduction during a read
cannot rescue its old observation. Missing foreign or original support remains unavailable, never negative evidence.
Native Source captures/holds require their existing same-home live transaction and retain all receiving/retirement
obligations. They confer neither bulk work authority nor permission to borrow another episode's paid foreign source.

Each bounded step re-admits its real episode and settles Source/filter/identity/foreign work. Insert only proven
matches into this manifest. Page ownership, exact retained page/target bytes, checkpoint CAS, counters and native
continuation intent commit atomically on the operation home. Uniqueness collisions require equality and ownership,
not silent omission on conflict. A read interrupted before commit repeats only the unfinished step. A committed
page survives a DBOS checkpoint gap; resume its native frontier instead of restarting from zero.

Native dependency enrollment must precede the first raw range escaping writer serialization. The complete cover
includes empty/new population ranges and behind-frontier arrivals; positives, negatives, NOT, exclusions and order;
foreign/privacy and meaning/release dependencies; and original/terminal identity and canonical support, including
originals outside selected positives. Late enrollment must account for every relevant change since the original
baseline. Selected IDs, a high-water, largest allocated sequence, suffix exhaustion or final-value equality cannot
prove this cover. No admission-sequence/slot-generation field is presumed installed.

Supply an admitted immutable baseline/history or complete dependency-local sticky drift detection with
stale/unavailable disposition, together with lossless committed OLD/NEW native routing. Mutable scans plus changed
anchors cannot reconstruct lost old values. Complete native writer coverage includes already-started writers at
their final commit boundary, identity claim/group/publication/cancellation, source enrollment/late receiving,
support withdrawal/addition, owner/partition movement, repair/ACK and output custody transitions. Coarse global
or account invalidation is not a substitute for complete dependency-local coverage.

The handoff must retain exact result/source/owner/provenance/support/frontier/completion evidence, bounded reading
and real occurrence-facing custody/ACK, with indexed owner/due/phase/unfinished/erasure locators. Repair may finish
the admitted build within its original bounds; after an expectation is captured or preview exposed, relevant drift
remains stale even if values are restored or repair is acknowledged. Never replace that baseline or renew membership.
Eviction preserves separately admitted exact proof custody or makes unfinished work unavailable. Canonical support
neither fabricates nor proves all real occurrences or their lifecycle witnesses. No producer is installed merely
by selecting this direction. Continuous relevant mutation may end stale or expired; it cannot yield truncated
completeness or perpetual fake preparation. Missing, failed, unknown and empty-but-unexhausted work never supplies
a completed zero.

For subject-based removal from a target Collection, bind selected membership to the immutable request/shared
result and transfer bounded exact pages into an indexed target-home selected-subject lookup. Scan the target
Collection once in bounded raw pages, probing that lookup, then transfer every captured real occurrence back into
`bulk_target`. Explicit occurrence selection captures only its IDs. Transfer page/ACK evidence retains exact
operation/selection ownership and bytes, not merely a digest. Release each home before checking out the other;
acknowledge only after matching source adoption. Selected-subject staging is not installed DDL and is not an extra
effect manifest. Only captured occurrences enter executable pending rows for this action.

## Preview, seal and explicit confirmation

Admission is an idempotent native command under current authority. It freezes bounded canonical request bytes,
action, originals and authentic creation provenance, using `captureDurableInitiator` during authorization prepare
and `durableInitiatorCommitment`. Operation header, creation receipt and recoverable continuation intent commit
together; enqueue is never an unprotected post-response action. A private recoverable asynchronous admission
response means durable admission, not completed selection or effects.
Retain the existing structured JSON-encoded quoted UUIDv4 idempotency-key convention, recoverable `202` operation
locator, `422 idempotency_conflict` for changed input under a supported key, concealed `404` for foreign/unknown
operation access and `400 invalid_cursor` for unusable cursors. The old proposed `/v1/libraryOperations` wire shapes
are historical compatibility declarations; exact adapted routes/types await shared owner ABI agreement.

Capture every native action expectation before sealing. Seal only after complete selected-population and occurrence
coverage, current source/meaning/identity/disclosure evidence and immutable target intentions. Retain completion
provenance binding the canonical definition, action, exact targets, cardinalities and ordered digest to committed
native evidence. A digest corroborates those rows; it does not prove their completeness. Compute counts from unique
inserts/terminal transitions, never a GET-time population aggregation. No target effects occur during preparation.

The preview and outcomes are private/no-store. Reauthorize operation and source and validate current disclosure of
every returned field, example and count. Display action, safe confirmed subject/occurrence counts, expiry and useful
preparing/incomplete/stale state. Public candidate totals and internal scanned counters remain private operational
data; a private operation does not declassify unsafe public-query totals. Unknown/incomplete is not zero. Only a
genuinely complete, currently disclosure-safe empty selection can seal zero. Entry-removal copy names its limited
scope and preserves copies, sessions/history, follows and Collection members.

Confirmation is a separate explicit idempotent native command over the exact sealed generation/action binding,
not a new query or replacement client target array. It restores/re-authorizes, checks cancel/expiry and all required
currentness, then binds the confirmation transition, receipt and continuation at the defined cut. Concurrent confirm,
cancel and expiry serialize on the native operation transition so only one generation can dispatch. A stale preview
remains inspectable as stale; it never refreshes into an accepted confirmation. A refresh needs a new operation.

### Exact temporal boundary

All relevant admitted population, meaning, original/terminal identity AND captured target expectation drift before
the confirmation cut makes confirmation stale, with no dispatch. This includes selected entry incarnation/revision,
absent-slot lifecycle witness and captured occurrence lifecycle expectations, as well as exclusion/NOT/order,
foreign/privacy dependencies, canonical groups and behind-frontier arrivals. Missing proof is unavailable, not current.

The missing native producer must bind validation of this complete scope to the confirmation transition across the
actual participating homes. Sequential validations followed by operation-row CAS do not establish the cut: another
home can change an excluded candidate or a captured target after its check, before confirmation commits. A later
check cannot undo an earlier independent effect. Hashes, returned positives, header rereads, RR snapshots and
per-page/target serializable transactions do not close that race. Same-home custody holds are not cross-home locks.
No exported long-lived PostgreSQL snapshot or global gate is selected. A bounded single-home transaction can be a
placement optimization, not a restriction that removes required common cross-home support.

Complete pre-scan dependency cover and durable reading still do not bind validation to that root transition.
Durable writer interlocks, writer tickets, prepared transactions and distributed validation/commit are unselected
proposals, not accepted mechanisms or protocol proofs. Urgent authority writes must remain effective; root unknown
commit/abort/no-inflight disposition, indexed finite dependency overlap/fanout, retention and full original-frame
costs remain unresolved. No new ABI, epoch, global gate, population/version cap or enlarged budget is selected.

Strictly later drift does not expand or re-query the manifest. Exact target conflicts and target-specific denials
are inspectable partial outcomes. Loss of source/account/consent/delegation/gate/resource authority stops remaining
source-wide work. Identity drift cannot reroute an old target to a replacement terminal. Previously committed effects
remain: there is no rollback across independent commands, nor a promise to hold every expectation unchanged through
the first or all effects. An irrelevant outside-source edit need not invalidate selection; stricter existing fences
may conservatively stale. A new target occurrence after capture survives unless independently selected by a new
operation; if that write also changes a relevant pre-cut source/query dependency, it separately stales confirmation.

## Exact native actions

`set_status` uses captured native entry incarnation/revision. Already-desired status is `no_effect` only when those
expectations still match; missing/recreated/changed entries conflict even if their current value equals the desired
state. Creating an absent selected entry uses ordinary `putEntry` profile validation and a complete indexed absence
witness. In particular, explicit absent status needs a writer-maintained slot generation or equally complete native
lifecycle witness changing on create/delete/recreate. Two absence reads, timestamps and revision-one equality cannot
reject ABA. Present entry incarnations exist; the absent-slot producer remains a Library owner decision.

`add_to_collection` selects unique subjects and atomically checks active subject presence plus append under the
ordinary Collection parent lock and current authorization. Present means `no_effect`, even with several duplicates;
absent appends at most one occurrence per subject in this operation. Exact receipt replay precedes a new presence
check. Ordinary intentional duplicates remain allowed, with no subject uniqueness constraint. The installed
`collection_member_subject` index includes tombstones: the native bulk add needs a nonunique active partial lookup
on `(route, collection_id, subject_id, member_id) WHERE deletion_id IS NULL`, or an equally bounded adopted access
path. Failed presence seeks cannot scan deleted duplicate history. Existing `addMember` always appends and cannot
be called unchanged to implement bulk semantics. Retain its current 5,000-member capacity and ordinal allocation/
respacing; a present subject still skips at capacity, while a required append can fail `collection_full`.

`remove_from_collection` removes only captured real occurrences. Subject selection captures every matching occurrence
at a complete stable native boundary before seal; later additions survive. `collection_member.member_revision`
already changes on delete/restore, while note/move preserves it. Capture that lifecycle expectation and active deletion
state and use exact member CAS under the parent lock. Delete/Undo ABA and genuinely missing members conflict.
Reorder/note edits retain identity, and native removal preserves their current values in history with ordinary
reduction events and retention. Existing `removeMember` checks whole Collection revision and its delete SQL lacks
this lifecycle CAS. Replaying one frozen parent revision would conflict with the operation's first deletion;
refreshing it on every target or replaying a subject-wide delete predicate is forbidden.

`remove_from_library` deletes only the entry using exact incarnation/revision and ordinary deletion invariants/events.
Progress sessions/history, copies, follows and Collection members remain. Confirmation says only the library entry
is removed; full erasure is a separate explicit action. Bulk adds no history cascade or payment/benefit right.

## Authority, receipts and crash recovery

All operation access binds the authenticated account, never an actor/account supplied in request data. Foreign and
unknown operations share private not-found behavior. Retain `personal_library`, source/list/effect scopes and target
Collection gates: reads require `library_entry:list`, status uses `library_entry:update`, entry removal uses
`library_entry:delete`, and membership uses `collections`, `collection:update` and installed resource permission.
Additions also require current `subject:read`. Route action catalogue data creates no grant or effect authority.
Current original AND terminal eligibility, foreign resources, mounts and owner lifecycle remain independently checked.

### Authentic native creation and current restoration

During `CommandAuthorization.prepare`, after actual native command admission and before target checkout, use the
[`capture helper`](../access/durable-initiator-capture.ts) as
`captureDurableInitiator(commandAccessContext(context, attempt), actor)`. The actor must be the exact admitted
account object. Capture the original account floor/operator and, for
`requestedBy`, the exact live native assignment transaction and `issued_valid` snapshot at that attempt's T.
Do not reconstruct these observations later.

Commerce owes the immutable native [`DurableInitiatorReader`](../access/durable-initiator.ts):
`(client, operation, time) => Promise<DurableInitiatorRecord | null>`. Its exported `DurableOperationAnchor` is
`{route,id,kind,sourceId}`. Read the actual exact operation and independently verify its immutable native source,
source payload/creation target and `sourceDigest`, including operation/source/transaction equality. Return the
complete exported record: `operation`, `initiatorAccountId`, `actor`, `recordedTransactionId`, `sourceDigest`,
`originalDelegation`, `originalAccount` and `creation` (original command kind, idempotency key, request digest and
target route/id). `BulkStore.readOperation(route, operationId)` has a different signature and evidence contract;
it and the throwing `createBulkStore`/`admitBulkOperation` bodies do not supply this trusted producer.

Native creation authenticates and authorizes normally, committing the immutable operation and actual source/target
binding with its exact account-principal creation receipt. Independently verify that receipt at
`partitionOf(operation.route)` for `initiatorAccountId`, original command kind/key/digest and recorded transaction.
Its `response.durableInitiator` must equal `durableInitiatorCommitment(record)`: lowercase SHA-256 over RFC 8785
canonical JSON of the complete allowlisted record, including creation evidence. The reader verifies the source and
receipt independently; restoration repeats the exact receipt check. Absent, collected/minimized or substitute
operation/source/transaction/receipt evidence and row-shaped callbacks fail closed; no history scan or replacement
can supply it.

Preserve every exported nested key and wire constraint in `DurableInitiatorRecord`, without extra policy/private
fields: lowercase routable UUIDv7/v8 IDs and matching explicit routes; 1–255 non-space printable ASCII operation
kind/command kind/key; exact account actor and initiator equality; 1–1,024 non-space printable ASCII client ID;
positive safe-integer authentication epoch; at most 512 scope tokens of 1–128 non-space printable ASCII characters
excluding quote and backslash; requestedBy null or the exact native `urn:rezics:request:<principal UUID>:<request UUID>`
of at most 128 characters; 64-character lowercase hexadecimal digests; original positive canonical decimal floor
of at most 19 digits and null/routable operator;
null delegation iff requestedBy is null, otherwise its original routable transaction and canonical PostgreSQL
`issued_valid::text` of at most 256 characters. Every nested object has exactly its exported keys, and the complete
record must be cloneable and RFC 8785 canonicalizable. These are installed evidence constraints, not a new field ABI.

Use `createInitiatorRestorer({pool, access, readOperation, readConsent})` with the real native pool/Access, that
operation reader and the actual Auth-owned `CurrentConsentReader`. Each target is one stable native command;
dispatch freezes exact operation/generation/ordinal, target/action/request bytes, target-home receipt locator,
command kind, original key/digest and creation-initiator binding. At every step, retry and receipt replay, call
`restoreInitiator({operation, action, anchor, context}, time)` in `CommandAuthorization.prepare` at the exact current
same-attempt T, before target checkout; release the source first. Independently verify operation/source/creation
commitment, current consent/client chain, active account/fence, original floor/operator/delegation, current resource
anchor and native formula. Recorded scopes intersect current consent; they do not grant authority. Evidence ends
at the earlier caller deadline or existing 1,000 ms lifetime, within the existing 5-second bulk command deadline.
The returned actor is not reusable authority. Missing reader, consent or supported work funding remains unavailable.
A stored Actor, `trustedAccount`, rate receipt or successful enqueue grants no continuing authority.

### Exact authorized receipts and evidence gaps

Authorize before receipt access. An authorized exact replay returns its original status/body before fresh profile/
capability validation or a new membership check; changed input under the same key conflicts. Only a genuinely new
value uses current profile acceptance. Later release activation cannot reinterpret an earlier exact receipt.
Clearing an own historic fact needs its accepted identity/CAS, not a newly supporting profile.

[`runCommand`](../command/command.ts) accepts `receipt-only` only from a real native authorization implementation.
After current authorization it returns an exact authorized stored hit; a miss denies without executing the body.
Digest mismatch conflicts, and minimized response payload raises `CommandResultErasedError`. This is no public
receipt permission. `hasOwnCommandCompletion(tx, receipt)` is narrower: the exact live executor-owned transaction
must have execute authorization, current principal/partition/deadline/keyring and exact key/digest evidence. It
returns a completion boolean, not a response or a replacement for the captured intent's resource policy.

A real target mutation, ordinary domain events, Core receipt and compatible immutable `bulk_effect` evidence share
the target transaction. Core `noEffect` permits no domain writes, events or callbacks, so its body cannot insert
`bulk_effect`, even though that table's outcome union includes no-effect. Separately recording an authorized
no-effect operation outcome requires actual native authorization and exact receipt verification. An unconditional
requirement to insert `bulk_effect` in every target transaction remains unsatisfied for `noEffect`; neither
receipt-only permission nor an invented adapter resolves it. Denial cannot fabricate an authorized receipt.

Neither receipt-only nor completion metadata supplies private evidence-only reconciliation after revocation.
That remains an unavailable original-owner producer requiring the exact captured intention, immutable operation/
source and stable command/principal/key/digest/transaction, permitted terminal classification/receipt fields,
owning-partition lifecycle/erasure fences, expiry, unknown-result custody and complete original-work costs.
Its evidence may settle only that intention: no new effect, restored person authority, denied-viewer receipt
disclosure, success inferred from current state or replacement key follows. Every outcome read independently
authorizes currently.

ACK verifies exact original source/operation/target/request/key/digest/receipt/transaction/outcome equality and
ownership, including resulting member where applicable. One pending/reconciling-to-terminal CAS updates fixed
counters once. A crash after target commit but before DBOS checkpoint or source ACK recovers the exact earlier
receipt, never guesses from current row state or mints a replacement key. Missing/unavailable evidence remains
unknown/reconciling; it is not success, a false denial receipt or an excuse to repeat under a fresh identity.

Target-specific conflict, denial or durable failure lets other authorized targets continue. Source/account/consent/
delegation/Collection authority loss stops new dispatch while retaining earlier effects and unknown accounting.
An operation's own successful writes do not cause selection to be rerun or invalidate its remaining intentions.
Operation-change events use the owning account, membership events the Collection and entry events the account;
event payloads contain no manifest/subject arrays. Any later new event needs its actual registered schema.
Serialization/deadline/overload/partition-fence failures use the existing shared command-step retry policy with the
same key. Retry exhaustion is an operational interruption; resolve exact receipt disposition before classifying a
terminal outcome. A replayed DBOS step result supplies no authority to execute the next command.

## Native storage, work and outcome obligations

Implement the missing header for this operation on the account home, with indexed `(route, operation_id)` lookup,
exact owner/admission key/digest, canonical request/creation receipt commitment, admitted source/preparation and
dependency provenance, immutable seal/confirmation binding, checkpoint/frontiers, fixed counters, cancellation and
absolute deadlines. Supply owner-led lookup, active/due-expiry and account-erasure locators. These are storage
obligations, not an approved exact new field schema. No transaction spans source and target partitions.

Reuse `bulk_target` primary/subject/occurrence uniqueness and operation/state/pending indexes. Freeze action,
expectation and receipt bytes before seal; only outcome/dispatch accounting may change. Bind seal provenance through
an adopted checked root/row relationship, not caller JSON. Decimal ordinals are immutable operation-local keysets,
not mutable Collection order. Reuse `bulk_effect` only for compatible evidence with exact native receipt meaning.
Lock operation transitions and native slot/parent/member targets consistently; retry deadlocks with the same keys.

Use the existing atomic command outbox and registered deterministic effect-delivery route. Domain mutation commits
with the receipt, partition fence and outbox event through [`command/fence.sql`](../command/fence.sql) in the same
command transaction. The registered native page event must bind its actual continuation locator to the
exact immutable operation/page/checkpoint transition, under ordinary authorization and History classification.
Later delivery consumes that committed intent; it neither expands the manifest nor authorizes targets.

[`registerEffects`](../events/effects.ts) uses `effectWorkflowId(envelope, eventSeq, name)`, binding epoch, partition,
position, event sequence and effect name, with `history_event_consumer` admission and `return-existing` durable
effect delivery. `relayEffects` commits admission separately before enqueue; redelivery resolves the same
deterministic identity. DBOS enqueue is not inside the original command transaction. A `NativeEffect` can transfer
custody only through actual durable native storage established by its `admit` body; the `transferred` marker alone
is not continuation storage.

Commerce owns the real registered native event/schema, source-bound consumer and continuation bodies in the
existing `libraryWorkModule` and single kernel worker. Require exact operation/source/page/checkpoint equality,
closed/expired/cancelled dispatch fences, actual affected accounts, erasure locators and idempotent current-authority
target commands. Retain the installed 32-consumer effect fanout ceiling and Source/History custody. These bulk
bodies and their registration remain missing; selecting the existing route installs no bulk callable.

[`enqueueIntent`](../command/operational.ts) accepts only its actual live WeakMap-bound `OperationalTransaction`
and exactly the account set already fenced there. [`enqueueWorkIntent`](../work/client.ts) is the executor-internal
actual-`PoolClient` SDK bridge. A query wrapper or registered command callback acquires neither client nor fences
nor authority. Do not cast `CommandTransaction` to either type; no direct command-to-SDK adapter is selected.
Actual `WorkIntent.input` includes exact fenced `accounts`, alongside operation/route/generation locators; old
`SegmentInput` omits them. Never put target arrays in DBOS input. Retain the `workflows` queue, bounded checkpoints
and at most 100 pages per segment; enqueue success advances no effect counter. Unacknowledged intents recover.
Seek at most 100 pending/reconciling targets by indexed operation ordinal, reducing the batch to its remaining
allowance. Execute serially per operation through the existing queue and yield between commands under the admitted
page deadline; queue concurrency is no permission for unbounded target `Promise.all` or a transaction spanning targets.

Status reads use one fixed header, never manifest counts or arrays. Keep distinct scanned/selected/captured/effect
target counters and `targets = pending + reconciling + applied + no_effect + conflict + denied + failed + cancelled`.
Subject counts are canonical distinct subjects; occurrence counts are real captured occurrences. Direct occurrence
selection does not pretend to have selected subjects or scanned a whole target Collection.

Summary remains absent until selection/capture are complete and every target is terminal. Changed means applied,
unchanged means no-effect; the failed roll-up includes conflict, denial, failure and cancelled targets, whose separate
categories remain inspectable. Completed-with-errors retains partial effects. Cancellation during preparation stays
incomplete without a complete manifest summary. Any unknown target suppresses terminal summary, including after stop
or expiry. Internal fixed counters do not themselves authorize disclosure of private population counts.

Adapt `pageBulkOutcomes` behind independent owner authorization and current field disclosure. It seeks
`bulk_target_pkey` or `bulk_target_state` with exact route/operation/account, at most 21 fetched and 20 emitted rows,
using last emitted ordinal for continuation only with lookahead. State is current at that page's RR snapshot, not a
whole-operation snapshot. Preserve default/max 20 and optional exact state filtering. The outer owner uses existing
`encodeListCursor`/`decodeListCursor`: encrypted route/viewer/operation/filter/page-size binding, no exposed internal
decimal position, and invalid/expired/retired/tampered/mismatched cursors return invalid-cursor. Outcome transitions
do not invalidate the immutable ordinal keyset. These are behavior obligations, not newly mounted HTTP routes.

### Durable rate chunks

Admission uses the ordinary route write budget. Each durable selection, transfer, capture, target or checkpoint
chunk consumes the actual accounts-owned `DurableWriteRateLimiter.spendChunk(context, { operation, index },
'write', units)` authority, exposed by the old bulk `SpendBulkChunk` port. Call it asynchronously in authorization
prepare after current initiator restoration, at the same authoritative time with exactly that restored actor.
Units are 1–100 raw candidates/occurrences/targets, with one for checkpoint-only work; no match-only charging.
The monotonically indexed operation chunk and checkpoint persist together; retries use the same index. Refusal
records no spend and durably waits `retryAfter`; unavailability remains retryable `503`, never denial or zero work.
Release all transactions/connections during the wait. The spend-only ordinary limiter is not a substitute for this
port. Counter-window expiry or UNLOGGED-ledger loss may charge again, but never duplicates effects or logical counts.
Rate chunks grant neither receipt authority nor the still-missing outstanding-operation/byte reservation policy.

## Cancellation, expiry and native custody

Cancellation atomically closes new dispatch at the operation generation, stops between bounded steps, drains exact
in-flight receipts and marks untouched captured targets cancelled in bounded pages. Replays never reopen work.
Cancellation is not rollback or compensation over later edits. No new effect starts before confirm or after closure.

Keep absolute execution 24 hours and results/idempotency 48 hours from admission; confirm, retry, continuation and
preview reads never restart them. Same-key/same-request admission returns the same operation or bounded expired
tombstone during the supported window; changed request conflicts. There is no permanent deduplication promise, new
410 response or timestamp-key scheme. Shared proof expiry/eviction/loss may close preview validity earlier than the
execution horizon. An inspectable manifest does not make expired proof confirmable.

The shared 32-live-result/24-hour-idle preparation policy is not a bulk-manifest quota. Duplicate reservations/retries
and unadmitted bulk reads cannot renew its LRU; only the producer's actual admitted read may touch it. Bulk admission
also needs an owner-approved finite outstanding-operation/byte reservation and minimization policy using real rate
chunks and resource custody. No numeric allocation is selected here. TTL alone cannot bound aggregate retained bytes.

Every target checks absolute execution closure, including a DBOS restart past the deadline. Earlier evidence may
reconcile, but a retained segment cannot reopen effects after expiry or collected source provenance. At results
expiry, indexed child-first cleanup removes only evidence with established disposition, then roots/tombstones after
continuation closure and the supported replay window. Use due/owner indexes, at most 100 charged child keys per step,
durable bounded continuations and exact remote ACKs; no table counts, history scans or new scheduler.

Keep unknown in-flight receipt custody until exact reconciliation or explicit native evidence disposition. Closed
execution cannot justify either indefinite retention or dropping unknowns to claim success. If disposition cannot
fit the results horizon, the owning receipt/retention contract must resolve that conflict before enabling delivery.
DBOS terminal retention does not replace native closure or shared-store minimization.

Terminal account deletion conceals private operation/preview/outcomes immediately and fences all late adoption,
dispatch and resurrection. Join the existing Library erasure graph and native Source/identity custody, preserving
last-complete public A rather than pending/private B where their owners require it. Existing account-leading
target/effect indexes do not supply the account-home target-effect producer locator/late-disposition fence missing
in [`erasure-participant.ts`](erasure-participant.ts). Operation/selection producers need complete owner locators too.
Core receipt/outbox/write-basis, DBOS input/output and other shared histories require exact producer custody and
store-owner minimizer acknowledgements. Do not infer no-data ACK, transplant source, release old physical custody or
declare erasure complete from expiry, a missing parent or a completed workflow.

## Cost

All formulas below are obligations, not measurements or proven native feasibility. Let `N` be relevant raw source
candidates, `M` target-Collection raw members examined, `D` changed dependency/repair keys, `T` frozen effect targets,
`J` selection/capture steps and `E` target attempts including replay. Charge aliases, duplicates, nonmatches,
tombstones, lookahead, empty seeks, failed/repeated work and every child, including identity metadata/witnesses,
Access, locks, rollback, Core receipts/outbox and WorkClient SQL/bytes. No hidden allowance renewal or literal price.

Define `V=(candidateKeys,identityMetadataRows,nativeRows,nativePoints,witnessKeys,statements,bytes,emptySeeks)`.
For each actual original invocation `f`, its remaining allowance is `R_f=A_f-sum_j V_fj` componentwise, where `A_f`
is its original admitted vector and `V_fj` is each dispatched body/child's complete debit. Keep every coordinate
nonnegative under that invocation's original absolute deadline. Reserve complete nested work before dispatch;
charge failure, empty seeks, repeats, rollback, unknown commits and controls. Retain unknown child remainder,
never refund dispatched work or introduce a replacement frame. Summing lifecycle work across admitted invocations
does not refill any invocation. Engine iterator/examined/buffer work, connection/lock tenure and peak retained
copies need separate complete inclusive accounting beyond this vector. Returned-row legacy counters do not quote
inclusive indexed/control/SQL/argument work. Unknown bodies and costs remain unavailable even for zero targets,
never zero or permission to suppress a guard.

### Admission, seal and whole confirmation

- Admission accepts at most 1,000 explicit subject or occurrence IDs and caps the whole request at 64 KiB; that fits an approximately 53 KiB UUID list with room for the command envelope while bounding full query filters.
- Touches: bounded request (1,000 explicit or occurrence IDs/64 KiB), exact authorization/creation/receipt/root/intent and all admitted
  source, meaning, identity, population and captured-expectation dependencies, including excluded/foreign keys.
- Bound: indexed root conditional writes plus actual Core/Access/intent work. Whole confirmation includes the entire
  missing validation-to-confirm primitive across participating homes; it is not O(1) or just a root CAS. Inclusive
  rows/statements/bytes and custody must be admitted before allocation. One checked-out connection per backend,
  sequential cross-home visits; no transaction/connection retained during durable waits.
- Growth check: deferred native first/replay/stale/confirm-cancel-expiry races, complete negative/order/identity
  dependencies and independently growing relevant/unrelated populations. No current test proves the missing cut.

### Creation, restoration and delivery

- Touches: actual admitted account observation, optional native assignment, complete immutable commitment,
  operation/source/creation receipt, current consent/client chain, account/fence/delegation, Access/formula/anchor,
  command outbox, effect admission and continuation/SDK custody.
- Bound: capture reuses admission's account observation with zero extra account reads; delegated capture adds one
  unique assignment seek at T. Hashing is linear in the complete bounded record. These are local facts, not a whole
  callable quote. Full restoration repeats all operation/source/creation verification (including the independent
  receipt check), consent/client chain, account/fence/original floor/operator/delegation and Access/formula/anchor
  costs on each step/retry/replay. Commerce/native/Access/Auth/History/Source/delivery owners owe body-derived
  operation/manifest/outcome/continuation/target and delivery SQL/bytes/children, failure, rollback, finalization and
  minimization aggregates inside the original admitted frame/deadline. No guessed quote, budget, renewal or allowance
  increase follows from a helper's local bound or the chosen route.
- Growth check: deferred exact creation/source substitution and collected evidence, current consent/account/delegation loss,
  receipt hit/miss and no-effect/unknown reconciliation, outbox redelivery, native custody and erasure/minimization;
  include repeated authorization and all nested delivery branches in native growth evidence.

### Selection, capture and manifest pages

- Touches: all raw admitted Source/filter candidates and dependencies, one target-Collection scan with indexed
  selected-subject probes, exact transfer/ACK pages, immutable target inserts, one frontier and continuation.
- Bound: the stronger applicable 100 raw native keys per worker step wins. Derive page size `k` from every remaining
  vector coordinate and the original deadline; 100 is only a ceiling. Proposed manifest SQL is one multirow insert
  plus one root CAS, before Source/Semantic/Access, equality, receipt/event/control and adoption/ACK work, all in
  the existing allowance. Native external anchor probes remain at most 100 per chunk,
  further limited by the shared ledger; this is not a second 100-key allowance. Stable total candidate/capture/repair
  work targets `O(N + M + D)` and target/evidence work `O(T + E)`, with at most one unfinished-step reread per recovery
  and indexed affected-result repair, never full rebuilds after each change. Total SQL sums actual shared calls,
  proposed two manifest statements per page, commands, ACKs, continuation and cleanup.
- Growth check: deferred first/deep/empty/sparse/NOT/alias/duplicate/tombstone/behind-frontier and interrupted steps;
  inspect actual adopted indexes, complete finite coverage and total work, not just returned rows or page duration.

### Shared allowances

- Touches: direct/ready/composed reads and retained preparation through their actual Source/filter/Access reservations.
- Bound: preserve [filtered-list budgets](../../../../docs/filtered-lists.md#budgets): `s <= 100`,
  `c <= min(600, 6s+3)`, three refills, three owner-index/six engine reads, points `16+8c`, examined rows `64+16c`,
  six shared blocks per budgeted examined row, response `16 KiB+4 KiB*c`, request `64 KiB+1 KiB*c` and 12 statements
  for one read/backend. Ready results use at most `2s+2` candidates/two result-index reads. Composed pages keep
  `R <= 16`, 128 total output slots and `8+4R` statements/backend, with existing summed ceilings and complete privacy
  observation inside them. Preparation keeps 1,000 input/result rows, one frontier, eight points/input,
  examined `64+16*input`, 16 statements/backend, four engine reads and 4 MiB response. One connection/backend remains
  shared throughout each admitted operation class; the applicable native raw-100 step limit is still stronger.
  Existing native Source/owner read and work allowances also remain binding. Manifest writes, nested controls,
  identity/foreign work and empty/failure/rollback work spend this same ledger.

  The Semantic direct-output guard local subtotal is `(0,14,112,14,0,4,2124544+Q,4)`, where `Q` is dispatched SQL
  plus serialized argument bytes. Two such sequences reserve `4249088+sumQ` bytes, exceeding 4 MiB (`4194304`) by
  `54784` before nested work. This excludes native holds/output, command/Access/component/event/constraint/control
  and variable non-SQL work; it is a conditional composition refusal, not a complete callable price.

  The old repair mapper reserves 8 statements per original; three originals require 24 against preparation's 16
  before raw/current/mutation work. Sweeping 4096 privacy homes twice costs 8192 logical rows before other work,
  versus the required indexed two-statement `64+2(behind+changed)` subset at zero changed/behind homes. These exact
  refusals require actual better bounded bodies/access paths and complete owner prices. They permit no suppressed
  guard, guessed allowance, population/version cap, additional funding or replacement frame.

- Growth check: deferred shared three-scale native captures, inclusive role attribution and engine iterator work;
  no free witness work, budget reset, private/public fallback or growth waiver follows from this adoption.

### Targets, ACKs, summary and outcomes

- Touches: indexed exact slot/member/parent/receipt/effect points, current authorization, one command and one unique
  source transition; header summary and immutable ordinal/state keysets for outcomes.
- Bound: actual native command/Access/evidence SQL plus one source ACK CAS/counter update. Collection add may require
  ordinary admitted ordinal repair up to current capacity; respacing is not O(1) and cannot evade the step budget.
  Summary uses one fixed header, O(1) rows/statements plus logarithmic index blocks and current admission/disclosure;
  its runtime is missing. Native outcome SQL is one seek, at most 21 rows/20 emitted plus outer authorization/cursor
  work. Receipt reconciliation is by exact key. Bytes include inspected candidate/dependency payloads,
  `T * (admitted target + receipt/evidence bytes)`, transfer and replay, not merely the request body.
- Growth check: existing `services/kernel/test/library/growth-bulk-outcome-page.test.ts`,
  `outcome pages have bounded rows and statements as operation targets grow`, covers first/deep/all-state/exact-state
  pager branches as targets, nonmatches, other operations and owners grow, without planner settings. Existing test
  source proves no full bulk journey. The original `specs/library-bulk-outcomes.test.ts` titles
  `progress is bounded truthful and outcome pagination does not repeat or expose the manifest on summary` and
  `growth axes retain indexed admission replay summary and fixed outcome pages without manifest recounts`
  remain deferred obligations, not measured runtime results. Native growth evidence must retain independent
  256/1,024/4,096 scales, at least one warm-up per measured statement, shared catalogue classification and no planner
  settings, including pending-target/manifest insert and exact receipt/transfer paths beyond this existing pager test.

### Retention, cancellation and erasure

- Touches: native due/owner/child indexes, exact remote evidence disposition, preparation proof custody and shared
  Core/DBOS histories, including abandoned/stale previews and unfinished attempts.
- Bound: at most 100 charged child keys/page, child-before-parent ACK/checkpoints and bounded segments. Durable bytes
  are `O(T * admitted target/evidence bytes + dependency bindings + page frontiers + receipt/work history)`;
  indexed seeks are logarithmic in retained rows. Aggregate horizon bytes also depend on admitted operations/bytes
  and cleanup throughput. Finite outstanding-operation/byte admission and shared minimizers remain missing;
  neither a TTL nor preparation quota proves an aggregate bound. Unknown receipt disposition must be resolved.
- Growth check: deferred independent retained-operation/target/owner/history axes, abandoned preparation, unknown
  receipts, revocation, terminal deletion, late target disposition and shared-owner ACKs. No custody/growth harness
  or measured storage claim is introduced here.

## Acceptance and remaining owner work

Original valid outcome/regression obligations remain: explicit limits/deduplication; more than 100 filtered targets;
bounded sparse/no-match progress; entry ABA/absence/no-effect; current personas/scopes/gates/consent/delegation;
atomic skip-present add, ordinary duplicates, capacity/respacing; exact occurrence removal and later-addition survival;
entry-only deletion preserving independent facts; partial denial; cancellation/incomplete summaries; receipt/ACK/transfer
crash equality; unavailable enqueue/evidence; private not-found; encrypted cursor binding/rotation/expiry; deterministic
chunk spend; absolute expiry/GC and retained-worker non-revival. Their existing test source is not runtime completion.

`specs/library-bulk-outcomes.test.ts` still contains historical discovery-time/high-water assertions. Frozen tests,
schemas and declarations are preserved; superseded assumptions need explicit exact owner amendments before later
implementation admission, not automatic execution, skipped assertions or silent weakening. The old file-by-file
delivery split does not define the new ABI or a ready work queue.

Additional native acceptance is deferred/unimplemented: bound preview and explicit confirmation on curated,
Everything/state and permitted mounted sources; generic released meanings and historic replay; complete NOT/
exclusion/order/foreign/privacy/original-terminal currentness; stable finite capture/behind-frontier repair; all
captured expectation drift before the cut yielding zero dispatch; strictly later exact conflicts/source-wide stops
retaining prior effects; concurrent confirm/cancel/expiry; disclosure-safe counts/unknowns; noEffect evidence
discipline; default native/API/worker/client/Web composition; and complete byte admission/erasure/shared custody.
No exact new seal/confirm schema, test title or measurement is invented pending producer agreement.

The concrete delivery boundaries above remain required. Search/Source and Library preparation owe the complete
finite result/reader and dependency cover; Semantic owes original/terminal/support witnesses, committed OLD/NEW
routing and restoration/retirement. Library owes real slot/occurrence/writer bodies, while Commerce owns their
binding to its actual root cut and immutable action expectations. Core/Accounts/Access/Auth/History/WorkClient
retain current consent/authority, protected evidence/unknown/abort disposition, rate/resource admission and shared
minimizers through their actual owner bodies. Installed capture/restoration and outbox/effect helpers supply
neither these missing producers nor whole-call funding, including for zero targets. The delivery route is selected.
Default routes, worker registration and actual client/Web consumers must complete this one journey after that ABI.
Existing receiving, stopped producer and native erasure obligations remain in force.

Search owns the sole independent complete capture/currentness/cut/cost research pair. The common cross-home cut
remains unavailable; no new ABI, epoch, protocol, proof or source release is selected here.

Specification adoption and source presence do not establish native acceptance or full feature/Goal completion.
The remaining producer agreements, implementation and native/regression evidence are required before delivery;
no automatic admission, restart, source transplant or custody release follows from this contract.
