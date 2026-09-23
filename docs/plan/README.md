# Implementation sequence and qualification

## Active execution

| Field | Selection |
| --- | --- |
| Scope | Active implementation Goal: deliver and qualify the retained M01–M10 first-delivery product scope in [GOAL.md](../../GOAL.md), including local full-application browser verification. |
| Phase | S0 graph substrate verified; S1 internal Work activation, one-scope PostgreSQL Access registration and the first live Account/Main OAuth path verified in part. The one-scope claim/strong-seal race is verified internally; the authenticated public Work command, edit/history and full S1 cases are next. S2–S3 and remaining stages are pending. |
| Authority | Runtime implementation, local disposable services, installation/recovery qualification and autonomous coherent commits on the current `main` branch are authorized by the activated Goal. Production publication and paid provisioning remain outside this execution scope. |
| Deliverables | S0 pinned Fuseki/TDB2/jena-text drill and evidence; next, fixed model/shape profile, guarded Main commands, receipts/outbox and Account/Access admission with their first consumers. |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Qualification | S0 OPS14 and substrate OPS16 passed. The internal S1 storage test passed scoped SYS02/SYS10/SYS14 and one-scope IAM07 claim/strong-seal cases on Fuseki 6.2.0/PostgreSQL 18.6. Product G2–G6 and complete S1–S3 remain pending. |

S0 owners are [installation](../operations/installation.md), [Jena storage](../storage/jena.md), [recovery](../operations/recovery.md) and [operations cases](../testing/operations.md). The reproducible [drill](../../scripts/operations/verify_graph_substrate.py) ran on 2026-09-24 with Fuseki 6.2.0 (published SHA-512 `ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132`) and isolated Temurin JRE 21.0.12.1. [Executed evidence](../../tests/recovery/evidence/2026-09-24-s0.json) records one RDF and joined-text binding after insertion, restart and isolated restore. After label deletion, the named graph anchor remained and the direct text query returned zero bindings. Graceful process exits, stopped-state backup and checksum verification succeeded. This qualifies the substrate only; product receipts, authorization, index rebuild after crash, G2 persistence and multi-store restoration remain untested.

The S1 owners are [commands](../contracts/commands.md), [identity/access](../contracts/identity-and-access.md), [model profiles](../contracts/model-profiles.md), [API/events](../implementation/api-and-events.md), [graph records](../implementation/graph-records.md), [model validation](../implementation/model-profile-validation.md), [authorization bridge](../implementation/authorization-bridge.md) and [Access implementation](../implementation/access-control.md). Its exit cases include [MODEL](../testing/model-contracts.md), [IAM](../testing/identity-and-access.md) and [SYS](../testing/backend-integration.md). The first [fixed Work metadata profile](../../model/README.md) has a pinned Jena SHACL 6.2.0 helper and [executed candidate evidence](../../model/tests/evidence/2026-09-24-work-profile.json): one valid candidate conformed; removing its Work type or required MainVersion link produced violations on the explicitly selected focus. This covers only the fixed-profile portions of MODEL15/17. The [Main storage slice](../../services/main/README.md) now uses a Yarn 4.18 lockfile, Bun 1.4.2 and Elysia 2.0.0-beta.16. Its [executed JUnit result](../../services/main/tests/evidence/2026-09-24-main-storage.xml) records one live-Fuseki/PostgreSQL integration test with 54 assertions and no failures. It exercised guarded metadata Work creation, receipt replay/conflict, lost response, same-key race, stale epoch/input, graph/text and immutable bytes, plus a claimed admission after closure that succeeds before sealing, a cancellation defeating a delayed update, and pending status during Fuseki outage. The current API exposes health only; no browser/client can submit a product write. Early storage cases use synthetic admissions; a later case registers one real Access admission on PostgreSQL and binds its ID, scope and epoch in the graph receipt. Its Account verifier is a fixture. These are scoped storage/bridge checks, not complete SYS/G2/G3 acceptance.

The first [Access migration and registry](../../services/main/README.md) were exercised on a disposable PostgreSQL 18.6 cluster. Its [JUnit result](../../services/main/tests/evidence/2026-09-24-access-admission.xml) records one test, 30 assertions and no failures: admission/receipt/outbox registration, replay/conflict, issuer/action denial, expiry before claim, same-key concurrency, ordinary closure, and competing claim/strong-closure orders. This covers one-scope IAM07 registration and dispatch fencing. The fixture seeds principal and grant records directly; it does not qualify grant creation or the full strong-revocation lifecycle. Main's [Account verifier](../../services/main/README.md) checks a JWKS-signed, audience-bound bearer assertion and forces current introspection before returning issuer/subject for Access; its [local-issuer result](../../services/main/tests/evidence/2026-09-24-account-assertion.xml) covers scoped IAM02/IAM10 rejection cases. The [live Account result](../../services/account/tests/evidence/2026-09-24-account.xml) uses actual Better Auth and PostgreSQL to issue a service resource token and a user authorization-code/PKCE token; Main verifies both and denies the user token after sign-out. This is a first cross-service Account enforcement path, not complete IAM01/IAM02/IAM10 or recovery/consent qualification. Next executable step: expose a typed authenticated Main Work HTTP command with safe pending/error semantics and integrate the real Account issuer, Access and Fuseki in one journey; then finish same-head edit, exact history, restart/restore and denied/invalid cases before S1 completes. No external credential blocks the local work.

Follow [execution workflow](execution-workflow.md). The user-selected design
supersedes single-database assumptions. Keep implementation and executed qualification
distinct. Documentation completion does not start runtime work automatically.

## Fast-start milestones

Deliver a small usable path before widening the product surface. These milestones
are dependency order and acceptance requirements, not reports of completed code.

| Milestone | Implement / execute | Exit evidence |
| --- | --- | --- |
| S0 Graph substrate | Pinned Fuseki bundle, Java, one text-wrapped TDB2 dataset and persistent directories; follow [installation](../operations/installation.md). | Insert/read/text-match public fixture, graceful restart, backup and isolated restore; service remains private. |
| S1 Safe command foundation | Minimal Main HTTP adapter, Account verification, PostgreSQL Access, fixed model/shape artifact, guarded graph updates, immutable component revisions and polling outbox. | Same-head race has one winner; lost response reconciles its receipt; denied/invalid writes change nothing; old revision still resolves. |
| S2 First authenticated journey | Create metadata-only Work/MainVersion, publish one text contribution, assign different classification decisions in two Realms, search the eligible public view, then edit and read the prior revision. | Shared Work identity, distinct Realm decisions, exact comments, current authority and graph/text completeness remain correct end to end. |
| S3 Broaden to retained product gates | Add ratings, multilingual relevance, qualified private search, all indexing domains, sources and package flows through stages B–F below. | Owning capability and integration matrices pass for each activated surface. |

S0 can be followed from this documentation checkout; S1 and later require new
runtime code. S0 does not require a model compiler, Redis, a broker, a cluster,
full-corpus import or a billion-row benchmark. S1 can begin with a pinned authored
profile and generated or packaged validator artifacts; the reusable compiler grows
with admitted profiles rather than blocking the first command behind a universal
metamodel implementation. Public-only text is the first admitted search lane;
private text remains a required capability gated by scoped security qualification.

Fresh installation uses new datasets and explicitly seeded owners. No automatic
Fluree migration or dual-write mode is selected. If retained source data exists,
inventory it, export exact RDF/objects/revisions, convert to the new manifests and
verify identity, disclosure and restore before retiring the old copy. Do not infer
that TDB2 can recover missing historical content from a current-state RDF dump.

## Task reading routes

Start with the active scope above and the [coverage map](../architecture/coverage.md).
These routes select initial context; follow additional owning links when a change
affects their invariants. They do not redefine contracts or waive acceptance cases.

| Slice | Initial owners and realization | Exit evidence owner |
| --- | --- | --- |
| S0 Graph substrate | [Installation](../operations/installation.md), [Jena](../storage/jena.md), [recovery](../operations/recovery.md). | S0 above and [operations cases](../testing/operations.md): graph/text persistence, restart and isolated restore. |
| S1 Safe commands | [Commands](../contracts/commands.md), [identity/access](../contracts/identity-and-access.md), [model profiles](../contracts/model-profiles.md), [API/events](../implementation/api-and-events.md), [graph records](../implementation/graph-records.md), [model validation](../implementation/model-profile-validation.md), [authorization bridge](../implementation/authorization-bridge.md), [Access implementation](../implementation/access-control.md). | [Model](../testing/model-contracts.md), [IAM](../testing/identity-and-access.md) and [integration](../testing/backend-integration.md): admission, validation coverage, same-head races, idempotency, receipts, outbox and retained revisions. |
| S2 Authenticated journey | [Main Version](../contracts/main-version.md), [Space](../contracts/space.md), [classification](../contracts/classification.md), [search](../contracts/search.md), [vertical workflows](../implementation/vertical-workflows.md), [frontend](frontend.md). | [Native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and relevant [experience](../experience/README.md): one Work, two Realm decisions, eligible search and exact historical reads. |
| S3 Remaining capabilities | Select the next unmet dependency from stages A–G and [M01–M10](../product/capabilities.md#capability-coverage); use the corresponding [coverage row](../architecture/coverage.md). | Owning [backend](backend-acceptance.md), [frontend](frontend.md) and G1–G6 evidence for every retained capability. |

For each active slice, maintain its outcome, owner links, unresolved blocking
decisions, relevant acceptance IDs, executed evidence and next action in this
plan. Resolve the decisions needed for that slice before expanding speculative
design elsewhere. The [external source index](../development/external-sources.md)
supplies upstream lookup routes; supporting evidence stays beside its decision.
For a wording/link-only task, inspect the affected document and consumers without
activating runtime stages or loading all these routes.

## First-stage product and indexing scope

Space (Realm + Zone), contextual classification/ratings and REZICS Main Version
form the first foundation. Books, software, media, recipes, Skills and Prompts
exercise it. Universal package resolution/installation workflows are selected,
with Cargo, npm-family, Go, Nix, Minecraft and mod-provider profiles.

Collections, wikis, discussions, character/background/causal graphs and ordinary
interactions compose these foundations. [Capabilities](../product/capabilities.md)
retains the complete native product coverage. Provider limitations do not erase
native requirements. Full source-corpus indexing and separately operated hosting/
commerce/verification campaigns retain explicit rollout boundaries.

Stage A establishes typed authority composition and scoped institutional
representation. Stage F applies the [voting contract](../contracts/votes-and-references.md)
to institutional entitlements and approved collective decisions. Direct proxies
and explicit allocations are charter-enabled capabilities under that contract;
live proxy rerouting and full liquid delegation require a separate qualified
profile. Numeric Access work limits and 99% legitimate-task coverage remain
qualification targets in the [depth study](../research/access-depth-representation-and-voting.md).

Redis is outside the first release's delivery and acceptance scope. Likes and
favorites must work through Main's TDB2 authority without Redis. Redis deployment,
client integration, cache consumers and Redis-specific recovery/performance tests
belong to a later optimization scope; their absence does not block a first-release
gate. Existing correctness, bounded-query and practical-load obligations remain.

## Dependency order

The [repository organization proposal](../development/repository-structure.md)
defines the workspace layout and bootstrap preparation for these stages. It does
not change the selected owners or mark any runtime gate complete.

| Stage | Complete implementation scope | Exit evidence |
| --- | --- | --- |
| A | Minimal identity/value profile, Fuseki guarded commands, immutable revisions, Context, Account/Access and local receipts; expand the IR as profiles grow. | Semantics, rejected states, retries and authority fences. |
| B | Space capabilities, concepts/expressions/applications, Realm fallback and rating contexts. | Two-Realms/one-resource journey with conflicting decisions and private data. |
| C | Work/Main Version, content/structure anchors, translations, Post chapters and fixed releases. | Stable common entry, precise history/comments and publication/adoption recovery. |
| D | Graph-integrated full-text/CJK, projections and all five native indexing domains. | Joint relation/text/context queries, completeness and bounded updates. |
| E | Live source conversion and universal package profiles, lock/install/update/rollback. | Current-source semantics, native-tool comparisons and interrupted operation recovery. |
| F | Remaining native interactions, governance, communication, export and admitted commercial applications. | Capability coverage and cross-owner workflows. |
| G | Deployment selection, installation, practical load and recovery on available hosts. | Measured bounded behavior, restore and explicitly accepted initial outage model. |

Dependencies permit independent work but do not excuse leaving one stage's required
behavior as a stub. Space/classification comes before treating Book or package
success as the whole product. Large-volume/fleet qualification is a later scale
stage, not a gate blocking this sequence.

## Acceptance gates

The [interaction/cache bootstrap](../implementation/interactions-and-cache.md)
provides a concrete Jena slice and later cache growth. Prior-engine probes are
historical research only; Jena, application, security and capacity gates remain pending.

[Backend scope](backend-acceptance.md) and [frontend acceptance](frontend.md)
detail the integration and experience obligations for these gates.

| Gate | Meaning |
| --- | --- |
| G1 Design | Owners, state transitions, identities, authority, failures and required tests are specified. |
| G2 Persistence | Actual Jena/PostgreSQL/object bindings pass positive, rejected, concurrent and recovery cases. |
| G3 API | Stateful producer-to-consumer HTTP/SDK/MCP flows preserve the same contracts. |
| G4 Integration | Cross-owner source, publication, search, package and revocation journeys pass. |
| G5 Experience | Affected deterministic frontend checks and authorized scoped Storybook reviews pass. |
| G6 Operations | Fresh installation, backup restoration and measured practical workload meet elected objectives. |

## Delivery and qualification

The capability table is the scope denominator; this table is the single program
status owner. S0 and a scoped internal S1 storage check have executed on the new
architecture. Full product runtime qualification remains pending; do not insert
historical implementation results here.

| Scope | Design | Runtime qualification |
| --- | --- | --- |
| Shared architecture and selected technology | Jena startup boundary, TypeScript/Elysia 2/Bun, Yarn and vinext/Workers selected; owner protocols specified. | S0 passed OPS14 and substrate OPS16; internal S1 storage/HTTP readiness test passed its scoped cases. Complete S1–S3 and product gates pending. |
| Space, Context, classification and Main Version | Selected first-stage foundation. | Pending actual engine and end-to-end tests. |
| Five domains and universal packages | Selected with ecosystem profiles and live validation. | Pending conversion/resolver/install tests. |
| Security, operations and user experience | Specified owner protocols and acceptance. | Pending their respective gates. |

## Documentation verification

On 2026-09-24, goal preparation passed all nine documentation-tool regressions,
local links/fragments/navigation checks for 160 Markdown files and diff whitespace
review. The added regression checks links from the root goal file and navigation
through it. Eight upstream `llms.txt` indexes were fetched as recorded in the
[source index](../development/external-sources.md).

Source-level walkthroughs traced a substantive S1 command change through contract,
storage/authority and acceptance owners, an ordinary wording/link fix through its
local consumers without runtime activation, and continuation after S2 toward the
remaining capabilities. These inspect instruction consistency; no GPT-6 Sol Goal
run or measured agent-effectiveness comparison was performed. Runtime acceptance
remains pending until implementation executes its owning cases.

The preceding source-data reuse review completed documentation integrity and
source/diff review with all eight documentation-tool tests passing. Legal/provider
review supports the documented distinctions, not blanket clearance or § 512
eligibility; VNDB's data-license page was unavailable. Its substantive evidence
remains in the [source-data review](../research/source-data-rights.md). Runtime and
live-provider acceptance remain prospective.

On 2026-09-23, local link/fragment/navigation checks passed for 153 Markdown files;
all seven checker regression cases passed. Syntax-only checks with RDFLib 7.6.0,
Python JSON parsing and `sh -n` accepted eight SPARQL examples, twelve shell blocks,
three JSON blocks, two inline Turtle examples and the Fuseki assembler. Source/diff
review covered single-JVM ownership, conditional receipts, permanent revision
manifests, query scope, index deletion and restored epochs. Historical scripts and
recorded JSON evidence were preserved.

The subsequent application-stack reconciliation passed local documentation checks
for 157 Markdown files and all eight checker regressions. The new regression keeps
installed dependencies and disposable research output outside authored-document
navigation checks. The [framework probe](../../scripts/research/http_framework_comparison/README.md)
passed a Yarn 4.18 immutable install, TypeScript 7 fixture type checking and Bun
1.4.2 behavioral assertions against pinned Elysia 2 and Hono packages. Its
[result](../../scripts/research/http_framework_comparison/result.json) records
request/response validation differences and an Elysia OpenAPI configuration issue;
it does not certify the future product services. Diff whitespace checks passed.

These checks did not execute shell examples, start product Fuseki/Main/PostgreSQL, validate
assembler behavior, verify all external links or measure runtime/capacity. S0–S3
and runtime gates remain pending. [Development](../development/README.md) provides
the reproducible local integrity commands.

## Completion boundary

New-system integrity, source fidelity and recoverability are required. Old-system
schema/API/data compatibility and migration-only dual writes are not required.
Current-site inputs refresh each run; captures reproduce one run. Retain 500M/3B
planning arithmetic separately from measured initial-host acceptance.
