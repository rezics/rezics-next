# Implementation questions and experiments

Fluree, native Semantic Web, graph-integrated full-text, Main Version, Space/context
classification and universal package management are selected. Research resolves
their implementation details rather than treating those choices as undecided.

| Question | Investigation and decision criterion | Owner |
| --- | --- | --- |
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
