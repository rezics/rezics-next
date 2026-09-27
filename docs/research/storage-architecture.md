# Storage architecture decision

Selected 2026-09-24: **PostgreSQL for Content and operations;
Apache Jena/Fuseki/TDB2 for semantic authority and joint graph/text queries;
embedded jena-text/Lucene for the first search binding.** This is the startup
choice. The [architecture overview](../architecture/overview.md),
[Content owner](../storage/postgresql.md), [Jena owner](../storage/jena.md) and
[search contract](../contracts/search.md) own current behavior. The
[qualification record](../plan/qualification.md) records backend phase 1;
its passing acceptance run does not establish production capacity or the
planned 500 million entity scale.

## Why this boundary

Semantic names, predicates, typed claims, context decisions and publication
references belong together where their graph invariants and query joins execute.
PostgreSQL owns independently edited bodies, exact revisions, drafts, private
preferences and operational transactions. Each field has one writer. Publishing
pins an exact PostgreSQL revision; derived RDF MatchUnits and Lucene text make
that revision searchable only after the graph decision and eligibility are
available. This first binding reuses Jena's text/index machinery at the cost of
a third physical representation and graph writer load.

The product accepts delayed discovery: owner-local commits, durable outboxes
and replayable projections fit ordinary social publication better than a
distributed transaction. A fixed prefix of text hits followed by graph checks
loses valid results. Keeping graph and text in one Jena-planned query avoids
a general application-side join coordinator. Exact bodies can be fetched in
a bounded PostgreSQL batch after result membership and ranking are settled.
The [publication code](../../services/main/src/modules/content-publication/publish.ts),
[projection relay](../../services/main/src/modules/content-publication/relay.ts)
and [search read](../../services/main/src/modules/content-publication/search.ts)
carry the executable path.

Jena supplies RDF terms, named graphs, SPARQL and a local text operator. It
does not itself provide REZICS command receipts, permanent component history,
transactional shape admission, current Access decisions or crash reconciliation.
TDB2 has one active writer. Its queue and mixed-load tails remain deployment
constraints even though the phase-1 backend run passed. Required deployment
components must be eligible self-hosted open-source or source-available
software; a required closed module does not meet that constraint.

## Alternatives and reasons for rejection

| Alternative | Decision reason |
| --- | --- |
| PostgreSQL as sole authority with graph/search replicas | Plausible simpler write boundary, but invariant-sensitive graph edits would need validation against authoritative SQL records, never a stale replica. Current contextual graph commands favor graph authority. |
| PostgreSQL + Jena + OpenSearch | A complete projected social query is possible, but a separate index adds synchronization, rebuild and dependency-fanout costs. The bounded public probe did not qualify dynamic predicates, sparse Realm selection or private search. The earlier three-engine choice was premature. |
| Virtuoso Open Source, RDF4J/Lucene, QLever | Credible integrated alternatives. Their command, validation, update, history and text-index lifecycle have not beaten the selected complete binding on a common workload. QLever supports updates; it is not read-only. |
| Dgraph or Fluree | Both passed useful bounded graph/history probes. Dgraph needs a binding for RDF terms and generic predicates; one Alpha did not test distribution. Fluree's native history does not remove the shared application revision contract, and its SQL bridge lacks a shared PostgreSQL snapshot. |
| PGroonga or other SQL text binding | The bounded CJK fixture passed, including a fast selective SQL literal plan. It did not establish ranked Realm/occurrence-aware search or the whole update lifecycle. |
| MarkLogic, GraphDB and Siren | Mechanism references for integrated joins and projections; required proprietary editions/modules do not meet the deployment constraint. |

OpenSearch remains a candidate for a fixed, fully projected discovery profile if
its complete ranking, update fanout and recovery costs win. A read projection
never gains write authority. External-content Lucene indexing could later remove
the derived RDF text copy, but needs its own exact-revision, deletion and rebuild
qualification. Neither is a startup dependency.

## Measurement provenance and limits

The [reproducible research lab](../../scripts/research/storage_architecture/README.md)
ran isolated loopback services on a Threadripper 3970X workstation with Btrfs/NVMe.
Its 2026-09-24 raw records are [graph/publication](../../scripts/research/storage_architecture/evidence/2026-09-24/graph.json),
[post-index reads](../../scripts/research/storage_architecture/evidence/2026-09-24/graph-post-index.json),
[CJK/SQL plans](../../scripts/research/storage_architecture/evidence/2026-09-24/search.json),
[OpenSearch](../../scripts/research/storage_architecture/evidence/2026-09-24/opensearch.json),
[Dgraph](../../scripts/research/storage_architecture/evidence/2026-09-24/dgraph.json),
[SQL bridge](../../scripts/research/storage_architecture/evidence/2026-09-24/bridge-measurement-baseline.json)
and [snapshot counterexample](../../scripts/research/storage_architecture/evidence/2026-09-24/bridge.json).
Fixtures, versions and commands remain with those scripts; these results are
component evidence, not equivalent whole-product benchmarks.

| Observation | What it established, and what it did not |
| --- | --- |
| At 10k and 50k Works, Jena and Fluree passed 57 sparse-selection, bounded traversal, CAS and publication checks. Eight same-head writers yielded one winner/receipt. | Exact-reference and guarded-command mechanisms are feasible. The lost-response injection was not a power-loss or network-fault test; bare Fuseki did not enforce a domain SHACL rule. |
| Jena and PGroonga each passed 11 CJK/mixed-script substring cases. A global first-100 text prefix lost all five late Realm-eligible hits. | Complete filtering is necessary. The 50k Jena Realm-bound `CONTAINS` sample p50/p95 was 3.67/5.69 ms, while subject-bound `text:query` was 526/563 ms; one HTTP call can still do excessive internal work. The selective SQL literal control was faster than PGroonga for that fixture. None establishes ranked broad-corpus relevance. |
| OpenSearch's single-request public projection found all five selective eligible Resources at 10k and 50k; the broad control checked counts and top-20 membership. | A complete fixed-policy joint query can execute in one search engine. A rating-only update of a 409-object root sent 545,995 bytes, illustrating rewrite amplification. No graph relay, private statistics, crash replay or production update tail was qualified. |
| Dgraph's 10k-Work one-Alpha probe retained exact revisions and one winner across eight guarded upserts. | Application-owned history/CAS can be built there; arbitrary semantic fidelity, distributed scale and crash recovery were outside the probe. |
| Fluree's SQL bridge split more than 2,000 outer keys; an interleaved 2,001-key read returned 2,000 old and one new PostgreSQL title. Default numeric/JSON mapping also lost precision. | Federation is a query adapter, not a shared transaction or opaque lossless payload transport. |

Small warm samples, differing query semantics, fixture compression and a
single-client workstation run cannot rank engines by production tail latency,
storage cost or target-host capacity. Preserve raw plans and failures when
reassessing; do not promote a component probe into a completed acceptance gate.

## Fixed-call plans and performance evidence

The decision requires finite profile-specific ceilings for all backend request
attempts, serial dependency stages, transferred bytes and deployment fanout.
Count Account, Access, readiness, cursor setup, data reads, retries and nested
calls. A single HTTP request can hide expensive postings or shard work; a
per-candidate refill loop is not a bounded plan. Current budgets and tests
belong to [workload budgets](../storage/workload-budgets.md) and the
[search owner](../contracts/search.md), with recorded phase-1 evidence in
[qualification](../plan/qualification.md). Full performance verification and
500 million entity capacity remain later work; these research samples are not
their SLOs.

## When to revisit the choice

Reopen an engine or binding boundary after a material failure of complete
multilingual/Realm/occurrence-aware search, writer throughput and catch-up,
fixed-call and byte budgets, private pre-match disclosure, exact revision
replay/erasure, or mixed-cut recovery under the admitted workload. Compare the
same semantics and target deployment, including projection fanout, index growth,
P95/P99 with failures, rebuild time, operator plans and the synchronization code
each design requires. Change a failing placement or profile before adding a
general query optimizer to Main. Wikimedia's
[Search Update Pipeline](https://wikitech.wikimedia.org/wiki/Search/Update_Pipeline)
and [WDQS updater](https://wikitech.wikimedia.org/wiki/Wikidata_Query_Service/Streaming_Updater)
inform durable, revision-aware ingestion; they do not supply a cross-store
transaction or a ready-made REZICS query plan.
