# Collection source owner contract

[Filtered lists](filtered-lists.md) owns complete indexed observations, current disclosure, direct/prepared
admission, freshness, useful pages, canonical identity and cost. [Library and Collections](library-and-collections.md),
[Dynamic Collections](dynamic-collections.md) and [Deletion](deletion.md) retain native owner authority. This document
specializes Collection obligations for shared Search/Zone composition, not a new Collection model or filter language.

## Current implementation and superseded scaffolding

The exported `createCollectionSource` factory composes native Collection authorization, source-scoped identity
observations and maintained canonical generations. Preparation and every later call admit current source authority;
positive membership additionally checks current original support and the ordinary original/terminal Subject guards.
Unknown scope, incomplete generations and unavailable public capture return retryable `dependency_unavailable`.

`canonical-source-store.ts` owns indexed successor/group reads, native raw-driver repair checkpoints and complete
publication CAS. The default Library WorkModule binds its existing operational transaction/client and maintenance
queue. Population capture uses `createNativeLibrarySourceCustody`; mapping points only map examined originals.
Semantic's closed `IdentityScopedObservations` declarations are consumed through its real module name. The
provisional producer adapter returns explicit `source_unready` with zero work until its authoritative body lands.
Public output needs Semantic's independent public capture, never a borrowed Library capture. Native useful-page,
whole-query and lifecycle proof remains pending combined integration.
`collection-source-order.ts` owns the data-only raw ordinal declaration. Its native reader
`readNativeCollectionRawOrdinalPage` reads 1–100 raw curated occurrences in actual `(ordinalKey,memberId)` order,
including retained deletion episodes. The frontier settles the last examined raw occurrence even when later
membership/disclosure excludes it; an exact-sized page conservatively needs a later seek to prove exhaustion.
It returns no notes or other retained member payload. These internal rows provide neither canonical uniqueness,
current viewer disclosure nor complete query observations. The caller uses the same Source work allowance and
receipt; complete observations still require the shared native scope producer.

Old exported identity-basis, sealed-repair, alias-window and one-pending-group protocols are superseded list
scaffolding until replacement native acceptance permits removal. The universal 256 raw-key ledger, exhaustive
request-time alias recovery, repeated home sweeps and final leaf replay are no longer list requirements. Existing
code and frozen tests are unchanged by this prose adoption. Native batch, byte/string and cursor limits keep their
independent units and scope. The scoped observation ABI is selected in `semantic/identity-scope-types.ts`; raw ordinal data retains the callable below.

## Raw native ordinal callable

[`collection-source-order.ts`](../services/kernel/src/library/collection-source-order.ts) owns the exported
`NativeOrdinalKey`, `NativeOrdinalFrontier`, `NativeOrdinalRow`, `RawOrdinalCollectionPrefix` and
`ReadRawOrdinalCollectionPrefix` aliases. `CollectionSource.readRawOrdinalPrefix(input)` accepts the existing
`CollectionSourceCall` plus `after: NativeOrdinalKey | null` and integer `limit` from 1 through 100 raw native rows.
It returns `Promise<RawOrdinalCollectionPrefix>` with kind `raw_curated_ordinal_prefix`, readonly native rows,
frontier, raw exhaustion, and the existing `CollectionSourceObservation` and `WorkReceipt`.

The key aliases the actual `MemberPage.after` tuple `(ordinalKey, memberId)`. Rows pick the actual member's
`memberId`, `subjectId`, `ordinalKey`, `deletionId`, `deletedAt` and `memberRevision`, preserving their optionality.
The frontier records actual raw progress, including deleted and excluded rows. Raw exhaustion does not establish
canonical uniqueness, disclosed-result completeness, or current source/identity readiness. The existing shared
`WorkAllowance`/`WorkReceipt` budget is charged before filtering; full excluded/order/population observations and
current original, terminal and canonical semantics remain mandatory.

This is an internal owner primitive for preparation's already adopted `id | ordinal` ordering and canonical
identity, not a new public sort, filter engine or retained mechanism. Consumers alias these owner types without a
reverse dependency. The factory's new method uses the same explicit `dependency_unavailable` implementation;
this declaration adds no execution, native evidence or readiness.

## Existing-owner native capture and custody

[`native-source-custody.ts`](../services/kernel/src/library/native-source-custody.ts) is the closed lower
Library seam. `createNativeLibrarySourceCustody({pool, clock?})` exports these exact calls:

- `capturePage({identity, frontier, limit, allowance, deadline})` returns `pending` with raw dependency rows,
  a persisted `NativeSourceFrontier` and work, or typed `unavailable`.
- `finishCapture({identity, frontier, allowance, deadline})` returns `complete` with opaque
  `NativeSourceCapture` and work only after the native receipt transaction commits, or `unavailable`.
- `readAndHold({client, at, identity, captureId, holdId, allowance, deadline})` returns `held` with opaque
  `NativeSourceCustody` and work, or `unavailable`. `client` is the actual Core `CommandTransaction` query
  capability, including its private live attempt registration, or the actual same-home live
  `OperationalTransaction` in work-step mode with its exact single owning account and installed pool. `at` is
  the live attempt's `AuthoritativeTime`. No cast or structural client creates that registration.
- `revalidateHold({client, at, identity, captureId, holdId, allowance, deadline})` has exactly the
  `readAndHold` input and result types. It verifies only already committed retained custody for that exact
  binding; later Source generations or writer counters do not grant a fresh read or invalidate that custody.
- `releaseHold({client, at, identity, captureId, holdId, allowance, deadline})` returns `released` with
  work, or `unavailable`. Releasing the same real hold again is idempotent under its exact owner fences.

`NativeSourceIdentity` contains `route`, `collectionId`, `accountId`, native `incarnation`, source
`generation`, `scope`, `ownerEpoch`, `receivingEpoch` and `effectKey`.
The ordinary `curated` and `private_builtin` variants are unchanged. Commerce and Semantic consumers may use the
additional exact variant `{scope:'active_explicit_output', outputGeneration:string,
publicationTransactionId:string, publicationPosition:string}` with all of those common fields. The account is the
actual current curator, never an Account synthesized from a Collection ID. Output generation is a native UUID;
publication transaction and positive position identify the native publication receipt and its same-transaction
Core write basis. The owner rereads native xid, selected head, exact member count and source/writer fences; these
locator fields do not certify completeness. No consumer type or public-catalogue capture is imported by the owner.
This variant covers active curator-owned output only. Frozen output after curator removal still needs an exact
existing ownership binding from Semantic/Commerce; it remains explicitly unavailable and retains public custody.
These are lookup hints, never evidence or admission. Receiving owns the meaning/currentness of its epoch and
planned/accepted record; the native seam requires exact equality to the committed capture's binding.
`NativeSourceCaptureWork` carries the existing `WorkAllowance` and unchanged absolute deadline. Every result,
including insufficient allowance and missing evidence, carries the consumed `WorkReceipt`.

The native incarnation is the existing Collection ID plus its exact native creation epoch, as used by native
metadata. A capture is bound to the active Collection, its native curator, the active unfenced account and the
current active, unmoved partition epoch. Source and account must occupy that same native partition; this seam
cannot promise a cross-owner hold. Ordinary caller/source/subject authorization remains with the consumer's
existing Access boundary. Neither these metadata nor a successful custody read grant disclosure permission.

A raw page scans at most 100 native rows, before eligibility filtering. Its frontier contains the capture ID,
actual driver, native `after` and stable `tie`, current session parent where needed, total `scanned` and persisted
`version`. The owner verifies every frontier field before advancing it. Curated occurrence order uses native
ordinal plus member ID, including retained occurrences. Other ranges cover live and retained entries, personal
labels, every assignment (including excluded/unreserved assignments), sessions and their unit/change children,
copies including retained copies, and account-owned published logs. Active explicit-output capture instead starts
at the output driver and scans only `(route,collection_id,output_generation,subject_id)` in native UUID order.
It visits every selected original, including originals a consumer later excludes, without scanning private inputs.
The persisted scanned total must equal the receipt's exact expected native member count before finalization or a
fresh hold; native tuple exhaustion alone or caller counts cannot establish a complete empty capture. Child pages stay anchored to one already
scanned native session; they never search other owners to discover dependencies. Publication tombstones without
an account or subject carry no dependency. No subject normalization or eligibility classifier runs here.

`native_source_fence` holds only route-leading native writer counters. Every insert/update/delete of these
owner rows, including raw reorder/rebalance, retained deletion/restoration, Collection activation and participant
writes, advances the corresponding control in that same transaction. Direct native `fact_source_head` writes, including
final writer barriers and migration/participant changes, advance the same account control. Session child writes fence their native
parent account. Account lifecycle/authentication-floor writes also advance that account control, including
transient suspension and restoration between pages. Capture pages compare both Collection and account controls; finalization repeats the checks under
native shared row locks. The final receipt increments the actual active Core partition fence and commits with the
completed frontier. Consumption rereads the receipt and capture, verifies their same-transaction native provenance
and current owner position/epoch, and refuses a receipt from the consuming transaction itself.

`readAndHold` retains native partition, account, source and writer-control locks on the receiving command's own
client through adoption. No connection or callback crosses an owner checkout, and no process-local token or lock
establishes durable proof. The hold locator references only that committed native custody. Releasing it changes
only hold metadata, preserving facts, shared history and receipt provenance. An intervening native fact change
invalidates fresh capture/holding; it does not give this seam authority to withdraw or purge a public destination, or
acknowledge destination disposition. Releasing an existing hold tolerates later fact/source generations while
requiring its original capture binding, source incarnation/ownership and current owner/account fences, including the exact deleted source and actual terminal erasure scope.

`revalidateHold` rereads that exact capture, its committed same-transaction receipt and the already committed,
unreleased hold on the live receiving command client. It never inserts, recreates or updates custody. All original
identity, scope, generation, owner/receiving epoch and effect keys must still match the retained capture; current
source incarnation, ownership and partition must still apply. The account must be active and unfenced, or have
the actual terminal erasure obligation; the exact source may already be deleted. This retained-only exception
allows revalidation/release, never fresh reading or holding. Source generation and
Collection/account writer counters may have advanced. An absent, altered, released or differently controlled hold
is unavailable, as is a hold newly written by the consuming command. The returned opaque custody retains the old
binding: it grants no fresh Source read, complete/current observation, publication, permission, byte access, new
admission or ordinary purge authority. Each lookup uses bounded indexed native points and the original work
allowance and deadline. There is no cross-partition transfer or destination acknowledgement authority here.

Active curator-owned public/unlisted saved-dynamic output uses `active_explicit_output`. Native metadata exposes
`outputPublication: CollectionOutputPublication | null` with `generation`, `transactionId`, `position`, `nativeXid`,
`sourceGeneration`, `memberFence` and `members` (all strings). The selected COMPLETE head, its source generation,
immutable publication receipt and actual same-transaction Core `editorial.write_basis` must agree on reread.
The receipt's source writer fence must equal the current native Collection control; a restored head or unchanged
caller metadata cannot hide an intervening writer. A build also retains and checks its actual curator at every append and completion.
The publication hook uses Core's live command callback and executor transaction ID; a deferred native constraint
requires the actual Core fence/basis at commit, including same native xid provenance. It copies no request body,
private criteria, pins or author-approval JSON. Its source incarnation and actual curator are retained explicitly.

Native membership triggers maintain a separate exact row count and member fence; COMPLETE compares these with
its bounded append checkpoint and declared expected count. Changes to selected rows, keys or the head invalidate
the publication proof and advance native Collection controls. Pending B does not replace or fence unchanged A.
Every capture page and its committed final fence rereads current publication proof. Releasing/revalidating an
already held capture still uses the original retained receipt, allowing later selection/visibility changes without
new reading authority. Ordinary curated/private-built-in source paths retain their existing drivers.

Missing, pending, cancelled, stale or forged output remains unavailable. Historical output without this real
publication receipt is preserved without invented provenance. Frozen output after account T/curator minimization
still has no selected exact native ownership binding: capture remains unavailable and original output/header/
publication custody is retained pending Semantic/Commerce ownership and destination disposition. The published-log
range and Semantic public catalogue capture are never borrowed as output authority. Cross-partition owner holds
also remain unavailable. This seam imports no identity receiving,
scoped observation, coordinator, canonical Source store or Library participant. Scoped protocols and canonical
Source remain separate authorities. Export presence and local compilation do not establish native physical-plan,
full-row payload, acceptance, integration or main readiness; those proofs are deferred to controller checks.

## Native capture retirement

`createNativeLibrarySourceCustody().retireCapture` takes the existing `allowance` and absolute `deadline`, a live
Core `CommandTransaction` as `client` and its matching `AuthoritativeTime` as `at`, exact `identity` and `captureId`,
and the current `sourceGeneration`. Its closed `episode` is either
`{kind:'deleted', deletionId, revision, purgeAfter}` or `{kind:'terminal'}`. The latter requires the actual current
native account erasure obligation; the former requires the exact deleted Collection episode and its original
720-hour deadline at command T. Values are lookup hints, never authority. Active-source repair is refused.

The result is `retired` or `progress` with `removed`, `blocked` with `live_hold`, `release_uncommitted`, `source`
or `public_custody`, or the existing typed `unavailable`; every result carries the actual `WorkReceipt`. None
means readable, permitted, ready or erased at a destination. Unreleased holds survive generation changes. Only
native releases committed before this command can be removed. Retirement deletes bounded released holds, then
the receipt and capture, under current partition/account/Collection/control locks. Never-public private/unlisted
due cleanup and the existing terminal owned-graph runner consume this operation before deleting local children.
Every retained explicit-output generation (including building, cancelled and superseded copies), its publication
receipt and public history remain retained pending actual Source and ordinary destination disposition. Existing
account probes enumerate output and publication owner indexes even after curator minimization; child-family
entries describe FK obligations, not independently observed rows or global no-data. Native source/control release
guards and ordinary/terminal Collection cleanup preserve these roots.
There is no new public endpoint, scheduler, shared custody wakeup or participant acknowledgement.

## Authority and source selection

One Library owner selects the same native truth:

| Source                        | Membership authority                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| Curated                       | Native Collection and occurrence truth, never reverse public listing or counts               |
| Private built-in              | Authorized owner's native state/label/session/holding facts and accepted pins                |
| Public/unlisted dynamic       | Actual complete published output, never live private predicate evaluation for another reader |
| Frozen eligible public output | Last completely published generation retained under the same Collection ID                   |

Preserve stored subject and occurrence IDs, ordinals, notes, personal-fact keys and pins. Canonical browsing shows
one card per canonical subject; editing preserves occurrences and multiplicity, including `[x,y,x]`. Raw ordinal or
stored-ID paging remains an owner primitive, not a canonical prefix or proof of filtered-page completeness.
Catalogue predicates use the one released grammar with shared datatype/unit/same-statement qualifier and unknown
semantics. Private facts stay in the owner's PostgreSQL partition and never enter public Search or a holder directory.

Authorize the current source before candidate work, through ordinary native resource eligibility and grants.
Unknown, deleted, unreadable private and denied sources remain concealed `not_found`, with no metadata/candidate
leak. Essential unavailable evidence is preparation/readiness, not a false empty source or silently omitted mount.
Known unreadable mounts disclose no ID, label, description, count, source position or cursor-visible metadata.
Suspension advances the authentication floor and fences existing sessions before revocation. A pre-suspension bearer
is rejected before any Source actor is created with HTTP 401 `invalid_credentials` and
`WWW-Authenticate: Bearer error="invalid_token"`; revoked credentials also use 401 where required. Auth issues no
valid native suspended bearer: correct-password sign-in returns 403 `ACCOUNT_SUSPENDED` without a session, while a
wrong password remains ordinary 401. Kernel's verified-suspended 403 `account_suspended` branch is defensive only,
not a native fixture persona. Do not substitute anonymous access for a suspended bearer.
Authentication follows [the owner admission boundary](library-owner-queries.md#viewer-self-binding-and-admission):
pre-suspension bearers are invalid credentials before routing, never valid suspended-bearer fixtures or anonymous fallback.

Every later call reauthorizes actor and source and checks actual current original AND terminal eligibility,
Access, consent, foreign targets and tuple fences. A Zone mount, terminal grant, prepared handle, indexed row or
earlier witness cannot replace these checks. Native read time is supplied by the actual owner/Core boundary,
not a client date or fabricated cast. Owners release a partition transaction before visiting another partition;
this does not promise a simultaneous cross-owner snapshot at network delivery.

## Scoped subject-search integration

[Owner consumer requirements](library-owner-queries.md#scoped-subject-search-consumption-required-runtime-pending)
adopt Library/Collection conditions in existing `subject.search`, without another source or interpreter.
The sole [Search conditions](search-conditions.md) authority covers universal mixed-kind requests; existing
`subjects:search` is its first producer. Integrate actual delivered shared grammar and source producers. Manual membership is eligible canonical occurrence EXISTS, including subjects
absent Everything; own private dynamics use native facts/pins, other readers complete authorized published output.
Authorize every resource even under true OR/NOT before candidates. The exact one-Library-scope preparation rule,
Everything basis equivalence, missing verified/logical-owner bridges and native text/Cost obligations are in that
owner section; generic prepared-plan vocabulary below grants no wider request-time operational permission.

## Admitted access and publication

Admission covers filter + Collection source + order. Commerce owns direct owner index and prepared owner result
plans; public result plans compose with Search under the shared contract. These are responsibility names, not new
executable discriminants. Use page-derived bounded indexed seeks; otherwise retain bounded preparation on existing
infrastructure, with finite progress, quota and expiry; otherwise reject 422 before enumeration. Typed parameterized
ranges/qualifiers may execute shared semantics. Neither a LIMIT nor a small result bounds examined engine work.

Successful pages fill the requested size or prove genuine final exhaustion. Sparse matches behind many nonmatches
must reach useful output after finite preparation. If admitted work cannot establish a useful page, return explicit
preparation/readiness; do not expose short/empty success chains over rejected raw windows. Unknown remains unknown
under NOT. A failed old positive is not complete negative evidence, and a stored-ID point miss is not canonical
absence. No fabricated Search Hit or Collection-local Boolean interpreter supplies evidence.

Public dynamic output discloses a subject selection, not private facts/predicates. Private changes that leave
published output unchanged cannot alter public fields, counts or cursor bases. Owner writes are reflected on the
owner's next read. Catalogue membership uses the shared 60-second healthy target and readiness beyond five minutes
of actual source-to-searchable lag; privacy reduction has no lag allowance.

Current candidate checks are necessary but insufficient. Query-level privacy invalidation/acknowledgement must also
cover exclusion, order, fields, source metadata and cursor-visible information. Local reductions invalidate public
use in the authoritative transaction. Foreign source-fence, target, consent and Collection reductions invalidate
affected use immediately. Acknowledgement covers actual refresh-visible repair including dependent foreign repair.
Observe safety before execution and revalidate before disclosure; unsafe, changed, missing or pending state means
preparation/readiness. A checkpoint, local security revision, complete ordinary generation, returned-ID check or
omitted count cannot certify safety. This is an abstract seam, not a certificate store or safety-token ABI.

A withheld harem tag cannot affect NOT harem exclusion or order merely because the returned subjects pass Access.
Paused-indexer negative/order/count cases remain preparing until local and all affected foreign repair are
acknowledged. Unsafe engine totals/facet counts over unchecked populations are omitted, with no approximate/as_of
exemption and no zero/row-length fallback.

At terminal account deletion, only eligible active public contributions and completed public generations survive
with de-identified attribution. Completed A survives pending B; never evaluate private facts to manufacture output
at deletion. Private/unlisted/deleted data and published reading logs do not survive. Durable freeze/revoke and
bounded cleanup handoff cannot wait for consumers; stale delivery cannot resurrect withdrawn output or facts.
[Deletion](deletion.md) and the native owner contracts own erasure, individual restore and takedown policy.

## Canonical access and continuation

Use maintained canonical-ID indexes and unique prepared result rows. One public terminal document is maintained by
Search; Commerce canonical access retains actual original support for current disclosure. Stored `[a,c,z]` with
`a → z` cannot be normalized after paging to certify canonical `[c,z]`. Dedup within a page alone cannot establish
cross-page uniqueness. An arbitrary representative cannot discard the only eligible original of a large group.

[Semantic identity](../services/kernel/src/semantic/README.md#identity) owns the durable job and scoped concurrent publication. Disjoint changed-group sets may proceed concurrently;
only overlap is busy. Admission/publication/cursor currentness cover the ACTUAL source and its COMPLETE dependencies,
including excluded and order originals. There is no global active marker or universal page gate: unrelated identity
work cannot stall a finite unchanged source. Publish only direct redirects to active terminals after complete fixed
mapping/Search/ALL-Library maintenance; use the actual native control and mapping declarations without a local epoch
or capacity substitute. Relevant pending work returns readiness; changed relevant bases restart cursors. No request-time 4,096-home sweep or exhaustive alias walk is required. Bounded preparation
and maintained access must support listing and direct targets when only the last original is eligible, and complete
negative outcomes on finite ready input. Stored personal originals, notes, copies/sessions and occurrence IDs remain.

Unmaterialized PRIVATE state-view presentation chooses the lexicographically smallest CURRENTLY SUPPORTED immutable
release digest CONTAINING THAT STATE. Digest order is neither chronology nor compatibility. Discovery unions
supported sibling state identities; facts retain their own accepted pins/meaning. Materialized headers and public
complete generations keep fixed accepted meaning; owner rename wins. Support/reader selection must use indexed
seeks, never all-release/history scans. This is presentation policy, not a replacement native fact authority or ABI.

Keep existing cursor ownership and `encodeListCursor`/`decodeListCursor`. GET retains its default limits/policy;
Zone POST uses the Search profile for all viewers. Stable route/viewer/request binding is authenticated; mutable
meaning/source/generation/epoch bases remain in the encrypted position. Reauthorize every continuation. Unusable
Zone POST progress starts fresh current authorization, rather than treating stale progress as permission.
Direct Zone targets share the existing optional cursor query transport: complete common page 200, retained
preparation 202 `{next}` private/no-store, or unavailable/no-progress 503 Problem + Retry-After without cursor.
No partial document or new HTTP schema. Web follows at most four 202 steps then retains continuation on a
private/no-store preparing page. Progress is retained preparation, not cached authority or endless final-leaf replay.

## Native delivery and acceptance

The actual factory, owner indexes, preparation, built-in discovery/materialization, complete public activation,
freeze/revoke, identity-epoch participation and default worker integration remain required. The Zone resource
substrate is integrated; actual membership/page/default execution and Zone-specific withholding/purge/account/
scheduler work are incomplete. Typed schemas, immutable loaders, cursor capacity and helper setup prove none of
those native outcomes. Old proof reports remain evidence, not gates for the replacement architecture.

Use the [shared acceptance matrix](filtered-lists.md#shared-acceptance-matrix): harem light novels, Book
wordCount > 1,000,000 (exact threshold and absent count excluded), and combined, in public Zone/Collection, own library and
own library with own state. Reviewed released Concepts, words versus characters and source mappings remain producer
prerequisites, not invented identifiers here. Also cover owner-only NOT state X including no entry, same-statement
qualifiers/units, compact/expanded conformance, two-release pins, current grant/source/fact revocation, foreign repair,
sparse matches, crash/replay, canonical cross-page order, last-eligible-original direct targets, epoch readiness and
native cursor restart/session/cache. Full persona/API/default/growth and unrelated owner acceptance remain required.

## Bulk selection capture and confirmation

Commerce decision L2 supersedes the cross-home confirmation-cut protocol. An explicit selection or admitted
indexed filter yields at most 1,000 exact targets, each written once to installed `library.bulk_target` rows.
Read no more than the first 1,001 matching targets; a larger population refuses preview and asks the user to narrow
the selection. The source uses its existing direct or ready-result reader and current disclosure checks. This
adds neither a new Members preparation protocol nor public-source access.

Confirmation changes the native operation state and executes only persisted target rows. It never reruns the
filter, validates the entire population at a common cross-home cut, or adds later arrivals. Each native effect
checks its captured entry or occurrence revision/incarnation atomically. A changed target receives
`conflict/revision_mismatch`, displayed as “Changed since preview; skipped”; the remaining targets continue.
Current authorization remains mandatory for preview, confirmation, effects and recovered results.

Decision: explicit subject targets are canonical and unique; occurrence selections preserve each selected member,
including duplicate subjects, and retain the occurrence revision. Persist only action/filter provenance in the
operation header; the target rows are the sole membership manifest.

The [bulk owner contract](../services/kernel/src/library/bulk-contract.md) owns persistence and delivery.
Preparation keeps its existing native implementation. Account erasure remains composed through Accounts 27af;
this operation does not grant an alternative erasure or disclosure path.

## Cost

Keep the existing direct, preparation, page, backend and raw-100-key ceilings, actual one-connection placement
and each invocation's original frame and deadline. The comparison normalizes local vectors as
`(candidateKeys, identityMetadataRows, nativeRows, nativePoints, witnessKeys, statements, bytes, emptySeeks)`.
Local query prices from the reports remain query-specific and are not complete callable quotes. The Semantic
guard subtotal `(0,14,112,14,0,4,2124544+sumQ,4)` is local only; two such sequences reserve `4249088+sumQ`
bytes, already exceeding 4 MiB by 54784 before SQL/argument and nested-work bytes. The old mapper's 8 statements per original exceeds
preparation's 16 at three originals. Sweeping 4096 privacy homes twice is 8192 rows, conflicting with
`64+2(behind+changed)` when behind and changed are zero; complete indexed coverage is required. These are
conditional composition conflicts, not whole-call prices. Inclusive whole-call and numeric remaining costs
remain unavailable, including for empty capture.

For each original finite invocation `f`, `R_f = A_f - sum_j V_fj` componentwise in that same invocation.
Before dispatch, debit all query, engine, child, control, failed, repeated, rollback, unknown, retention and
erasure work. Do not refund or refill dispatched work, reset the deadline, or create a replacement frame. Also
account for connection and lock placement, examined and buffered work, and peak retained bytes beyond this
projection.

#### Capture construction and bounded page adoption

- **Touches:** Complete population and predicate inputs, negative/NOT/exclusion/order and identity/meaning/
  foreign/privacy dependencies; finite raw frontiers, old/new repair, canonical results, real occurrences,
  expectation witnesses, immutable page transfer, equality/checkpoint/ACK and retained-copy locators.
- **Bound:** Charge every query, empty seek, miss, alias, duplicate, tombstone, lookahead, repair, failed attempt,
  child/control operation and retained byte to the original allowance before dispatch. Preserve the applicable
  raw-key limit of 100, preparation and page limits, one connection per backend and the original deadline.
  No available whole-capture or empty-capture price is implied by a local query subtotal.
- **Growth check:** Owner evidence must show complete positive and negative coverage, new/behind-frontier
  handling, bounded stable pages, empty capture, interrupted repair and exact page ACK at geometric input and
  changed-dependency scales. Missing or unbounded coverage remains unavailable.

#### Confirmation validation and cut

- **Touches:** Restore current authority and validate the whole sealed selection and captured target expectations;
  visit every proven participant home; account for interlock or alternate ordering evidence, pending writers,
  root decision, receipt and exact release/recovery custody.
- **Bound:** Price all home visits and conflicts inside the original confirmation episode and deadline. The
  shared vector, SQL/engine work, connections/locks, child controls and retained evidence all count; local guard
  prices and root counters do not price or prove the complete cut. Numeric inclusive and remaining costs are
  unavailable.
- **Growth check:** Prove that every final writer, including an already-started writer and old snapshot, orders
  against complete participants; pre-cut drift yields no dispatch, later target drift yields exact conflicts,
  and unknown decisions retain interlocks without timeout release or dispatch.

#### Effects, results and retained custody

- **Touches:** Current per-target authorization and exact captured expectations, native mutation and deterministic
  effect/outbox receipt, no-effect and unknown reconciliation, partial outcomes, bounded result reads, and
  owner/due/phase/unfinished/erasure cleanup including shared-history copies.
- **Bound:** Preserve explicit-ID, result-page and backend limits and the same original frame/deadline for each
  invocation. Debit failed/repeated effects, rollback, unknown resolution, retention and erasure with no refund;
  include peak retained bytes and actual lock/connection placement. Deadlines and proof expiry cannot be renewed
  by preview, page, ACK or retry.
- **Growth check:** Verify exact target conflicts and authority stops after the cut, retained completed effects,
  stable replay receipts, bounded partial-result continuation, and finite indexed cleanup as targets, retries,
  unknown outcomes and retained copies grow. This documents obligations; it is not native acceptance evidence.

## Cost

### Direct and ready-result Collection pages

- Touches: named owner/catalogue index seeks, candidates including duplicate/rejected/lookahead rows, current
  Collection/source and original/terminal Access, complete disclosure dependencies, summaries and control/epoch reads.
- Bound: per-plan candidates/keys, native points, examined/removed rows, buffers, statements/connections, bytes,
  backend engine work and output slots. Compose within 16 reads and 128 TOTAL output slots. Each page/step supplies
  the internal cost object and separate shared harness evidence defined in [Filtered lists](filtered-lists.md#cost).
  Owner-native specifications must bind actual counters; no executable counter ABI is invented here.
- Growth check: real API/native first/deep/sparse pages at three geometric scales, all owner pools, unrelated
  history/population and alias/duplicate axes. Performance supplies numeric allowances and captures; old 256-proof
  or constant returned-row checks do not establish replacement acceptance.

### Preparation and canonical maintenance

- Touches: bounded input/frontier/result writes, actual source changes/dependencies, shared durable work/outbox and
  canonical mapping/index changes within the actual source/query dependency scope.
- Bound: each step admits keys/rows/points/bytes/statements/engine operations and retains settled work. Finite total
  work may follow relevant finite input and changed dependencies. No per-built-in witness mirror, whole-account
  synchronous fanout or permission-bearing result. No new service/scheduler.
- Growth check: three-scale native captures, interruption/replay, concurrent privacy reduction and terminal fencing;
  verify complete activation/catch-up and useful pages. Permanent preparing fails.

## Staged owner directory binding

The [owner implementation status](library-owner-queries.md#staged-native-owner-implementation) records the native
structural directory, all four native writer families, bounded bootstrap/parent repair and released pin metadata.
Common Collection callers share `builtin-runtime.ts`; logical empty Everything is read-only and needs no header,
grant or receipt. The general `createCollectionSource` factory remains unavailable. Nonempty common members and
state descriptors refuse readiness/current disclosure until the actual cross-owner publication and whole-query
privacy bindings arrive; source versions and structural candidates are not substitutes.

The adopted [current](research/library-scoped-title-plan-current.md) and
[deep](research/library-scoped-title-plan-deep.md) text-plan direction is finite retained evaluation over ONE
structural owner directory with native facts as authority, without mandatory persistent owner text copies. It is
conditional on actual complete source/provenance, seekable rank, writer-aware registration and current original AND
terminal disclosure. Full `search_text` means labels, aliases AND descriptions using shared parser/analyzer/phrase,
ranking and defaults; title-only narrowing is rejected. This delivery adds no text evaluator and does not close the
full shared Search/owner-query capability, useful-page, cost or native acceptance obligations.
