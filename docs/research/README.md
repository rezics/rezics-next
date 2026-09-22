# Implementation questions and experiments

Fluree, native Semantic Web, graph-integrated full-text, Main Version, Space/context
classification and universal package management are selected. Research resolves
their implementation details rather than treating those choices as undecided.

| Question | Investigation and decision criterion | Owner |
| --- | --- | --- |
| Semantic Web coverage and application-specific meaning | [Model coverage audit](semantic-web-model-coverage.md): reconcile all previously inventoried model families with standards, community vocabularies and research precedents; qualify exact mappings before adding dependencies or replacing native terms. | [Standards](../contracts/standards.md), [semantic model](../contracts/semantic-model.md), [spatial annotations](../contracts/spatial-annotations.md). |
| Access storage, object authority and ordered rules | [Comparative review](access-storage-and-policy.md): four executed backend paths, decision-snapshot and historical-policy counterexamples, bounded local measurements and the native PostgreSQL implementation plan. Production qualification remains pending. | [Identity/access](../contracts/identity-and-access.md), [Access](../services/access.md). |
| Access depth and institutional voting qualification | [Research basis](access-depth-representation-and-voting.md): academic/production evidence for the adopted typed authority composition, Realm/Org boundaries and conserved voting entitlements. Work-profile limits, production behavior and 99% task coverage require qualification. | [Identity/access](../contracts/identity-and-access.md), [votes](../contracts/votes-and-references.md), [governance](../contracts/governance-rules.md). |
| Access extraction threshold | [Placement research](access-and-interaction-placement.md): compare end-to-end freshness-aware evaluation when a consumer, isolation or scaling need justifies extracting the Main-hosted module. | [Access](../services/access.md), [service boundaries](../architecture/services.md). |
| Interaction capacity and later cache activation | [Fluree bootstrap](../implementation/interactions-and-cache.md): first qualify mixed-load tails, high-degree count work and replay. Redis integration and cache-failure qualification are outside the first release. | [Votes/references](../contracts/votes-and-references.md), [storage ownership](../storage/ownership-and-placement.md). |
| CJK analyzer/profile | Compare domain names, mixed scripts, offsets and recall/ranking; select versioned dictionaries. | [Search](../contracts/search.md). |
| Filtered graph/text execution | Prove candidate completeness, private-field isolation and incremental affected-root updates on actual engine paths. | [Search acceptance](../testing/search.md). |
| History retention and erasure | Verify exact anchors through engine GC/backup/movement and identify payload/history erasure coverage. | [Fluree](../storage/fluree.md), [security](../operations/security.md). |
| Ecosystem adapters | Compare current native-tool semantics against captured manifests/versions; preserve unsupported clauses explicitly. | [Package profiles](../contracts/package-profiles.md). |
| Placement and resource allocation | Measure disk/network/existing load; assess principal-host concentration and optional remote Account. | [Deployment](../operations/deployment.md). |
| Executable hosting envelope | Choose admitted runtime/isolation/secrets/cost policies before persistent hosting activation. | [Execution design](ai-hub-execution.md). |

Use primary specifications/code and bounded experiments appropriate to the active
phase. Record a selected answer in its owning contract and remove the resolved
question here. Do not accumulate historical implementation reports or duplicate
the plan's status table. [Architecture evidence](../architecture/evidence.md)
records the source basis and qualification limits.
