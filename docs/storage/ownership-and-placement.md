# Data ownership and physical placement

## Authority map

Main's semantic module owns native resource facts, names/titles, multilingual
predicate definitions/labels, relations and qualifiers, contextual assertions,
Main Versions, semantic revision metadata, publication selections and catalog
metadata in TDB2. Main's Content module owns JSON bodies, drafts and immutable
Content revisions in PostgreSQL. Content language/provenance metadata follows
those revisions; the graph holds exact immutable references for semantic joins.
Account, Access, preferences and operations use separately owned PostgreSQL state.
Object storage holds media/artifacts, large payload pages and sealed semantic
revision payloads/manifests. The [common history resolver](../implementation/graph-records.md#revision-anchor-resolver)
dispatches by logical owner.

jena-text/Lucene indexes derived RDF MatchUnits, including extracted PostgreSQL
body text. These copies are reconstructable and have no editorial authority.
Avoid Resource-by-Realm duplication: exact variant/field/chunk units join sparse
Realm decisions. Deployment needs no additional search service or SQL text
extension. See [body projection](../contracts/search.md#postgresql-body-projection).

Ordinary durable likes/favorites initially remain native interaction facts in
TDB2. Redis is deferred beyond the first release; when introduced, it holds
reconstructable counts or bounded read results.
[Interaction/cache bootstrap](../implementation/interactions-and-cache.md)
defines the graph representation, growth steps and measured-decision gates.

Every authoritative component names exactly one owner/writer and its command.
Read models declare source, freshness, disclosure and reconstruction. Do not
independently write the same accepted fact into PostgreSQL and TDB2. A second
store can hold distinct workflow state without pretending both commits are atomic.

## Projections and durable delivery

PostgreSQL and Jena are authoritative for different facts. Their coexistence does
not require a general bidirectional synchronization queue. Cross-owner references
name exact revisions; they do not create a second writer for the referenced fact.

Distinguish the existing delivery paths:

| Path | Purpose and authority |
| --- | --- |
| PostgreSQL Content events to RDF MatchUnits and embedded Lucene | Search projection of owner-held bodies. Content remains authoritative; indexed copies are reconstructable. |
| Jena command outbox to PostgreSQL relay delivery records/checkpoints | Durable event delivery and recovery reconciliation. Graph receipts remain authoritative for the graph command; relay records are not a second editable semantic database. |

Each retained outbox/consumer must identify its producer, actual consumer, payload,
delivery/idempotency contract, retention/replay boundary and cost bound. Keep it
only for a required downstream effect, projection or recovery obligation. An
outbox makes committed intent durable; it does not make two stores commit atomically.
Do not add generic database mirroring, a broker or full-history replay merely
because there are two engines.

Audit existing consumers before simplifying delivery. Removing unused copies or
replacing a projection path requires preserving its freshness, authority and
crash/recovery cases. This strategy does not by itself remove the current outboxes
or select synchronous cross-store indexing. Bulk rebuilding a derived current
view can use a verified source snapshot plus a bounded tail; it need not recreate
every historical online event. See [data preparation](workload-budgets.md#data-preparation-and-import).

## Initial placement

Start with one logical `product` TDB2 dataset (the `/rezics` quickstart service)
in one Fuseki JVM, with explicit named graphs
for current facts, source observations, revisions, control records and projections.
Keep bulk source ingestion budgeted and its graphs excluded from ordinary search.
Do not allocate a dataset per Realm, resource, revision, semantic class or month.
Add a separate source dataset only when measured load or a required lifecycle
boundary justifies the extra ownership, query and recovery coordination.

Co-locate bounded aggregates: identity/header, current selection and tightly owned
facts that ordinary commands mutate together. Growing comments, observations,
votes and messages have independent ownership so they need not change a popular
target's head. TDB2 still serializes write transactions within the dataset; more
API processes do not create more storage writers. Use admission and short bounded
writes before proposing a new physical boundary.

Only the owning Fuseki JVM accesses its TDB2 directory and Lucene index. Workers,
other application processes and the second host use its private endpoints. The
second host is not a live graph replica, and a shared disk is not a replication
protocol. Keep private credentials outside the semantic graph and its history.

## Routing and later movement

Stable UUID/IRI never embeds physical host or shard. A locator is not existence
or permission authority. The owner validates the routing epoch separately from
the [dataset epoch/sequence](jena.md#application-source-positions). Bootstrap needs
one configured owner location; automatic global placement is deferred.

If later movement is required: stage a target -> copy retained current/revision
state and objects -> stop admission and drain the old writer -> verify the final
source frontier -> activate routing and a new data epoch -> retain a recovery
window -> collect old storage. Include receipts, outbox/consumer progress, source
correspondence, retention and erasure fences. Verify old exact revision IDs still
resolve. Never bring both copies online as writable instances of the same owner.
This maintenance procedure does not promise live replication or zero downtime.

## Growth decisions

Use measured writer occupancy, query budgets, storage headroom, backup/rebuild time
and source-ingest interference to decide whether a separate dataset is worthwhile.
If divided later, partition bounded owner aggregates rather than random triples;
one command cannot atomically mutate independent datasets. Cross-dataset reads
need explicit dependency manifests and authorization. Automatic sharding, read
replicas and consensus clusters are outside the launch architecture.
