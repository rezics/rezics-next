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

### Main outbox relay next-batch read (OPS05)

Let N be retained outbox batches, E batches from other data epochs at the same
numeric sequence, and e events in the next batch (admitted maximum 100). The
relay reads one keyed control row and seeks exactly `checkpoint + 1` through
the named graph's `rv:sequence` predicate/object index in the same graph
snapshot. It returns at most two batch headers, reads the selected batch's
members, and probes each member's object. The request makes one graph read when
idle and at most `2 + e` graph reads when a batch exists; result rows are at
most `2 + e` before the object
probes. Under Jena's [POSG quad index](https://jena.apache.org/documentation/tdb/store-parameters.html)
and a selective sequence, index seeking is expected to depend logarithmically
on N plus E and e. [Jena's optimizer](https://jena.apache.org/documentation/tdb/optimizer.html)
can reorder the basic graph pattern, so the physical plan and E remain measured
preconditions. Missing positions, duplicate headers, a restore hold, excess
members and incomplete event objects fail explicitly; none triggers a scan of
later sequence positions. `OPS05: next relay batch seeks one indexed sequence
regardless of unrelated backlog` checks the query shape and fixed graph-call
count at backlogs 1, 100 and 100,000. The quiet-host phase-D run still needs to
measure the native plan, latency and relay lag under writes.

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
`REZICS_FIXTURE_ROOT` directs the fixture manifest and private Compose
configuration to a checkout-local `.temp/fixture` when a worker's filesystem
boundary does not allow writing the shared fixture directory.

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
restart and source isolation.

`yarn fixture:build` now bulk-builds the current owners directly. The real
graph bootstrap commits first, then the TDB2 phased loader and offline text
index run on the stopped dataset, objects go to RustFS and PostgreSQL rows are
loaded in 5,000-row `unnest` batches. Imported data sits at graph position 0
with no receipts. Measured on 2026-09-27 on a 64-CPU host with a 25 GB Docker
Desktop VM:

For the fixture graph generator, W is imported Works, U is imported public
MatchUnits, and B is their total body bytes. Graph generation and its digest
each traverse O(W + U + B) input; the graph stream buffers at most one 1 MiB
chunk plus one Work's quads. Jena's phased loader and Lucene indexer run once
for the entire import, with native memory and index amplification measured by
the build, not assumed constant. The generator emits one indexed literal per
public unit and checks three exact postings plus the total MatchUnit count.
`OPS05/SEARCH18: deterministic public graph plan scales with the imported
corpus` checks record growth at two Work/public-unit scales. Restore reads only
sampled exact state and the public index readiness proof; it does not regenerate
or recount every imported object.

| Profile | Works | Build | Backup | Restore |
| --- | --- | --- | --- | --- |
| `small` | 1,000 | 28.3 s | 373 MB | 13.0 s |
| `medium` | 100,000 | 370.3 s | 2.91 GB | 92.3 s |

The medium build loaded 2,758,334 quads in 17.3 s (about 160,000 per second)
and indexed 100,001 labels in 5.8 s. Its 400,000 object PUTs took 303.5 s;
RustFS saturated near 1,400–1,460 PUT/s at 64 or 192 concurrent requests, with
or without a checksum header. The first medium build took 958 s because
verification listed the 400,000-key prefix (588 s); verification now counts
acknowledged PUTs and reads evenly spaced samples. Copying the 400,016-file
RustFS volume took 80.0 s of the medium restore, against about 4.6 s each for
PostgreSQL (1.25 GB, mostly WAL and build-time archive) and TDB2/Lucene
(1.26 GB). Object count is therefore the restore bottleneck. During an
experiment, a one-container tar-pipe copy of that volume coincided with a
Docker Desktop 4.90.0 engine panic, so restore keeps `cp -a`. These figures
cover only metadata-only Works, Agents with Work read grants and Content drafts.
The complete M01–M10 fixture remains work, and none of this is a capacity
claim.

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

The private Open Library source-graph projection has a fixed work bound per
conversion: three base source subjects plus at most two reified field Statements
(title and optional description), at most 24 statement/link triples, and at most
five source-subject validations. It makes one guarded Jena write transaction and
does not iterate over provider fields, source records or graph history. Its
integration complexity check exercises both Statements and asserts the maximum
triple footprint.

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

The 2026-09-27 selected load-tier run `20260926t203951-bdbe06` passed its
10-Work diagnostic: 11 Main units and one Content unit across English, Chinese
and Japanese; two k6 clients for 20 seconds; 286 complete exact reads; 70.2 ms
overall p95; zero failed HTTP responses and zero 5xx responses. The offered
mix used 50% hot-Work reads, 20% other Main reads, 20% Realm reads and 10%
Content reads. Its retained evidence is under
`.artifacts/qa/20260926t203951-bdbe06/load/`. This run measured no admitted
writers, relay lag, memory, or cold storage recovery, and does not qualify OPS05
or SEARCH18's 10,000-Work host objective.

The 2026-09-27 G-115 restore of the rebuilt current medium fixture
`fx-medium-532e16fa7af3` as `fixture-g115` passed in 160.048 s (600 s preparation
ceiling). It applied only
`services/main/migrations/relay/014_current_authority_coverage.sql`; the Fuseki
engine image changed while Jena stayed compatible. A second clean copy,
`fixture-g115-run2`, restored in 311.572 s, including 288.560 s copying the
RustFS volume. Both are below the fixed restore bound.

The fixture has 100,000 metadata-only Works. That is useful host background but
does not provide the 10,000 published public MatchUnits required to qualify the
named searchable host profile. `yarn load --fixture-run-id` now attaches the
load runner to a restored persistent fixture and limits fresh command seeding
to its explicit `--works` count; fixture-backed runs remain diagnostic unless
their searchable population reaches the named objective.

The attached 100-fresh-Work, 180-second attempt
`load-20260926t215428-2c179c` ended after 93.404 s with `The operation timed
out.` before seed completion, phrase/cursor traces, k6 mixed traffic, relay lag
sampling, container-memory capture or cold storage restart. The retained early
Main-process high-water mark was 131,900 KiB; the Main-to-Fuseki meter saw 9
calls, 6,464 request bytes, 32,520 response bytes and zero errors. The Main
relay process logged a timeout. Fuseki's log includes a relay batch query that
completed in 55.020 s, above the Fuseki client's existing 10 s upstream read
timeout. Thus OPS05 did not pass: no mixed-workload latency, lag, memory-cgroup
or recovery result was collected. The relevant relay query is in
`services/main/src/modules/outbox/relay.ts`, outside this worker's claimed
paths; changing its plan or timeout would need its own bounded-work review, not
a larger budget.

An initial attached attempt (`load-20260926t214645-3945ce`) stopped before
seeding because the load harness omitted owner-specific receipt fields when
sealing an Access rating-context command. `scripts/load/corpus.ts` now preserves
the returned owner identity while binding the seal to the claimed admission;
the focused test passes. The subsequent relay timeout still blocks the full
profile, so OPS05 and SEARCH18 remain partial. In particular, this run supplies
no evidence for SEARCH18's cold/stale/retry/cursor traces, growth to 10,000
searchable units, or its end-to-end total remote-attempt accounting. The
declared search limits remain unchanged: 72 Fuseki calls, 8 MiB aggregate
Fuseki response bytes, 1 MiB per response, 512 phrase candidates, 20,000 public
units and a 1,500 ms wall deadline (90 total attempts including owner/cursor
reads). No budget was raised to pass.

A separate fixture-backed Search trace (`load-20260926t220953-5e102f`) ran
without the relay on the partially seeded `fixture-g115-run2` copy, before
cold-restarting its storage services. It measured 11 public MatchUnits, so it
is a trace check, not a growth qualification. With Fuseki already running, the
cold Main-process phrase read returned 11/11 complete results in 783.0 ms using
8 Fuseki calls and 38,792 response bytes; its warm read took 91.5 ms, 6 calls
and 37,513 bytes. Chinese and Japanese probes each returned one exact result in
67.1 ms and 56.2 ms (6 calls each). A rejected Realm phrase returned complete
zero in 71.7 ms (6 calls). An 80-character phrase was accepted in 56.0 ms (6
calls); 81 characters returned HTTP 400 without a Fuseki call. Cursor pages 1
and 2 returned different Works in 110.6 ms and 63.0 ms (6 calls and 1,246
response bytes each). After a real selection replacement, the old continuation
returned HTTP 409 `search_restart_required` in 181.5 ms (6 calls). A concurrent
selection movement during a Main phrase request returned the new selected
Contribution in 1,100.8 ms, with 14 calls, 83,364 Fuseki response bytes and
5,529 API response bytes; that was 8 more calls than the stable six-call
baseline. Each completed measured request stayed within 72 calls, 8 MiB Fuseki
response bytes, 1 MiB API response bytes and the 1,500 ms deadline. The probe's
aggregate 79 metered calls span multiple separate requests and are not a
per-request budget comparison.

A follow-up (`load-20260926t221214-9e4337`) cold-restarted the persistent
storage services in 50.353 s, then ran the same trace. Its cold Main phrase
read returned 11/11 complete results in 706.3 ms using 8 calls and 38,774
response bytes. Cursor pages, language probes, rejected phrase and payload
limits also completed. However, its deterministic selection-movement retry
returned HTTP 503 `search_index_unavailable` at 1,504.8 ms. Main's retained
attempt diagnostic shows the first read detected `SearchSnapshotMoved` after
1,455 ms and the 45 ms writer wait exhausted the unchanged 1,500 ms request
deadline. That request used 6 Fuseki calls and received 37,506 bytes before
the timeout. The earlier warm-engine retry returned the new selection in
1,100.8 ms (14 calls), so the current evidence distinguishes a warm pass from
a cold-storage retry miss. The cold trace did not reach its final stale-token
check; the preceding warm trace did return HTTP 409
`search_restart_required`. Search's retry remains within its hard wall bound
but fails the required complete-result/error objective under this forced cold
movement. No budget was raised. Neither probe measures cross-owner calls in
the deliberately concurrent write setup, candidate degree, or growth scales up
to 10,000/20,000 units; SEARCH18 remains partial.

The continuation built `fx-medium-deecad138315` with 100,000 imported Works
and 10,000 indexed public MatchUnits. Its deterministic bodies include 64
`public load` hits for cursor/retry traces, 512 admitted `candidate degree`
hits, 513 `overflow degree` hits for explicit refusal, Chinese and Japanese
canaries, one 4 KiB body, and a Realm-rejected candidate. The graph loader
loaded 3,008,345 quads in 32.344 s and indexed 110,001 literals in 9.707 s;
the builder verified the public population and exact sampled postings. This is
a search materialization fixture: imported public selections have current and
projection rows but no fabricated command receipts or complete authorial
revision-object history. The fresh load cohort still exercises real
Account/Access/Main/Content commands and receipts. Imported units qualify the
public read/index population, not exact publication recovery.

This build took 821.846 s on the loaded worker host, so it **failed** the
600-second preparation objective. Object upload took 452.069 s for 400,000
acknowledged immutable objects, and the full volume size/file-count walk took
242.489 s; graph loading, migration, verification and stop accounted for the
remaining time. The stopped consistent backup was retained, but no restore or
capacity run was started after the preparation breach. The prior quiet-host
medium build and restore remain the relevant evidence for the preparation
design; the new backup must be restored and timed on the manager's quiet host.
The relay now seeks the exact next outbox sequence in one indexed snapshot query,
and the fixture-backed 180-second load runner recognizes a restored corpus with
at least 10,000 public units as the named practical profile. OPS05 and SEARCH18
remain partial until that run measures latency, lag, memory and recovery, and
the 20,000-unit scale and cold movement retry are exercised successfully.
