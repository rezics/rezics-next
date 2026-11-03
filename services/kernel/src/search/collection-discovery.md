# Collection discovery adapter

`createNativeCollectionDiscoveryAdapter(dependencies, metadata)` installs Commerce's
`publicCollectionDiscoverySource({pool})` and
`readPublicCollectionDiscoverySummaries(dependencies, ids, context)`. Dependencies are the installed
`PublicCollectionDiscoveryDependencies` (pool, Access, optional route key and clock); metadata is the Collection
registry metadata (`id: 'collection'`, localized labels and icon). There is no optional ready producer.
`createCollectionDiscoveryAdapter(producer)` remains the validation boundary over these native contracts;
missing or preparing producers retain typed readiness.

## Source and continuation

The factory returns `source.read(partition, keys)`, `source.page(partition, after, limit)` and
`source.count(partition)`. Keys are full `{route, id}` pairs with the route encoded in the UUID, within one native
partition. Read admission counts duplicates toward batch100, then deduplicates full identities. Read results
settle each requested key as `indexable`, `withdrawn` or `unavailable`; missing selected publication witnesses
remain uncertainty. Source partition unavailability is preserved. Indexable values carry only native public
metadata, presentation hints, Collection revision, membership kind and the selected output reference.

Available snapshots retain `{partition, epoch, position}` separately from numeric Collection revision. Position
is an opaque native stamp, never a revision ceiling. Native ordering/replacement rules remain Commerce's.
A complete page contains at most LIMIT raw keys in strict `(route,id)` order. A full raw page continues from its
last raw key even when every item has unavailable publication authority. A short raw page exhausts, including
an empty final page. Eligible length is never used as a frontier or census. `count` explicitly returns
`native_collection_population_evidence_unavailable`; generation consumers must retain unavailable census.

## Current disclosure and caller handoff

`hydrate(ids, context)` accepts the native `PublicCollectionDiscoveryContext`: current actor, native partition,
deadline and optional borrowed authoritative time. The native batch reader prepares current Access decisions,
reads owner truth, resolves authorized presentation, then revalidates native authority before disclosure.
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
Its `readCurrent(ids, DiscoveryReadContext)` binds the request's Access, actor and deadline, groups complete IDs
by native partition and issues batches of at most 100. The existing `hydrateOwnerDiscoveryHits` caller checks
routed identities and the closed metadata envelope. Neither that port nor common index actions receive counts,
owner information, saved predicates, member sets or working output. Canonical destinations remain on the native
card as `/collections/<id>`; the installed common metadata codec owns its smaller envelope.

## Cost Touches / Bound / Growth check

- Source reads touch one native owner snapshot and at most 100 full keys. Pages retain the producer's indexed
  public-listing LIMIT over raw keys, including unavailable witnesses. No refill or population scan is added.
- Native hydration uses one authorized batch reader per partition batch, including its final revalidation,
  without per-candidate full Collection reads. Direct hydrate admits 100 duplicate-inclusive IDs in one partition.
- The installed owner caller admits 200 IDs. For distinct partition populations n[p], native batch calls total
  sum(ceil(n[p]/100)), bounded by 200; one partition needs at most two. Only authorized cover resolution inside
  Commerce may scale with visible covers. Unrelated rows/history do not add Search reads.
- Focused tests pin raw sparse/zero-eligible continuation, routed collisions, unavailable census, current-reader
  withdrawal/restoration, completed empty A during B, absent A and expired deletion retention. The native fixture
  uses product creation/publication and the installed registry hydration caller. These tests are landing checks,
  not a production native execution or measured three-scale growth claim.

## Readiness

Factory/registration readiness means the callable native ports are installed. Ready default generations additionally
require complete source coverage, genuine partition stamps, native census/coverage authority required by their
owner, compatible mixed registry/document codecs and current hydration admission. Source-order dependencies,
constructed examples and passing adapter checks alone do not authorize ready default generations. Generation,
codec and default wiring remain with their existing owners; they consume this factory without another producer
or mixed pipeline. Broader native/default-generation acceptance runs after integration.
