# Bounded current Zone union: independent source assessment

Research evidence, 2026-10-28. Repository basis: `ae35cbc5222b0cff382f1ee1ea743665f1af896f`.
This report proposes a design for owner review; it changes no authoritative contract or runtime.
Other Zone-union reports and proposed query algorithms were not read. The routing skeleton was absent from this
worktree; its exact supplied path was read in the read-only main checkout:
`/home/edge/projects/rezics/rezics-next/.temp/goal/semantic/zones-shared-skeleton.md`.

## Answer

**The existing implemented entry points cannot provide the requested guarantee. The existing owners can provide
a bounded, deduplicated current-keyset union after specific native adapters and identity readiness work.**
That is a conditional feasibility result, not evidence that these adapters already exist.

Recommend one common ascending **canonical subject-ID** order, covered raw candidate prefixes from every readable
source, and a single committed union watermark. Compute the safe frontier as the minimum covered source frontier;
never advance to the greatest frontier or to the last public Search result. Re-read bounded lookahead on the next
request instead of retaining a growing seen-ID list or a vector of private raw source cursors.

The local budget of 256 can cover this design by allowing short and empty pages, even when the requested size is
100. It cannot guarantee a full page, exact live recall, completion while an essential proof remains unknown, or
constant database/search-engine work. Canonicalization must be complete and ordered at the owner before admission;
an arbitrary redirect walk in a request is not an adapter. Identity/basis changes require restart.

All numerical limits in this report are repository/task limits or explicit proposals made here, **not external
standards**. First scope means at most 16 saved catalogue scopes plus 16 mounted Collections; user-authored dynamic
queries remain deferred. No public personal-fact index, Zone membership store, cross-partition SQL join, invented
Search hit, snapshot service, or Zone cryptography is needed or recommended.

## Local evidence and actual readiness

Paths below are relative to this repository. These are the permitted owner entry points, not a survey of unrelated
systems. The three product documents were read in full: [scope](../scope.md),
[Library and Collections](../library-and-collections.md), and [Dynamic Collections](../dynamic-collections.md).

| Evidence | Implemented capability and limitation |
| --- | --- |
| `services/kernel/src/search/query.ts`: `searchSubjects`, `SearchPlan`, `SearchResult`; `db/search/templates/subjects-search-v2.json` | Native `id` ascending sort and `after` tuple; raw hit identity, partition, security revision, matched clauses. Size is 1–200. This low-level function is not a complete Zone raw-prefix/current-authorization contract. |
| `services/kernel/src/search/service.ts`: `createSearchService`, search loop | Up to three rounds, each at most 200 raw hits. Current checks can remove them. The public cursor advances through consumed rejected hits, with special handling for undisclosed accepted lookahead. Up to 600 raw hits **per Search call**, not 600 per Zone or a 256 guarantee. The public response does not expose the covered raw interval. |
| `services/kernel/src/search/filter.ts`; `packages/filter/src/filter.ts`: `FILTER_LIMITS`, admission | Shared closed filter, saved-filter expansion, definition-based admission, overflow broadening. Current limits include 32 expanded leaves, depth 4, up to 64 values in an `in` leaf; do not substitute the later custom dynamic-query envelope's different limits. |
| `services/kernel/src/search/disclosure/check.ts`: `checkHits`, `filterPlan` | Re-routes each real hit to its actual subject partition; checks current visibility, redirect and exact security revision. Evaluates the complete admitted Boolean filter, including negative leaves; preserves `not_proven` through negation. This is Search disclosure, not the viewer's native `subject:read` permission for a mounted member. |
| `services/kernel/src/search/source.ts`: `SubjectSource`, `RelationFacetMatch` | `read` and `count`; optional `matchRelationFacets`, at most 256 inputs per call. Type declaration is not proof that the production source supplies the optional method. |
| `services/kernel/src/semantic/search-source.ts` and `search-source-{subjects,facts,adoptions,statements}.sql` | Current partition snapshots; exact source subject anchors and source fences. Production return object on this basis implements `read` and `count`, not the optional relation probe. Descriptive fact/history processing is not bounded by the number of subject IDs alone. |
| `services/kernel/src/semantic/relation-facets-design.md`, source/witness entry handoff | Explicitly unimplemented handoff: recorded witness plus at most 32 alternatives; uncertainty is not absence. Required witness tables and durable rebuilds are proposals here, not existing native capabilities. |
| `services/kernel/src/library/collection-reads.ts`: `loadCollection`, `listMembers`; `collection-reads-members.sql` | Real Collection Access and current account checks, then ordinal/occurrence keyset, at most `limit+1` raw rows. Subject filtering may underfill. Public members are occurrences, not a distinct subject-ID prefix. Existing cursor binding here includes only Collection ID. |
| `services/kernel/db/library/schema.sql`; `src/library/collection-store-collection-member-read.sql` | Member primary key `(route, collection_id, member_id)`, ordinal uniqueness, and existing B-tree `collection_member_subject(route, collection_id, subject_id)`. The subject index can support bounded subject seeks; the existing point read is by **occurrence ID**, not an exact canonical-subject membership port. |
| `services/kernel/src/library/subject-anchor.ts`: `resolveSubject`, `readableSubjects` | Real subject-anchor Access, but calls full `readSubject` and follows redirects with an unbounded visited set until termination/cycle. Returning stored IDs also does not implement canonical union identity. Cannot reuse this as a bounded point API. |
| `services/kernel/src/semantic/subject.ts`: `readSubject`; `semantic/eligibility.ts`: `subjectReadEligibility`; `subject-public-evidence.sql`, `read-redirect.sql` | Useful authorization ingredients exist. Full reads wait for links and resolve properties, slots, relations and summaries. Public eligibility is a visibility/security point; it alone is not the full native Access decision. Latest redirect lookup is one edge, not a proven bounded terminal mapping. |
| `services/kernel/src/tokens/list-cursor.ts`: `encodeListCursor`, `decodeListCursor` | Existing shared encrypted list codec; eight position keys, each string at most 256 UTF-8 bytes, token at most 4096 characters. Viewer/route/query authenticated binding; account lifetime 15 minutes; anonymous deterministic, timestamp-free, timeless; retired keys invalidate both. |
| `services/kernel/src/tokens/{seal,cursor}.ts`; `search/cursor.ts` | Older HMAC/base64 JSON protocol remains used by these Search/Collection reads. Signing authenticates but does not conceal its position. It is not the encrypted shared list codec. |

The dynamic document explicitly says specification-only. Its Everything/state membership, profile pins, canonical
shared members page, public projection and deletion freeze are therefore requirements, not capabilities established
by this checkout. Dynamic's individual `4P <= 400` candidate allowance must not multiply into a Zone allowance:
the Zone must pass smaller allocated raw budgets through an internal owner adapter.

## Primary external evidence

Reference repositories were reused, read as data with `git show`, and neither installed, built nor executed.
Their checkouts are sparse; the listed source paths are Git tree paths at the exact commits, accessible without
checking out or executing their contents. Inventory entries are retained in the main checkout's ignored
`.reference/INDEX.md` under `zone-union-independent-current`.

| Project / retained directory under `.reference/` | Commit, licence, precise evidence |
| --- | --- |
| PostgreSQL / `library-shelf-maintenance/postgres` | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL License, `COPYRIGHT`. [MergeAppend source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeMergeAppend.c), `ExecMergeAppend`; [Unique source](https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeUnique.c), `ExecUnique`. |
| OpenSearch / `search-rating-populations/opensearch` | `4ee42a94e87f66fbf1e62a9871b1b87f91e02472`; Apache-2.0, `LICENSE.txt`, `NOTICE.txt`. [SearchAfterBuilder](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/searchafter/SearchAfterBuilder.java), `buildFieldDoc`; [QueryPhase](https://github.com/opensearch-project/OpenSearch/blob/4ee42a94e87f66fbf1e62a9871b1b87f91e02472/server/src/main/java/org/opensearch/search/query/QueryPhase.java). |
| OpenSearch documentation / `search-rating-populations/documentation-website` | `9bf360dee6e0930aa0bd66ba91e992b9ee2828bf`; Apache-2.0, `LICENSE`, `NOTICE`. [_search-plugins/searching-data/paginate.md](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_search-plugins/searching-data/paginate.md), [point-in-time.md](https://github.com/opensearch-project/documentation-website/blob/9bf360dee6e0930aa0bd66ba91e992b9ee2828bf/_search-plugins/searching-data/point-in-time.md). |

PostgreSQL's MergeAppend requires every child to use the same sort key, initially obtains a head from each child,
and maintains a heap of those heads. Unique removes adjacent equal tuples from an already sorted stream using
one retained tuple. These support the ordering proof, not an application of SQL across our owner partitions.
Unique's loop can consume arbitrarily many duplicates: small memory does not prove bounded input work.

OpenSearch's `buildFieldDoc` checks that continuation values match the sort's arity and constructs an exclusive
boundary. QueryPhase performs shard query/collection work before reduction; a small response is not a CPU proof.
Official [pagination documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/)
requires a unique tiebreaker and explains that live `search_after` can change across requests. Its
[PIT documentation](https://docs.opensearch.org/latest/search-plugins/searching-data/point-in-time/)
describes a different frozen dataset mechanism. This design uses neither PIT nor scroll.

PostgreSQL documents that [B-tree ordering with LIMIT](https://www.postgresql.org/docs/current/indexes-ordering.html)
can retrieve a small ordered prefix directly. Its [isolation documentation](https://www.postgresql.org/docs/current/transaction-iso.html)
locates repeatable-read consistency inside a transaction. Separate owner transactions and later pages do not share
one instantaneous view. These facts justify seeking and describe the limit of the consistency claim.

[RFC 2104](https://www.rfc-editor.org/rfc/rfc2104) defines keyed message authentication, not encryption.
[RFC 5116, sections 2 and 3](https://www.rfc-editor.org/rfc/rfc5116) distinguishes encrypted plaintext from
authenticated associated data and specifies AEAD's confidentiality/integrity interface. RFC texts are read under
their published notices and [IETF Trust rights](https://trustee.ietf.org/documents/trust-legal-provisions/), not a
software licence to transplant an implementation. No external implementation or long passage is proposed for copying.

The common pattern is ordered, exclusive continuation plus explicit state/consistency boundaries. None of these
sources establishes that signing a cursor hides it, that a filtered page proves coverage, that a Set proves
cross-page uniqueness, or that a bounded output implies bounded authorization work.

## A concrete conditional design

Use `K` for currently readable configured sources, `B = 256`, and `1 <= P <= 100`. Apply existing mount eligibility
as well as current read authorization; a reference is not permission to mount an otherwise ineligible private list.
Denied sources are checked before discovery and contribute nothing. If there are no readable sources, return an empty terminal page.
All active sources must support the same canonical UUID order (fixed lowercase encoding and identical comparison).
Names, relevance, ratings and curated ordinal order are not admitted for this first union plan.

### Required prefix meaning

For an exclusive watermark `w` and allocation `q`, a source returns at most `q` raw **distinct canonical subject
candidate keys**, sorted, with its basis and a coverage assertion. No current residual filter or subject Access
filter may silently remove keys from this raw prefix. A Search prefix is the raw indexed candidate superset for
the admitted saved filter, before current semantic rejection. A Collection prefix is owner membership candidate
keys before the Zone's residual/current checks. Candidate presence is never an authorization grant.

For a non-exhausted source its frontier `f_i` is its last raw returned key: every source candidate in `(w,f_i]`
has been represented. For a source proven exhausted after `w`, set `f_i = +infinity`. Exactly `q` returned keys
need not prove exhaustion: return a conservative non-exhausted assertion, with no hidden `(q+1)`th lookahead.
Every extra key touched for lookahead, rejection, duplicate resolution or repair belongs in the allocation.

An unavailable/unknown **coverage** result is not an empty or exhausted source. A source that cannot yet supply
this port is a readiness dependency for the requested union, even when its ordinary public members page works.
The owner must not replace it with a scan or silently omit the mount forever.

### One bounded window per request

1. Authorize Zone and each configured source on its real resource anchor with the current viewer. Validate saved
   filter expansion and all owner bases. Decrypt/validate the shared continuation and compare its basis before use.
2. For adapters costing one candidate examination per exposed key, allocate
   `q = min(200, floor(B/K))` raw keys to each readable source. Thus `K*q <= B` and `q >= 8` for `K <= 32`.
   Request exactly one covered prefix per source after `w`. An adapter may use several bounded seeks internally,
   but must charge their entire logical candidate work to this allocation. Do not call the public refill loop.
3. Set `h = min_i f_i`. Merge returned keys in order, coalescing equal IDs, but process only keys `<= h`. Keys above
   `h` are paid lookahead and are discarded after this response, never committed as consumed source progress.
   If every source is exhausted, the safe range is all returned keys.
4. For each coalesced key `x`, establish at least one currently readable source's current membership/filter proof,
   then native current `subject:read` on `x`'s real subject anchor. Recheck source evidence before disclosure as
   required by its owner. Source truth is OR, with `unknown OR true = true`; unknown is never false under NOT.
   Emit at most one subject for `x`. A definitive false/denied key consumes budget and advances progress too.
5. Stop at `P` emitted subjects, the end of the safe range, or the first essential unresolved proof. Commit only
   through the last **terminally decided** key, not through unprocessed lookahead or an unresolved key. Return
   `{subjects,next}`; null means every source is exhausted and every returned key was terminally decided.
   A conservative extra empty terminal page is acceptable. No unbounded refill occurs.

The one-examination premise must be tested, not inferred from response size. More generally let `c_i` be the
owner's proven maximum candidate-key examinations per exposed key, including candidate-row rereads, internal
duplicates, rejections and lookahead. Reserve any fixed examination overhead `b0`, then choose
`q = min(200, floor((B-b0)/sum_i c_i))`. Stop before exceeding the ledger. For example, independently re-reading
each source candidate for membership makes `c_i=2`, giving `q=4` at K=32, rather than silently claiming eight.
Direct evidence points are separately costed below; any such point that enumerates further membership candidates
also charges this source ledger. If no positive q fits, that owner plan is not ready under 256; improve its index
or explicitly revise admission/budget. Do not describe a zero-progress schedule as finite traversal.

For unresolved coverage, fail with owner readiness rather than claiming progress. For a per-key `not_proven`,
recommend retaining the boundary before that key and asking the existing owner repair protocol to resolve it;
a bounded empty page may retain the same position. This is a normal uncertain window, not evidence of absence
or an excuse to use Search's existing drop/refill loop. There is no guaranteed progress while that proof persists.
Returning a retry indication must use the shared owner readiness/error vocabulary when adopted, not a Zone job store.

This conservative recommendation deliberately preserves valid members for retry. If instead an adopter chooses
Search's existing fail-closed skip behavior, the unknown key is consumed and recall for that traversal is lost;
only repair plus a new traversal can recover it. That alternative must be specified as an additional recall gap,
not described as a complete union. A missing implementation is never this ordinary uncertainty case.

### Proof and asymmetric frontiers

For every `x <= h`, each active source has either represented `x` if it is a candidate, or covered the range without
it. Therefore the merge has all occurrences relevant to the candidate union through `h`. Ordering makes equal
canonical keys adjacent. Once `x` is terminally decided, every future request seeks strictly past `x` in every
source, so `x` cannot reappear within the same identity basis. No historical seen-ID cursor is involved.

Example: source A returns `[10,20]` and source B `[15,90]`, both non-exhausted. Only `[10,15,20]` is safe because
`h=20`. B's key 90 is fetched but unconsumed. The next request starts all sources after 20, so B returns 90 again.
Committing 90 loses an unreturned A key 30. Persisting independent source progress through 90 can also lose a later
duplicate unless additional ordering/proof state exists. The single common watermark sacrifices repeated lookahead
work to avoid that cursor complexity. Repeated lookahead is charged again on every request.

All-rejected prefixes still move the watermark through the safe terminal range and may return an empty nonterminal
page. All-unknown prefixes do not. A Set only coalesces this window; the exclusive global order proves cross-page
deduplication. Per-source uniqueness is also an owner obligation: duplicate occurrences cannot hide arbitrarily many
input reads behind one returned candidate.

For a finite, quiescent candidate union, positive `q`, fixed canonical identity/bases, complete prefixes, and every
essential current decision becoming definitive after finite owner repair, the traversal terminates after finitely
many successful requests (ignoring account-token expiry/restart). Each nonterminal decided window consumes at least
one new union key. If all proofs are immediately definitive, at most `N+1` requests suffice for `N` candidate keys;
this loose bound includes small `P` and one exhaustion-confirmation request. It is not a latency bound.

Quiescence alone is insufficient if an absent relation witness remains `not_proven` forever. The current witness
handoff explicitly permits this for overflowing absence. Such a plan needs a stronger complete negative proof or
is not ready for guaranteed finite exhaustive traversal. A repair queue by itself proves neither convergence nor recall.

## Counterexamples that constrain admission

| Admitted-looking plan | Exact failure | Minimal honest change |
| --- | --- | --- |
| One public Search call used as one Zone source | `P=100`, three consecutive 200-hit raw windows all fail current checks: 600 source keys, no public subjects. A result cap cannot make this a 256-key request. With 16 such scopes the raw maximum is 9600. | Search-owned raw-prefix port with caller allocation; no public refill loop. |
| Ordinal Collection order and constant seen cursor | Occurrences `x, y1, ..., y257, x` can span pages; the final x repeats. Any fixed-size seen cache can be evicted before it. A single ID watermark cannot follow ordinal order. | Subject-order owner adapter; preserve ordinal occurrences on the ordinary Collection page. |
| `DISTINCT` over an ordinal/subject stream with LIMIT applied after dedup | A curated list begins with 257 occurrences of x, followed by y. Reading until a second distinct subject consumes 258 occurrence keys. The existing 5000 occurrence cap does not satisfy 256. | Seek directly to the next strictly greater subject ID using the existing subject index, or maintain an owner-owned unique canonical membership index. Do not scan the duplicate group. |
| Allocate 256 to each of 32 sources | 8192 raw keys, including rejected/lookahead keys. | One shared budget, `sum q_i <= 256`; our equal allocation is a simple sufficient schedule. |
| Promise 100 outputs under 256 with arbitrary residual filters | One source has 256 rejected candidates followed by one readable matching candidate at key 257. Even one output needs more than the cap for this plan. | Short/empty page with progress; improve the native index/admission, never silently enlarge the cap. |
| Raw ID order followed by terminal redirect resolution | Ordered raw keys `a < z`; a redirects to z and another occurrence/source contains z directly. Page 1 emits z from a; a later page emits z from its native key. A redirect can also move a survivor behind the committed watermark. | Canonical-order membership at the owner plus identity-basis restart. A point mapping alone does not reorder a raw source prefix. |
| A fixed hop cap presented as complete redirect resolution | A valid chain of length cap+1 exceeds it, regardless of page size. A cycle-detecting Set is still degree/history-sized. | Semantic terminal mapping with a proven fixed read bound and readiness during incomplete maintenance; no permanent loss of valid members. |
| Treat unknown as false in a negated scope | `NOT relation(p,v)` becomes true when all examined witnesses are concealed but an unexamined valid witness exists. | Three-valued Boolean evaluation and bounded owner witnesses; unknown cannot authorize output. |

The 256 number counts application-visible source candidate examinations, including adapter-internal candidate
reads, not just final IDs. It cannot honestly count every B-tree comparison, MVCC dead tuple or OpenSearch posting
as though raw hit `size` bounded those too. In particular Search's query can evaluate many postings and its total
collection can examine beyond the returned prefix. If “256 examined keys” is intended to cover *all engine work*,
the current Search backend does not establish it; admission needs a separate native cost contract, not this proof.

## Minimum native owner seams and indexes

Names in this section describe obligations, **not currently exported APIs**.

**Search:** expose a covered raw prefix with a caller's exact budget, shared admitted filter and `id` sort, actual
hit evidence, concrete generation, exhaustion/coverage and freshness. No hidden overfetch, refill, or synthetic hit
for a mounted subject. Export/reuse a current filter evaluator that accepts real Semantic candidate evidence for
non-Search sources; do not counterfeit indexed security revisions or clause matches. A Search-only index predicate
is admitted for Collection residual evaluation only if Semantic offers a bounded equivalent owner proof.
The existing keyword-ID order is usable; a new arbitrary sort over mounted private members is not.

**Collections/Library:** expose current Collection eligibility/basis and a unique canonical subject prefix for
curated, live built-in dynamic and adopted frozen public output through the same Collection identity. For unchanged
curated IDs, repeated `subject_id > previous ORDER BY subject_id LIMIT 1` seeks on the existing
`(route,collection_id,subject_id)` index can avoid scanning an occurrence run. `SELECT DISTINCT ... LIMIT q` is
insufficient without measured duplicate-independent native plans. An `EXISTS` membership point must stop after
one matching index entry; never count or load every occurrence.

Canonical aliases require more: keep a canonical key in the owner's member index, or complete an owner migration
before declaring that source ready. Preserve occurrence ID/note/order outside this union. Recheck source generation
and canonical coverage so a partially migrated Collection is not mistaken for complete membership. If a new
canonical member index is needed, it belongs to the existing Collection owner/store, not to Zones.

For Everything/state, the owner needs ordered unique subject membership and exact bounded current presence/state
proofs on the curator partition, including labels, sessions/history and holdings. A state-only entry index cannot
prove Everything, and enumerating all facts per subject is not a bounded point. Suitable owner indexes have keys
starting `(owner_route,owner_id,subject_id)` for unique presence and
`(owner_route,owner_id,profile/state identity,subject_id)` for states; a maintained bounded summary or bounded
first-witness probes for each personal fact kind must cover retained facts. These are required shapes, not claims
of existing built-in implementation. Missing label/session/holding presence seams block that adapter.

Public dynamic/frozen traversal additionally needs the specified shared monotonic publication generation, activation
and terminal freeze/revoke evidence. Frozen membership reads the last completely activated unique subject set;
erased private facts are neither an empty-query proof nor a reason to evaluate a retained predicate. Index that
existing owner output by Collection/generation/subject ID, with its shared source stamp. Do not create a second
public-membership authority. Unactivated output is withdrawn as specified.

**Semantic:** expose a small current subject identity/visibility/Access evidence read on each real subject anchor,
and bounded filter-leaf proof ports. It must not render full `readSubject`, enumerate arbitrary fact history or
walk redirects. Use ordinary Access, including the private grant path, current actor state and native public
eligibility; Global Context, Zone and Collection authorization cannot stand in for subject authorization.
Canonicalization evidence is not an allow decision: any original/terminal subject anchors required by the native
merge policy still need that policy's checks. A migrated membership must behave like the owner's ordinary current
membership, with no inherited loser grant or permission inferred from a terminal-ID cache. If those checks require
an arbitrary chain of anchors, the bounded adapter is still unavailable until the owner supplies a bounded policy-preserving seam.

Complete the declared witness identity index
`(route,subject_id,property,value,statement_id)`, recorded pair-witness point key
`(route,subject_id,property,value)`, bounded per-witness current evidence and durable rebuild protocol before claiming
relation-filter readiness. The handoff's at-most-33 witnesses per pair is only a contract proposal on this basis.
Descriptive filters likewise need bounded current value/range/qualifier evidence rather than a renamed source
snapshot that folds arbitrary history. Full rendering may follow for returned subjects under its own existing
page budget; it cannot be charged as a constant-cost candidate permission check.

**Identity consistency:** owners must expose an identity/canonicalization basis invalidated by merges and a
bounded terminal-ID proof. Owner canonical membership migration and Search index canonicalization must be safe
before admitting the new basis. A merge need not synchronously fan out through every Collection: affected sources
can be not ready while existing bounded maintenance converges. The exact terminal mapping and generation
invalidation seam is unsupported here and must be supplied by Semantic, not invented in Zone storage.

**Shared cursor owner:** use `tokens/list-cursor.ts`. Suggested compact position is `[watermark,basisDigest]`,
plus its existing epoch for resource incarnation, with query binding covering Zone ID, requested size, order and
canonical filter/configuration identity. Reconstruct/hash the bounded owner basis vector on every request, including
saved-filter revisions, membership/query/profile pins, index/publication/identity generations and readable source
set. Compare the authenticated previous digest to return stale/restart rather than silently changing meaning.
This fits the existing eight-key/256-byte-key envelope; 32 arbitrary source tokens generally do not.
No custom encryption, new TTL, or cursor snapshot is proposed.

## Authorization, changes and actual recall limits

Current means each owner's ordinary current evidence/Access decision at its native read, not a simultaneous
cross-owner authorization snapshot. Source membership and subject checks occur at different instants. Revalidate
required stamps when handing off evidence, fail closed on detected changes, and never cache an allow in the cursor.
A revocation committed after the final native read can race response delivery; a candidate-count bound cannot
eliminate this race. Account suspension/revocation must be checked again on resumed requests.

If a source becomes unreadable between pages, it contributes no IDs/metadata/counts; changing the readable source
set changes the basis and requires restart. Regrant likewise cannot silently resume with a different source set.
This does not authorize exposing which private source caused a restart. A Zone mount never broadens Collection
visibility or subject Access. Under concurrent edits there need not be a full response's worth of stable evidence;
return readiness/restart instead of combining mutually incompatible generations.

Duplicate canonical output cannot be promised across an identity-changing merge in a continuing live traversal
without restart or history state. Our guarantee ends at a basis change. New traversal duplicates are expected.
Binding the Search index generation alone is insufficient: same-generation documents and Collection rows change.
Identity invalidation must observe the canonical basis independently of ordinary listing freshness.

Catalogue recall remains index-relative. A matching subject absent from Search is not discoverable from that saved
scope; current rechecks can remove candidates but cannot manufacture missing ones. A readable mounted Collection
can independently supply it, after native proofs, without making it a Search hit. Late indexing/insertion or a
newly matching/unhidden member at `id <= watermark` is missed by that current-keyset traversal. Deletion and source
withdrawal can remove future results. A fresh traversal after convergence is required; `as_of`/freshness is not
a membership snapshot or proof that every eligible current subject was indexed.

Persistent unknown evidence, unavailable profile pins, incomplete canonical migration, and incomplete public
activation can delay or prevent exhaustive completion. They must not be converted to permanent empty sources.
Our recommendation pauses at essential unknowns; the existing Search skip policy would add further recall gaps.
Neither policy can promise finite complete traversal of every admitted relation query with the present witnesses.

Private rejected keys and predicates must remain encrypted even in anonymous continuations: a public source can
contain currently unreadable subjects. HMAC/base64 JSON exposes such keys to anyone decoding it. Existing encrypted
list cursors bind route, viewer and query, use the shared key ring, expire account tokens after 15 minutes, and keep
anonymous tokens deterministic and timeless. Encryption does not hide response length, traversal length, timing,
token equality or every inference from a public Collection's deliberate disclosure. Return no private count,
predicate, profile/state key, raw source cursor or private source diagnostic in the envelope.

## Work accounting

Let `E = sum e_i <= b0 + q*sum_i c_i <= 256` be **all** examined source candidate keys, including lookahead,
rereads and adapter-internal rejects; `U <= E` distinct keys are actually decided through the safe frontier.
The simpler `E <= K*q` applies only to one-examination adapters with no fixed overhead. Let `L_i <= 32` be expanded filter
leaves, `V_i <= 64` set values per leaf, `W <= 33` proposed relation witnesses per value, `A` the proven bounded
native Access work per anchor and `D` bounded descriptive-leaf work. None of `A`, `D`, or production `W` is proven
merely by counting subjects in this checkout.

With membership rechecks for every potential contributing source, conservative upper bounds are:

- Source discovery: `K` adapter windows, at most `E` logical candidate rows. Unique-seek Collections can require
  up to `K*(q+1)` seek statements including exhaustion checks; each seek costs index descent, not O(1) disk work.
- Merge/coalescing: `O(E log K)` comparisons with a heap, `O(E + K + P)` bounded window/output memory. No state
  grows with Collection size or traversal depth. A sorted small array is possible but costs `O(E*K)` comparisons.
- Current source eligibility: `O(K*A)` plus at most `U*K` membership point checks. Evaluating only sources that
  actually supplied a key can reduce this; the advertised worst case must retain K when every source overlaps.
- Subject native authorization: at most `U` distinct subject anchors, cost `O(U*A)` after canonical readiness.
  There is no redirect-length multiplier only if the promised fixed terminal mapping exists.
- Catalogue residual proof: conservatively `U * sum_i(L_i*V_i)` value probes; relation evidence may examine up to
  `U * sum_i(L_i*V_i*W)` witnesses, plus descriptive cost `O(U*sum_i L_i*D)`. Deduplicating identical probes within
  a request improves common cases but does not remove the worst case across different filters.
- For illustration, `256*32*32*64 = 16,777,216` pair probes and `553,648,128` witness examinations at W=33 are
  a conservative independent-cap envelope, **not** a recommended operational budget or a claim all maxima are
  simultaneously reachable by the chosen windows. Even `U=8` with 16 overlapping saved scopes gives 262,144
  distinct-value probe slots before witness amplification. A 256-input batching cap limits one call, not all calls.

Only checking sources that actually supplied x gives a tighter total of at most `E` source/key pairs for
one-examination prefixes, hence at most `E*max(L_i*V_i)` pair-probe slots. The overlapping-source case still costs
K per union key. The looser `U*K` accounting above also covers an adapter that probes additional sources; such
probes must obey both the point ledger and any candidate charges, not obtain free work from deduplication.
Materializing all pending probes uses `O(U*sum_i L_i*V_i)` additional memory. A bounded batch can reduce working
memory, but query representation, proof results and response bytes also need limits; merge memory alone is not
the full request-memory bound.

Plan admission therefore also needs a shared per-request point/witness/byte budget, charged before starting a key;
stop before that key when the remaining budget is insufficient. A plan whose single key exceeds the admitted
native work must be unsupported/not ready until its owner supplies a better index, rather than retried forever
as though the candidate cap solved it. This is a recommendation for owner adoption, not a second filter registry.

Index seeks still have `log N` descent, physical buffers, contention and MVCC costs. Search raw-hit allocation
does not bound shard postings, total-hit accounting, sorting, or network latency. Current snapshots may contain
large descriptive histories. Measure native plans and enforce existing shared deadlines/cost classification;
no wall deadline or claim of “fast” follows from these candidate numbers.

## Minimum native acceptance and owner split

These are implementation handoff outcomes, not new tests or code in this research change.

1. **Search owner:** prove raw prefix coverage before disclosure, exact caller budget including rejected/lookahead
   hits, real generation and failure semantics; 600-rejected public-loop fixture must not enter a Zone request.
   Test actual filter expansion/negative/overflow evidence and missing production probe readiness.
2. **Collection owner:** ordinary curated duplicates/order/notes stay intact; subject-order union seeks remain
   bounded with 257 and then 5000 repeated occurrences. Native Everything/state reads include every specified
   fact kind; public/private/unlisted/frozen output retains one identity and current Access. Test missing pins,
   monotonic revocation, account deletion freeze, older events and no unactivated output disclosure.
3. **Semantic/Access owners:** small permission/evidence port matches native decisions for owner, other account,
   anonymous and suspended viewers. Assert no full `readSubject`, history scan or redirect loop. Test chain beyond
   any proposed hop bound, canonical merge across pages and source migration readiness; generation changes restart.
   Implement witness indexes/current provenance checks and prove actual examined rows per point, both filter signs.
4. **Shared cursor owner/adopter:** encrypt rejected private keys; byte-inspect tokens and verify no plaintext IDs
   or predicates. Test viewer/route/Zone/filter/page-size/basis mismatch, tamper, stale basis, key retirement,
   account expiry and anonymous deterministic timeless behavior through the existing codec.
5. **Zone integration:** native K=32, P=1/100, unequal frontiers `[10,20]` versus `[15,90]`, repeated lookahead,
   all-rejected windows, all-unknown windows, one true among unknown OR sources, inaccessible source and subject
   revocation between pages, missing Search candidates with/without mount, late candidates behind watermark,
   duplicates across sources/pages, changed definitions/profile/query/publication/identity basis. Assert total
   raw candidate accounting <=256, independent point budgets, no counts/private details and correct null semantics.
6. **Growth checks across owners:** fixed P/K at three increasing source sizes, first and deep pages; record rows
   examined, buffers, seeks, probe/witness counts, bytes and shared cost classification. Include sparse matches,
   high duplicate multiplicity, large subject history and many unrelated personal facts. A result-length assertion
   or mock-only merge test is insufficient. Cover every new index with the actual native query plan.

The manager can adopt this split without authorizing an alternate store. Search supplies coverage/evaluation;
Collections own all membership and publication; Semantic owns bounded evidence/canonical identity; Access and the
shared cursor protocol retain their existing authority; Zones compose evidence and presentation only.

Decisions made for this recommendation: common canonical-ID order instead of mixed native orders; one global
watermark instead of source-vector/seen history; equal conservative source allocation with short pages; essential
unknown proofs preserve their position; restart on source-set/identity/meaning changes; current-keyset rather than
snapshot recall. Unproven dependencies are explicitly the raw prefix adapter, bounded current native evidence,
canonical-order membership/terminal mapping, dynamic implementation and safe public generation/freeze adapters.
Until those owner tasks pass native acceptance, the requested guaranteed union is not implementation-ready.

Research validation: the report existence acceptance passes. An in-memory exhaustive model checked 36,864 finite
window cases: all three-source combinations of subsets of four ordered keys, window size two, requested sizes
1/2/4, and no/alternating/all rejected keys. It matched the distinct filtered union and terminated in every case.
This checks the finite ordering argument only; it does not establish native index plans, authorization, repair
convergence or concurrency guarantees. No product tests or frozen files were changed.
