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

## Qualification scope and decisions

The retained [OPS05](../testing/operations.md) and
[SEARCH18](../testing/backend-integration.md) load tests cover named fixture-backed scopes,
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
