# Data ownership and physical placement

## Authority map

Main owns native resource facts, relations, contextual assertions, Main Versions,
application revision metadata, publication selections and package catalog metadata
in TDB2, served by Fuseki. Account and Access own private/control state in
PostgreSQL. Operational databases hold justified job, delivery, installation or
accounting state. Object storage holds content/media/artifact bytes and immutable
revision payloads/manifests. jena-text/Lucene indexes selected RDF text projections;
the index is reconstructable and has no independent domain authority.

Ordinary durable likes/favorites initially remain native interaction facts in
TDB2. Redis is deferred beyond the first release; when introduced, it holds
reconstructable counts or bounded read results.
[Interaction/cache bootstrap](../implementation/interactions-and-cache.md)
defines the graph representation, growth steps and measured-decision gates.

Every authoritative component names exactly one owner/writer and its command.
Read models declare source, freshness, disclosure and reconstruction. Do not
independently write the same accepted fact into PostgreSQL and TDB2. A second
store can hold distinct workflow state without pretending both commits are atomic.

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
