# Implementation sequence and qualification

## Current state

| Field | Selection |
| --- | --- |
| Scope | The current [Goal](../../GOAL.md), prepared on 2026-09-29, makes REZICS production-ready; the frontend-centred Goal before it paused after its third milestone. Backend phase 1 implemented retained M01–M10 backend/API only; UI consumes the APIs. By the 2026-09-27 direction, that phase qualified the main performance paths by measured checks and the rest by written complexity derivations; full performance verification and the 500 million entity scale are later-phase work ([complexity](../testing/complexity.md#inventory-and-coverage)). |
| Program | The frontend-centred [Goal](../../GOAL.md) started 2026-09-27 22:54 CST under the [manager charter](../goals/manager.md). Status 2026-09-28 02:45: merged the web shell and session layer, Rezics UI stories and polish for all 95 components, the Accounts app on the Account origin (:3004), Account APIs for the Accounts site and admin, the Search and Discover slice, Main read families (Work, contents, activity, discovery, profiles, Realm home and profile, moderation, submissions), baseline member permissions, and about 30 documentation-to-code batches from the [audit](docs-audit.md). In progress: Work page and reader, Accounts centre completion and admin panel, member replies and publication selection, relay repair, search cards and facets, discovery refresh, Realm directory. The [frontend direction](frontend.md) records product decisions. 2026-09-28 04:00: maintainer feedback redirects the main site toward a Reddit-like feed home, eight UI locales (as in the old repository), richer themes and Goodreads-quality cover-first catalogue pages; manager notes in `.temp/manager/notes.md`. Live tasks: `bun scripts/goal/goalctl.ts status`. |
| Usage resets | Astra (`codex-1`) full reset used 2026-09-28 06:4x CST when G-314 hit the weekly limit (credit expiring 2026-10-04); two credits left (expiring 2026-10-05 and 2026-10-23). |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Status | Backend phase 1 is complete: the full `task qa -- --backend --record` run `20260927t101230-1616d8` on clean commit `af3f5f40` (local tag `goal/backend-phase1`) passed all 276 retained backend acceptance IDs; see the [qualification page](qualification.md). The Goal's report, task briefs, handoffs and execution log are archived on the local orphan branch `archive/goals`, outside this working tree; read it only when the maintainer asks. |
| Next action | Later-phase work: full performance verification including the 500 million entity scale, and production destruction verification for OPS10. Deferred items live in [low-priority work](low-priority/README.md), starting with CurseForge and Steam Workshop acquisition. |

## Fast-start milestones

Deliver a small usable path before widening the product surface. These milestones
are dependency order and acceptance requirements, not reports of completed code.

| Milestone | Implement / execute | Exit evidence |
| --- | --- | --- |
| S0 Graph substrate | Pinned Fuseki bundle, Java, one text-wrapped TDB2 dataset and persistent directories; follow [installation](../operations/installation.md). | Insert/read/text-match public fixture, graceful restart, backup and isolated restore; service remains private. |
| S1 Safe command foundation | Minimal Main HTTP adapter, Account verification, PostgreSQL Access, fixed model/shape artifact, guarded graph updates, immutable component revisions and polling outbox. | Same-head race has one winner; lost response reconciles its receipt; denied/invalid writes change nothing; old revision still resolves. |
| S2 First authenticated API journey | Create metadata-only Work/MainVersion, publish one text contribution, assign different classification decisions in two Realms, search the eligible public view, then edit and read the prior revision through real APIs. | Shared Work identity, distinct Realm decisions, exact comments, current authority and graph/text completeness remain correct end to end. |
| S3 Broaden to retained backend/API gates | Add ratings, multilingual relevance, qualified private search, all indexing domains, sources and package flows through stages B–G below. | Owning backend/API capability, integration and operations matrices pass independently of frontend. |

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

The main site's [read API design and Work template](read-api-design.md) map the
browse, reader, profile, Realm and management read families to their next owners.

Start with the active scope above and the [coverage map](../architecture/coverage.md).
These routes select initial context; follow additional owning links when a change
affects their invariants. They do not redefine contracts or waive acceptance cases.

| Slice | Initial owners and realization | Exit evidence owner |
| --- | --- | --- |
| S0 Graph substrate | [Installation](../operations/installation.md), [Jena](../storage/jena.md), [recovery](../operations/recovery.md). | S0 above and [operations cases](../testing/operations.md): graph/text persistence, restart and isolated restore. |
| S1 Safe commands | [Commands](../contracts/commands.md), [identity/access](../contracts/identity-and-access.md), [model profiles](../contracts/model-profiles.md), [API/events](../implementation/api-and-events.md), [graph records](../implementation/graph-records.md), [model validation](../implementation/model-profile-validation.md), [authorization bridge](../implementation/authorization-bridge.md), [Access storage decision](../research/access-storage-and-policy.md). | [Model](../testing/model-contracts.md), [IAM](../testing/identity-and-access.md) and [integration](../testing/backend-integration.md): admission, validation coverage, same-head races, idempotency, receipts, outbox and retained revisions. |
| S2 Authenticated API journey | [Main Version](../contracts/main-version.md), [Space](../contracts/space.md), [classification](../contracts/classification.md), [search](../contracts/search.md) and [vertical workflows](../implementation/vertical-workflows.md). | [Native Work](../../scripts/qa/cases/native-work.ts), [classification](../testing/classification.md), [search](../../scripts/qa/cases/search.ts) and [backend integration](../testing/backend-integration.md): one Work, two Realm decisions, eligible search and exact historical reads through actual APIs. |
| S3 Remaining backend/API capabilities | Select the next unmet dependency from stages A–G and [M01–M10](../product/capabilities.md#capability-coverage); use the corresponding [coverage row](../architecture/coverage.md). | Owning [backend scope](../../scripts/qa/backend-scope.ts) and [operation targets](../../scripts/qa/cases/backend-operations.ts) for every retained API capability, including G1–G4 and G6 at the backend boundary. |
| Full web journeys (outside Goal) | In a separately selected frontend task, load the [frontend direction](frontend.md) and the affected feature's stories and browser tests. | G5 and browser journeys consume delivered APIs; these do not gate this backend Goal. |

For each batch, keep one short row in the [current state](#current-state)
with its scope, acceptance IDs and result, and cite the
[qualification page](qualification.md) for evidence. Resolve the decisions needed
for that batch before expanding speculative design elsewhere. The [external source index](../development/external-sources.md)
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
profile. Numeric Access work limits in the
[workload profile](../storage/workloads/identity-access-capacity.md) and 99%
legitimate-task coverage in the [depth study](../research/access-depth-representation-and-voting.md)
remain qualification targets.

Redis is outside the first release's delivery and acceptance scope. Likes and
favorites must work through Main's TDB2 authority without Redis. Redis deployment,
client integration, cache consumers and Redis-specific recovery/performance tests
belong to a later optimization scope; their absence does not block a first-release
gate. Existing correctness, bounded-query and practical-load obligations remain.

## Dependency order

The [repository organization](../development/repository-structure.md)
explains the current workspace and owner boundaries. It does not change the
selected owners or mark any runtime gate complete.

| Stage | Complete implementation scope | Exit evidence |
| --- | --- | --- |
| A | Minimal identity/value profile, Fuseki guarded commands, PostgreSQL Content and local receipts/outbox, common immutable history, Context and Account/Access; expand the IR as profiles grow. | Semantics, rejected states, retries, publication preparation and authority fences. |
| B | Space capabilities, concepts/expressions/applications, Realm fallback and rating contexts. | Two-Realms/one-resource journey with conflicting decisions and private data. |
| C | Work/Main Version, content/structure anchors, translations, Post chapters and fixed releases. | Stable common entry, precise history/comments and publication/adoption recovery. |
| D | Graph-integrated full-text/CJK, exact PostgreSQL-body projections and all five native indexing domains. | Joint relation/text/context queries, complete ranking, fixed whole-request bounds and bounded updates/rebuild. |
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

[Backend scope](../../scripts/qa/backend-scope.ts) details the integration obligations for these gates;
web stories and browser tests carry the experience, as the [frontend direction](frontend.md) describes.

| Gate | Meaning |
| --- | --- |
| G1 Design | Owners, state transitions, identities, authority, failures and required tests are specified. |
| G2 Persistence | Actual Jena/PostgreSQL/object bindings pass positive, rejected, concurrent and recovery cases. |
| G3 API | Stateful producer-to-consumer HTTP/SDK/MCP flows preserve the same contracts. |
| G4 Integration | Cross-owner source, publication, search, package and revocation journeys pass. |
| G5 Experience | Separate frontend scope: affected deterministic checks and authorized Storybook reviews. Outside the current backend Goal. |
| G6 Operations | Fresh installation, backup restoration and measured practical workload meet elected objectives. |

## Delivery and qualification

The capability table is the scope denominator; this table summarizes program
status by scope. Per-ID results come from the [qualification page](qualification.md);
do not insert narrative evidence here.

| Scope | Design | Runtime qualification |
| --- | --- | --- |
| Shared architecture and selected technology | Jena startup boundary, TypeScript/Elysia 2/Bun, Yarn and vinext/Workers selected; [toolchain lock](../development/toolchain.md) adopted. | S0 passed OPS14 and OPS16. Phase 0 connects the toolchain and harness. Complete S1–S3 and product gates pending. |
| Space, Context, classification and Main Version | Selected first-stage foundation. | Qualified in the [recorded run](qualification.md); the web journey is outside the backend Goal. |
| Five domains and universal packages | Selected with ecosystem profiles and live validation. | Pending conversion/resolver/install tests. |
| Security, operations and user experience | Specified owner protocols and acceptance. | Pending their respective gates. |

## Documentation verification

On 2026-09-24, the toolchain reconciliation added the [toolchain lock](../development/toolchain.md),
the [executable harness](../testing/test-harness.md), the transactional command
endpoint and the batch cadence. It condensed this plan's evidence narrative into
the implemented baseline. The documentation checks listed in
[development](../development/README.md) passed for it. Versions were checked
against the npm registry, Docker Hub and upstream releases; no runtime was executed.

Earlier on 2026-09-24, goal preparation passed all nine documentation-tool regressions,
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
Current-site inputs refresh each live-source run; verified captures reproduce one
run. The current baseline is 500M business entities/documents; 3B is a future
scenario. Keep derived complexity, executed growth checks and measured rollout
capacity separate. No small-data pass certifies that all existing data fits.

[Documentation-to-code audit](docs-audit.md) groups the page inventory into replacement and retirement batches.
