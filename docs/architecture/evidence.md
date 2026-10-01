# Design evidence and qualification boundaries

The PostgreSQL + Jena/TDB2/jena-text selection was confirmed 2026-09-24 after
reviewing official sources on 2026-09-23–24. These sources explain mechanisms;
they do not prove REZICS's combined protocol or production capacity.

## Why this startup boundary

[Fuseki](https://jena.apache.org/documentation/fuseki2/) and
[jena-text](https://jena.apache.org/documentation/query/text-query.html) combine
SPARQL graph patterns with Lucene text matches in one configured service.
[TDB transactions](https://jena.apache.org/documentation/tdb/tdb_transactions.html)
support one active writer and concurrent readers; remote requests do not share a
business transaction. REZICS therefore owns guarded receipts, revisions and
cross-store reconciliation. [Jena SHACL](https://jena.apache.org/documentation/shacl/index.html)
provides validation machinery, but ordinary updates are not automatically
validated. The [storage lab](../research/storage-architecture.md) retains the
alternatives and slow-plan/candidate-truncation cases.

[PostgreSQL transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html)
keep Content revisions, receipts and outbox local to one authority. Exact body
serialization must be retained separately from
[JSONB](https://www.postgresql.org/docs/18/datatype-json.html), which does not
preserve source bytes. Projecting exact-revision text into RDF reuses jena-text's
index/rebuild path at the cost of extra storage and graph writes; it is not an
atomic PostgreSQL/Jena transaction. A rewritten Java Main or detached search
service would change the chosen application boundary without measured benefit.

## Evidence that does not transfer

The prior Fluree probes are historical research, not Jena acceptance or a scale
result. Source documentation for [OAuth](https://www.rfc-editor.org/rfc/rfc9700.html),
[SHACL](https://www.w3.org/TR/shacl/) and [PROV-O](https://www.w3.org/TR/prov-o/)
supports their mechanisms, not REZICS's admission, validation or provenance
composition. The [recorded qualification](../plan/README.md#current-state) states the
actual accepted scope; full performance, 500M corpus and production destruction
evidence remain later work. [Storage research](../research/README.md) keeps
experiment provenance and unresolved engine limits.
