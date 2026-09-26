# Implementation questions and experiments

The maintainer selected **PostgreSQL + Jena/TDB2/jena-text/Lucene** on 2026-09-24
after the [storage architecture evaluation](storage-architecture.md). The
[architecture owner](../architecture/overview.md) and storage/search contracts
now define implementation. PostgreSQL owns Content bodies/revisions, drafts and
operations; Jena owns semantic aggregates and joint graph/text execution. The
first body binding extracts derived RDF MatchUnits and uses Jena's embedded
Lucene. OpenSearch and SQL text extensions are not startup dependencies.

The report retains measurements and complete-system comparisons as decision
evidence and possible responses to a material failed gate. It does not leave the
startup engine unselected. Wikimedia informs ingestion/recovery; proprietary
MarkLogic/GraphDB/Siren systems are architecture references only. Required
deployment components must be self-hosted open-source or suitable source-available.
Native i18n, exact history with owner adapters, delayed content visibility and
fixed whole-request budgets remain requirements. P0.8 qualifies the complete
Content/publication/search/recovery path; prior component probes do not pass it.

Apache Jena Fuseki + TDB2 + jena-text/Lucene is the current runtime baseline.
Native Semantic Web, Main Version, Space/context classification and universal
package management remain product requirements.
Research resolves their implementation details. Main uses Elysia 2/Bun over HTTP and
Access remains a Main module backed by PostgreSQL; a single Fuseki JVM owns graph
and index files. The [plan](../plan/README.md) distinguishes quickstart substrate,
authenticated vertical slices and the full retained product requirements.

Results from the retired Fluree architecture remain historical evidence. Their
engine identities, versions, tables and raw artifacts are preserved; none validates
Jena, supplies a Jena capacity claim or advances current runtime acceptance.

| Question | Investigation and decision criterion | Owner |
| --- | --- | --- |
| Application stack and framework tradeoffs | [Stack review](application-stack.md): selected Elysia 2/Bun, Yarn workspaces and vinext/Vite on Workers; Hono/Next alternatives, version evidence and bounded verification limits. | [Main](../services/main.md), [workspace layout](../development/repository-structure.md), [frontend](../plan/frontend.md). |
| Mature toolchain selection | [Toolchain survey](toolchain-survey.md): Jena modules, model/mapping tools, language libraries, domain standards and operations candidates. Executed graph evidence remains in the [CJK probe](../../scripts/research/jena_text_cjk/README.md); framework evidence has its separate scope in the stack review. | Each linked owner; [search](../contracts/search.md) for analyzer and query construction. |
| Agent-efficiency tooling | [Re-evaluation](agent-efficiency-tooling.md): which development tools shorten Goal batches now, with the adopted changes, rejected candidates such as go-task and their revisit triggers. | [Toolchain lock](../development/toolchain.md), [test harness](../testing/test-harness.md). |
| Source data rights and acquisition terms | [U.S. reuse review](source-data-rights.md): facts versus expression, use-specific NC/fair use, ShareAlike and provider terms; individual uses and VNDB license details retain explicit evidence limits. | [Source lifecycle](../contracts/source-lifecycle.md), [rights](../contracts/license-grants.md). |
| Semantic Web coverage and application-specific meaning | [Model coverage audit](semantic-web-model-coverage.md): reconcile all previously inventoried model families with standards, community vocabularies and research precedents; qualify exact mappings before adding dependencies or replacing native terms. | [Standards](../contracts/standards.md), [semantic model](../contracts/semantic-model.md), [spatial annotations](../contracts/spatial-annotations.md). |
| Access storage, object authority and ordered rules | [Comparative review](access-storage-and-policy.md): historical four-backend comparison, decision-snapshot and historical-policy counterexamples; the selected native PostgreSQL Access plan remains current. Production qualification remains pending. | [Identity/access](../contracts/identity-and-access.md), [Access](../services/access.md). |
| Access depth and institutional voting qualification | [Research basis](access-depth-representation-and-voting.md): academic/production evidence for the adopted typed authority composition, Realm/Org boundaries and conserved voting entitlements. Work-profile limits, production behavior and 99% task coverage require qualification. | [Identity/access](../contracts/identity-and-access.md), [votes](../contracts/votes-and-references.md), [governance](../contracts/governance-rules.md). |
| Access extraction threshold | [Placement research](access-and-interaction-placement.md): compare end-to-end freshness-aware evaluation when a consumer, isolation or scaling need justifies extracting the Main-hosted module. | [Access](../services/access.md), [service boundaries](../architecture/services.md). |
| Interaction capacity and later cache activation | [Jena bootstrap](../implementation/interactions-and-cache.md): first qualify mixed-load tails, high-degree count work and replay. Redis integration and cache-failure qualification are outside the first release. | [Votes/references](../contracts/votes-and-references.md), [storage ownership](../storage/ownership-and-placement.md). |
| CJK analyzer/profile | Qualify the initial versioned Lucene CJK analyzer, domain names, mixed scripts, offsets, phrase behavior and recall/ranking; rebuild on profile changes. | [Search](../contracts/search.md). |
| Filtered graph/text execution | Qualify bounded public graph/text queries first; preserve private pre-match admission, statistics isolation, complete filtering and stable continuation as explicit capability gates. | [Search acceptance](../testing/search.md). |
| History retention and erasure | Verify application-owned immutable RevisionAnchor manifests, retained object payloads and epoch fences through TDB2 backup/restore/movement; history is not supplied by MVCC. | [Jena](../storage/jena.md), [security](../operations/security.md). |
| Ecosystem adapters | Compare current native-tool semantics against captured manifests/versions; preserve unsupported clauses explicitly. | [Package profiles](../contracts/package-profiles.md). |
| Placement and resource allocation | Measure disk/network/existing load; assess principal-host concentration and optional remote Account. | [Deployment](../operations/deployment.md). |
| Jena model-validation integration | [Historical model evidence](model-profile-engine-evidence.md) preserves engine-specific counterexamples. Qualify complete affected-focus validation and all-dependency conditional guards on Jena; ordinary Fuseki updates do not automatically run SHACL. | [Model validation](../implementation/model-profile-validation.md). |
| Retired interaction mechanisms | [Historical Fluree evidence](retired-interaction-engine-evidence.md) retains the eleven-assertion probe and its limits; it is not Jena evidence or a launch step. | [Jena interactions](../implementation/interactions-and-cache.md). |
| Executable hosting envelope | Choose admitted runtime/isolation/secrets/cost policies before persistent hosting activation. | [Execution design](ai-hub-execution.md). |

Use primary specifications/code and bounded experiments appropriate to the active
phase. Record a selected answer in its owning contract and remove the resolved
question here. Do not accumulate historical implementation reports or duplicate
the plan's status table. [Architecture evidence](../architecture/evidence.md)
records the source basis and qualification limits.
