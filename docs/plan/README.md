# Implementation sequence and qualification

## Active execution

| Field | Selection |
| --- | --- |
| Scope | Active implementation Goal: deliver and qualify the retained M01–M10 first-delivery product scope in [GOAL.md](../../GOAL.md), including local full-application browser verification. |
| Program | Phase 0 connects the [toolchain](../development/toolchain.md) and the [executable harness](../testing/test-harness.md), then product batches follow the [execution program](#execution-program) and the [batch cadence](execution-workflow.md#batch-cadence). |
| Authority | Runtime implementation, Docker-based local services, disposable QA stacks, installation/recovery qualification, parallel agent worktrees merged locally and autonomous coherent commits on `main` are authorized by the activated Goal. Remote pushes, production publication and paid provisioning remain outside this scope. |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Status | The [implemented baseline](#implemented-baseline) summarizes pre-harness work. Qualification from `yarn qa --record` is on the [qualification page](qualification.md). |
| Next action | Measure cmd0.5.10's no-copy native validation in the fixed-source 1,000-Work seed diagnostic, then rerun the full practical 10,000-Work profile if its rate is viable. The native model gate passed 26 tests and matched all 66 recorded outcomes; the performance change remains unmerged until its load check. Isolated WORK10 outcome-recovery and SEARCH17 raw-import drills passed and are merged. Run the WORK02 native-variant integration case after the load stack releases, merge the remaining branches, then run one full `yarn qa` at that batch boundary. The last clean merged run `20260924t220707-de8312` passed all seven tiers but qualified only 2 of 277 retained IDs; Phase 0 coverage and B1 remain. The selected PostgreSQL + Jena/TDB2/jena-text/Lucene architecture remains in force. |

### Implemented baseline

This is the state at commit `5823d1b` (2026-09-24). Its scoped checks ran as
one-off integration tests before the harness existed; they count toward the
listed IDs only as *partial*. Detailed narrative evidence for these slices is in
git history up to that commit.

| Area | Implemented | Partial scoped checks | Main gaps |
| --- | --- | --- | --- |
| Graph substrate | Pinned Fuseki 6.2.0/TDB2/jena-text, `cjk-bigram-v1` assembler, offline CJK rebuild, generation-bound public text readiness gate. | OPS14, OPS16 | Privileged activation of rebuilt existing indexes; crash-time rebuild. |
| Account | Better Auth 1.7.5 OIDC authorization code with PKCE, client credentials, introspection, member deletion with an Access fence, WAL recovery manifests. | IAM01, IAM02, IAM10 | Web sign-in, email flows, consent, passkeys. |
| Access (in Main) | PostgreSQL admission, receipts, scope and principal fences, strong closure, PITR recovery fence. | IAM07 | Grant management lifecycle; complete strong revocation. |
| Main commands | Guarded Work create/edit, immutable manifests and exact history reads, receipts, RDF outbox relay with checkpoints. | SYS02, SYS04, SYS05, SYS09, SYS10, SYS12, SYS14, G3 | The baseline's host validator path was replaced by P0.2; native command ingress still needs a complete validation gate. |
| Work and publication | Text Contribution draft/edit, contributor eligibility, Main Version default, Realm-local adoption and rejection. | WORK02, WORK03, CTX01 | Web journey; management grants. |
| Space and classification | Space/Realm creation, classification contexts, shared Global propositions, curated decisions, effective resolution. | MODEL15, MODEL17 | Broader Application paths; web. |
| Ratings | Realm standing RatingContext and observations, bounded latest-per-rater aggregate. | MODEL15, MODEL17 | Materialized generations, persona rules. |
| Search | Bounded public phrase search for Main and Realm, classified and rated joins, CJK and mixed-script fixtures. | SEARCH01, SEARCH03 | Private search, broader descriptors and relevance. |
| Recovery | Isolated graph/Access/object restore, mixed-cut outcome replay, deletion journals and coverage envelopes. | OPS03, SYS13 | Coordinated owner cuts, erasure state, downstream checkpoints. |
| Web client | The baseline had none; P0.6 now adds a built Worker shell, public search, Work metadata page, sign-in/studio routes and Storybook. | Public browser search and component states; authenticated browser check is in progress. | Complete authenticated Work/Realm/edit/search journey and broad frontend acceptance. |

### Execution program

Phase 0 comes first. Without it, an implementation batch cannot be qualified by
one 30-minute `yarn qa` run. P0.1 unblocks the rest; P0.2 through P0.6 can then
run in parallel worktrees, and P0.4's harness core starts as soon as P0.1 lands.
Prioritize a root-command run of one existing real integration path, with shared
setup and a compact result, before expanding coverage. This is the harness's
first increment, not P0.4 completion. Use scoped module briefs and the
[context discipline](execution-workflow.md#context-and-agent-coordination) to
reduce model round trips and repeated context loading as well as test overhead.

| ID | Deliverable | Exit check | Progress |
| --- | --- | --- | --- |
| P0.1 | Service/image topology in `infra/dev/` and `infra/jena/`; root commands and host process wiring in `scripts/dev/` and root `package.json`. OPS01/OPS14/OPS16 and the existing Main/Account integration path are affected. | From a clean clone, `yarn toolchain:install && yarn dev` serves healthy Main and Account. No `REZICS_*` host paths remain. | Exit check passed from a sibling fresh clone with no Yarn install state: exact install completed, then `yarn dev` served Main and Account `/health/ready` with HTTP 200; teardown left no running stack. The existing checkout also served both without host Jena/Java/Python variables. This does not certify full OPS01/14/16 cases. |
| P0.2 | Java command endpoint, assembler/image wiring and transactional gate under `infra/jena/`; Main command adapter and writer migration under `services/main/`. SYS02/SYS09/SYS10/SYS14 and model validity cases are affected. | The module gate in the toolchain lock passes; Main has no `execFile` validator path. | Partial: pinned native module 0.5.9 adds fenced Content rebuild commands, per-JVM identity and a public-search write epoch to the private-capability and exact in-transaction domain-head CAS gate. Main claims Access grants before dispatch. Selected native model and 66-case equivalence gates passed; broader native command families and external Access binding still need qualification. |
| P0.3 | TypeScript model IR and compiler for the historical and newly admitted profiles, with generated shapes, TypeBox schemas, types, constants, registry and arbitraries. | Recorded candidate outcomes reproduce; the Python validators and hand-written profile Turtle are deleted; `yarn gen:check` is clean. | The 12 historical generated profile digests and all 66 recorded native outcomes retain zero result-path differences; three Content publication/search profiles bring the current total to 15. The merged model tier passed in `20260924t195652-538b84`. The handwritten Turtle definitions and Python validator/test execution files were removed; historical fixtures remain. MODEL17/MODEL27 retain partial acceptance status pending broader cases. |
| P0.4 | Shared-stack `yarn qa` core under `tests/qa/` and `scripts/qa/`, starting with real Account signup/session and Main/Fuseki readiness. OPS01/IAM01 have partial smoke coverage; later increments add oracles, split cases, model/fault/e2e/load tiers, fixture fetcher and `--record`. | `yarn qa` passes within 30 minutes on this host; setup is shared, overlapping full runs on one checkout are rejected, failure reruns preserve their partial scope, and `--record` verifies and records in one run. Any failure can be rerun by ID. | The clean merged run `20260924t220707-de8312` passed all seven tiers in under three minutes: static, 91 unit, 25 model, 12 integration, 3 fault/recovery, 4 browser and 1 load case. It reported 2 fully passed IDs (SYS02, WORK01), 19 partial, 256 uncovered. Failed-test selection, seeded replay, the hash-checked Q42 fixture and product-command Main/Realm selection oracle are in place. Broader coverage and a final clean `--record` remain. |
| P0.5 | Explicit response schemas, OpenAPI export, `MainApp` type export, S3 object adapter on RustFS. | The Eden and object-storage gates pass. | Partial: aws4fetch signed conditional creation, read-back checks and eight same-key writers passed against RustFS. Main Work create/edit, exact and recovery reads use the adapter when configured. All 27 Main `/v1` routes have explicit response schemas and inferred types; `yarn gen:check` checks `generated/openapi/main/public.json`, and the standalone Eden consumer compiles and makes two actual calls. The merged static, unit and integration tiers passed in `20260924t202630-48ca4a`. Other semantic object consumers, backup/restore, multipart/GC and the web Eden BFF gate remain. |
| P0.6 | `apps/web`: vinext on Workers, Eden with TanStack Query, Tailwind/SharkUI in `packages/ui`, `native-i18n`, Storybook, Playwright; sign-in through Account, one RSC Work page and one client search component. | Playwright on `wrangler dev` and the Storybook tests pass inside `yarn qa`. | The merged English/Simplified Chinese shell, search, auth, Studio and exact Work page passed the built-Worker browser tier in `20260924t202630-48ca4a`. Cases covered PKCE, denied actor, Work creation, explicit QA read grant, Chinese exact revision on mobile, locale persistence, per-browser isolation and independent search language. Integration proves exact read denied before and allowed after the Access grant. The complete authenticated Content/Realm/edit journey and broader frontend acceptance remain. |
| P0.7 | README, installation, service READMEs and model README describe the actual commands. | `yarn docs:check` passes; the documented commands run as written. | Root README, installation, operations index, Main/Account service READMEs and model README document the current commands and separate the S0 raw-update drill from the product command path. Merged `yarn docs:check` passed 166 Markdown files and 9 checker tests. `yarn dev --profile qa --run-id p06-install` then launched Main, Account and web from an isolated stack: both readiness endpoints and `/sign-in` returned 200, registered OAuth/runtime files were mode 0600, and teardown left no QA containers. Final documentation reconciliation follows the Content search and broader browser boundaries. |
| P0.8 | PostgreSQL Content revisions/drafts/receipts/outbox and preparation pins; common history adapters; exact-revision publication; bounded two-owner relay into RDF MatchUnits and embedded Lucene; coherent readiness and two-stage rebuild. | WORK02–03/09–10, SEARCH01–04/06–08/15–20 and OPS03/09/11–12/15–16 pass through the harness. Pin numeric whole-request budgets and practical mixed-load objectives before qualification; retain query plans, update amplification and recovery evidence. | Content CAS/history/pins, native 0.5.9 publication/eligibility/MatchUnit validation, durable relay and exact reads are merged. Public search admits 20,000 MatchUnits with a 512 raw-hit complete phrase bound, 1 MiB response cap and position/JVM-bound index audits. Fenced two-stage rebuild passed missing-body and changed-cut fault cases. Concurrent search uses native public-write epochs and bounded movement retries; a 10-Work/180-second mixed diagnostic passed 2,425 reads and 437 admitted writes with zero 5xx. The source-stable practical attempt `load-20260924t221051-ccd697` stopped at 1,057 Works: 100–500 seeded at 0.93/s, 700–1,000 at 0.66/s, making its 3-hour profile impossible; graph/relay lag drained to zero. Native SHACL/BindingPolicy whole-graph copies are the measured repair candidate. SEARCH17, WORK10 and full OPS05 remain pending. |

After Phase 0, product batches follow the [dependency order](#dependency-order).
P0.7's final documentation verification includes the P0.8 commands once supplied.
P0.8 reuses the selected engines: it does not authorize a new query optimizer or
an automatic engine migration if a gate fails. Correct the bounded plan/index
binding first; a material remaining failure reopens only the affected decision
with retained evidence. Do not pass by excluding the core graph/text/Realm query.
Add one row per batch; keep the rows short and cite the qualification page.

| Batch | Scope and acceptance IDs | Result |
| --- | --- | --- |
| B1 | The S2 journey in the web app: sign up or sign in, create Work/Main Version, draft, edit and publish a contribution, create two Realms, give conflicting classification decisions, search, edit and read the prior revision. IDs from [native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and [identity/access](../testing/identity-and-access.md). | Pending. |
| B2+ | Next unmet dependency from stages A–G and [M01–M10](../product/capabilities.md#capability-coverage), selected by the coordinator. | Pending. |

Follow the [execution workflow](execution-workflow.md). The user-selected design
supersedes single-database assumptions. Keep implementation and executed
qualification distinct.

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

For each batch, keep one short row in the [execution program](#execution-program)
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

The capability table is the scope denominator; this table summarizes program
status by scope. Per-ID results come from the [qualification page](qualification.md);
do not insert narrative evidence here.

| Scope | Design | Runtime qualification |
| --- | --- | --- |
| Shared architecture and selected technology | Jena startup boundary, TypeScript/Elysia 2/Bun, Yarn and vinext/Workers selected; [toolchain lock](../development/toolchain.md) adopted. | S0 passed OPS14 and OPS16. Phase 0 connects the toolchain and harness. Complete S1–S3 and product gates pending. |
| Space, Context, classification and Main Version | Selected first-stage foundation. | Partial scoped checks listed in the [implemented baseline](#implemented-baseline); harness qualification and the web journey pending. |
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
Current-site inputs refresh each run; captures reproduce one run. Retain 500M/3B
planning arithmetic separately from measured initial-host acceptance.
