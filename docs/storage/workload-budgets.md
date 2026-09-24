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
TDB2 has one active writer per dataset; keep transactions bounded. Do extraction,
object upload and staging preparation outside that writer. Preflight validation
may run there too, but required SHACL/post-state checks and mutable dependency
guards remain inside the command's write transaction before commit.

Budgets name scanned candidates, graph expansions, batches/bytes, memory, time,
external calls, concurrent jobs, retention and cancellation. Product semantic
cardinality is separate from one request's work limit. Do not put temporary
implementation ceilings into ontology meaning.

## Fixed bounds for interactive requests

The maintainer requires a fixed maximum number of storage/service round trips for
every admitted interactive operation. This is a design and release requirement,
not a property already established for the existing runtime. The maximum must
not grow with corpus size, node degree, matches rejected by a filter, label count
or the number of historical revisions. A finite timeout without a call-count
bound does not meet the requirement.

Each versioned query/command profile declares numeric ceilings for total remote
request attempts, serial dependency stages, transferred IDs/bytes, page size,
query width/depth, retries and deadline. Count authentication, Access admission
and delivery checks, readiness, vocabulary/language resolution, cursor creation,
cache misses, fallback and transaction protocol calls. One HTTP wrapper, one
transaction, batching or parallel dispatch is not proof of one storage round trip.
Database-internal shard fanout is a separate bound for the admitted deployment;
federated requests/extra SQL calls must be observable rather than hidden by the
front door. A topology or query-profile change requires requalification.

The physical plan must justify these ceilings before admission; a shared runtime
budget must also stop nested adapters from exceeding them. Budgets are not reset
by a retry or subcall. Do not refill filtered pages, follow context parents,
resolve each label, hydrate each item or fetch more candidates in an open-ended
loop. Batch sizes need both a fixed item cap and a byte cap. Parallel N+1 remains
N+1. Caches may reduce work but cannot be necessary to satisfy the maximum.

When a cross-owner candidate set cannot fit one admitted complete exchange,
choose a precomputed/index-local plan or an explicit asynchronous operation;
do not keep dividing the growing set into more requests. Cap detection such as
fetching B+1 IDs bounds transferred results, not the engine work needed to find
them. A budget/partial/unavailable result must not be presented as exact empty
results, exact counts or complete top-K. Ordinary pagination advances a declared
result cursor; it cannot disguise internal candidate probing as more page calls.

Fixed request counts are necessary but insufficient. Qualify engine work,
memory/bytes, internal fanout, contention, P95/P99 latency and overload behavior
on the elected hardware and representative skewed mixed workloads. Count failures
and budget rejections alongside latency; rejecting the ordinary workload cannot
be called a performance pass. Async projection/materialization jobs use bounded
checkpointed batches, bounded queues and measured catch-up capacity. Accepting
delay does not allow sustained backlog growth.

The [architecture research](../research/storage-architecture.md#fixed-call-plans-and-performance-evidence)
records the supporting research, proposed paths and still-unqualified runtime
budgets. This policy applies to both single-store and multi-store implementations.

## Growth arithmetic

Let N be primary objects, f current facts per object, H retained RDF revision/
outbox/source facts and b measured TDB2 bytes per fact including its dictionaries
and native indexes. Estimate current facts N*f and RDF storage (N*f+H)*b; identify
the derived body/MatchUnit share within that total. Add
PostgreSQL revision bytes/JSONB/manifests and WAL,
immutable object pages, Lucene indexes, backups and rebuild
space separately. Unchanged reused pages count once; retained revisions still
incur root/metadata and changed-page costs. State assumptions and do not
double-count index costs. Average-width errors amplify
across relations; hot keys and churn can dominate total object count.

Record read/write rates, skew, query shapes, worker service rates, backlog age,
storage/network costs, restore and rebuild time. Queue capacity is arrival rate
times retention, not the number of business objects. More API replicas do not
increase a saturated transaction/index/storage resource.

For the selected body binding, distinguish authoritative JSON/bytes from extracted
RDF text and Lucene postings/stored fields. Include obsolete revisions, pending
publication pins, index merges and replacement generations. Report storage/write
amplification and TDB2 writer time per published body; small draft edits must not
trigger a whole-body graph/index rewrite until a publication requires it.

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
