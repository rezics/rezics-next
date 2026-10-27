# Zone membership and current disclosure

This is the first-public-scope query/access outcome contract under [scope](scope.md).
Resource lifecycle and presentation are separate from membership. A Zone is a routed site over existing catalogue
scopes and CommonCollection identities. It is neither a catalogue authority nor a second personal library.
[Deletion](deletion.md), [Collections](library-and-collections.md), and
[dynamic Collections](dynamic-collections.md) retain their owner policies.

## Observable membership

For Zone Z, viewer V and the current request, eligible subjects are:

`distinct(union(admitted saved scopes, readable mounted Collection subjects)) intersect current subject Access(V)`.

The Zone itself must first be readable by V. Zone grants and visibility do not confer any source or subject rights.
A mounted Collection contributes only while its owner authorizes its disclosure to that viewer. Public Zone output
cannot reveal private mounts, even if its editor can read them. CommonCollection alone owns curated occurrences
and built-in dynamic membership. Repeated occurrences, overlapping mounts and overlapping saved scopes contribute
a subject once. The Zone stores only bounded source descriptors, never a membership mirror, seen-subject history,
personal state, profile pins, progress, notes, copies or a second list model.

The first scope accepts released saved catalogue filters and curated/built-in dynamic Collections. User-authored
dynamic queries remain deferred. Validate saved references and expanded filters at admission against the current
shared Search/semantic filter registry. Reject unsupported plans with `422 unsupported_query` before executing
source enumeration; do not evaluate arbitrary predicates over all catalogue or library rows. An unknown saved ID
is invalid configuration, not an empty membership source. No local property whitelist replaces shared admission.

## Native routes and projections

- `POST /v1/zones` takes `{configuration,mounts,visibility}`. Configuration is the validated ZoneStarter with
  eight-locale labels, sorted relative pages including home and at most sixteen saved-filter IDs in `scope`;
  mounts contains at most sixteen distinct existing Collection IDs. Resource creation uses Global parent authority
  and ordinary initialized Zone owner grants. Query code must not invent a bypass for that authority.
- `GET /v1/zones/{id}/subjects?limit=P&cursor=...` returns `{subjects,next}` with explicit freshness using the
  shared listing protocol. Each subject has its canonical `id`; other fields obey their owners' DTO contracts.
  No union total is implied. `P` is in 1..100, default 20. Underfill, including an empty page with non-null continuation, is legal.
- `GET /v1/zones/{id}/collections` returns `{collections,next}` and shared freshness. Omit unreadable mounts
  entirely, including their IDs, labels, descriptions, counts and source positions. A curated count may be shown
  only under its Collection owner's disclosure; it is not an accessible-subject or Zone-union total.
- `POST /v1/zones/{id}:readPage` accepts `{target:{route}}` or `{target:{subject,view?},languages?}`. It returns
  the shared presentation result plus safe Zone shell metadata. A subject target must satisfy membership and
  current subject Access. Configured routes cannot shadow reserved `subjects` routing. Global subject URLs remain
  canonical. A related reference does not become a Zone target automatically: its owner independently decides
  whether to disclose its link, label and fields.

Unknown, unreadable, deleted and fully withheld Zones or subject targets have the same `404 not_found` problem,
apart from request-specific diagnostics. Do not echo the tested hidden ID, source, label or count. Navigation,
metadata, cursors and any future facets obey the same rule as the primary rows. No public configuration projection
may serialize a hidden mount. Zone facets are not a new first-scope endpoint; should they be added, raw source
facets/totals are insufficient evidence for accessible union counts.

## Mutation, freshness and continuation

Every page rechecks current Zone, source and subject rights. A cursor issued before a source becomes private,
loses a viewer grant, is deleted or withheld cannot preserve access. A subject suppressed after issuance must not
appear in continuation or a direct Zone target read. Restore within the owner's thirty-day policy permits fresh
reads again; it does not promise that a pre-restoration traversal will revisit a key already passed. Takedown is
reversible withholding, never a purge. Public visibility revocation is tested independently of deletion.

For a dynamic Collection, public membership may disclose the curator's adopted subject selection, never the private
facts or predicate that produced it. Changing a private copy note, progress value, label, profile pin or state detail
without changing adopted membership must not change any public Collection-derived fields or counts. A private
fact value cannot be smuggled through a public label, facet bucket, source descriptor or opaque token payload.

Continuation uses the existing encrypted `tokens/list-cursor.ts` `encodeListCursor`/`decodeListCursor`.
Keep its existing eight position keys, at most 256 bytes per string key and 4096-character token limit; do not nest
32 owner tokens. Anonymous tokens remain deterministic and timeless; account tokens retain the shared fifteen-minute
lifetime. No new codec, key policy or TTL is introduced. Stable operation/route, Zone ID, viewer and request shape
belong in authenticated binding. Changing configuration, admitted query/release/profile, owner order/index and
canonical identity basis belong in a bounded digest **inside the encrypted position**. Decode under the stable
binding, then compare the current structural basis so a valid stale cursor receives `stale_cursor`, rather than
being mistaken for tampering. Transferring a cursor between viewers, Zones or request shapes is invalid. Appearance
need not change membership semantics; language/view bind when they affect the page. A basis never carries an allow
claim: every continuation rechecks current Access even when that basis is unchanged.

### Ordered settled prefixes

All sources cover a common ascending **canonical subject-ID** order. Each owner reports its covered raw prefix,
including consumed rejected keys and truthful exhaustion. Zone settles canonical groups and commits the greatest
terminally decided common watermark, retaining the boundary before any undecided group. Unused lookahead may be
reread, with every reread paid again. Common order and covered ranges establish cross-page deduplication without a
traversal-sized seen set. Occurrence order, concatenated source cursors and canonical normalization after raw paging
do not establish this property. A short page may stop at the work budget; no positive-per-page guarantee applies.

The shared admitted Boolean evaluator preserves `true`, `false` and `not_proven` through AND, OR and NOT.
`NOT not_proven` remains `not_proven`. One independently current true source can establish union membership for a
group, subject to current source/original/terminal subject authorization. If no true source settles it and essential
proof remains unknown, stop **before** that group. Return an earlier actually settled prefix when one exists;
otherwise return existing retryable owner readiness (`semantic_not_ready` with retry advice where applicable).
Never skip an essential unknown forever, assert exhaustion, or return the same successful empty cursor indefinitely.
Public Search's existing drop/refill policy is unchanged; its public page is insufficient for Zone continuation.

Definitively rejected or denied groups consume covered keys and may produce advancing empty pages. Only fully
settled processed groups and exhausted covered ranges of every source permit `next:null`. A bounded pending alias
group may advance its own compact phase under the same shared budget, but the identity/group API and token layout
are shared dependencies, not a locally invented protocol. An unchanged group with no actual phase progress is
readiness, not a successful empty page. Owner failure also cannot manufacture exhaustion.

Finite exhaustive traversal requires a **fixed finite candidate and identity basis**, ready complete owner indexes,
and finite definitive owner repair. Under those conditions repeated continuation emits each eligible canonical
subject once and terminates, including across ordinary empty filtered windows. Quiescence alone does not make a
permanently missing witness negative. Late index candidates or identity changes behind the watermark need a fresh
traversal. No snapshot, complete live recall or exact union count is promised under concurrent mutation.

## Bounded owner adapters

The current Search seam is `createSearchService().search`, with shared filter admission, `sort:'id'`, bounded
candidate windows, current `checkHits` proof and opaque generation-bound continuation. It currently returns a
filtered public page; that alone does not expose all examined candidate work or provide a Zone membership probe.
The term currentSearch means this existing current-evidence path, not a new local search engine.

Search owns the additive `createSearchScopeSource.prepare/prefix/evaluate` contract over its **same** compiler
and current evaluator; those proposed methods are not live exports. Preparation admits the expanded released scope
and pins its index/query basis. Prefix enumeration uses real engine hits and `matched_queries`, a caller-reserved
candidate quota, covered consumed boundary and truthful exhaustion; reject partial shards/timeouts. Evaluation of
bounded IDs must use actual Semantic source/facet evidence and preserve the shared Boolean unknown result.
Collection candidates must not become fabricated Search Hit objects or run through a second evaluator. Search must
report internal fact-driver keys, rejected/unknown candidates, duplicates, rereads and quota+1 probes. Public hit
counts do not establish Zone counts. Source field disclosure, security revision and witness final revalidation keep
the current native semantics.

Commerce owns one `collection-source.ts` adapter contract over the same curated/built-in/frozen CommonCollection
authority, with current metadata authorization, canonical covered-prefix enumeration and bounded membership probes.
It is not yet a live export. Existing `collection-reads-members.sql` traverses stored occurrences in
`(ordinal_key,member_id)` order and returns notes. Raw stored-ID helpers/indexes are useful owner primitives;
neither they nor canonical normalization after paging prove canonical ordering or uniqueness. Charge raw duplicate
drivers before filtering whenever examined; do not refill through public members routes outside the caller quota.
Built-in identity resolution must use the actual common list/metadata/members surfaces, never a curated substitute.
Public reverse listings/counts and copied private fact values are not current membership evidence.

Canonical access paths, original and terminal authorization, lightweight terminal identity/readiness and a structural
merge/unmerge/repoint basis remain explicit shared prerequisites. Existing `semantic.merge_member` and
`semantic/merge-moves.ts` already register members before bounded redirect repointing; extend that native foundation
rather than proposing a second inverse authority. Ordinary public merges choose the minimum ID. An optional
requested survivor is internal/native, and account verification preserves catalogue identity. Keep stored Library
and Collection subject IDs and ordinary occurrence identity, order and notes intact.

The native positive-proof counterexample is 257 stored aliases of one survivor with only the last alias readable.
Scanning 256 then declaring absent, choosing an arbitrary representative, or staying permanently unknown loses a
valid mount. Listing and direct-target probes both need bounded definitive repair or a resumable authorization-group
proof that eventually finds that last readable alias. A canonical-ID index alone does not bound original-source
Access work. Exact shared group contracts, canonical access paths and structural identity metadata are pending
shared agreement. This document does not authorize new generation storage, synchronous all-Collection merge fanout,
a private holder directory or permission claims cached in indexes/cursors.

Access stays on each owner's partition: bounded source checks and subject points via the real current resource
eligibility predicates. No cross-partition SQL join is admitted. Capture every pool opened by owner commands and
adapters; SQL on a second connection is still work. Search provider work also needs examined-key instrumentation;
PostgreSQL captures alone cannot prove its bound.

### Local budget derivation and separate native bounds

At most sixteen scopes and sixteen mounts imply at most 32 sources. Every public page shares **one aggregate
256 source-key examination ledger**, independent of output size, catalogue size, Collection degree and other Zones.
Reserve quota before dispatch. Every examined raw duplicate, filtered key, lookahead, reread, owner-internal
fact-driver key, revalidation key and exhaustion probe counts; quota+1 requires a reserved slot too. Neither 256
per source nor 256 SQL statements is this budget. A source with no allocated quota cannot perform an uncharged
refill. Output is at most 100, default 20; output capacity does not require filling the page.

This ledger does not bound engine physical postings, total witness work, bytes, point reads, filter leaves or empty
seeks. Each needs separately admitted and measured native bounds, with bounded statements and per-partition point
and leaf/witness reads. PostgreSQL examined rows include rows removed by filters and all owner pools; Search engine
counters need native evidence too. The existing SQL envelopes in the tests are coarse separate ceilings, never a
measurement of the 256 source-key invariant. No cross-partition join or full-source scan follows from either limit.
These numbers, canonical merge scheduling and finite test ceilings are local design derivations, not standards.
The ordering/watermark rule is decided; exact owner wire types and pending identity-group progress remain dependencies.

## Acceptance and implementation slices

`test/zones/membership-contract.test.ts` uses native HTTP, real Access, real subject/Collection commands and a
narrow shared fixture. Its named outcomes cover union, overlap and duplicate occurrences; current private,
revoked, deleted and withheld disclosure; empty filtered windows and finite traversal. Additional cases cover
subject target exclusion, cursor transfer, source restoration, unsupported admission and the native built-in
Collection dependency. No absent Zone module is statically imported. Missing Zone routes must first fail at
HTTP creation with expected 201 versus actual 404, not at fixture grant setup.

`test/zones/growth-membership.test.ts` uses the shared capture/checkGrowth classifier with legal 64/512/4096
populations, warmup and repeated samples. Axes are unrelated subjects, degree of one mounted Collection and
unrelated Zones. First pages, continued filtered windows and direct membership checks must succeed before costs
are accepted. Captures include filtered candidates and all owner pools; bounds do not use elapsed-time benchmarks.
The native dynamic test is intentionally red until Commerce supplies real built-in membership and its public
privacy projection. The following owner-native acceptance is still required before claiming union readiness:

- Search: a real Semantic witness overflow with `not_proven` under NOT; an earlier settled prefix stops before that
  group; no-prefix requests return retryable readiness; definitive repair resumes without omission; an independent
  current true source settles the same group. Use real source setup and engine hits, never a model/fake unknown.
- Search and Commerce: the shared 256 ledger across sources, all internal drivers/lookahead/revalidation, and separate
  native point/leaf/witness/byte bounds. SQL captures alone do not certify engine candidates.
- Semantic and Commerce: native merge/unmerge/repoint invalidation, unchanged stored personal/occurrence IDs, and
  the 257-alias/only-last-readable positive listing and direct-target proof with bounded progress. The shared
  identity/group API is pending; no nonexistent fixture/import or synthetic readiness response proves it.

The native tests here add canonical order across deliberately different occurrence/source orders, paid duplicate
windows, and successful empty-page cursor progress. Existing acceptance tests remain intact. Owner dependencies
above are named explicitly rather than reported as passing native scenarios.

Implementation can land in small owner slices: (1) Search admission/candidate/probe evidence; (2) Commerce common
unique-member adapter including built-ins; (3) Zone bounded union and live Access/opaque continuation; (4) shared
presentation target gate and public shell projection; (5) native provider growth and mutation outcomes. Resource
CRUD/readPage shape is fixed by the shared routing skeleton; no query algorithm or adapter is implemented here.
