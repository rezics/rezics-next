# Workload, integrity and capacity policy

## Capacity planning

The current corpus requirement is **500,000,000 business entities/documents**,
confirmed by the maintainer on 2026-09-25; 3,000,000,000 remains a future planning
estimate. These are not RDF triple counts. Account separately for current facts,
retained revisions, source observations, derived text, indexes and recovery logs.
Bounded control datasets may use justified smaller bounds.

The initial hardware is one 16-core/64GB host and one 12-core/32GB host. This is
an available topology, not evidence that the corpus fits. Routine development
uses small, deliberately varied datasets to falsify the cost model. It does not
require loading 500M entities on each change. Production placement still needs
measured byte amplification, query/write rates, import/index throughput, disk
headroom and restore/rebuild objectives; small-data passes cannot certify those.

## Complexity contracts

Every API operation, job, importer, projection and recovery/rebuild entry point
must have a cost contract beside its owning behavior and acceptance cases. Cover
normal, absent, denied, stale, retry, cold-cache and fallback paths. This is a
required implementation gate, not a claim that the current code is covered.
Unknown library or engine costs stay explicitly unverified.

| Contract field | Required content |
| --- | --- |
| Variables | Name the relevant dimensions: corpus N, related degree d, raw candidates c, returned items k, input/body bytes b, history h, changed units u and batch size. |
| Bound and reasoning | Derive work per stage and compose the whole operation. Distinguish worst-case, amortized and expected bounds; include retries and downstream effects. |
| Preconditions | Required indexes, ordering, uniqueness, selectivity assumptions, admitted input shape and algorithm/plan switch points. |
| Resources | CPU/iteration work, engine work, remote calls and bytes, peak memory, write/index amplification and lock scope. Parallelism reduces elapsed time only when resources permit; it does not remove total work. |
| Evidence | Name observable counters, representative plans and multi-scale counterexamples linked to existing acceptance IDs. Record unsupported observation boundaries. |

An indexed exact read might cost O(log N + b) under its declared index and
encoding assumptions; a full rebuild legitimately costs at least the amount of
data read and written. Do not demand O(1) for every operation or hide unbounded
work behind a page-size constant. Interactive work must not acquire an accidental
dependence on unrelated corpus/history, while batch work must not repeatedly
rescan completed prefixes. Include iterator consumption and engine operators,
not only code in the HTTP handler.

Declare bounded concurrency and contention separately: lock wait, single-writer
occupancy and queue service rate are not established by Big-O. A correct growth
class with a prohibitive constant also fails the elected latency/resource budget.
The [complexity verification method](../testing/complexity.md) defines executable
checks; it supplements, rather than replaces, correctness and recovery tests.

## Data preparation and import

The maintainer's 2026-09-26 direction sets a hard **600-second ceiling** for
ordinary fixture construction or restoration, including service startup,
migration, index readiness and the small setup smoke check. Design owner schemas,
constraints, indexes and relationships first; bulk-create the test corpus once
and save a consistent complete backup. Subsequent runs restore isolated copies.

Routine setup reads the small fixture-version/schema/engine manifest and checks
service readiness. It does not rescan every row/object, replay receipts, recompute
the corpus digest, fetch upstream data or execute a recovery proof. A code-only
change does not invalidate the backup. Regenerate only the part whose schema,
model meaning or storage/index format actually changed; migrate an existing
fixture where that is cheaper. Exceeding 600 seconds fails preparation and calls
for fixing the setup path, not raising its timeout or silently doing a full seed.

The backup includes PostgreSQL owners, consistent TDB2/Lucene state, objects and
fixture configuration. Take it while stopped or through supported consistent
backup mechanisms. Restore separate writable copies per isolated run; never
share mutable baseline volumes. Rebind only run-local endpoints and credentials.

Complete reconstruction, corpus validation and comprehensive recovery checks run
at final backend acceptance, or when a relevant defect makes them necessary.
Their time still counts against the requested ten-hour delivery budget. Runtime
API authorization, input validation and database constraints remain behavior under
test; this policy removes repeated fixture certification from normal setup.

Use distinct paths for command correctness, repeatable fixtures and corpus import:

- Small command fixtures exercise real authorization, receipts and state changes.
- Backups or deterministic bulk fixtures supply background data. Direct database
  loading is allowed for test setup; the operation being tested still runs through
  its real API/owner. Imported background rows need no fabricated interactive
  receipts and earn no evidence for command paths they bypassed. Rebase only
  expired run credentials needed by the small fresh operation cohort.
- Initial corpus import uses validated chunks, bounded parallel preparation,
  database bulk loading, index construction and restart checkpoints. Preserve
  identities, provenance, exact revisions, authority and cross-owner references
  through an explicit import contract; do not fabricate interactive receipts.
  PostgreSQL COPY and Jena's bulk/index tools are mechanisms to qualify, not new
  authorized commands until admitted through the toolchain and root facade.

Measure preparation separately from the operation. Increase batch size or
parallelism only with measured work, locks and memory; TDB2's single writer and
shared PostgreSQL control rows can serialize dispatch. Rebuild a derived current
view from an authoritative snapshot plus a bounded change tail where applicable,
rather than replaying all historical edits by default. Keep history/recovery
requirements distinct from disposable search state.

PostgreSQL documents [COPY and post-load indexing](https://www.postgresql.org/docs/18/populate.html).
Jena documents [TDB2 loader tradeoffs](https://jena.apache.org/documentation/tdb2/tdb2_cmds.html)
and [separate text-index construction](https://jena.apache.org/documentation/query/text-query.html#building-a-text-index).
Fast loaders may have weaker crash guarantees; build an isolated generation and
validate it before activation. These sources establish mechanisms, not REZICS
throughput. Stopped-state clone reuse and a 600-second-enforced routine restore
facade passed on a ten-Work source with owner/index readiness, fresh writes,
restart and source isolation. General bulk construction and the complete
M01–M10 fixture remain work; this small restore is no capacity claim.

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
