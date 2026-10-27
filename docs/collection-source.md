# Collection source owner contract

This is a formal native-owner contract and typed interface only. The exported factory in
[`collection-source.ts`](../services/kernel/src/library/collection-source.ts) throws the existing retryable
`ProblemError('dependency_unavailable')` from **every** method. It performs no data query, mutation, identity production,
or readiness simulation. Neither that export nor the outcome driver's interface establishes a functional native driver.
The missing-driver verifier must pass; the native outcomes must remain red until their real prerequisites exist.

Authority remains [Library and Collections](library-and-collections.md), [Dynamic Collections](dynamic-collections.md),
and [Deletion](deletion.md). This contract specializes their internal composition seam; it changes no current Collection
API, occurrence paging, deletion policy, Access formula, profile registry, or public Search behavior.
The complete independent comparisons `zone-union-independent-sol.md` and `zone-union-independent-current.md`, and the
adopted Zone union decision, establish the conditional design, not native implementation evidence.

## Exact ABI and ownership

`createCollectionSource({pool: Pool, access: Access, clock?: KernelClock}): CollectionSource` exports:

| Method                | Input in addition to current context                          | Result                                                  |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `prepare`             | `collectionId`, `allowance`                                   | `{source: PreparedCollectionSource, work: WorkReceipt}` |
| `prefix`              | `source`, `afterSubjectId: string \| null`, `allowance`       | `CanonicalCollectionPrefix`                             |
| `containsSubject`     | `source`, `subjectId`, `allowance`, optional `progress` and `positiveEvidence` witness key | `CollectionSubjectMembership` |
| `readRawStoredPrefix` | `source`, `afterStoredSubjectId: string \| null`, `allowance` | `RawStoredCollectionPrefix`                             |

Current context is **required on every call**: `{actor: Actor, at: AuthoritativeTime, deadline: number}`. Core mints T for
the live native read/attempt. It is not a request-supplied date, a newly constructed object, or a string cast to T.
The deadline is the existing absolute execution deadline. No call extends it. A prepared source, evidence reference,
old stamp or encrypted cursor never carries an allow decision. No network endpoint accepts these internal handles.

One Library owner selects the same native Collection truth, including curated occurrences, legitimate private built-in
facts, complete activated output, and complete frozen output. It preserves **every** stored subject ID, occurrence ID,
ordinal, note, personal-fact key and profile binding. No duplicate private membership/type/cache/Zone query store,
personal-ID rewrite, global reverse holder directory, schema/index migration or production basis engine is approved here.
There is no new public DTO and no fake Search hit for a member.

## Current authorization and native authority

`prepare` describes and authorizes the current Collection on `{route: routeOf(collectionId), id: collectionId}` using the
native Collection public-eligibility and grant paths, current actor/account evidence and Core T **before any candidate
read**. Invalid IDs, unknown/deleted sources, private sources unreadable by that actor and denied sources are the same
concealed `not_found`, without metadata or candidate work. They are not successful empty sources. Unavailable Access,
partition, publication, profile or identity evidence is a distinct retryable dependency/readiness failure, never denial
or a silently omitted mount. A legitimate private owner read remains possible through the ordinary grant path.
Suspended credentials cannot use that private grant path; the existing native public/unlisted read floor still applies,
as specified by `collection-reads.test.ts`. Reauthorization does not introduce a stricter parallel Collection policy.

Every later call rechecks current source/actor and required native subject anchors. Subject checks use the subject's
actual route, original stored identity and terminal identity, including other anchors required by native merge policy.
Collection, Zone, Global Context or terminal-only permission cannot replace those checks. A mount grants nothing.
`ContainsCollectionSubject.positiveEvidence` is an optional trusted witness-key reuse hint, never an allow cache:
each call first reauthorizes the current Collection and rereads current membership, original and terminal subject
evidence at the supplied native T. A failed old witness is not complete negative evidence; continue a bounded fresh
group read or return `not_proven` with real progress/readiness. Positive membership evidence returned by the method
is current evidence, and must be revalidated on current native anchors before disclosure. Cached index presence
cannot restore a revoked source or alias grant. Owners release their transactions before visiting another partition;
this is current evidence per native read, not simultaneous cross-owner authorization at network delivery.

`CollectionSourceObservation` explicitly carries Collection ID, route, actual incarnation reference, current revision,
selected authority, partition stamp, and structural basis. Its authority discriminant is:

- `curated`: the existing Collection/member truth, never the public reverse listing or its count;
- `private_builtin`: authorized curator facts only, using the accepted built-in/profile owner semantics;
- `activated_output`: public/unlisted dynamic reads use the **actual complete activated** subject-set generation;
- `frozen_output`: retained public output uses the last completely published generation under the same Collection ID.

An active public Collection survives terminal account deletion de-identified. Private and unlisted sources become hidden
at terminal T, and bounded native private purge is initiated at T. For an activated unlisted dynamic contribution the
dynamic contract's adopted public output is retained through its native de-identified public freeze, not through the
deleted curator's unlisted/private authority. If that safe native transition is unavailable, fail readiness rather than
expose an old unlisted row. Never-activated output is withdrawn. Deletion durably records terminal freeze/revoke and
cleanup checkpoints without waiting for consumers. Private pending B never substitutes for completely activated A;
the frozen source retains A. Older events cannot resurrect B, private facts or a withdrawn source.

## Structural basis and ordinary observations

`stamp` reuses `ListingStamp {partition, epoch, position: bigint}` and its comparator. Compare epochs/positions only for
the **same partition**. Time, UUID order and cross-partition positions are not a clock. Source facts and their stamp
are observed in the same native authoritative transaction. Ordinary unrelated writes can advance that position without
changing the structural basis; restarting on every such write would prevent traversal.

`basis` contains `digest`, `identity`, `query`, `profilePins`, `projection`. These are commitments/references to the
**actual native** structural identity, admitted query/release meaning, accepted profile pins and projection compatibility.
Profile pins reference only bounded actual query inputs; never discover or copy the account's profile history merely
to construct a basis.
Null/empty means genuinely inapplicable, never unavailable. Digest input also binds source identity/incarnation and
authority selection. The digest is a commitment, not a new meaningRevision, numeric profileRevision, epoch or authority.
An ordinary Collection metadata revision need not change meaning/order. Identity merges, unmerges, repointing or an
incompatible query/profile/projection change invalidate affected canonical continuation with `stale_cursor`.

The shared direction is approved: Semantic owns lightweight terminal identity/readiness, same-home structural
generation updated atomically with redirect/unmerge/repoint, and a fixed-home digest; the Collection store owns derived
canonical access paths and bounded repair. These are implementation prerequisites, not implemented capabilities.
`NativeIdentityBasis = Readonly<{digest: string}>` is exactly assignable from Semantic's actual ready `IdentityBasis`,
without a branded string, constructor, readiness flag or second identity producer. No fabricated epoch/ready flag or
hash of arbitrary partition positions can fill the gap.
Existing `semantic.merge_member` and `moveMergePage` register/repoint members in bounded pages;
they are a foundation, not a Collection canonical-order fence or a bounded authorization representative. The current
`resolveSubject` renders and walks redirects with a visited set; renaming it does not produce a bounded native probe.

## Canonical prefix versus raw stored prefix

`prefix` returns `kind: 'canonical_subject_prefix'`, ascending canonical subject candidates, each with its own opaque
native evidence reference, `coveredThrough`, `exhausted`, observation and receipt. Candidate keys are distinct from
stored evidence keys. Every canonical candidate in `(afterSubjectId, coveredThrough]` must be represented **before**
current residual/subject filtering. Hidden, rejected and unresolved candidates cannot disappear while coverage advances.
Non-exhausted coverage ends at the last represented candidate, never a later fetched tail; an empty non-exhausted
result must not claim progress. Empty exhausted output requires a real bounded exhaustion proof. An exhausted result
also certifies no candidate after its covered prefix. Unprocessed lookahead cannot advance a union watermark.

`readRawStoredPrefix` has `kind: 'raw_stored_subject_prefix'`, `storedSubjectIds`, `storedCoveredThrough`,
`storedExhausted`. It is an explicitly **stored subject-ID order** helper for curated truth, not a normalization API.
Other authority kinds cannot silently reinterpret it. Its output deliberately lacks canonical coverage field names.
Use strict indexed seeks anchored by route and Collection on `collection_member_subject(route,collection_id,subject_id)`:
`subject_id > last ORDER BY subject_id LIMIT 1`. Repeated seeks can skip an equal stored-ID occurrence group without
loading the group. Alternatively fetch at most the raw quota before bounded dedup/filter, with proved coverage.
Every loaded occurrence counts before dedup. Never use `SELECT DISTINCT`/`GROUP BY` then LIMIT as a quota proof,
COUNT/load all 5000 occurrences, public member paging's hidden limit+1/refill, reverse public listing/count proxy,
alias mapping after order, or a holder directory. Native EXPLAIN row/buffer work must demonstrate the seek shape.
The ordinary curated page keeps its ordinal/occurrence ordering and duplicates/notes, including `[x,y,x]`.

Stored `[a,c,z]` with `a -> z` maps to `[z,c,z]`. This raw helper **cannot** certify canonical `[c,z]` order or coverage.
Production canonical access paths require the specified Semantic exports, native current evidence and ready
owner-derived storage.

## Membership, unknowns and large alias groups

`containsSubject` returns `result: true | false | 'not_proven'`, the requested canonical subject ID, exact native
observation/basis and work. True requires current membership and all actual original/terminal Access checks. False
requires complete current negative evidence at that basis. A stored-ID point miss is not canonical absence when
another stored alias can match. Unknown is never false, including under NOT in the existing shared Boolean evaluator.
Collection membership does not implement another filter language. Applicable catalogue residuals must use the real
shared admitted full-Boolean native evaluator; fabricated index hits or root-only permissions are inadmissible.
The optional `positiveEvidence` input can identify a previously discovered witness to recheck first. It cannot skip
current Collection authorization, current membership, or current Access for the stored original and terminal. If the
old witness no longer proves true, it is neither a complete negative nor permission to disclose.

One independent current true OR source can settle a union group despite another unknown source. Otherwise an essential
unknown retains the boundary **before** that group and asks the owning repair/readiness protocol to resolve it. Return
an earlier settled prefix when one exists. With no actual progress, return existing retryable dependency/readiness;
never return unchanged-success-empty cursors, mark EOF, or skip unknown forever. Ordinary definitive rejection may
advance an empty page. Finite completion requires a finite fixed complete candidate/identity basis and finite definitive
native repair; a toy repair queue or permanent `not_proven` proves neither convergence nor completeness.

Critical fixture: 257 distinct stored aliases of one survivor, only the last readable under actual source and survivor
policy. A canonical index or arbitrary representative alone is insufficient. The first bounded call must not spend
over 256, return false/exhausted, or move the canonical boundary beyond that unresolved group. The owner MUST supply
bounded **resumable alias groups**, including the 4096-alias case. A bounded representative is not an alternative.
`containsSubject({..., subjectId, progress?})` returns `not_proven` with `progress: CollectionAliasProgress | null`.
Non-null progress contains exactly `{subjectId, basisDigest, aliasAfter, sourceAfter}`. It binds the pending group and
actual Collection source/structural basis; `aliasAfter` is the last consumed Semantic original key, `sourceAfter` the
last consumed owner occurrence/fact key. A mismatched target is `invalid_cursor`; a valid handoff from another source
or incompatible basis is `stale_cursor`, both before candidate work. Neither key is lookahead. A fetched native alias
window is not a processed window: if its suffix cannot be
fully checked within the allocation, keep `aliasAfter` at the last actually settled original, charge the fetched
suffix, and charge its reread on resume. Never copy the native window `.after` over unchecked originals. Each continuing call
must advance at least one actual keyset, retaining the canonical settled boundary BEFORE this group. Resume within an alias before advancing past it
when its source evidence needs several windows: leave `aliasAfter` before that alias until its evidence is complete,
and resume its source keyset with `sourceAfter`. Re-reading that pending alias is charged again. When its source
keyset is complete, advance `aliasAfter` and clear `sourceAfter` before examining the next alias. The store's source
key must identify its original alias and stable evidence tie-break within the one admitted field. Null means essential
evidence is not ready; use real owner repair,
not a successful unchanged cursor. A completed all-rejected group can return false only with complete current negative
evidence. Positive results recheck current original, terminal and Collection authority at final use; discovery and
progress carry no permissions. Direct target eligibility uses this exact same input/result, so it can recover the
last readable alias rather than permanently 404, scan unboundedly or spin. Late eligibility behind a consumed keyset
requires a fresh traversal.

The canonical prefix's `coveredThrough` certifies candidate discovery, not settled union membership. It may represent
the pending group's candidate without settling it. Zone's committed boundary stays before that group until a true OR
source or complete negatives settle it. Later sources and unused lookahead are reread from the settled floor and
charged again; one deterministic source is resumed at a time. No alias cache, global reverse index, seen set,
personal-ID rewrite, fixed hop cap dropping valid chains, or 32 nested source tokens is admitted.
The source ordinal records completed raw traversal of preceding sources for this pending group, never their cached
permissions. A newly eligible witness behind those completed keysets requires a fresh traversal. Reauthorize current
Collection anchors on every call, and recheck every positive used. The outer digest binds all source descriptors and
their structural compatibility so a changed preceding source cannot silently reuse an old ordinal. Reserve enough
work to probe an independent current true OR source before exhausting the allowance on an unknown source's alias
window; a true witness can settle the group without finishing that other window.

## Work and continuation

`WorkAllowance {reservationId, remaining}` is a caller reservation, not another budget authority. `WorkReceipt` echoes
the reservation and reports `used`. Both use separated dimensions: `candidateKeys`, `emptySeeks`, `nativePoints`,
`witnessKeys`, `statements`, `bytes`, `identityMetadataRows`. Shared Search/Zone ledger integration is a prerequisite;
this module implements no ledger. The caller reserves each dimension before dispatch, subtracts used work, then may
release unused reservation.
Concurrent reservations cannot overlap. Errors also settle actual work through the same caller instrumentation.

All raw duplicates, rejects, lookahead, rereads, alias-member candidates, and **every** internal fact-driver key consume
the aggregate request allowance of **256 candidate keys** across calls/sources. Dedup does not refund work. Quota+1
exhaustion consumes the extra key only if reserved in advance. Indivisible native work must fit every remaining dimension
before starting. Empty seeks, native points, witnesses, statements and bytes have additional finite admitted bounds;
they are not free. Zero/insufficient allocation yields retryable readiness before work; no owner private refill budget.
At most 100 raw keys, INCLUDING internal work and lookahead, are consumed in one owner source window.
Semantic alias windows independently accept limit 1..100 plus a reserved/charged lookahead, so limit 100 may examine
101 keys. Reserve that extra key before dispatch, or request a smaller limit that fits the remaining owner window.
All internal drivers share that window and the supplied allocation. Even a 256-key reservation does not permit an
indivisible 257-alias scan. Preparation may spend metadata points but cannot spend candidates before source authorization. At most 100 public items,
with no full-page promise. Everything's four fact families do not imply one key per emitted subject or four complete
native drivers: retained history, overlaps and aliases must be charged for their actual internal work.

The 256 application-key cap does not bound physical B-tree/MVCC work, OpenSearch postings, buffers or latency. Native
EXPLAIN and three geometric growth scales (each <=4096), first/deep pages at fixed quota, large alias/duplicate/history
runs, statements, actual rows, buffers, bytes and the existing growth classifier are mandatory. No whole-account or
unbounded per-subject history scan, private fact mirror or synchronous all-Collection merge fanout is allowed.

The caller uses existing `tokens/list-cursor.ts` `encodeListCursor`/`decodeListCursor`, unchanged: eight keys, 256 UTF-8
bytes per string, 4096 token characters; anonymous deterministic/timeless and account 15-minute policy; key retirement.
Stable route/viewer/request parameters are AAD. Changing structural basis digest goes **inside encrypted position** and
is compared after decode to distinguish valid stale from invalid/tampered. The shared Semantic handoff fixes exactly
eight `position.after` keys (the enclosing epoch remains the real resource partition epoch):

`[basisDigest, settledCanonicalId, groupId, sourceOrdinal, aliasAfter, sourceAfter, ownerBasisDigest, formatVersion]`

Absent strings are `''`; UUIDs are lowercase canonical text, digests lowercase 64-character hex, source ordinal and
format version safe integers (first format is 1). Source order/descriptors are committed in `basisDigest`, not embedded
as a vector. With a pending group, map `CollectionAliasProgress.subjectId` to `groupId`, `.basisDigest` to
`ownerBasisDigest`, and the two after keys directly; with no pending group clear all group/source fields. The outer
settled floor never changes merely because these two inner keysets advance. A Collection source's identity/incarnation,
authority and meaning must match the decoded owner digest before use. The source store supplies one reviewed native
`sourceAfter` key: `1:<driver>:<storedSubjectUUID>:<factUUID>`, exactly 77 ASCII bytes. Driver ordinals
0..5 mean member, entry, label, session, copy, output respectively. A curated fact UUID is its occurrence ID; other
drivers use their actual native fact/output key. Decode/validate the format, discriminator and canonical lowercase
UUIDs before use, then seek the native columns in canonical/stored-subject/driver/fact order. Encoded-string order
is NOT SQL tuple order. This is one fixed composite, never an arbitrary JSON vector, profile array or another token.
The derived-store owner owns the codec validation and SQL; this specification implements neither. The tuple is a handoff to the existing codec, not a new encoder here.
Work receipts, rejected candidate keys, predicates, profile pins and alias progress never enter public DTO/debug output; only encrypted compact
admitted continuation or server-side evidence can carry them. No local codec, TTL, token store, PIT, session or seen set.
Ordinary mutations retain current-keyset semantics; no cross-page snapshot, exactly-once across identity restarts or
live complete Search recall is promised. Inserts behind the watermark require a fresh traversal.

## Native acceptance and implementation handoff

[`collection-source-driver.ts`](../specs/collection-source-driver.ts) specifies a **real native** driver, not an
implementation. It must use migrated PostgreSQL, actual Auth/Access personas, production Collection/Semantic/Library
commands, accepted Definitions releases and actual publication/repair workers. Inspection/tracing may observe truth,
never compute membership or supply fake Access/policy maps. No in-memory production stub can satisfy the suite.
The outcomes cover the native raw/canonical/built-in/frozen cases, and the pure fixtures check the ABI and throwing
factory. Accepted canonical identity tests stay red until real code exists; no conditional pass, skip or fake ready.

Each following implementation slice is <=400 production lines and <=8 files, independently reviewable. These are
prerequisite-gated slices, not approval to start identity production or touch other owners here.

| Parallel slice                 | Real prerequisites and small landing surface                                                                                                                                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw curated adapter            | Existing `collection-reads.ts` eligibility/account checks and `collection_member_subject`; implement private raw seek SQL, owner wrapper and native EXPLAIN tests. Preserve ordinary reads. <=4 files.                                                                                                      |
| Shared identity owner          | Produce the exact independent terminal, basis/home, alias-window and sealed-repair ports below, with same-home generation/maintenance hooks built on `merges.ts`, `merge-moves.ts`, and `merge_member`. Keep terminal, metadata/hooks, and alias enumeration slices within <=8 files/400 production lines each. No Collection-local substitute. |
| Built-in adapter               | Real built-in Collection identity and profile registry/old pins, independent labels and indexed retained state/session/holding presence from their existing owners. Add only ordered owner adapters and accounting. <=6 files. Existing shelf/type-preparation helpers do not establish these capabilities. |
| Published/frozen adapter       | Real shared listing-freshness monotonic producer/observer/apply/fence plus complete activation and terminal deletion freeze/revoke. Add a per-kind owner reader and tests. <=5 files. Existing throwing listing ports are not publication capability.                                                       |
| Canonical owner adapter        | Consume `readSealedSubjectIdentity` for hidden-original canonical repair and the accepted terminal/basis/alias APIs for current evidence; require bounded native policy-equivalent original/terminal Access and ready derived canonical paths over the same truth. Wire this single factory and native SQL/tests. <=8 files/400 production lines per slice; defer runtime imports until producers exist. |
| Shared Zone/Search integration | Actual caller ledger, generic full-Boolean native evaluator, real encrypted cursor binding and settled-prefix composition. Import this ABI; no fake Search hit or second Collection engine. <=8 files per slice.                                                                                            |

Handoff exports are exactly `createCollectionSource`, `CollectionSource`, `PreparedCollectionSource`,
`CollectionSourceContext`, `CollectionSourceObservation`, `CollectionSourceAuthority`, `CollectionSourceBasis`,
`NativeIdentityBasis`, `CollectionSourceEvidence`, `CanonicalCollectionCandidate`, `CanonicalCollectionPrefix`,
`RawStoredCollectionPrefix`, `CollectionSubjectMembership`, `PrepareCollectionSource`, `CollectionSourceCall`,
`WorkDimensions`, `WorkAllowance`, `WorkReceipt`, `CollectionAliasProgress`, `ContainsCollectionSubject`,
`CollectionSourceAfter`, `CollectionSourceDriverOrdinal`. Pending runtime
items are native identity/storage, bounded alias recovery,
policy-equivalent lightweight native proofs, ledger/evaluator integration, built-in runtime and safe publication/freeze.

## Exact cross-owner imports and remaining prerequisites

The accepted Semantic Identity contract defines these separate additive exports, with runtime imports added only
when the corresponding production exports are present:

- `readTerminalSubjectIdentity(pool, id, options: IdentityReadOptions)` from `semantic/terminal-identity.ts` returns
  `TerminalIdentity`: `null`, `{state: 'not_ready'}`, or
  `{state: 'ready', id, components}`. Pass `nativeT: at` unchanged. It authorizes the original and, when distinct,
  the maintained one-hop terminal using current native Access; it is not the display resolver.
- `readIdentityBasis(pool, {deadline})` from `semantic/identity-basis.ts` returns `BasisRead` with
  `{state: 'ready', basis: IdentityBasis} | {state: 'not_ready'}`. `readIdentityHome(client, partition)` returns
  `HomeIdentity`: `{partition, epoch, home, generation: bigint, pending: bigint}`. The consumer type is exactly
  `Readonly<{digest: string}>`, structurally assignable from the Semantic ready basis, with no competing brand.
- `readSubjectAliasGroup(pool, options)` from `semantic/alias-group.ts` accepts
  `{terminal, basis: IdentityBasis, after, limit, deadline}` and returns `AliasWindow`: `not_ready`, `basis_changed`, or a ready window with
  `{originals, after, exhausted, examined, points}`. A window limit is 1..100 plus separately reserved and charged
  lookahead. `originals` are trusted raw internal keys, never Access or a disclosure DTO. `basis_changed` maps to
  `stale_cursor`; `not_ready` is retryable readiness, never false.

These independent producer contracts are not a claim that their runtime exists in this owner branch. This module's
interface has no missing static imports and cannot claim their runtime readiness. Terminal reads inspect at most the
original and its maintained terminal on separately released same-client RR/Access reads; they do not call the subject
renderer or walk request-time redirects. All actual native statements/bytes/witnesses still settle through caller
instrumentation; Semantic counters do not create another allowance.

Semantic's fixed 4096-home digest requires two independently released complete matching sweeps with zero pending
obligations. Before EACH prepare/final/continuation basis observation reserve at least 8192 `identityMetadataRows`
plus actual core-home observations in `nativePoints`, statements, empty seeks and bytes. Settle actual usage even
when the read is partial, not ready or throws; never reserve only one 4096-row sweep, infer a zero generation, or
read a free/per-candidate digest. Charge all these in their separate admitted dimensions; do not hide them in one
candidate key or infer readiness from a fresh link checkpoint. Ordinary partition
position changes do not alter identity generation. Atomic writer coverage includes merges, inherited member repoint,
account verification and reversal; rollback/replay and larger requested survivors must preserve truthful readiness.
Existing merge-member registration/repointing is the foundation, not proof those generation hooks already exist.
The separate derived-store contract supplies canonical group seeks, within-group source keysets, repair raw keysets,
and completed-generation compare-and-publish. Index presence is never membership/Access. Its ABI and SQL stay with
that owner; this change adds no store module, migration or second writer.

Direct target reads use the accepted shared optional opaque `cursor` query parameter on `POST :readPage`.
Actual advancing bounded eligibility work returns `202 {next}` with `Cache-Control: private, no-store`; a definitive
positive returns the unchanged `200` commonPage-plus-zone result. Zero-progress/maintenance failure returns the
existing `503` standardProblem plus `Retry-After`, with NO cursor or new error extension. Library exports INTERNAL
progress/evidence only. The shared Zone/schema owner owns the route/transport; no HTTP schema is added here.

The agreed covering point for canonical repair is the internal Semantic producer port
`readSealedSubjectIdentity(client: PoolClient, original: string)`, from `semantic/identity-maintenance.ts`, returning
`{state: 'ready', terminal, home: HomeIdentity} | {state: 'not_ready'} | null`. It reads native source-home
existence, redirect, current obligation version/seal and source core-home points without actor allocation, Access,
visibility, payload, type, pool checkout, or redirect walking. It lets owner repair canonicalize a hidden or denied
stored original to its actual sealed key. A live `original === terminal` result proves only native never-redirected
and sealed-removal truth. Missing/null and `not_ready` are never self and never permission to drop a candidate. The
source home/seal is not proof that the target is live, globally ready, or currently authorized.

Canonical repair covers every original under a ready global basis and independently rechecks before publishing
coverage/index state. Positive use still calls the actor-authorized terminal API and revalidates current original,
terminal, Collection authority and membership. The source ABI specifies this exact producer port; the runtime stub
here imports none of it and does not claim that maintenance or canonical indexes are implemented. Do not invent a
replacement point, manufacture canonical-self, omit hidden aliases, allocate a privileged repair actor, or implement
Semantic SQL/a second resolver locally.

The new native outcomes require real resumable progress after ready owner repair at 257 and 4096 aliases, last-alias
positive success, all-concealed completion, current final-use revocation, stale/mismatched group rejection, and fixed
64/512/4096 first/deep group growth. A test-only inspection decodes actual union continuation with its real binding and
keyring, checking that advancing inner keysets retain the settled floor before the group until its final witness.
Earlier outcomes that observe repair and a later bounded positive do not establish resumability by themselves. Tests add these obligations without changing existing acceptance assertions. The missing
driver guard covers every scenario; passing it establishes specification integrity only.
