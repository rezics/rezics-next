# Design evidence and qualification boundaries

The selected architecture is a maintainer decision. Primary sources explain
mechanisms and implementation constraints; they do not certify the complete
REZICS composition. References below were reviewed for the September 2026 design.

| Decision | Primary basis | Application and limit |
| --- | --- | --- |
| Native Semantic Web | [RDF](https://www.w3.org/TR/rdf11-concepts/), [JSON-LD](https://www.w3.org/TR/json-ld11/) | Shared identity/value/dataset representation; product ownership and state machines remain explicit. |
| Contextual classification | [SKOS](https://www.w3.org/TR/skos-reference/) | Concepts/schemes/labels/mappings; Realm acceptance and inference isolation are REZICS rules. |
| History and graph execution | [Fluree time travel](https://github.com/fluree/db/blob/v4.2.1/docs/concepts/time-travel.md), [compatibility](https://github.com/fluree/db/blob/v4.2.1/docs/reference/compatibility.md) | Native history supports thin business anchors; validate exact datatype/query/transaction profiles. |
| Graph-integrated text | [BM25](https://github.com/fluree/db/blob/v4.2.1/docs/indexing-and-search/bm25.md), [operator](https://github.com/fluree/db/blob/82dbcec3e435d6ed1d45bc0ed929432323b6b201/fluree-db-query/src/bm25/operator.rs) | Preserve bindings and combined evaluation; repair candidate/policy/incremental-update limitations. |
| Account and authorization | [OAuth BCP](https://www.rfc-editor.org/rfc/rfc9700.html), [Zanzibar](https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/) | Private login and explicit delegated authority with causality; no automatic cross-service atomicity. |
| Exact provenance/annotations | [PROV-O](https://www.w3.org/TR/prov-o/), [Web Annotation](https://www.w3.org/TR/annotation-model/) | Identify evidence and selectors; approval/disclosure are separate. |
| Ecosystem package profiles | [Cargo](https://doc.rust-lang.org/cargo/reference/resolver.html), [Go](https://go.dev/ref/mod), [Nix](https://nix.dev/manual/nix/stable/command-ref/new-cli/nix3-flake.html) | Different selection, feature and input-graph semantics require adapters. |
| Bounded transport | [JetStream](https://docs.nats.io/learn/jetstream/pull-consumers) | Durable delivery, ACK and replay; owner receipts/fences protect business effects. |

## Scale and deployment

[Fluree's published WGPB report](https://raw.githubusercontent.com/fluree/benchmark-db/main/benchmarks/wgpb/reports/wikidata-all/REPORT.md)
describes a large fixed workload with warm sequential queries. It is not a REZICS
concurrent-write, authorization, historical-search or recovery measurement.
[Performance tradeoffs](https://github.com/fluree/db/blob/v4.2.1/docs/design/performance.md)
inform bounded query admission. Initial practical-volume tests and future 500M/3B
estimates remain separate under [workload policy](../storage/workload-budgets.md).

## Engine use and maintenance

Fluree is selected. Its [BUSL-1.1 terms](https://github.com/fluree/db/blob/v4.2.1/LICENSE)
distinguish application use from an offering exposing substantial database-service
functionality. Confirm the rights for the actual public query/hosting product before
launching that surface. This is an operating boundary, not a reason to leave the
native semantic architecture unspecified. Maintain a small reviewed patch set,
conformance cases and index-generation upgrade procedure.

## Remaining experiments

Qualify CJK relevance and positions, combined query completeness/privacy, exact
history retention/relocation, Fluree conditional-write entry points, ecosystem
resolver equivalence and two-host recovery. Test these mechanisms directly rather
than reopening every selected design from scratch. [Research](../research/README.md)
tracks specific unresolved implementation choices.
