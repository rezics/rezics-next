# Design evidence and qualification boundaries

The selected architecture is the maintainer's September 2026 decision to start
REZICS with PostgreSQL + Apache Jena/TDB2/jena-text/Lucene, confirmed 2026-09-24.
Official sources were reviewed on 2026-09-23–24. They support
component mechanisms; application protocols below are REZICS design deductions,
with runtime acceptance still pending.

| Decision | Primary basis | Selected use and limit |
| --- | --- | --- |
| Native semantic representation | [RDF 1.1](https://www.w3.org/TR/rdf11-concepts/), [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/) | Stable IRIs, values and exchange; ownership and acceptance are application rules. |
| Private graph server | [Fuseki](https://jena.apache.org/documentation/fuseki2/), [TDB2 setup](https://jena.apache.org/documentation/tdb2/tdb2_fuseki.html) | SPARQL query/update through one configured dataset, reachable only through trusted owners. |
| Local transactions | [TDB transactions](https://jena.apache.org/documentation/tdb/tdb_transactions.html), [remote RDFConnection](https://jena.apache.org/documentation/rdfconnection/#remote-transactions) | Single writer and concurrent readers; one request is the remote transaction boundary. REZICS adds guarded receipts and sequence fences. |
| Graph-integrated text | [jena-text](https://jena.apache.org/documentation/query/text-query.html) | Lucene text matches join SPARQL graph patterns. Per-triple index documents, analyzer behavior, early limits and disclosure need explicit product handling. |
| PostgreSQL Content authority | [PostgreSQL JSON](https://www.postgresql.org/docs/18/datatype-json.html), [transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html) | Body revisions/drafts and local receipt/outbox commit together. Retain exact serialized bytes for the history digest; JSONB does not preserve original serialization. This authority split is a REZICS decision. |
| Revision-aware derived services | [Wikibase entity storage](https://doc.wikimedia.org/Wikibase/master/php/docs_storage_entities.html), [WDQS updater](https://wikitech.wikimedia.org/wiki/Wikidata_Query_Service/Streaming_Updater) | Separate editorial revisions from derived query state and replay revision-identified changes. Does not imply our two-owner boundary or one distributed transaction. |
| Durable projection pipeline | [Wikimedia Search Update Pipeline](https://wikitech.wikimedia.org/wiki/Search/Update_Pipeline) | Separate change publication, enrichment/indexing and recoverable progress. Initially use bounded owner-outbox polling; Kafka/Flink are not necessary at startup, and transport alone cannot solve graph/text query planning. |
| Exact revisions and recovery | [TDB2 administration](https://jena.apache.org/documentation/tdb2/tdb2_admin.html) | Snapshot backup and compaction are database operations. Permanent product revisions are retained component manifests, not TDB2 generations or reopenable historical transactions. |
| Shape validation | [Jena SHACL](https://jena.apache.org/documentation/shacl/index.html), [SHACL](https://www.w3.org/TR/shacl/) | Validate a candidate graph with explicit focus and dependency coverage; a report endpoint does not impose validation on ordinary updates. |
| Current authorization | [OAuth BCP](https://www.rfc-editor.org/rfc/rfc9700.html), [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | Verified identity and causality motivate current fences. Neither provides an automatic PostgreSQL/Fuseki distributed transaction. |
| Classification and provenance | [SKOS](https://www.w3.org/TR/skos-reference/), [PROV-O](https://www.w3.org/TR/prov-o/), [Web Annotation](https://www.w3.org/TR/annotation-model/) | Reuse exact meanings; contexts, editorial control and disclosure remain explicit. |
| Optional distributed event delivery | [JetStream](https://docs.nats.io/learn/jetstream/pull-consumers) | Can transport committed outbox events later; the initial polling relay needs no broker. |

## Why this startup boundary

The selected combination keeps RDF query and indexed text in one server and uses
its supplied storage and search modules. This reduces the initial integrations
and avoids requiring a custom search operator or database fork before the first
journey. The tradeoff is explicit application work for permanent revisions,
Access enforcement, optimistic validation and crash reconciliation.

PostgreSQL Content keeps drafts and body revisions out of the semantic write
transaction. Publication pins an exact revision and the worker materializes
derived RDF text through Jena's existing wrapper. This first binding reuses its
index/delete/rebuild machinery at the cost of another text copy and graph writer
load. Jena's external-content model permits removing that RDF copy later, but
requires separately qualified ingestion and reconstruction. Neither binding is
an automatic PostgreSQL/Jena transaction or evidence of complete ranked-search
performance. The [research report](../research/storage-architecture.md) retains
the alternatives, working probes and known slow-plan/candidate-truncation cases.

Embedding TDB2 in a rewritten Java Main could provide direct transactions and
validator calls, but would also replace the chosen TypeScript/Bun application boundary.
The initial design retains Main and uses bounded HTTP operations. A detached text
service would introduce another projection/transport boundary without satisfying
the requested graph/text composition by itself. Either direction needs measured
benefit before revising this baseline.

Use the exact [installation release profile](../operations/installation.md),
including its source links for Java/Lucene versions. Apache Jena is distributed
under [Apache License 2.0](https://github.com/apache/jena/blob/jena-6.2.0/LICENSE);
retain the distribution's LICENSE/NOTICE and dependency notices. This replaces
the previous engine's deployment and patch-maintenance assumptions.

## Evidence that does not transfer

The 2026-09-26 [editorial-protection decision](../contracts/editorial-protection.md#evidence-and-alternatives)
reuses these owner transactions for modification guards and exact review/application.
Its [verification evidence](../contracts/information-verification.md#evidence-and-qualification)
separates provenance, source dependence, acceptance and quality. The linked primary
sources support those distinctions/mechanisms; they do not prove the proposed
composition, single-writer cost or restored protection coverage. A separate lock
service is not universally invalid. No additional authority is selected here.

Prior Fluree probes remain reproducible historical research, including transaction,
SHACL, policy and latency observations. They are not Jena conformance results.
[Research](../research/README.md) preserves those boundaries and the unresolved
Access/model lessons. No prior engine's large-workload report establishes TDB2
capacity, Lucene recovery behavior or REZICS's concurrent latency.

Initial practical-volume qualification checks command races, bounded work,
multilingual relevance, private-data exclusion and backup recovery on available
hosts. The 500M/3B arithmetic remains planning evidence under
[workload policy](../storage/workload-budgets.md), never a first-start requirement.

## Remaining validation

Qualify the exact configured update path, lost responses, immutable revision
restoration, index delete/crash/rebuild behavior, CJK analyzer offsets, filtered
Top-K completeness, SHACL read-dependency protection and current-policy historical
reads. The [acceptance owners](../testing/README.md) define required outcomes.
Documentation checks cannot close any runtime gate.
