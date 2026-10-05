# Workload and capacity decisions

## Capacity planning

The maintainer confirmed 500 million business entities/documents on 2026-09-25;
3 billion is a future scenario. These are not triple or per-owner row counts. The starting topology
is one 16-core/64 GB host and one 12-core/32 GB host, not evidence of fit.
`CAPACITY_SCENARIOS` and `deriveCapacity` in
[`scripts/load/budget.ts`](../../scripts/load/budget.ts) keep owner population,
current facts, retained facts, measured RDF bytes per fact and queue retention
separate. Relational revisions, WAL, immutable objects, text indexes, backups
and rebuild space require separate measurements; do not count shared pages or
indexes twice. Each owner must measure its skew, rates, bytes, lag, memory and
restore/rebuild time before choosing placement or admission thresholds.

## Complexity contracts

Every API operation, job, importer, projection and recovery/rebuild path needs
a cost contract beside its owner. The contract names dimensions, stage bounds,
index and selectivity preconditions, retries, calls and bytes, memory, write
amplification, lock scope and evidence. Include absent, denied, stale, cold and
fallback paths. Unknown engine work remains unverified. Interactive work must
not accidentally grow with unrelated corpus or history; batch work must not
rescan completed prefixes. Big-O alone cannot establish latency or contention.
The [complexity verification method](../testing/complexity.md) explains multi-scale observations.

Lock scope (write-concurrency Goal, 2026-10-06): no user write path takes a row,
counter or constant lock key shared by unrelated targets. Ordered consumers use
one of three shapes instead of a gap-free head that writers update: a reader
gated by `pg_snapshot_xmin` over `(epoch, xid, id)`, a post-commit sequencer
that alone numbers committed rows, or change rows that builders fold. The epoch
leads because a logical restore does not carry the transaction counter.
[`serialization-points.ts`](../../scripts/qa/serialization-points.ts) refuses a
new singleton, constant advisory key or shared-then-exclusive gate upgrade unless
it is listed with its class and reason; application pools bound lock and
transaction waits ([`pg-pool.ts`](../../services/main/src/infrastructure/pg-pool.ts)),
and `/health/ready` reports horizon consumers' lag.

## Data preparation and import

The maintainer set a 600-second ceiling on 2026-09-26 for ordinary fixture
build or restore, including startup, migrations, readiness and a small smoke
check. Build background data once, retain a consistent stopped backup of all
owners, and restore isolated writable copies for runs. A code-only change does
not invalidate that backup. The manifest compares owner generators, model and
schema inputs, migrations and engines; normal restore reads sampled exact state
and index readiness without a full corpus scan or receipt replay. Exceeding the
ceiling calls for a setup fix, not a longer timeout.

Use small command fixtures for real authorization and receipts, bulk fixtures
for background population, and validated chunks/checkpoints for initial import.
Background rows bypassing commands are not evidence for those commands. Preserve
identities, revisions, authority and cross-owner references; keep object upload
and staging outside TDB2's single writer, with required post-state validation
inside its transaction. `task fixture:build` creates the reusable backup;
`task fixture:restore -- --fixture <id> --run-id <id>` makes a writable copy.
`REZICS_FIXTURE_ROOT` places worker metadata in checkout-local `.temp/`.
Full reconstruction and recovery proofs belong to final acceptance or a relevant
defect investigation. Routine preparation and its evidence are separate from
the timed operation.

Large command corpora and performance runs use the
[disk-backed scale recipe](../testing/complexity.md#api-request-work-profiles).
Ordinary tests keep tmpfs. This separates TDB2 file growth from the JVM's
memory allocation; it does not relax preparation time or command semantics.
Catalogue capacity probes create Works, publish/select contributions and decide
classification through the public APIs. Measure their preparation throughput
and storage growth before claiming a scale. If those commands cannot reach a
requested scale within 600 seconds, fix their owner paths; bypassing admission,
validation or projections cannot qualify the write cost.

## Fixed bounds for interactive requests

The maintainer requires a fixed maximum of storage/service round trips for each
admitted interactive operation. A timeout, final LIMIT, HTTP wrapper, cache or
parallel dispatch alone does not establish that bound. A query/command profile
must count authentication, Access, readiness, retries, fallback, hydration and
transaction calls, plus transferred IDs/bytes and internal engine work. Budget
exhaustion is an explicit partial/unavailable result, never exact empty or
complete top-K. Cross-owner sets that cannot fit one complete exchange require
an indexed local plan or an asynchronous operation. Requalify profile/topology
changes against skew, contention, latency, memory and overload on elected
hardware. Async jobs need bounded batches and measured catch-up capacity.

PostgreSQL's JIT compilation is off for the application databases (manager,
2026-10-04). Interactive queries are short and bounded; a misestimated plan
that crossed `jit_above_cost` spent about 240 ms compiling on every Studio read
(G-1049), more than the query itself. A batch job that measurably benefits may
enable JIT for its own session. Production configuration applies the same
setting as `infra/dev/compose.yaml`.

## Qualification scope and decisions

The retained [OPS05](../../scripts/qa/cases/operations.ts) and
[SEARCH18](../../scripts/qa/cases/backend-integration.ts) load tests cover named fixture-backed scopes,
not the 500-million-entity requirement. The frozen
`fx-medium-c9f6e4fdcb52` fixture has 100,000 Works and 10,000 public
MatchUnits. Three quiet-host runs each completed a 63-second offered mix of
253 reads and 63 writes with zero errors and relay lag ending at zero:

| QA run | Read p95 | Edit / selection / rating p95 | Recovery |
| --- | ---: | ---: | ---: |
| `20260927t081313-6acb60` | 366 ms | 942 / 756 / 697 ms | 21.0 s |
| `20260927t082537-290a9f` | 447 ms | 1,005 / 878 / 585 ms | 22.2 s |
| `20260927t083748-b28663` | 440 ms | 666 / 1,002 / 566 ms | 23.9 s |

The third tier took 236.7 of its 240-second test budget. The earlier
20-second tier `20260927t035602-33bffd` passed its named mix; earlier probes
with 503s and deadline misses drove bounded retry/readiness changes, not raised
request budgets. SEARCH18's registered trace measured 512 admitted candidates
in 177.0 ms, rejected 513 with HTTP 422, and returned a moved selection in
698.9 ms with 14 Fuseki calls. No native operator or 20,000-unit result follows
from those observations.

This evidence qualifies the named 63-second host mix and 10,000-unit search corpus only.
The 180-second sustained profile, 20,000-unit search scale, full
native Jena/SQL work, 500-million-entity placement and 3-billion scenario are
not qualified. A later owner-specific threshold breach should trigger admission,
query/profile restriction, index adjustment or a placement review. Sharding and fleet operations remain separate measured work.

## Owner workloads

Each owner's planning axes are declared as checked inputs in
[`scripts/load/budget.ts`](../../scripts/load/budget.ts); derive the owner's
facts and retained history separately from the global scenario above, and use
[multi-scale work observations](../testing/complexity.md) before qualifying a
threshold. Current small fixtures do not establish 500-million-entity capacity.
The design rules each owner keeps:

### Statements, grouping and context

Anchor statement, inverse and vocabulary reads; stage cycle-sensitive changes;
invalidate affected statements and context generations incrementally. Never
materialize Resource × Realm or Resource × Context × individual products, and
never scan Realm members to discover their interpretation: resolve indexed
explicit, speaker, entry and Global selections over bounded pinned dependency
chains, and reject ambiguity or unavailable bases. A final page limit does not
bound aggregation work, so budget candidate statements, support fan-out,
correlated occurrences, distinct-key memory, group overlap and hydration,
including cold caches. Count facts, resources and occurrences separately; never
infer distinct targets by summing overlapping groups. A new semantic Context
revision justifies no corpus rewrite or automatic fan-out adoption; prove pinned
statements stay unchanged and measure actual adoption separately.

### Identity and Access

Use selective subject/target/scope indexes, batched decisions, bounded impact
planning and immediate scope fences before cleanup; the private directory is
never a per-request join. An authority change advances only the generation of
what it changed (membership episode, grant source, representation path, member
set); admissions pin the sources their proof used and recheck them at register,
retry and claim, so a Realm join never invalidates unrelated admissions. Enforce budgets inside execution (a counter checked
after an unbounded SQL scan is insufficient), and treat budget exhaustion as
unavailable, never as allowance or proof of no authority. Materialize ancestry
only where measured reads warrant it, budgeting storage by actual closure, and
stage index generations because reparenting and revocation multiply updates.
The [depth study](../research/access-depth-representation-and-voting.md)
explains the unqualified tuning candidates (32-edge hierarchies, 8-edge
representation chains, 64 evaluator levels, 2,048 decision states, 50 ms
deadline, 100-target batches); they are not production limits. Report 99%
legitimate-task coverage as a separate product target with representative task
weights, not from a small chain probe.

### Governance, voting and delivery

Commit decisions and fences before bounded propagation; page recipients; bound
intent, dead-letter bytes and external retries. Prepare electorate, weight and
allocation snapshots before a poll opens, so ballot mutations work on named
entitlements and expected revisions without recomputing the electorate. Use
replayable tally projections rather than one global exact write counter; full
liquid routing is a separately qualified bounded job.

### Catalogue, sources, subscriptions and ratings

- Catalogue editing pages source/target correspondence, coalesces root-local
  search updates and stages large adoption bundles; a name edit never rebuilds
  unrelated facts.
- Source interoperability streams acquisition with bounded joins, keeps source
  load apart from the product dataset and detects retention gaps; full
  source-corpus indexing is a separately admitted workload.
- Subscriptions index by beneficiary, target and period, reserve atomically
  per owner, reconcile providers idempotently and never recompute all
  beneficiaries synchronously.
- Ratings reduce per rater before population aggregation, update affected
  buckets incrementally, bound interval intersections and run exact analytics
  asynchronously.

### Discovery refresh

G-1063 replaces catalogue copies with versioned changed-Work posting lists and
term/Concept counters. Irrelevant events advance coverage only. Global browse
and rating scopes have an indexed foreground lane; eight foreground claims give
one background opportunity, so idle Realm count does not set reader catch-up
latency. Full builds finish their pinned population scan and reconcile a durable
change journal before publication. Named scope-wide changes, unknown/gapped
input and safety invalidation retain a full-build fallback. Opaque composition
changes still need better owner receipt effects to avoid harmless rebuilds.

QA `20261004t124611-ff1da1` measured the public and global-rating populations
together at 100/1,000/10,000 Works: 1.90/13.59/135.15 seconds, under a five-minute
10,000-Work budget. At each scale, with zero and 1,000 queued idle scopes,
irrelevant refreshes used four graph calls/46 SQL statements and one-Work rating
refreshes used eight/126. No generation was allocated for an irrelevant event;
one posting version was added for the rated Work. These are per-serving-basis
costs, not a constant total across every genuinely affected scope. Real-command
tests check a ten-second rating-readiness recovery budget after rating/follow
writes and continued Discover availability.

The unrelated background is a native, sparse projection corpus; the target,
Context and rating writes use public commands. It does not qualify command
preparation, dense classification/rating fanout, the medium fixture or global
capacity. Projection rows and unreferenced terminal metadata retire after six
minutes, with three 1,000-row purge limits per tick; audit receipts/activations
remain. The owner [cost model and decisions](../../services/main/src/modules/discovery/README.md)
record the executable probes, source-consistency boundary and post-merge behavior.

## Catalogue write qualification

G-1038, 2026-10-04: disk-backed Jena 6.2.0, one native author and one global
classification per imported Work. The public command corpus was built once to
10,000 Works, with stopped all-owner backups at 1,000 and 10,000. Full preparation,
including startup and the final backup, took 388.0 s. The snapshots retain the
undelivered relay backlog and immutable objects; they are command/read fixtures,
not evidence of end-to-end projection throughput.

| Background Works | Path | ms / Work | Durable graph commits | Allocated TDB2 KiB / Work |
| --- | --- | ---: | ---: | ---: |
| 100 | Ordinary publication + classification | 3,058 | 5 | 5,272 |
| 100 | Compound catalogue | 499 | 1 | 1,712 |
| 100 | Bulk catalogue, 128 items | 35.8 | 1 / 128 | 53.7 |
| 1,000 | Ordinary publication + classification | 3,422 | 5 | 8,012 |
| 1,000 | Compound catalogue | 511 | 1 | 2,712 |
| 1,000 | Bulk catalogue, 128 items | 27.0 | 1 / 128 | 71.8 |
| 10,000 | Ordinary publication + classification | 2,965 | 5 | 11,868 |
| 10,000 | Compound catalogue | 792 | 1 | 4,000 |
| 10,000 | Bulk catalogue, 128 items | 28.5 | 1 / 128 | 135.5 |

The ordinary path creates a draft, publishes and selects short native text, then
classifies it. Initial metadata and author credit already share its creation
commit. The compound path creates a public catalogue record without selected
text. These are distinct workloads, not interchangeable latency measurements.
Numbers are traced requests at each background scale; bulk latency is batch wall
time divided by 128. Allocated filesystem blocks are distinct from logical file
lengths and modified index pages. No latency distribution or storage-cold claim
is made.

The write diagnostic elects `catalogue-preparation-v1`, with a 15,000-position
broker ceiling, to measure durable writes separately from relay delivery. The
production ceiling remains 1,000. Eight vocabulary definitions support the
query matrix; the separate 128/512-definition scale probe remains unqualified.
Use `tests/qa/integration/g-1038-catalogue-scale.test.ts` for the writer and
`G1032_BACKUP=<backup.json>` with `g-1032-query-cost.test.ts` for isolated restores.
The benchmark, stopped-copy driver and public import recipe live under
`scripts/load/`; neither raw storage seeding nor a bulk loader establishes these
command results.

The retained-cut smoke passes at both scales (QA `20261004t002639-892359`),
checking sampled exact Work heads, public names and native index readiness.
The writer run `20261003t233032-70c3be` completed all measurements and stopped
backups but failed during a second pool close; that cleanup is corrected.
G-1032 Query attempts on independent 1,000 and 10,000 restores
(`20261004t000229-1f970a`, `20261004t001328-46e0b0`) timed out at 420 s during
Discovery generation preparation, before the interactive query assertions.
The public advance route now uses the existing bounded batch path, but per-Work
classification hydration remains the preparation bottleneck. These query scales
and the richer vocabulary probe are unqualified; no timeout was extended.
