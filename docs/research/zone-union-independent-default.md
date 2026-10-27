# Independent bounded Zone union research

Evidence date: 2026-10-28. Local source baseline: `ecc2424167207c6a000a93b784b853d866b10d70`.
This report is evidence and a proposed owner split, not an adopted query contract.
No other Zone union report or proposed manager algorithm was consulted.

## Answer

**The existing implemented owners cannot currently guarantee the requested traversal.** They have useful indexes,
filter admission, current disclosure checks, and an encrypted list codec, but lack several necessary composed seams.
A bounded, cross-page unique traversal is possible with a common **canonical subject-ID order**, owner-native
raw candidate seeks, a single covered frontier, and short or empty pages. It is conditional on bounded native
authorization/filter evidence, canonical membership indexing, and coherent basis invalidation. Those are readiness
dependencies, not permission for Zone to build another membership store.

This proves bounded candidate work and uniqueness for a fixed identity basis; it does **not** prove complete live
recall, a full page, atomic cross-owner authorization, or a wall-clock deadline. With current Search and witness
capabilities, some current members are undiscoverable or unproven. Describe these gaps explicitly and require a
fresh traversal after convergence. Do not enable an admitted source by silently discarding its valid members.

The local limits in this report are ours: at most 16 saved scopes plus 16 mounts, page size `P <= 100`, and proposed
total examined enumeration budget `C = 256`. Neither PostgreSQL nor OpenSearch specifies these application bounds.

## Evidence and current capability

The fixed routing/resource skeleton was read from the main checkout's read-only
`.temp/goal/semantic/zones-shared-skeleton.md` (absent in this worktree), SHA-256
`14606e3f60bb02753b4673fe5ec40edb21c7c40c639f6b568851e9178858cb09`.
It fixes ordinary Access, one Collection identity, a deduplicated subjects envelope, opaque keysets, explicit
freshness, and the scope/mount limits. It does not fix an algorithm or require full pages or a name order.
The interpretation below therefore chooses subject-ID order and permits underfill; adoption belongs to the owner.

The other local authorities read were [scope](../scope.md), [Library and Collections](../library-and-collections.md),
and [Dynamic Collections](../dynamic-collections.md). Dynamic Collections explicitly remains specification-only.
Its public output exposes membership, never predicates/personal facts; current membership does not grant subject
access; unknown or stale public projection rows must be withheld. Deletion's activated public/unlisted output
freezes as a unique-subject contribution under that same Collection identity.

All following implementation paths are under `services/kernel/` unless otherwise stated:

| Existing entry point                                                                              | What it actually establishes; what it does not                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/search/service.ts`, `createSearchService().search`                                           | Admits the shared filter, chooses sort, reads at most three raw rounds of at most 200 hits, checks current evidence, and advances past examined rejects. Its public filtered `subjects` are not a raw covered prefix. Work can reach 600 raw hits before one call returns.                                                                                                           |
| `src/search/query.ts`, `searchSubjects`; `src/search/filter.ts`, `compileFilter`                  | Internal raw hit and `search_after` plumbing, including `sort: 'id'`. Relation overflow broadens both positive and negated literals. No owner-level Zone raw-prefix guarantee, global allowance, native viewer authorization, or candidate-completeness certificate is exposed.                                                                                                      |
| `src/search/disclosure/check.ts`, `checkHits`                                                     | Groups real hits by subject partition, checks routability, current visibility, redirect absence and security revision, evaluates the original Boolean filter, and retains three-valued relation evidence through negation. It is not an arbitrary subject membership API and takes no viewer Access actor.                                                                           |
| `src/search/source.ts`, `SubjectSource`                                                           | `read` and optional `matchRelationFacets`; 128 sampled relation values/property and 256 probes/call are interface constants. A batch input bound is not a total page-work bound.                                                                                                                                                                                                     |
| `src/semantic/search-source.ts`, `subjectSource`                                                  | At this baseline supplies `read`/`count`, **not** `matchRelationFacets`. `search-source-facts.sql` reads term/history and nonrelation statement rows; `search-source-adoptions.sql` reads current adoption per slot. These reads are not a proof of fixed work per subject. The relation port's presence in the interface must not be mistaken for an implemented production method. |
| `src/semantic/relation-facets-design.md`                                                          | Owner handoff, not proof that its seams exist here: one recorded witness plus at most 32 alternatives, current source/target/provenance fences, `not_proven` and bounded repair. Missing or invalid witnesses cannot establish a negation.                                                                                                                                           |
| `src/library/collection-reads.ts`, `createCollectionReads`                                        | Real `collection:read`, live account/suspension checks, Collection visibility/state, and curated ordinal pages. `listMembers` fetches `limit+1`, examines the first `limit`, then filters subject reads; it returns original occurrence subject IDs. It neither exposes raw covered ID prefixes nor implements dynamic membership.                                                   |
| `src/library/collection-reads-members.sql`; `db/library/schema.sql`                               | Curated page is `(ordinal_key, member_id)`. Native `collection_member_subject(route, collection_id, subject_id)` already supports raw subject-ID existence/seeks, independently of notes/order. It is not a canonical-survivor index.                                                                                                                                                |
| `src/library/subject-anchor.ts`, `resolveSubject`/`readableSubjects`                              | Uses each subject's own Access anchor, but calls full `readSubject` and follows redirects until a cycle/end with no hop cap. Input 100 and concurrency four do not bound rendering or chain work. This cannot be hidden behind a purported constant-cost point API.                                                                                                                  |
| `src/semantic/subject.ts`, `readSubject`; `src/semantic/eligibility.ts`, `subjectReadEligibility` | Full subject read waits for links and reads releases, slots, previews/counts and summaries. Eligibility already offers a current exact subject visibility/security-revision check usable by the owner when designing a smaller native authorization seam. Eligibility alone is not all Access or canonicalization.                                                                   |
| `src/tokens/list-cursor.ts`, `encodeListCursor`/`decodeListCursor`                                | Shared encrypted, viewer/route/query-bound continuation; epoch plus at most eight keys, each string at most 256 bytes, token at most 4096 characters; query binding at most 2048 bytes. Anonymous is deterministic/timeless; account tokens have the shared 15-minute lifetime.                                                                                                      |
| `src/tokens/cursor.ts`, `src/tokens/seal.ts`, `src/search/cursor.ts`                              | Older signed JSON/HMAC cursors, including current Collection and Search reads. Base64 is reversible. These codecs cannot confidentially carry rejected private candidates. Do not infer that every existing route already uses the encrypted codec.                                                                                                                                  |

Native fact indexes also matter. `db/library/schema.sql` has `entry` primary key
`(route, account_id, subject_id)`, `copy_account_subject_created`, and `progress_session_account_subject`.
These can support anchored existence and subject-key navigation in their respective native stores.
`entry_account_state` places `updated_at DESC` before subject ID; it does not supply a state-only subject-ID stream.
Existing activity/finished shelf indexes and `entry-store-entry-page.sql` likewise do not prove the needed order.
Independent labels, canonical profile/state membership, and Everything over all retained facts remain owner work.
The inspected SQL is evidence about indexes, not an invitation to have Zone query Library tables directly.

## Primary external sources and retained evidence

Reference root: `/home/edge/projects/rezics/rezics-next/.reference/`. Existing clones were reused, read only;
no third-party installation, build, or execution occurred. Sparse files were read with `git show HEAD:<path>`.
The root `INDEX.md` records the topic reuse, URL, commit, licence and date. Exact pinned sources:

| Project; retained directory; licence                                                                                                                      | Source and finding                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL; `library-shelf-maintenance/postgres`; `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL License (`COPYRIGHT`)                            | [`src/backend/executor/nodeMergeAppend.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeMergeAppend.c), especially `ExecMergeAppend`: initializes one head from every child and replaces the consumed head. Its precondition is a common sort key.                                                                                                                                               |
| Same PostgreSQL clone and licence                                                                                                                         | [`src/backend/executor/nodeUnique.c`](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeUnique.c), `ExecUnique`: sorted adjacency allows remembering only the last group. This executor loops until a different tuple; its loop must acquire an explicit budget in an HTTP adapter.                                                                                                                   |
| OpenSearch; `search-rating-populations/opensearch`; `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`; Apache-2.0 (`LICENSE.txt`, `NOTICE.txt`)                  | [`server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java`](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java), `buildFieldDoc`: requires the matching sort tuple, converts its typed values, and resumes strictly after equal sort values. It does not make that tuple a membership or authorization proof. |
| OpenSearch documentation; `search-rating-populations/documentation-website`; `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`; Apache-2.0 (`LICENSE`, `NOTICE`) | [`_search-plugins/searching-data/paginate.md`](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_search-plugins/searching-data/paginate.md) and [official pagination documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/): live `search_after` can change under mutation; PIT is a separate snapshot facility.                                                   |

[PostgreSQL index ordering](https://www.postgresql.org/docs/current/indexes-ordering.html) explains why a matching
B-tree can avoid a full sort before LIMIT. [Its UNION documentation](https://www.postgresql.org/docs/current/queries-union.html)
defines duplicate elimination but promises no output order from UNION itself. These support indexed order plus
explicit identity comparison, not a cross-partition SQL UNION proposal.

[RFC 5116 §§1.1–2](https://www.rfc-editor.org/rfc/rfc5116.html), under its IETF copyright/legal notices, distinguishes
MAC integrity from authenticated encryption's confidentiality and authenticates associated data without encrypting
that data. It supports using the existing shared encrypted cursor; it is not an audit of that codec's construction.
All recommendations here are designs for this repository's owners, not code or passages to copy.

The shared patterns are explicit ordering/tiebreakers, a frontier describing consumed work, separation of identity
from tuple occurrence, and separate freshness/security evidence. None of these systems makes bounded output imply
bounded examined input or turns a live keyset into a snapshot. The algorithm and bounds below are our deductions.

## Concrete recommended plan, conditional on owner readiness

Choose ascending canonical subject UUID bytes (equivalently fixed lowercase canonical UUID text under C ordering).
Zone union order is independent of a mounted curated Collection's presentation order. That page retains its
occurrences, order and notes. Name, relevance, activity and Collection-count sorts are not admitted for this plan:
their native streams do not supply the same immutable key.

Let `K <= 32` be readable logical sources. Each provides one or more native physical candidate streams, with total
`M` known and bounded at admission. Every stream must support a strict indexed seek after a canonical ID, returning
its least next candidate or an exhausted certificate. It must not filter arbitrary rows before charging them.
It may overinclude stale/false/unknown candidates; it must not claim that a filtered empty result exhausts a raw range.
The Search stream's certificate covers its **indexed query candidate universe**, not all current catalogue members.

A candidate read returns the real source identity/anchor, native candidate evidence, canonical key, basis stamp,
and actual examined-key debit. Callers reserve allowance before invoking it. Uncertainty about whether an earlier
raw key exists is a readiness failure or a bounded range needing more work, never an exhausted certificate.
An adapter returning only a partial raw window must expose its covered endpoint separately from accepted items.
For the simplest initial implementation require exact one-head seeks; do not add window-local hidden refills.

Everything can in principle use four subject-key streams: non-null state, independent labels, retained sessions,
and holdings. Each skips repeated facts of a decided subject by the next strict subject-key seek. A state built-in
uses one scoped state-identity stream. With four streams per mount, `M <= 16 + 4*16 = 80`, rather than 32.
This is a **proposed admitted plan**, not an implemented decomposition or a mandated four-table schema.
Do not expand every old release/profile pin into an unbounded stream fanout. The owner must provide an indexed
canonical state identity and compatible-pin validation, or report that source not ready.

The continuation stores only a global decided key `L` and a fixed-size basis digest, using the shared encrypted codec.
Within a request keep at most one charged head per physical stream, an exhausted bit per stream, and output <= P.

1. Authenticate the viewer and recheck Zone Access. Resolve current saved filters and readable mounted Collection
   identities under their real owner Access. Obtain a coherent basis (see below). An unreadable source contributes
   nothing; no raw prefix from it enters a response. A readable but unsupported source makes the plan not ready.
2. Starting after `L`, obtain one head or exhaustion for every stream, reserving from the **one** C allowance.
   Empty indexed seeks consume statements, even though they examine no logical candidate keys.
3. Only when every nonexhausted stream has a head, choose their minimum key `g`. All equal heads form one subject
   group. Check current native union membership and current viewer subject Access at real anchors; only definite
   true can emit. Current union membership is OR of readable Collection membership and saved semantic predicates.
   Its point path is independent of Search discovery; it does not manufacture a Search hit for a Collection member.
4. Whether emitted, rejected, or unproven, decide `g` once and advance `L = g`. Drop all equal heads; strict seeks
   after `g` skip their duplicate occurrence/fact runs by index range. Do not scan that run to implement DISTINCT.
   Refill only the streams whose heads were dropped, charging every candidate read including lookahead.
5. Stop at P output or before any reservation would exceed C. If a missing head prevents establishing the next
   minimum, return the last decided L, never a maximum source endpoint. Nonconsumed prefetched heads are discarded;
   next request re-seeks them after L and charges them again. This saves cursor space without skipping them.
6. Revalidate the source eligibility supporting output and its basis before disclosure; on inconsistent basis abort
   with restart/readiness semantics. Return next unless **all** streams are proven exhausted. At a budget boundary
   next may lead to an empty terminal page; do not fetch an uncharged extra row merely to avoid this.

Collection point membership should be checked even if another stream discovered `g`; similarly evaluating all
saved predicates can recover a match missed by one indexed scope when some other source did discover the subject.
Short-circuiting a definite OR proof is allowed. Worst-case budgeting must assume no short circuit succeeds.
Only checks actually supporting a proof authorize its disclosure. A confirmed live revocation removes that proof;
unavailability is not false and must not be used to justify disclosure through NOT.

### Why this traverses, rather than merely caps

Inductively, before selecting g every source either has no keys remaining or has least remaining key >= g.
Consequently no undiscovered candidate key lies between L and g. All representations of g in a correctly ordered
canonical stream are adjacent; a strict seek past g cannot skip another identity. Once L becomes g every later
request considers only identities > g. No historical Set is necessary. The scalar frontier itself proves cross-page
uniqueness. A Set confined to one response would not prove it.

Under a fixed finite candidate universe and basis, exact indexed seeks, and `C >= M`, each nonterminal successful
request can decide at least one new group: initialization needs at most M candidates and already proves a minimum.
At a stop after partial refill that group is still committed in L. Thus repeated successful requests terminate,
including all-rejected pages. At worst there are as many advancing requests as distinct candidate keys, plus a
terminal request; this is a finiteness bound, not acceptable latency evidence. K=0 terminates immediately.
If an adapter cannot expose a least head within its bounded work, this proof does not apply to it.

For **complete** quiescent recall add: every valid member is represented in at least one candidate stream;
canonical indexes and Search are caught up; every needed filter/authorization proof is definitive; access and facts
remain fixed throughout that fresh traversal; and the client follows every next within shared cursor validity.
Finite background repair must actually converge, and a fresh traversal must start after it. A permanently unknown
overflow absence fails these conditions even on a quiescent dataset. Candidate exhaustion alone cannot prove full
current membership exhaustion.

## Counterexamples that constrain the recommendation

**Asymmetric frontiers.** Source A covers IDs through 200 and source B covers only through 10 with more pending.
Continuing at 200 drops B's 11–199, even when A returned nothing. Continuing independently after each public list
cursor does not establish a common output watermark. Safe window merge coverage is at most the minimum certified
covered endpoint (and must retain/re-read anything beyond it). The head algorithm obtains the stronger least-head
certificate and stores only decisions supported by every stream. A public filtered list supplies neither contract.

**An actual 256 conflict.** With 32 ID-ordered sources all containing the same 100 IDs, one-head discovery without a
cross-source absence oracle examines 32 source keys per distinct group: 3200 for 100 output. Even three disjoint
sources prefetched at 100 each examine 300 before merging. Calling public Search at P=100 can itself inspect
200+200+200 rejected hits: 600 > 256 before Zone sees its empty response. For P=100, 256 can never promise full
pages for these admitted algorithms; arbitrarily many rejected keys refute any fixed full-page cap.
The minimal honest changes are **globally reservable raw-prefix allowance plus underfill/empty continuation**;
neither a silent 600 cap nor 256 per source is acceptable. Retain C=256 with the proposed plan; if owners cannot
expose that allowance, it is not ready. With the identical 32-stream example, at most eight groups fit initially.

**Different orders and duplicate occurrences.** Curated ordinal order `[x, y, x]` produces x again after a page break
even if the Search side is ID-ordered and each page uses a Set. Sorting each fetched window by ID does not repair
the unseen suffix. The existing subject index can support strict distinct-ID seeks without scanning all <=5000
curated occurrences, but no public members endpoint exposes this seam today.

**Unknown versus false.** For `NOT relation(v)`, a fenced saved witness followed by 32 hidden alternatives and a
33rd live alternative cannot yield true from a bounded negative probe. `not_proven` must remain unknown.
An all-unknown page advances like an all-rejected page, withholding its members and marking incomplete evidence.
After repair, already passed IDs are not automatically revisited. A new traversal is necessary. I/O/partition
failure aborts; it must not be relabelled a normal unknown or an exhausted raw stream.

**Canonical survivor ordering.** Let `a < b < z`, with a redirected to z before the traversal starts. Raw source
`[a, b, z]` mapped after enumeration becomes `[z, b, z]`. Returning z from a then continuing by raw ID emits z again;
continuing by z instead drops b. A merge-generation check alone does not fix this already-quiescent alias example.
Every participating stream must enumerate canonical keys, including alias-only Collection membership, or a
different owner-proved canonical equivalence seek must exist. A reverse alias walk can be degree-sized and is not
a bounded point operation. Do not simply suppress alias-only valid members until an unspecified future rewrite.

**Mid-traversal merges.** If x was returned and is merged into later z, the historical output and a new z cannot be
deduplicated as one survivor using only today's scalar raw frontier. Require identity-basis invalidation before
continuing, plus canonical source readiness for the new basis. Restart is a new traversal and may repeat results.
This is an owner seam for canonical indexing and coherent invalidation, not a Zone-local identity snapshot.

**Source priority with point anti-membership is insufficient alone.** Concatenating source A then B and suppressing
B members currently in A avoids a shared sort only under stronger fixed-membership assumptions. Return x from A;
revoke A before B's x; a current anti-membership check now permits x again. Earlier unknown/rejected evidence also
does not prove earlier emission. Exact canonical occurrence/dominance checks would require further native indexes.
This alternative is not the recommended first contract.

**Missing indexed candidate.** A currently qualifying subject s absent from Search, with no matching mounted
Collection candidate, is never discovered. Security-revision rechecks and point probes cannot invent its key.
If s enters the index later at or behind L it is still missed. Overflow-marker broadening helps only when that
marker/candidate is indexed; a newly overflowing relation before index catch-up can still be missed.
Report source freshness and incomplete recall; no fake hit, public private-fact mirror, or whole-catalogue refill.

## Authorization, basis and continuation boundaries

Recheck viewer activity/authentication epoch, Zone Access, and each relevant Collection's real `collection:read`.
For subject g perform native `subject:read` on g's resource anchor with the same actor. Membership in a visible
Collection does not grant that right. Source provenance/witnesses must check their own source and target anchors
and current fences; a Zone grant or Global-context check cannot substitute for those native anchors.
Canonical resolution must check the originally referenced anchor and survivor as required by the native policy;
indexing a survivor ID must not launder an inaccessible original reference.
If many original aliases map to g and each needs different authorization, a canonical-ID index alone does not
prove bounded authorized existence: 256 denied aliases followed by one allowed alias defeats a filtered LIMIT 1.
The owner must supply a bounded valid evidence representative under its canonical policy, or expose charged
alias-evidence continuation/repair with explicit unknown. This adds work/state beyond the simple one-head proof;
it cannot be assumed ready or silently skip the surviving valid member. The recommended initial readiness gate
requires canonical membership and its native authorization proof to satisfy the bounded point obligation.

The minimal subject seam returns bounded authorization, identity and requested compact summary evidence, without
running full `readSubject`. It requires an indexed bounded canonical lookup, or bounded redirect hops with a typed
readiness/repair result beyond the bound. A hop cap that permanently removes long-chain members is unacceptable.
Its cost must include actual Access work, original/survivor anchors and fence evidence. The current helper is not
this seam. Rendering the final <=P summaries is separate work and must itself have an owner-proved bound.

Bind continuation to viewer, route, Zone identity/incarnation, normalized sort/filter/page size and language/output
options, and an encrypted digest of the bounded source basis: Zone configuration revision, expanded saved-filter
and definition revisions, Collection identities/incarnations/query revisions, accepted profile/state/release meaning,
source/projection generations, and canonical identity basis. Obtain current basis before and after bounded work;
no claim of an atomic cross-partition snapshot follows. Owners must publish monotonic change stamps synchronously
with authoritative basis changes; comparing an eventually updated stamp is insufficient for merge invalidation.
Do not restart on every ordinary fact insertion by inventing a new snapshot contract; basis changes and live
membership changes have different consequences.

Keep stable request binding in shared codec associated data, and compare the decoded encrypted basis digest with
current basis so legitimate basis mutation can return `409 stale_cursor`, rather than being indistinguishable
from token tampering. Shared owners must agree the exact error mapping. L plus a digest fits existing eight-key
and per-key limits; a 32-source cursor vector generally does not. Do not pack an arbitrarily large JSON vector into
one key. Confidential fields belong in encrypted position, not associated data or public response metadata.
Use the shared key ring, expiry and rotation behavior: anonymous deterministic/timeless, account 15 minutes;
retired keys invalidate both. No Zone cryptography, TTL, snapshot, or per-traversal storage is proposed.
Encryption does not hide token length/equality or ordinary pagination timing; do not publish rejected/private counts.

Current authorization means valid at the native evidence reads. Independent owner partitions cannot promise that
all authorizations held at one global instant or that none changed after the final check. If source/viewer access
changes, withdraw its proof; basis-dependent changes restart, and remaining sources can prove membership anew.
Whether an inaccessible source is skipped or triggers a conservative stale restart must preserve non-disclosure;
the recommendation is restart on a changed eligibility basis once one is bound, then skip unreadable sources in
the fresh traversal. Current-keyset semantics can miss newly eligible IDs behind L even without a basis change.
Revoked subjects disappear on their next read; an earlier response cannot be retracted by pagination.

Private, public, dynamic and frozen Collections remain references to one Collection ID, with ordinary current
Access and the owner's membership implementation. Public dynamic/frozen adapters expose eligible subject membership
only. An activated public contribution uses the shared monotonic listing protocol's current eligibility and source
stamp; old projection events must not resurrect revoked output. Frozen output reads retained adopted membership,
not erased personal predicates. Source incarnation prevents delete/recreate or stale projection resurrection.
No new public membership projection, private holder directory, or second query authority is justified by this plan.

## Work accounting and real index obligations

Let N be all enumerated candidate keys actually examined across physical streams, including rejected, duplicate,
unknown, prefetched and re-read heads; `N <= C`. Let D <= N be distinct groups decided this request. Empty exhausted
seeks cost at most M attempts per request with one-head adapters; total enumeration statements are <= N+M.
Merge bookkeeping is `O(M + N log M)` CPU with a heap and `O(M + P)` key/output memory. Source index seeks also
have tree-height/storage costs; the merge formula is not the total request cost. Nested dynamic enumeration must
debit **all** its native fact candidates against C; emitting one logical Collection candidate is not a free reset.

Current union membership can require D*K logical source point checks (<=8192 at D=256,K=32), plus subject anchors
and source eligibility. With four fact kinds per dynamic mount, fact-existence points can reach `4*16*D`, and saved
predicates another `16*D`: 20480 logical checks at D=256 before per-check work. Batching reduces round trips, not
examined evidence. Revalidation adds bounded checks on supporting proofs; it must be counted separately.

`packages/filter/src/filter.ts` admits at most 32 leaves, depth 4, OR width 16, IN width 64 and four qualifiers;
expansion also enforces the leaf limit. For S saved scopes and L leaves with V values each, worst-case relation
pair probes are `D*S*L*V`, not D. At D=256,S=16,L=32,V=64 that is 8388608 potential pairs before shared-leaf reuse.
The proposed witness seam's 33 identities/pair would permit 276824064 witness examinations, each with further
current evidence cost E. These are conservative upper bounds, not claims that such a request is fast or admitted
by a future execution planner. Existing batching at 256 probes/call does not cap this total.

CPU includes `O(D * sum(filter leaf/value evaluation and witness evidence))`, native Access cost, canonical lookup,
and summary projection. The current `holds` implementation also scans subject statements and qualifiers; its
snapshot SQL reads histories. Without new bounded anchored evidence, E and subject snapshot size are not constants.
Process one group/filter batch at a time to keep memory `O(M + P + L*V + B*E)` for bounded evidence batch B, rather
than materializing D*S*L*V probes. Admission needs a separate explicit evidence/probe budget and supported-plan
check. Reject an unprovable plan before execution or return typed readiness; do not silently treat budget exhaustion
as Boolean false. Unknown evidence retains the shared semantics. Candidate count alone proves no wall deadline.

Minimal real indexes/seams needed from existing owners:

- Search: a budget-aware raw ID-prefix adapter around its real compiler/query/current-evidence machinery;
  active generation/release validation, exact consumed/covered endpoints and incomplete freshness, no public
  filtered-list wrapping. Physical search engine postings/scoring work is additional to returned raw hits.
- Collection: expose native strict subject-ID seeks using `collection_member_subject` where IDs are canonical;
  add owner-native canonical-key indexing/readiness for alias references and exact current canonical membership.
  `SELECT DISTINCT ... LIMIT` without proving its examined run is bounded is insufficient. Strict `subject > g`
  seeks can skip decided duplicate runs. Add INCLUDE/tiebreak columns only if the actual required evidence needs
  them; no full occurrence reordering or replacement Collection store is needed.
- Dynamic membership: native subject-key indexes for non-null accepted state, independent labels, retained sessions
  and holdings, and `(owner, scoped profile/state meaning, canonical subject)` seeks for state built-ins. Existing
  copy/session indexes supply useful raw subject prefixes; existing state/time indexes do not supply the state
  order. Preserve old accepted pins. Empty entry shells cannot create Everything presence, and no presence flag is
  proposed. Canonical alias handling and public/frozen contribution readiness belong to the Collection owner.
- Semantic/Access: bounded canonical identity resolution and change stamp; bounded actor-native subject authorization
  and compact summaries; shared admitted filter evaluation for arbitrary anchored subjects without fake hits;
  real current witness/fence ports with explicit unknown. History/degree-sized rendering is not a point check.
- Shared Query/List and Projection: the existing encrypted codec/error/basis policy, evidence budgets, source stamps,
  current public eligibility and bounded repair. Zone consumes these protocols and never substitutes its own.

Index LIMIT bounds logical candidate output only when predicates are index seeks or checked after debiting candidates.
Residual filter scans, stale/dead MVCC index entries, heap visibility, index height, network and partition scheduling
still affect physical work. Native growth plans must record actual rows examined, buffers, statement counts and cost
classification at fixed C/P. A hard physical-I/O or wall-clock guarantee has not been proved here.

## Minimum native acceptance and owner task split

These are proposed implementation acceptance obligations, not new runtime tests for this report-only task:

| Owner                    | Required native acceptance before readiness                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search                   | Exercise real raw ID pages with all 600 public-search candidates rejected; Zone's raw adapter must stop within the shared 256 debit. Compare indexed prefix coverage and current predicate truth; test mixed generation, newly missing overflow markers, all-rejected and empty nonterminal pages.                                                                                                                                                    |
| Collection/Library       | Real private/unlisted/public curated duplicates across pages, alias-only members, notes/order unchanged on the ordinary page, native strict ID plan; Everything/state built-ins through the same Collection identity, independent labels/sessions/holdings, empty shells, old/retired pins and state-index seeks. Count nested candidates.                                                                                                            |
| Semantic/Access          | Native other/anonymous/owner/suspended actor checks on each original/survivor/source/target anchor; prove point checks avoid rendering/history and bound redirect work. Preexisting alias chains, mid-page merge and between-page survivor change must never silently duplicate/drop canonical members.                                                                                                                                               |
| Semantic evidence        | Real negative/positive/nested Boolean filters, qualified unsupported shapes, invalid recorded witness, 32 hidden alternatives then later live witness, `not_proven` through NOT, I/O failures, repair convergence and fresh traversal. Missing production witness port must be detected as not ready.                                                                                                                                                 |
| Shared cursor/projection | Decrypt neither rejected private IDs nor predicates from public tokens; viewer/route/request/Zone/source incarnation mismatch, basis `409`, account expiry, anonymous determinism, rotation/retirement, revoke-before-disclosure, stale projection and freeze-after-deletion cases.                                                                                                                                                                   |
| Zone composition         | Native 32 logical sources and the admitted physical fanout at three data scales; asymmetric prefixes, equal keys in every source, duplicate occurrence runs, P=1/100, all-false/all-unknown windows, discarded lookahead re-reads, empty intermediate/terminal pages. Assert N<=256 globally and <=P output, monotone decided L, no cross-page duplicate, and complete reference enumeration only under the stated quiescent completeness conditions. |

The direct Zone subject route additionally needs a bounded native membership check across all readable sources,
without running a list scan or relying on Search indexing. Test an accessible matching subject missing from Search:
point eligibility may succeed while listing recall is incomplete, and the discrepancy must be an explicit freshness
limitation. Test source/viewer revocation between all read phases without granting subject access through a mount.

Owning tasks should land the Search raw port; Collection canonical/member/fact indexes and public/frozen adapter;
Semantic identity/point evidence and Access integration; and shared basis/cursor/projection accounting before Zone's
merge coordinator. Unsupported owner seams are readiness dependencies. Zone owns only bounded orchestration and
the routed union surface. There is no dependency on user-authored dynamic query runtime in this first scope.

Unproven assumptions requiring owner validation are canonical-index completeness and invalidation, fixed-cost native
Access/fence/summary evidence, the admitted dynamic physical fanout, and eventual Search/projection/witness repair.
This report supplies counterexamples where those assumptions fail. Adopt the common canonical-ID merge only with
those owner proofs and explicit incomplete live recall; the existing public list APIs alone are insufficient.
