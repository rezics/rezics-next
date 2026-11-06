# Collection discovery adapter

The composition root supplies Commerce's `publicCollectionDiscoverySource({pool})` to
`createNativeCollectionDiscoveryAdapter(dependencies, metadata)`, which binds it to
`readPublicCollectionDiscoverySummaries(dependencies, ids, context, query)`. Dependencies are the installed
`PublicCollectionDiscoveryDependencies` (pool, Access, optional route key and clock); metadata is the Collection
registry metadata (`id: 'collection'`, localized labels and icon). There is no optional ready producer.
`createCollectionDiscoveryAdapter(producer)` remains the validation boundary over these native contracts;
missing or preparing producers retain typed readiness.

## Source and continuation

The factory returns `source.read(partition, keys, query?, {deadline})`,
`source.page(partition, after, limit, query?, {deadline})` and `source.count(partition)`. Keys are full
`{route, id}` pairs with the route encoded in the UUID, within one native partition. Read admission counts
duplicates toward batch100, then deduplicates full identities. Read results settle each requested key as
`indexable`, `withdrawn` or `unavailable`; missing selected publication witnesses remain uncertainty. Source
partition or follow-count unavailability is preserved. The optional query contains explicit mixed/owner
presentation kind, canonical curator account ID, Subject ID, popularity request and sort choice. The source
keeps page results and `next` in ascending full `(route,id)` order so Search retains the original raw frontier.

Available source values carry the native `presentationKind` discriminant separately from `membershipKind`,
selected output reference and bounded query operands. A Subject operand is an exact indexed membership probe
against active curated members or the exact selected dynamic output generation. A popularity operand is the
exact decimal public follow aggregate plus its native health/currentness observation; unavailable aggregate
authority makes the whole source read unavailable. Recency is `(updatedAtEpochMicros, route, id)`: curated
headers use exact SQL decimal-text Unix microseconds from committed `updated_at`; dynamics use null until the
publication owner supplies a committed timestamp. Search sorts newest first or popularity highest first, with
null recency last and ascending full identity ties. It does not infer curator or public Subject disclosure from
these source hints.

Available snapshots retain `{partition, epoch, position}` separately from numeric Collection revision. Position
is an opaque native stamp, never a revision ceiling. Native ordering/replacement rules remain Commerce's.
A complete page contains at most LIMIT raw keys in strict `(route,id)` order. A full raw page continues from its
last raw key even when every item has unavailable publication authority. A short raw page exhausts, including
an empty final page. Eligible length is never used as a frontier or census. `count` explicitly returns
`native_collection_population_evidence_unavailable`; generation consumers must retain unavailable census.

## Current disclosure and caller handoff

`hydrate(ids, context, query?)` accepts the native `PublicCollectionDiscoveryContext`: current actor, native
partition, deadline and optional borrowed authoritative time. The native batch reader prepares current Access
decisions, reads owner truth, resolves authorized presentation, then revalidates native authority before
disclosure. It returns one aligned private operand per disclosed current card: currently disclosed canonical
curator identity (including withheld/deidentified state), requested Subject membership with unavailable
disclosure withheld, follow aggregate, presentation eligibility, and recency. Search evaluates requested
eligibility from these native operands and keeps them inside the owner metadata envelope.
Search preserves its `PublicCollectionDiscoveryResult`: ready carries summaries (including legitimate omissions);
unavailable carries `native_authority`, `changed`, `access`, `partition` or `deadline` and no cards. Infrastructure
and media errors propagate. No indexed hint supplies viewer authority, member sets or saved-rule evaluation.

Curated cards retain the authorized public memberCount, orderEpoch and timestamps. Dynamic cards carry
outputGeneration and no member count: completed empty A is valid and remains selected while B prepares;
no completed A is unavailable native_authority. Current withdrawal, deletion, private or unlisted state omits
cards even during index lag; restoration rereads native truth. Retention/currentness comes from Commerce;
Search adds no output TTL and expired deletion retention cannot revive a card.

Decision: expose full native authorized cards through `hydrate`, and project only `id`, `title`, `summary` at
the installed mixed registry port; native unavailable throws `CollectionDiscoveryReadinessError` there because
that map-only port has no unavailable result variant.

The returned `registration` is consumed as `ownerAdapters.collection` by `createNativeDiscoveryRegistry`.
Its `readCurrent(ids, DiscoveryReadContext)` binds the request's Access, actor, deadline and optional
`collectionQuery`, groups complete IDs by native partition and issues batches of at most 100. It compares source
operands with the fresh disclosure result, includes the source stamp and summary's opaque query observation in
the retained owner observation, and performs a final source currentness read. The query observation covers the
native partition position, disclosure/current Account and Subject identities, exact selected membership,
follow-count health/value, recency and requested query; a candidate revision or page position alone does not
stand in for those owners. The existing `hydrateOwnerDiscoveryHits` caller checks routed identities and the
closed metadata envelope, then returns only the current card projection. Counts, private predicates, member sets
and working output do not enter the common hit or public card DTO. Canonical destinations remain on the native
card as `/collections/<id>`; the installed common metadata codec owns its smaller envelope.

## Directory selection

The existing mixed Search request accepts `collectionDirectory` only with the sole `collection` kind filter.
It carries an explicit presentation Type ID or `mixed`, canonical curator and Subject IDs, and `recent` or
`popular` order; all values enter the cursor binding. Search runs the directory only when the Collection owner
registry advertises `collectionDirectory` on a ready adapter. Without that native capability it returns
`index_not_ready` before filter admission or enumeration. The identity-ordered `source.page` remains the indexing
frontier and never becomes a result-ordering authority. Query-time listing cannot walk every partition of the
4096-way split: OpenSearch supplies the occupied identity frontier, and native tests walk `source.page` on those
partitions, including a tail past the first owner batch of 100.
Decision: directory execution hydrates that indexed collection population with `collectionQuery`, then Search
applies recency or popularity order across the complete eligible frontier with query-wide currentness so a newly
eligible identity appears in its global position; continuation is a sort keyset, not an OpenSearch prefix.
`hasCollectionDirectoryCapability`, `consumeCollectionDirectoryFrontier`, `hydrateCollectionDirectory` and
`executeCollectionDirectory` are the mounted consumer. Working-draft timestamps never replace released public
owner recency or the selected publication generation.
Decision: Collection directory consumes `COLLECTION_DISCOVERY_BATCH_SIZE` at execution for identity-frontier
pages and hydration batches; it does not alias that imported value at module initialization.
Decision: directory occupancy walks `COLLECTION_DIRECTORY_SCAN_BOUND` (600), not mixed-search `min(600, 6L+3)`,
so a tail past the first owner batch of 100 can finish; an occupancy that cannot exhaust inside that bound stays
readiness rather than a partial listing.

## Cost Touches / Bound / Growth check

- Source reads touch one native owner snapshot and at most 100 full keys. Query operands add at most two
  indexed exact-membership probes (curated and selected dynamic), one batch follow-count read and one bounded
  root follow-count health/currentness read. Pages retain the producer's indexed
  public-listing LIMIT over raw keys, including unavailable witnesses. No refill or population scan is added.
- Native hydration uses two authorized batch snapshots per partition batch, including final disclosure
  revalidation; each snapshot includes one Collection/curator batch, Access decisions, selected-output witness,
  bounded four-member preview, optional exact Subject membership and follow-count operands. It adds bounded
  Account/Subject disclosure observations, cover resolution and a final source currentness read, without
  per-candidate full Collection reads. Direct hydrate admits 100 duplicate-inclusive IDs in one partition.
- The installed owner caller admits 200 IDs. Directory occupancy finishes inside 600 identities with hydration
  and revalidation in batches of 100, so each owner call stays inside that 200-key admission. For distinct
  partition populations n[p], native batch calls total sum(ceil(n[p]/100)); one partition needs at most two per
  200-key caller window. Only authorized cover resolution inside Commerce may scale with visible covers.
  Unrelated rows/history do not add Search reads.
- Focused tests pin raw sparse/zero-eligible continuation, routed collisions, unavailable census, current-reader
  withdrawal/restoration, exact membership beyond preview, explicit mixed kind, current popularity changes,
  deterministic count ties, exact recency, completed empty A during B, absent A and expired deletion retention.
  The native fixture uses product creation/publication and the installed registry hydration caller. These tests
  are landing checks, not a production native execution or measured three-scale growth claim.
  Focused native tests pin catalogue unique members, directory recency/popularity order, composition slot skip and
  TypeList Search-page admission; browser walks remain deferred.
  Decision: the fewest tests pin capability absent/present, an identity-page tail, recency ties, popularity, owner
  removal, a resumed sort-keyset cursor, query-wide currentness, lost-response reconcile against native
  generation/uuid/index, selected A lookup after a later working identity, and one native directory/publication
  group on released public owners and the live subject index. That native group shares one fixture and runs one
  at a time. Browser and main acceptance stay held.

Decision: catalogue Collection publication snapshots public Search population into selected A through
`observeCataloguePublication`/`readCataloguePublicationPage`/`lookupCataloguePublication`. A lost OpenSearch
response rereads the native generation/uuid/index and retries once while that observation is unchanged; a
changed generation restarts rather than failing the attempt as a lost transport. A lost observation without a
pinned selection stays unknown until a later native reconcile. Lookup reads those stored identities from the
pinned generation; present/missing are that selection, not a live population search. HTTP `renderSelected`
fills the present identities through `selectedCataloguePublicationShells` and the shared catalogue adapter. The producer carries the original deadline and
`SearchRequestWork`, reserves limit+1 candidates before dispatch, and fails closed when generation, UUID or
release currentness change. Library stages, seals and rereads that observation; working membership B stays
private. Omitted-source HTTP stays its existing owner contract. Configured TypeList BFF prepares the session on every read and attaches credentials only for a
selected realm. TypeList completion, revocation and suspension reuse that same session transport.
Decision: typecheck repairs keep those assertions; fixtures carry `source` (owner unless catalogue), omit
undefined `expected`, and FULL members pages pass only cursor, limit and languages. Catalogue publication
observation uses the stored accepted release digest; it does not hash FilterRelease as Release. HTTP
createKernel fixtures pass dedicated receipt keys, open gate:search and selling exposure, call the official SearchService
`complete` callback, and keep index prefixes within 48 characters. Native kind-metadata SearchService hits use
identity-admitted created subjects and install the released templates before indexing. Catalogue producer mocks honor
`search_after`. Access observation wraps only prepare ports. createKernel write fixtures inspect mounted composed
rates and the merged `subject:read` resource types.

## Readiness

Factory/registration readiness means the callable native ports are installed. Ready default generations additionally
require complete source coverage, genuine partition stamps, native census/coverage authority required by their
owner, compatible mixed registry/document codecs and current hydration admission. Source-order dependencies,
constructed examples and passing adapter checks alone do not authorize ready default generations. Generation,
codec and default wiring remain with their existing owners; they consume this factory without another producer
or mixed pipeline. Broader native/default-generation acceptance runs after integration.
