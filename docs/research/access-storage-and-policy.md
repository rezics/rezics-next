# Access storage, object authority and ordered policy evaluation

Research measured 2026-09-22; architecture reconciled 2026-09-23. Select
**private PostgreSQL authority plus a bounded Access evaluator in Main**. The
[identity/access contract](../contracts/identity-and-access.md) and current
`services/main/src/modules/access/` code own the operational rules. This page
retains the storage choice and its evidence. Fuseki/TDB2 owns product RDF; the
[authorization bridge](../implementation/authorization-bridge.md) governs
cross-store admission. The [depth and voting review](access-depth-representation-and-voting.md)
records the separate institutional limits.

## Why PostgreSQL is the initial authority store

Grant, membership, representation, policy revision, receipt and fence changes
need one coherent private authority transaction. An ordered decision must read
mutually consistent facts: batching independent checks or bypassing caches does
not by itself supply one snapshot. Main can load a bounded decision frame in a
PostgreSQL transaction and evaluate its first-applicable policy locally. A
PostgreSQL transaction still cannot atomically commit a later Fuseki mutation;
the admitted-command and revocation protocol handles that boundary.

PostgreSQL was already in the selected operational stack. MySQL would add another
database without an observed Access advantage; SQLite would change the shared
multi-process authority problem. SpiceDB and OpenFGA remain credible specialized
read evaluators, but their persistence and API calls do not become part of a
Main transaction merely by sharing a PostgreSQL server. Cedar could help with
rich conditions, but its default forbid-wins semantics do not provide arbitrary
first-applicable order. A PostgreSQL graph extension adds query syntax without
grant lifecycle or policy composition. The historical Fluree 4.2.1 option was
eligible under the accepted source-available license criterion; product RDF later
moved to Jena. None of those alternatives removes the need to define object
representation, grant mutation, exclusions and current disclosure in the
application.

## What the comparison measured

The [reproducible four-backend lab](../../scripts/research/access_backend_comparison/README.md)
used PostgreSQL 18.6, Fluree 4.2.1, SpiceDB 1.56.2/PostgreSQL and OpenFGA
1.21.0/PostgreSQL on one local Threadripper host with tmpfs storage. All four
passed 12 stationary scenarios through a common application combiner. This did
not establish mutation admission, complete lifecycle, confidentiality or
production capacity. The [environment and raw evidence](../../scripts/research/access_backend_comparison/evidence/2026-09-22/environment.json)
retain the exact setup.

In the coherence probe, a writer alternated atomically between two states that
both deny. The reader assembled five predicates. Invalid allows were 0/150 for
PostgreSQL repeatable-read, 0/150 for SpiceDB fully-consistent bulk, 8/150 for
OpenFGA HIGHER_CONSISTENCY BatchCheck and 0/150 for Fluree same-ledger snapshot.
The [counterexample](../../scripts/research/access_backend_comparison/evidence/2026-09-22/snapshot-composition.json)
is specific to that OpenFGA application composition: its BatchCheck did not
expose one revision for the assembled checks. It is not a claim that OpenFGA is
generally unsafe, or that zero observed failures prove the other paths correct.

Warm, reused-client decision frames had these local p50/p95 times in milliseconds;
the batch column is 50 **grant checks**, not 50 complete commands:

| Path | Frame p50 / p95 | Batch median |
| --- | ---: | ---: |
| PostgreSQL repeatable-read | 0.362 / 0.416 | 1.956 |
| SpiceDB/PostgreSQL | 0.624 / 0.699 | 1.266 |
| OpenFGA/PostgreSQL | 2.136 / 3.002 | 11.137 |
| Fluree/Main | 1.209 / 1.477 | 10.035 |

These [microtimings](../../scripts/research/access_backend_comparison/evidence/2026-09-22/microtiming.json)
exclude login, command effects, durable-disk and mixed concurrent load, and use
different transports and query shapes. They are not production SLOs or a general
engine ranking. The Fluree history probe also showed that reading old content
under old authority can reveal revoked material; current disclosure needs an
explicit current-authority check regardless of graph storage. No Jena path was
measured in this retired-engine comparison.

An earlier [PostgreSQL policy probe](../../scripts/research/access_policy_probe.py)
passed 25 illustrative assertions, with [SQL fixtures](../../scripts/research/access_policy_probe.sql).
Trusted fixture writes do not qualify the real grant API, concurrent mutation,
cross-store revocation or load. Revisit the selected evaluator if representative
mixed workloads with identical policy, freshness and list completeness show a
need for specialized relationship evaluation. The
[recorded backend qualification](../plan/qualification.md) states the current
accepted scope; full performance and scale verification remain later work.
