# Bounded Zone unions over saved scopes and Collection mounts

Research evidence, reviewed 2026-10-28; this report does not adopt a contract or implement a query engine.
Authority is [first public scope](../scope.md) and the supplied Zone skeleton, read at
`/home/edge/projects/rezics/rezics-next/.temp/goal/semantic/zones-shared-skeleton.md` because it is absent from this worktree.
The skeleton describes a routed site over at most 16 saved scopes and 16 Collection mounts, with current viewer Access,
deduplicated subjects, opaque continuation, and no complete live count. Collection semantics come from
[Library and Collections](../library-and-collections.md) and [Dynamic Collections](../dynamic-collections.md).

## Answer and its boundary

Recommend a **subject-ID ordered union of bounded source prefixes**, with one shared examined watermark and current
owner checks. Merge only the prefix that every source has covered. Re-fetch unused bounded tails on the next request;
do not serialize a growing seen-ID set or prematurely consume another source's tail. This needs additive owner adapters,
not a Zone membership database. The existing curated Collection subject index already supports its essential seeks.

The proof below establishes bounded application candidate/probe work and finite traversal of a finite, quiescent
candidate union. It does not establish complete recall from lagging Search, unresolved witnesses, redirects, or an
unready dynamic publication. Full pages, an exact count, and a live snapshot spanning owners cannot all be inferred
from bounded source pages. Source completeness is a separate prerequisite, not a property invented by the merge.
All numerical budgets below are REZICS choices, not external standards.

## Primary-source precedent

Reference roots below are relative to `/home/edge/projects/rezics/rezics-next/.reference/`. Existing clones were reused;
no third-party software was installed, built, or executed. Sparse PostgreSQL source was inspected with `git show`.

| Project and retained clone | Pinned commit; licence | Relevant source and finding |
| --- | --- | --- |
| BookLore, `shelves/booklore` | `01b3407528a6ce00d064dbb9aa3f69b72d82641b`; AGPL-3.0, `LICENSE` | [`MagicShelfService.java`][book-shelves] persists filter JSON beside shelf identity; [`BookRuleEvaluatorService.java`][book-rules] compiles nested rules to database predicates and requests distinct entities after multi-valued joins. |
| Open Library, `partitioned-sitemap-feeds/openlibrary` | `37e446827465be2febad416de1bc18753b66997d`; AGPL-3.0, `LICENSE` | [`openlibrary/core/lists/model.py`][ol-list], `get_work_keys` and `_get_solr_query_for_subjects`: list seeds can map editions to works, produce duplicate work keys, and form an OR of seed search terms. |
| PostgreSQL, `library-shelf-maintenance/postgres` | `700b422af7e26cf310caf3fb76d78f4c8ca39c1f`; PostgreSQL License, `COPYRIGHT` | [`nodeMergeAppend.c`][pg-merge] merges children sharing an ordering; [`nodeUnique.c`][pg-unique] removes adjacent equal tuples while retaining the previous tuple. |
| OpenFGA, `search-visibility-witnesses/openfga` | `57b39bc3dcc12f92270602bc01eb933ca4accfbe`; Apache-2.0, `LICENSE` | [`pkg/server/batch_check.go`][fga-batch], `BatchCheck`: resolves the authorization model, accepts consistency preferences, and configures batch size and concurrency separately. |

BookLore's [`service/opds/MagicShelfBookService.java`][book-page], `getBooksByMagicShelfId`, validates shelf access,
adds the user's library restriction, pages the database result, then applies content restrictions. It preserves the
database total after that filtering. This is precedent for saved predicates, source authorization, identity deduplication,
and residual checks; it is **not** evidence that the total counts visible books or that underlying examinations are capped.
Its offset pagination and `DISTINCT` query are not the proposed cross-owner algorithm. Open Library's seed expansion
likewise supplies a portal pattern, not a bounded private union or an access-recheck proof. These are observations of
specific paths, not security assessments of either project.

PostgreSQL's [UNION documentation][pg-union] says duplicates are eliminated on whole result rows and append order is
not guaranteed. Deduplicate on subject identity before attaching occurrence notes or source metadata; those columns
would make otherwise identical subjects distinct. Its [LIMIT documentation][pg-limit] requires a predictable ordering
and notes that offset rows still need computing. [Multicolumn indexes][pg-index] and [index ordering][pg-order] explain
why equality on the source prefix followed by a subject range can supply the bounded ordered prefix. `MergeAppend`
and `Unique` demonstrate ordering-based deduplication; neither alone caps how many rejected input tuples a page examines.

The official [Auth0 FGA search guide][fga-search] separates business filtering/sorting from authorization, describes
search-then-batch-check, and warns that a database page may contain no authorized results. It also describes permission
indexes and enumerating authorized IDs first. Neither alternative is required here; enumerating all accessible IDs
violates this task's bounds, and a per-viewer permissions catalogue would introduce an unwanted authority/projection.
OpenFGA's source supports batching as a mechanism; batch/concurrency limits do not prove bounded graph work per check.

[Google AIP-158][aip] is an API design guideline, not a pagination standard. It explicitly permits short or empty
nonterminal pages, requires tokens to be opaque, and says a token never replaces authorization. Base64 alone is
insufficient opacity. [OpenSearch pagination][os-page] distinguishes stateless `search_after` from a retained PIT;
changing data can change traversal. [Collapse][os-collapse] groups hits within its own index and constrains
`search_after` sorting to the collapse field. It cannot deduplicate private Collection rows held by another owner.
[RFC 7516][jwe] specifies authenticated encrypted content, distinct from signing/MAC mechanisms; it is precedent for
confidential tokens, not a requirement to introduce JOSE or new Zone-local cryptography.

Shared patterns are saved descriptors separate from catalogue records, explicit result identity, common ordering for
stream deduplication, source access before enumeration, residual authorization, and a stated consistency boundary.
No inspected source establishes REZICS's 16/100/3/600/32 limits, guarantees bounded exact authorized counts, or proves
complete union recall under concurrent writes. Repository licences above govern those sources; recommendations below
are independently described designs for the existing TypeScript/PostgreSQL/OpenSearch stack, not copied implementations.
Web documentation remains under its publishers' notices; RFC 7516 carries the IETF Trust/BCP 78 notice.

## What the worktree has, and what it does not

The inventory was checked against worktree base `7fe0308d4164e3d9b9ffe37fba1365cab3790ab9`.

| Owner and existing surface | Exact capability and limit | Additive seam needed |
| --- | --- | --- |
| Composition: [`packages/composition/src/zone.ts`](../../packages/composition/src/zone.ts), `validateZoneStarter` | Eight locale labels, at most 16 sorted pages including home, at most 16 distinct known saved-filter IDs. Inert configuration, no Zone query or mount storage. | Semantic supplies revisioned Zone configuration and ordered source descriptors; the skeleton adds at most 16 distinct mounts. |
| Shared Filter: [`packages/filter/src/filter.ts`](../../packages/filter/src/filter.ts), `parseFilter`, `admitFilter` | Expands release-owned saved filters; expanded document has at most 32 leaves, depth 4, OR 16, IN 64, qualifiers 4. Qualifiers count toward leaves; nested saved definitions are rejected. | Reuse admission for each scope and bind the accepted release and expanded meaning. Sixteen individually valid scopes do not imply that one combined OR fits 32 leaves. |
| Search: [`src/search/service.ts`](../../services/kernel/src/search/service.ts), `createSearchService().search`; [`query.ts`](../../services/kernel/src/search/query.ts), `searchSubjects` | Public search supports `sort: 'id'`, result limit 100; at most three rounds of up to 200 raw hits each. `searchSubjects` accepts `after` and raw size up to 200. Search's result cursor advances through consumed rejects. | Owner-internal ordered **raw candidate prefix** with caller-controlled examination quota, generation, exhaustion and source freshness. The public filtered page hides rejects and unconsumed lookahead, so it cannot provide the merge frontier. |
| Search/Semantic: [`source.ts`](../../services/kernel/src/search/source.ts), `SubjectSource.read`, `matchRelationFacets`; [`disclosure/check.ts`](../../services/kernel/src/search/disclosure/check.ts), `checkHits` | Reads named subject anchors; relation point probes accept at most 256 per call and return `true`, `false`, or `not_proven`. `checkHits` checks current security revision and the original admitted Boolean filter. It is not an exported arbitrary-subject saved-scope membership API and does not receive the viewer. | Bounded subject-point evaluation of an admitted scope, including native subject Access, complete-negative evidence and supported qualifiers/ranges. Expose existing owner semantics rather than synthesize fake Search hits. |
| Collection reads: [`collection-reads.ts`](../../services/kernel/src/library/collection-reads.ts), `readCollection`, `listMembers` | Current `collection:read`, account/authentication checks for private reads, active-state gate; member page consumes at most 100 occurrences plus one lookahead, then applies subject readability. Native keyset is ordinal/member ID and binds order epoch. | Same source eligibility as direct reads, plus an internal subject-ordered candidate prefix and point `containsSubject`. Native curated ordering and occurrence DTO stay intact. |
| Curated store/index: [`20261025164011_library_collections.sql`](../../services/kernel/db/library/migrations/20261025164011_library_collections.sql); [`20261025170530_library_subject_listing.sql`](../../services/kernel/db/library/migrations/20261025170530_library_subject_listing.sql) | PK `(route, collection_id, member_id)`; unique ordinal index; **existing** `collection_member_subject(route, collection_id, subject_id)` supports a named Collection's subject seek and existence probe. Store `readMember` addresses an occurrence ID, not a subject. Repeated subjects are allowed. | A read-only owner adapter over that existing index, not a new global index. `subject_id > h ORDER BY subject_id LIMIT q` may return repeated IDs; equality existence uses `LIMIT 1`. Neither needs to enumerate all duplicates. |
| Public Collection listing: same migration; `listSubjectCollections` | `subject_collection` PK `(route, subject_id, collection_id)` and `subject_listing` public counters are subject-anchored public projections; they are not private/current Collection membership. | Do not use these counts or public reverse rows to answer private mount membership. Probe the Collection's own partition. |
| Dynamic Collections: [`docs/dynamic-collections.md`](../dynamic-collections.md) | Explicitly specification-only here. Built-in Everything/state identities, current-keyset subject order, candidate budget `4P <= 400`, profile pins, and publication/freeze semantics are specified. Curated runtime DTO still has `memberCount` and no dynamic discriminator. | Library supplies both prefix and point adapters for built-ins and retained published generations. Existing curated routes and shelf helpers are not evidence that this seam already runs. User-saved dynamic queries remain later scope. |
| Shared tokens: [`tokens/cursor.ts`](../../services/kernel/src/tokens/cursor.ts), [`tokens/seal.ts`](../../services/kernel/src/tokens/seal.ts) | Binding, key rotation, eight key components, 4,096-character decoder ceiling, timestamp and 15-minute expiry. `seal` uses base64 JSON plus HMAC: integrity, **not encryption**. Search binds principal/request/generation; curated member binding currently names only the Collection. | Shared owner must supply the confidential cursor capability already required by the dynamic spec, including its anonymous/account policy. Do not reuse the existing signed payload for a rejected/private subject watermark or create a Zone-local codec. |

The last two rows are real readiness gaps, not reasons to claim existing runtime support. In particular, the dynamic
spec's encrypted, timeless anonymous cursor is not supplied by the inspected timestamped HMAC codec. The manager can
adopt the needed shared seams without this report changing either authority or broadening first-scope saved queries.

## Proposed minimum owner adapter contract

These are recommendations, not existing API names. For each configured source, the owner supplies:

1. `describe(viewer)`: current readable/active eligibility, immutable source identity/incarnation, query/profile/release
   basis and projection generation where applicable. Missing and forbidden are indistinguishable to the caller.
2. `prefix(viewer, basis, afterSubject, quota)`: at most `quota` ordered internal candidates, with identity keys,
   `exhausted`, source stamp/freshness and enough internal evidence for rechecking. It covers a contiguous prefix of
   its candidate stream strictly above `afterSubject`; it does not refill after residual filters. Zero rows mean
   exhaustion, or an explicit error, never an unexplained nonadvancing continuation. Truncation/timeouts are errors.
3. `containsSubject(viewer, basis, subjectId)`: bounded current `true | false | not_proven` membership, with eligibility
   and basis checks. No Collection pagination, account scan, or Search enumeration to answer this point query.
   Batches are grouped by the owning partition and capped, with separate limits on in-flight calls and underlying probes.

Curated prefix and point membership use `collection_member_subject` after authorizing the Collection. Point membership
is existential over occurrences, not their multiplicity. Dynamic private reads use the curator's retained fact indexes;
Everything needs a bounded existence result for state/labels/retained sessions/holdings, excluding empty entry shells.
State views use their exact profile/state/release identity. Library must admit an indexed plan for each source, including
ordered candidate selection before residual checks; an activity-ordered shelf helper alone is not this proof.
Public/unlisted dynamic reads use the ordinary activated publication or frozen adopted set and current eligibility,
not another viewer's private predicate/facts. Unavailable profile meaning, incomplete publication, or a stale source
stamp cannot become a guessed empty set or authorize old results. Use the shared publication/freshness owner.

Semantic owns current subject identity, visibility/fences and filter evidence; Search owns raw indexed discovery;
Library owns curated/dynamic membership, source stamps and Collection authorization; Access owns native checks;
shared Query/List/Tokens owns continuation. Zone only composes these results. Admission rejects unsupported plans
before enumeration; a runtime dependency failure fails the page rather than pretending a source is exhausted.

For `readPage({subject})`, authorize the Zone, check the requested current subject anchor, then OR at most 32 source
point results under the same viewer. A single current `true` suffices. If none is true, withhold the target using the
ordinary non-disclosing unavailable/not-found behavior; unknown is not a proof of nonmembership. Related reads still
use their native owners and do not gain Zone membership rights. Mounted metadata pages inspect only the bounded mount
list and emit safe fields from currently readable Collections; omit predicate/profile descriptors and candidate counts.

## Concrete prefix algorithm

Choose a first Zone union order of ascending subject UUID, identical byte/keyword ordering in every adapter. Emit only
current nonredirect identities; consume redirected stored IDs as rejects, never rename them after ordering. An adapter
that canonicalizes identities must do so before establishing its ordered prefix. This recommendation does not change
a Collection's native ordinal page or offer relevance/name union sorting. Let
`K <= 32` be configured sources, `1 <= P <= 100` the output cap, and `h` the last examined identity (initially bottom).
As one conservative **new local allocation**, give each readable source
`q = min(100, floor(600 / K), 4P)` raw rows; handle `K = 0` without division. Then `q >= 1` and total raw rows `B = Kq <= 600`.
Counting inaccessible sources in K is harmless. One raw request per scope is within, not an expansion of, Search's
three-round/600-hit ceiling; the existing public search call cannot implement this quota because it refills internally.
Dynamic and curated adapters must charge every examined candidate, not only retained rows, to their native budgets.

1. Authorize the Zone and validate cursor binding/current basis. Describe all bounded sources using this viewer.
   Read no candidates for an inaccessible, revoked or deleted source. Such sources supply no rows and no limiting frontier.
2. Fetch each readable source's raw prefix above h with quota q. For a nonexhausted source, let `f_i` be its last returned
   subject key; for an exhausted source use positive infinity. Let `F = min(f_i)`, or infinity when all are exhausted.
3. Merge fetched rows by subject key, grouping equal keys across sources and occurrences. Only process keys `<= F`.
   For each group x, obtain current subject eligibility and OR the bounded owner membership checks, short-circuiting
   on true if appropriate. Checking all readable sources can recover a true membership whose own index did not propose x.
   Emit x once only on current subject permission and membership true. Recheck current source eligibility/stamps as
   part of the owner proof; a cached description is not an authorization grant. Unknowns and denials produce no row.
4. Advance h to each examined group even when rejected. Stop immediately after P outputs, or after the safe prefix.
   Never advance beyond an unprocessed group just because another source fetched a higher tail. Discard unused fetched
   tails; the next request seeks above h again. If the safe prefix was fully processed and F is finite, h can reach F.
5. Return `{subjects,next}` and the owner-defined freshness surface. `next` is null only when every source exhausted
   and every fetched identity was processed. Otherwise encrypt the bound continuation with h. A full quota without
   explicit exhaustion can conservatively cause one final empty terminal request. Empty nonterminal pages are valid.

Example: A fetches `[2,5]`, nonexhausted; B fetches `[3,9]`, nonexhausted. The safe frontier is 5. Examine `[2,3,5]`,
deduplicate and check Access; retain h=5 if all three fit. B's 9 is fetched again later. With P=1, stop at 2 instead.
Serializing B's last raw cursor at 9 would lose 9; advancing globally to 9 would also skip A's unseen keys between 5 and 9.
If a curated prefix ends halfway through 500 occurrences of subject 5, h=5 skips the remaining equal identities on the
next indexed seek. No DISTINCT over the complete Collection and no scan of all 500 occurrences is needed.

## Work, deduplication and termination proof

Assume adapters satisfy the prefix, bounded point-read and identity requirements. Across a request, raw rows are at
most B; merging costs `O(B log K)` or sorting the bounded buffer `O(B log B)`, with `O(B + K)` memory. At most B distinct
groups are examined, at most BK membership decisions are requested, and at most B subject Access checks are needed
(plus a bounded final revalidation before serializing results). With the proposed limits, BK is at most 19,200.
Each catalogue scope still has at most 32 expanded leaves; all 16 scopes could involve 512 leaves across separate plans.
IN values, qualifiers and bounded witnesses multiply point work; they do not disappear inside the word “batch”.

More precisely, if each admitted point decision costs at most W bounded anchored probes, page authority work is
`O(K + B + BKW)`, plus indexed seeks with logarithmic index-depth cost. Source partition fanout is bounded by selected
anchors, not catalogue/account size. There is no SQL join across owner partitions. A `LIMIT` on a residual predicate
that scans arbitrary rows to find q matches is forbidden: select q indexed candidates first, then check them. Search
engine inverted-index execution has its own cost; a bound on returned engine candidates is not a constant Lucene CPU
or wall-clock guarantee. PostgreSQL physical work also needs plan/buffer evidence, not a LIMIT assertion.

The current `checkHits` scans `subject.statements` in `holds`, so its cost retains a per-subject fact-size term. Likewise,
Library's [`subject-anchor.ts`](../../services/kernel/src/library/subject-anchor.ts), `resolveSubject`, follows redirects
until termination/cycle without a fixed hop cap. Neither helper's request-count limit proves fixed per-candidate work
independent of fact/redirect degree. The owner seam must use bounded admitted anchor probes/current nonredirect reads,
or a capped operation returning unknown; do not hide a full snapshot/redirect traversal inside W. No new proof of
existing Semantic source completeness or bounded full snapshots is claimed here.

For deduplication, all emissions in a response are grouped on the same identity. Every subsequent request seeks
strictly above the last examined identity h, so an emitted identity can never appear again along that continuation
chain. A cursor replay can repeat a response; there is no cross-client exactly-once delivery promise. Cursor state
contains a single watermark and bounded basis digest, not emitted IDs, per-account catalogue membership, or source buffers.

For finite traversal, assume writes, access/basis changes and repairs stop, candidate streams are finite and ordered,
all required calls eventually succeed, and the client follows next. Every nonterminal request with remaining
candidates advances h to at least one new key: a nonexhausted prefix has a last key greater than h; the minimum such
frontier occurs in a fetched prefix. If all sources exhaust, either a fetched group advances h or traversal terminates.
Thus at most U advancing responses plus a terminal response suffice for U distinct fixed candidate identities above
the initial h. Re-fetching tails costs extra bounded work per response but cannot prevent progress. Persistent unknown
membership can suppress every output while traversal still terminates. Expiry or a basis change requires restarting;
this is a mathematical traversal bound, not a promise that a large traversal completes within one token lifetime.

## Mutation, identity, negative evidence and disclosure

Bind operation/route, Zone identity/incarnation/revision, ordered source-set and admitted scope digest, semantic release,
query/profile pins, relevant index/projection generations, sort/filter/page size, viewer identity and authorization
context, watermark, and shared key/expiry policy. Compress the bounded basis vector into a server-verifiable digest;
do not pack 32 raw owner tokens into the eight-key codec. Check basis again on continuation. A changed meaning or
generation requests restart; ordinary member insertion/removal need not invalidate every cursor. Current account
state, scope/grant eligibility and each resource's current Access are checked again, regardless of token validity.
Follow the shared owner's anonymous/account lifetime rules; do not introduce a separate Zone lifetime policy.

Current-keyset semantics mean insertion or newly granted membership at/below h can be missed until restart; deletions
and revocations remove subsequent disclosures; additions above h can appear. A source becoming readable after h does
not rewind it. A deleted/revoked mount is skipped without disclosing its ID, reason or counts; undeleting a new
incarnation or changing the Zone's configured source set invalidates the old basis. An ongoing cross-partition read
has per-owner check linearization points, not an atomic global authorization snapshot. Revocation completed before
the relevant current check must suppress output; no design can retract data already disclosed before revocation.

Recommend current, nonredirect subject IDs as the union keys, matching Search's exclusion of redirects. Do not resolve
old Collection IDs to survivors *after* paging: two old IDs on different pages can map to the same survivor and defeat
the watermark proof. Existing curated member reads preserve stored IDs even when readability resolves a redirect.
Library must certify canonical source keys/membership, or conservatively withhold redirected stored rows pending owner
repair. A capped resolver may return unknown but cannot manufacture an ordering-preserving canonical stream. Complete
recall of a survivor mounted only through an old ID requires an owner-maintained canonical seek/point path; it is not
supplied by the stored-ID index alone. No global private reverse-membership table is proposed to solve this gap.

Use the existing three-valued filter semantics: `NOT unknown = unknown`; OR is true with one true operand, false only
when all are false; AND is false with one false operand, true only when all are true. Bounded witness failure is unknown,
not absence. A false negative leaf requires owner evidence that the relevant current range is complete. Unsupported
qualified overflow/range plans fail admission rather than silently returning false. Source I/O failure is an error,
not Boolean false. Unknown groups are consumed and withheld; later repair below h requires a fresh traversal.

Do not forward Search totals/facets, Collection member counts/multiplicity, raw owner cursors, hidden source labels,
private descriptors, or rejected IDs. The watermark itself can be a rejected private subject ID, so HMAC/base64 is
insufficient even for anonymous viewers: encrypt through the shared token owner. A fixed bounded token encoding can
also avoid exposing the number of pending source positions. Viewer-dependent output must use the existing private
cache policy and bindings, never an owner-privileged public cache entry. A public Zone grants no Collection permission.
Freshness reports readiness/lag conservatively without private partition positions, candidate totals or source reasons.
Empty pages and opaque continuation do not establish traffic/timing noninterference or zero information in page count;
no such stronger claim follows from this design. They expose no raw private IDs or numeric private membership counts.

## Counterexamples and adoption recommendation

With a candidate budget C, put C unreadable candidates before the first readable result. A fixed-work request must
underfill; scanning until it fills violates the budget. With a relation witness beyond every bounded alternative,
failure to find it cannot prove a negative filter. With a true match absent from every candidate index, no merge can
discover it. Settling writes does not by itself settle repair or make a bounded unknown definitive.

Without a common identity order, two occurrence-ordered Collections can repeat an arbitrarily late subject from a
previous page. A page-local Set fails; a growing Set violates stateless bounds. An alternative is source-major order
with a canonical first matching source and first occurrence, using point checks against all earlier sources. That
requires definitive exclusion/earliest-occurrence evidence, can suppress results on unknowns, and can repeat a subject
when live membership moves between sources. It is less attractive than subject order for this first union surface.
Copying private memberships into Search, UNION DISTINCT over full owner tables, and LIMIT-after-Access filtering do
not repair these problems within the declared ownership and work constraints.

The manager can adopt the subject-order prefix algorithm and its conditional proof, then request four minimum seams:
Search raw prefixes under explicit quotas; Semantic bounded current scope/subject points with truthful negatives;
Library curated and built-in dynamic prefix/point adapters with canonical identity and publication stamps; and shared
confidential, fully bound cursors. No new index is needed for ordinary curated stored-ID seeks. Dynamic/canonical source
indexes require their owner's plan evidence. Until these seams exist, the public Search and Collection APIs cannot
honestly be composed into the stronger bounded canonical union contract. This is a concrete dependency finding,
not permission to implement a parallel membership authority.

Future owner verification should cover overlap across pages, many duplicate occurrences, asymmetric source frontiers,
all-rejected/unknown empty pages, direct subject membership without enumeration, positive/negative witness uncertainty,
source/subject revocation and deletion, redirects, profile/basis changes, cursor replay/tampering/viewer mismatch,
anonymous token confidentiality, and indexed row/buffer growth at fixed quotas. These are proposed adoption checks;
this research task adds no product tests and makes no claim that those integrations have passed.

[book-shelves]: https://github.com/booklore-app/booklore/blob/01b3407528a6ce00d064dbb9aa3f69b72d82641b/booklore-api/src/main/java/org/booklore/service/MagicShelfService.java
[book-rules]: https://github.com/booklore-app/booklore/blob/01b3407528a6ce00d064dbb9aa3f69b72d82641b/booklore-api/src/main/java/org/booklore/service/BookRuleEvaluatorService.java
[book-page]: https://github.com/booklore-app/booklore/blob/01b3407528a6ce00d064dbb9aa3f69b72d82641b/booklore-api/src/main/java/org/booklore/service/opds/MagicShelfBookService.java
[ol-list]: https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/core/lists/model.py
[pg-merge]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeMergeAppend.c
[pg-unique]: https://github.com/postgres/postgres/blob/700b422af7e26cf310caf3fb76d78f4c8ca39c1f/src/backend/executor/nodeUnique.c
[fga-batch]: https://github.com/openfga/openfga/blob/57b39bc3dcc12f92270602bc01eb933ca4accfbe/pkg/server/batch_check.go
[pg-union]: https://www.postgresql.org/docs/18/queries-union.html
[pg-limit]: https://www.postgresql.org/docs/18/queries-limit.html
[pg-index]: https://www.postgresql.org/docs/18/indexes-multicolumn.html
[pg-order]: https://www.postgresql.org/docs/18/indexes-ordering.html
[fga-search]: https://docs.fga.dev/integration/advanced/search-with-permissions
[aip]: https://google.aip.dev/158
[os-page]: https://docs.opensearch.org/latest/search-plugins/searching-data/paginate/
[os-collapse]: https://docs.opensearch.org/latest/search-plugins/searching-data/collapse-search/
[jwe]: https://www.rfc-editor.org/rfc/rfc7516
