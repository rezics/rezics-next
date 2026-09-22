# Workload, integrity and capacity policy

## Capacity planning

Potential corpus-scale datasets retain a 500,000,000-row baseline and a
3,000,000,000-row estimate for future planning. RDF designs additionally distinguish
business objects, current facts, retained component revisions/manifests, source
observations and index entries. Bounded control datasets may use justified smaller bounds.

The initial hardware is one 16-core/64GB host and one 12-core/32GB host. The
maintainer accepts deferring large-volume qualification. First delivery requires
correct semantics, recovery and reasonable bounded behavior on available hardware;
it does not require reproducing 500M/3B volumes or solving future fleet operations.

## Immediate design failures

Reject synchronous full-corpus scans on ordinary writes, Resource x Realm copies,
unbounded queues/closures, registry-wide package loading, application-wide locks
over validation/network work and search truncation presented as complete results. Exercise high-degree/skewed cases
at practical sizes and measure work growth. A LIMIT alone does not bound work.
TDB2 has one active writer per dataset; keep transactions bounded and do expensive validation, object upload and staging
preparation outside that writer, with guarded activation afterward.

Budgets name scanned candidates, graph expansions, batches/bytes, memory, time,
external calls, concurrent jobs, retention and cancellation. Product semantic
cardinality is separate from one request's work limit. Do not put temporary
implementation ceilings into ontology meaning.

## Growth arithmetic

Let N be primary objects, f current facts per object, H retained RDF revision/
outbox/source facts and b measured TDB2 bytes per fact including its dictionaries
and native indexes. Estimate current facts N*f and RDF storage (N*f+H)*b. Add
unique immutable payload/manifest-page bytes, Lucene indexes, backups and rebuild
space separately. Unchanged reused pages count once; retained revisions still
incur root/metadata and changed-page costs. State assumptions and do not
double-count index costs. Average-width errors amplify
across relations; hot keys and churn can dominate total object count.

Record read/write rates, skew, query shapes, worker service rates, backlog age,
storage/network costs, restore and rebuild time. Queue capacity is arrival rate
times retention, not the number of business objects. More API replicas do not
increase a saturated transaction/index/storage resource.

## Integrity and bounded work

Ingress checks syntax; domain commands check authority and transitions; the owning
database transaction protects irreducible persisted invariants. Explicit Jena SHACL
validation plus guarded update invariants and PostgreSQL constraints serve their
actual owners. Cross-service checks use staged workflows/fences, not imaginary cross-engine FKs.

Page forward/inverse relations, coalesce derived metrics, stage large changes and
activate fenced generations. Retain cancellation and partial/unavailable outcomes.
Rendering isolates malformed presentation without executing unsafe payloads.

## Growth decisions

Track concrete thresholds for queue lag, text-projection/index lag, hot aggregate
latency, memory, disk headroom and restore budget on elected hardware. Exceeding a threshold
triggers admission control, query/profile restriction, index adjustment or a
placement review. Long-term sharding/cluster work remains a designed evolution,
not an unmeasured claim that money guarantees arbitrary-query performance.
