# Data ownership and physical placement

## Authority map

Fluree owns native resource facts, relations, contextual assertions, Main Versions,
content/structure history, publication selections and package catalog metadata.
Account and Access own private/control state in PostgreSQL. Operational databases
hold justified job, delivery, installation or accounting state. Object storage
holds content/media/artifact bytes. Full-text indexes remain Fluree query sources.

Ordinary durable likes/favorites initially remain native interaction facts in
Fluree. Redis is deferred beyond the first release; when introduced, it holds
reconstructable counts or bounded read results.
[Interaction/cache bootstrap](../implementation/interactions-and-cache.md)
defines the concrete graph representation, growth steps and measured-decision gates.

Every authoritative component names exactly one owner/writer and its command.
Read models declare source, freshness, disclosure and reconstruction. Do not
independently write the same accepted fact into PostgreSQL and Fluree. A second
store can hold distinct workflow state without pretending both commits are atomic.

## Initial placement

Use a small product ledger for Space, classification, ratings, Main Version and
content queries; isolate bulk source observations in source ledgers. Add another
ledger only for a justified lifecycle, security, workload or transaction boundary.
Do not allocate a ledger per Realm, resource, revision, semantic class or month.
Private credentials never enter the public graph/history.

Co-locate bounded aggregates: identity/header, current selection and tightly owned
facts that ordinary commands mutate together. Growing comments, observations,
votes and messages have their own partitionable ownership. A popular target must
not force all incoming relationships through one serialized mutation point.

## Routing and movement

Resolve logical owner/partition to ledger/database/cluster group using versioned
placement. Stable UUID/IRI never embeds physical host or shard. A locator is not
the existence or permission authority. References can carry routing hints, but
owners validate current epoch and safely redirect/reject stale writers.

Movement: prepare target -> copy retained state/history -> catch up -> fence old
writer -> verify final frontier -> atomically activate new routing epoch -> retain
recovery window -> collect old storage. Include revision resolution, operation
receipts, outbox progress, source correspondence and erasure fences. Never move
only current facts while leaving exact historical links unresolved.

## Long-term partitioning

Partition by bounded owner aggregates and workload, not random individual triples.
Separate independent cluster groups when shared write/coordination limits justify
it. Cross-ledger queries require qualified dataset, authorization and snapshot
semantics. Restore/index-build time is a placement input alongside total bytes.
Initial delivery does not require implementing automatic global sharding.
