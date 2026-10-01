# Implementation questions and experiments

Research pages keep the evidence behind selected choices and the questions that
still affect implementation. The [storage architecture evaluation](storage-architecture.md)
records why PostgreSQL + Jena/TDB2/jena-text/Lucene was selected on 2026-09-24;
the [architecture owner](../architecture/overview.md) states the result.
Proprietary MarkLogic/GraphDB/Siren systems were architecture references only:
required deployment components must be self-hosted open-source or suitable
source-available. Results from the retired Fluree architecture validate nothing
about Jena. The [social-reading](reference-social-reading.md) and
[store](reference-stores.md) comparisons are product references for the
[frontend direction](../plan/frontend.md).

| Question | Investigation and decision criterion | Owner |
| --- | --- | --- |
| Application stack and framework tradeoffs | [Stack review](application-stack.md): selected Elysia 2/Bun, Yarn workspaces and vinext/Vite on Workers; Hono/Next alternatives, version evidence and bounded verification limits. | [Main application](../../services/main/src/app.ts), [workspace layout](../development/repository-structure.md), [frontend](../plan/frontend.md). |
| Mature toolchain selection | [Toolchain survey](toolchain-survey.md): Jena modules, model/mapping tools, language libraries, domain standards and operations candidates. Executed graph evidence remains in the [CJK probe](../../scripts/research/jena_text_cjk/README.md); framework evidence has its separate scope in the stack review. | Each linked owner; [search](../contracts/search.md) for analyzer and query construction. |
| Agent-efficiency tooling | [Re-evaluation](agent-efficiency-tooling.md): which development tools shorten Goal batches now, with the adopted changes, rejected candidates such as go-task and their revisit triggers. | [Toolchain lock](../development/toolchain.md), [test harness](../testing/test-harness.md). |
| Source data rights and acquisition terms | [U.S. reuse review](source-data-rights.md): facts versus expression, use-specific NC/fair use, ShareAlike and provider terms; individual uses and VNDB license details retain explicit evidence limits. | [Source lifecycle](../contracts/source-lifecycle.md), [rights](../contracts/license-grants.md). |
| Semantic Web coverage and application-specific meaning | [Model coverage audit](semantic-web-model-coverage.md): reconcile all previously inventoried model families with standards, community vocabularies and research precedents; qualify exact mappings before adding dependencies or replacing native terms. | [Standards](../contracts/standards.md), [semantic model](../contracts/semantic-model.md), [spatial annotations](../contracts/spatial-annotations.md). |
| Access storage, object authority and ordered rules | [Comparative review](access-storage-and-policy.md): why PostgreSQL was selected, historical four-backend measurements and decision-snapshot counterexamples. Full performance and scale verification remain later work. | [Identity/access](../contracts/identity-and-access.md), [Access owner](../../services/main/src/modules/access/policy-evaluator.ts). |
| Access depth and institutional voting qualification | [Research basis](access-depth-representation-and-voting.md): reasons for separate representation and conserved voting entitlements, alternatives and depth evidence limits. Work-profile limits and 99% task coverage still require measurement. | [Identity/access](../contracts/identity-and-access.md), [votes](../contracts/votes-and-references.md), [governance](../contracts/governance-rules.md). |
| Access extraction threshold | [Access placement research](access-storage-and-policy.md): compare end-to-end freshness-aware evaluation when a consumer, isolation or scaling need justifies extracting the Main-hosted module. | [Identity/access](../contracts/identity-and-access.md), [service boundaries](../architecture/services.md). |
| Interaction capacity and later cache activation | [Jena bootstrap](../implementation/interactions-and-cache.md): first qualify mixed-load tails, high-degree count work and replay. Redis integration and cache-failure qualification are outside the first release. | [Votes/references](../contracts/votes-and-references.md), [storage ownership](../storage/ownership-and-placement.md). |
| CJK analyzer/profile | Qualify the initial versioned Lucene CJK analyzer, domain names, mixed scripts, offsets, phrase behavior and recall/ranking; rebuild on profile changes. | [Search](../contracts/search.md). |
| Filtered graph/text execution | Qualify bounded public graph/text queries first; preserve private pre-match admission, statistics isolation, complete filtering and stable continuation as explicit capability gates. | [Search acceptance](../../scripts/qa/cases/search.ts). |
| History retention and erasure | Verify application-owned immutable RevisionAnchor manifests, retained object payloads and epoch fences through TDB2 backup/restore/movement; history is not supplied by MVCC. | [Jena](../storage/jena.md), [security](../operations/security.md). |
| Ecosystem adapters | Compare current native-tool semantics against captured manifests/versions; preserve unsupported clauses explicitly. | [Package profiles](../contracts/package-profiles.md). |
| Placement and resource allocation | Measure disk/network/existing load; assess principal-host concentration and optional remote Account. | [Deployment](../operations/deployment.md). |
| Jena model-validation integration | Qualify complete affected-focus validation and all-dependency conditional guards on Jena; ordinary Fuseki updates do not automatically run SHACL. | [Model validation](../implementation/model-profile-validation.md). |
| Executable hosting envelope | Choose admitted runtime/isolation/secrets/cost policies before persistent hosting activation. | [Execution design](ai-hub-execution.md). |
| Tag, filter and reverse-query references | [AO3 and VNDB](reference-ao3-vndb.md), with MyAnimeList as contrast: which of their tag, release, list and value pages the Work page, listings and Library should adopt. The query contract already names the shape. | [Queries](../contracts/queries.md), [frontend](../plan/frontend.md). |
| Reader and author patterns on web-novel sites | [Web-novel reference](reference-webnovel.md): what 起点, 晋江, KadoKado, Royal Road, Webnovel and Wattpad do well for serials, and which of those patterns the reader, Studio and Fiction zone should adopt. | [Frontend](../plan/frontend.md), [creation](../contracts/creation.md). |

Use primary specifications/code and bounded experiments appropriate to the active
phase. Record a selected answer in its owning contract and remove the resolved
question here. Do not accumulate historical implementation reports or duplicate
the plan's status table. [Architecture evidence](../architecture/evidence.md)
records the source basis and qualification limits.
