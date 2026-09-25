# Implementation sequence and qualification

## Active execution

| Field | Selection |
| --- | --- |
| Scope | The retained M01–M10 implementation Goal in [GOAL.md](../../GOAL.md) is active. Complete the backend/API scope and its owning gates before the full web journey, while keeping the Phase 0 web contracts healthy. Local full-application browser verification is included. |
| Program | Retain TypeScript/Bun, Better Auth, PostgreSQL and Jena. Require actual foundation dependencies, then qualify backend/API slices before full web journeys. Use [cost contracts](../storage/workload-budgets.md#complexity-contracts), small multi-scale checks and the [batch cadence](execution-workflow.md#batch-cadence). |
| Agent strategy | Default to local execution; use fresh briefs and at most two workers for justified independent deliverables under the [delegation policy](execution-workflow.md#delegation-and-worker-lifecycle). Workers finish after handoff. Compare accepted results against total main-task and worker usage under [efficiency measurement](execution-workflow.md#efficiency-measurement); no automatic per-batch fan-out or model-driven job monitoring. |
| Authority | The Goal authorizes local implementation, dependency setup, disposable QA stacks, browser verification and coherent local commits on `main`. Remote pushes, production publication and paid provisioning remain outside this scope. |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Status | As of 2026-09-25, B11's baseline preparation and clone-consumption slice passed full `yarn qa` in `20260925t115249-d6903a`: all seven tiers passed, with 11 passed IDs, 34 partial and 232 uncovered. Separate 100- and 1,000-Work cloned profiles passed with fresh admitted writes, expired background grants and storage restarts. This qualifies the changed batch and diagnostic sizes, not the retained product scope. Both earlier 10,000-Work load attempts remain failed. The [qualification page](qualification.md) remains the final generated evidence owner. |
| Next action | Prepare a 9,900-Work stopped baseline and run the 10,000-Work practical profile with 100 fresh writable Works at the fixed 180-second mixed interval. Check all source/index compatibility, native delta, cold/restart and load thresholds; use load-only failure traces if a remaining Content race occurs. Continue unmet backend/API dependencies from the acceptance map. |

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
| Web client | The baseline had none; later P0.6 adds a built Worker shell, public search, Work metadata page, sign-in/studio routes and Storybook. | See P0.6's scoped public/authenticated browser evidence below; it does not qualify the full product journey. | Complete authenticated Work/Realm/edit/search journey and broad frontend acceptance. |

### Execution program

Phase 0 names foundation dependencies, not an all-or-nothing barrier. The working
root commands and shared QA core unblock product slices whose owner dependencies
are available. Carry other P0 cases with their consumers and retain every required
case in the final gate. Parallel work stays within the active slice and the
workflow's work-in-progress limit.
Prioritize a root-command run of one existing real integration path, with shared
setup and a compact result, before expanding coverage. This is the harness's
first increment, not P0.4 completion. Use scoped module briefs and the
[context discipline](execution-workflow.md#context-and-agent-coordination) to
reduce model round trips and repeated context loading as well as test overhead.

| ID | Deliverable | Exit check | Progress |
| --- | --- | --- | --- |
| P0.1 | Service/image topology in `infra/dev/` and `infra/jena/`; root commands and host process wiring in `scripts/dev/` and root `package.json`. OPS01/OPS14/OPS16 and the existing Main/Account integration path are affected. | From a clean clone, `yarn toolchain:install && yarn dev` serves healthy Main and Account. No `REZICS_*` host paths remain. | Exit check passed from a sibling fresh clone with no Yarn install state: exact install completed, then `yarn dev` served Main and Account `/health/ready` with HTTP 200; teardown left no running stack. The existing checkout also served both without host Jena/Java/Python variables. This does not certify full OPS01/14/16 cases. |
| P0.2 | Java command endpoint, assembler/image wiring and transactional gate under `infra/jena/`; Main command adapter and writer migration under `services/main/`. SYS02/SYS09/SYS10/SYS14 and model validity cases are affected. | The module gate in the toolchain lock passes; Main has no `execFile` validator path. | Partial: pinned native module 0.5.10 keeps fenced Content rebuild commands, per-JVM identity and a public-search write epoch, and validates focus graphs through a read-only union rather than copying their triples. Main claims Access grants before dispatch. The native model gate passed 26 tests and all 66 recorded outcomes/path checks; broader command families and external Access binding still need qualification. |
| P0.3 | TypeScript model IR and compiler for the historical and newly admitted profiles, with generated shapes, TypeBox schemas, types, constants, registry and arbitraries. | Recorded candidate outcomes reproduce; the Python validators and hand-written profile Turtle are deleted; `yarn gen:check` is clean. | The 12 historical generated profile digests and all 66 recorded native outcomes retain zero result-path differences; three Content publication/search profiles bring the current total to 15. The merged model tier passed in `20260924t195652-538b84`. The handwritten Turtle definitions and Python validator/test execution files were removed; historical fixtures remain. MODEL17/MODEL27 retain partial acceptance status pending broader cases. |
| P0.4 | Shared-stack `yarn qa` core under `tests/qa/` and `scripts/qa/`, starting with real Account signup/session and Main/Fuseki readiness. OPS01/IAM01 have partial smoke coverage; later increments add oracles, split cases, model/fault/e2e/load tiers, fixture fetcher and `--record`. | `yarn qa` passes within 30 minutes on this host; setup is shared, overlapping full runs on one checkout are rejected, failure reruns preserve their partial scope, and `--record` verifies and records in one run. Any failure can be rerun by ID. | Clean merged `20260925t035859-06b5a7` passed static, 120 unit, 24 integration, 27 model, 10 fault/recovery, 4 browser and 1 load case within the 30-minute budget. It reports 8 passed IDs, 30 partial and 239 uncovered. The five host-Jena owner tests are explicitly outside the QA registry until migrated to the shared stack; their prior failed paths remain visible in failed-run diagnostics and certify no IDs. Final clean `--record` and broad coverage remain open. |
| P0.5 | Explicit response schemas, OpenAPI export, `MainApp` type export, S3 object adapter on RustFS. | The Eden and object-storage gates pass. | Partial: aws4fetch signed conditional creation, read-back checks and eight same-key writers passed against RustFS. Main Work create/edit, exact and recovery reads use the adapter when configured. All 36 Main `/v1` routes now have explicit response schemas and inferred types; `yarn gen:check` checks `generated/openapi/main/public.json`, and the standalone Eden consumer compiles and makes two actual calls. The earlier merged static, unit and integration tiers passed in `20260924t202630-48ca4a`; the new routes await full merged QA. Other semantic object consumers, backup/restore, multipart/GC and the web Eden BFF gate remain. |
| P0.6 | `apps/web`: vinext on Workers, Eden with TanStack Query, Tailwind/SharkUI in `packages/ui`, `native-i18n`, Storybook, Playwright; sign-in through Account, one RSC Work page and one client search component. | Playwright on `wrangler dev` and the Storybook tests pass inside `yarn qa`. | The merged English/Simplified Chinese shell, search, auth, Studio and exact Work page passed the built-Worker browser tier in `20260924t202630-48ca4a`. Cases covered PKCE, denied actor, Work creation, explicit QA read grant, Chinese exact revision on mobile, locale persistence, per-browser isolation and independent search language. Integration proves exact read denied before and allowed after the Access grant. The complete authenticated Content/Realm/edit journey and broader frontend acceptance remain. |
| P0.7 | README, installation, service READMEs and model README describe the actual commands. | `yarn docs:check` passes; the documented commands run as written. | Root README, installation, operations index, Main/Account service READMEs and model README document the current commands and separate the S0 raw-update drill from the product command path. Merged `yarn docs:check` passed 166 Markdown files and 9 checker tests. `yarn dev --profile qa --run-id p06-install` then launched Main, Account and web from an isolated stack: both readiness endpoints and `/sign-in` returned 200, registered OAuth/runtime files were mode 0600, and teardown left no QA containers. Final documentation reconciliation follows the Content search and broader browser boundaries. |
| P0.8 | PostgreSQL Content revisions/drafts/receipts/outbox and preparation pins; common history adapters; exact-revision publication; bounded two-owner relay into RDF MatchUnits and embedded Lucene; coherent readiness and two-stage rebuild. | WORK02–03/09–10, SEARCH01–04/06–08/15–20 and OPS03/09/11–12/15–16 pass through the harness. Derive path costs, assert multi-scale work and retain plans, amplification/recovery evidence and separately scoped host objectives. | Partial cmd0.5.17 evidence covers public paging, Content history/pins, link replay, projection, rebuild and restore. The 10-Work diagnostic passed a bounded native delta and private Contribution restart probe. The two 10,000-Work attempts failed 26 and two mixed reads after approximately 166 and 174 minutes of command seeding; the latter two were transient `search_index_unavailable` Content responses. Clean 100-Work one/four-worker seeding took 79/82 seconds; clean 1,000-Work seeding took 899 seconds and its mixed phase passed. Implement compatible isolated background preparation and a bounded read-race reproducer before another large run. Private paging, native cost coverage and complete P0.8 acceptance remain open. |

With their required foundations, backend/API batches follow the [dependency order](#dependency-order)
until every retained M01–M10 capability has a working API and its required
storage, authorization, cross-service and operations behavior. The complete web
product journey follows that backend/API gate. Existing Phase 0 web code and
necessary browser regression checks remain maintained during API work.
P0.7's final documentation verification includes the P0.8 commands once supplied.
P0.8 reuses the selected engines: it does not authorize a new query optimizer or
an automatic engine migration if a gate fails. Correct the bounded plan/index
binding first; a material remaining failure reopens only the affected decision
with retained evidence. Do not pass by excluding the core graph/text/Realm query.
Add one row per batch; keep the rows short and cite the qualification page.

| Batch | Scope and acceptance IDs | Result |
| --- | --- | --- |
| B1 | Complete the S2 authenticated Work/Realm/edit/search journey through real API calls and owner state, including denied, stale, concurrent and recovery outcomes. IDs from [native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and [identity/access](../testing/identity-and-access.md); required Content, Access, Account, Main and graph integrations are in scope. | The real Account OAuth, Access, Main, Content, Realm classification, adoption/rejection, search, exact history and paragraph-comment journey passed the merged integration tier `20260925t035859-06b5a7`. Content recovery coverage and a translated-link graph-loss replay passed the fault tier. The older host-Jena OAuth restore owner test is outside QA pending shared-stack migration, so the broader coordinated Account/Access/Content/graph restoration and mixed-cut gates remain open. Full web flows follow backend/API completion. |
| B2 | Establish the Access read-admission side of SEARCH11/SEARCH12 private phrase search, then bind exact Content and graph/index positions and enforce pre-match field/unit eligibility at the API. | The ten-second durable Contribution read lease, generation recheck and strong-closure pending accounting passed the merged QA; native private MatchUnit and field isolation have direct integration coverage. The internal adapter requires a command-only service and awaits the next small `yarn load` diagnostic and retained restart proof. A full-size WebSocket frame followed by a matching nonce pong proved ordered peer receipt in a loopback probe, while early/wrong pongs and a buffered half-closed peer remain counterexamples for terminal delivery. The HTTP route stays closed at 503 pending a proven delivery/cancellation protocol. SEARCH11/12 and broader Content mapping remain unqualified. `admission.ts` exceeds 800 lines pending extraction after live behavior is qualified. |
| B3a | Begin M01 private acting-context discovery and selection over real Account/Access/Main boundaries. IAM01/IAM03/IAM04; one principal may represent several Agents, and an Agent may have several controllers without publishing the private mapping. | Merged with B3b. Private discovery, task-scoped checks, an OpenAPI consumer and the shared-stack test have scoped evidence; the latest merged tree remains unqualified. Grant mutation, full group/role composition and web flows remain subsequent work. |
| B3b | Merge the next backend boundary slice: IAM09 explicit-consent authorization-code, refresh and introspection fence; IAM01/03/04 private acting-context preference CAS and Access recovery coverage; SEARCH02/10 rejected-candidate budget; SEARCH13 named-graph sentinel; SEARCH11/12 durable private-send receipt and final position recheck; OPS03 coordinated Account/Access/Content/graph physical restore. Owners are Account, Access, Main, Content, graph and the QA integration/fault tiers. | Merged `yarn qa` `20260925t082555-6980ba` passed all seven tiers after Access fixture, restore-run ID and Account JSONB consent fixes. It reports 9 passed IDs, 31 partial and 237 uncovered across the retained scope. Private delivery/search and broader owner coverage remain unqualified. |
| B4 | Integrate Stage A IAM04 direct-principal `work.create` authority beside represented-Agent selection; SEARCH11/12 native private field, position and receipt boundaries; SEARCH20 public Content projection/index restoration after loss. Owners are Account, Access, Main, Content and graph/index fault fixtures. Review the selected path, negative/recovery outcomes and bounded work under the cost contracts. | Full merged `yarn qa` `20260925t085124-7fa328` passed all seven tiers after an Access migration-fixture repair and a command-only native private-search fixture. It reports 9 passed IDs, 32 partial and 236 uncovered across the retained scope. SEARCH11/12 keep the HTTP route closed; SEARCH20 and broader IAM04/SQL-cost gates remain partial. |
| B5 | Extend Stage A IAM05/IAM36 with private same-scope Agent group inheritance for `work.create`; qualify SEARCH04 rated-relation multiplicity and SEARCH06 CJK Main/Realm selection; add an optional bounded seed-worker profile for OPS05/SEARCH18/SEARCH19 diagnostics. Owners are Access schema/context/admission, Main native query fixtures and the practical-load runner. Derive and check path costs, bounds and denied/stale outcomes. | Full merged `yarn qa` `20260925t091518-584f03` passed all seven tiers after a SQL alias repair, an Access migration fixture update and a bounded restore-promotion wait. It reports 9 passed IDs, 32 partial and 236 uncovered. Seed concurrency defaults to one and awaits a small 100-Work A/B diagnostic. Public group management, impact approval, general roles, wider IAM36 and bounded discovery SQL remain open. |
| B6 | Extend M01 and native Work boundaries: IAM11 older/current Account and Access physical restore against retained deletion evidence; IAM33 exact represented `work.create` proof across mandate, grant, Agent and principal generations; WORK04 explicit adaptation, recording and fork derivation from an exact retained source revision. Owners are Account, Access, Main, graph/model and the integration/fault tiers. | Full merged `yarn qa` `20260925t095644-8fd772` passed all seven tiers after fixture repairs and cmd0.5.17's successive restore-cutover correction. It reports 9 passed IDs, 34 partial and 234 uncovered. IAM11, IAM33 and WORK04 retain broader paths; Work derivation query plans and cold-cache costs remain open. |
| B7 | Complete SEARCH05/09's current-only public search refusal contract across all six query and page profiles, and extend IAM11's isolated Account erasure restore to retain an unrelated public Work and exact PostgreSQL Content revision. Owners are Main public API, Account, Access, Content, graph and the integration/fault tiers. | Full merged `yarn qa` `20260925t100655-4e1b04` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. The two supported refusal cases returned typed 422 before native reads; the IAM11 physical restore retained unrelated public Work and exact Content bytes. Historical copy sanitization and off-host custody remain open. |
| B8 | Batch IAM04/IAM36 acting-context discovery's represented Agent grants and same-scope group inheritance. Preserve current group depth, membership and 50/51 result ceilings, private path hiding, recovery fence and selected-command recheck; assert fixed SQL call count against a real Access owner. | Full merged `yarn qa` `20260925t102029-423253` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. The 20-group-Agent plus mixed 50/51 owner case passed with 13 total SQL calls, including transaction setup, versus candidate-dependent calls before batching. Physical plans and cold-cache costs remain open. |
| B9 | Diagnose the failed 10,000-Work mixed read boundary without another multi-hour seed. Retain phase-specific read/retry traces only in load Main logs, reproduce an over-deadline writer with a bounded fake, and select a falsifiable fixture candidate. | Full merged `yarn qa` `20260925t105949-a05211` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. The bounded fake times out in writer-wait and then succeeds after release; this does not establish the cause of the two retained Content 503s. A stopped-state clone of a command-seeded baseline is the next 100-Work experiment; compatible cloning and the 10,000-Work profile remain open. |
| B10 | Falsify a stopped-state clone on a 100-Work command-seeded source: copy all owner/index volumes and immutable objects into a separate QA project, validate compatibility and a fresh ten-Work admitted cohort, and diagnose live Main/Realm/Content retry exhaustion without relaxing query budgets. | Full merged `yarn qa` `20260925t113601-8a29bc` passed all seven tiers: 11 passed IDs, 34 partial and 232 uncovered. `load-20260925t112243-a396dc` had five Main/Realm movement failures and `load-20260925t112646-7977c5` had one Content movement failure. Coherent later metadata cuts removed those specific unnecessary retries; `load-20260925t113037-83d446` passed 129 reads/22 writes with no failures. `clone-image-b` passed cold cases, receipts, exact Content bytes, a fresh ten-Work cohort and restart; the source remained isolated. Short passes do not qualify 10,000 Works. |
| B11 | Turn the verified stopped-state clone into a reusable load fixture: prepare a command-created background with expired baseline grants and retained manifest, clone it into an isolated run, create a small fresh writable cohort, then exercise exact cold/mixed/restart checks against the combined corpus. | Full merged `yarn qa` `20260925t115249-d6903a` passed all seven tiers. Source `load-20260925t120124-ff88f9` prepared 90 Works with 368 sealed admissions; clone `load-20260925t120333-daae78` passed 129 reads, 23 writes, zero errors and 104 retained units after restart. Source `load-20260925t120450-1ecb71` prepared 990 Works with 3,968 sealed admissions; clone `load-20260925t121817-08beab` passed 136 reads, 28 writes, zero errors and 1,004 retained units after restart. Both sources had seven exact cases after baseline grant expiry, zero relay lag and a stopped, hashed owner/index manifest. This remains diagnostic below 10,000 Works. |
| B12 | Qualify the 10,000-Work host profile from a command-created 9,900-Work stopped baseline and a fresh 100-Work writable cohort, retaining exact owner/index identity and full 180-second mixed thresholds. | In progress: `load-20260925t122019-660a32` is preparing the 9,900-Work source in the unchanged `c47fdcc` checkout. Inspect its terminal evidence and stopped volumes; only if the manifest, grants, source fingerprint and checkpoints pass, run `yarn load --works 10000 --duration 180 --from load-20260925t122019-660a32 --cohort 100`. The separate WORK04 checkout may merge only after this source run no longer needs the original fingerprint. |
| B13 | Complete the first WORK04 graph-loss recovery boundary: replay an admitted exact Work derivation from retained relay and Access evidence into the held graph, reject changed/missing evidence, preserve the relation and receipt identity, and verify idempotent duplicate replay. Owners are Main's native derivation/recovery modules, relay, the model profile and fault/recovery tests. | Implemented in the isolated checkout. The single-snapshot relay repair passed unit and real WORK04 restore (`20260925t133014-4660c7`); applying it to shared one-event replay also passed translation unit and real WORK02 restore (`20260925t133602-de07ba`). Full QA `20260925t124152-5db7ac` and failed-only `20260925t125429-2258a1` were contended by B12's live seed. Disposable Content PostgreSQL initialization exceeded Bun's 5-second budget; skipping only `initdb`'s initial sync and asserting runtime `fsync=on` made the selected integration test pass in 1.0 second (`20260925t132053-55471b`). The fault tier still exceeded 360 seconds after its earlier cases passed. Keep this slice unqualified; rerun complete `yarn qa` after B12 releases the host, then integrate only a passing tree. |
| B14+ | Implement and qualify each remaining retained M01–M10 backend/API dependency through stages A–G: persistence, authority, cross-service contracts, source/package workflows and operations. The [backend map](backend-acceptance.md) and owning case files select the next batch; no required API behavior remains uncovered before W1. | Pending. |
| W1+ | Build and qualify the full web product journeys against the completed APIs, including the authenticated S2 flow and all retained frontend acceptance. Finish local full-application browser verification and the clean final `yarn qa --record`. | Waiting for the remaining backend/API gates. |

The backend/API exit gate requires every retained M01–M10 backend behavior to have
a working owner interface and passing owner-boundary evidence, with no failing or
uncovered retained backend case in the [backend map](backend-acceptance.md).
It includes storage, authority, cross-service, recovery, path-level complexity
and scoped practical-load checks. Small growth checks and larger host qualification
have distinct claims; the latter is not a prerequisite for unrelated slices.
Run merged `yarn qa` batches during this stage; the final clean
`yarn qa --record` follows W1+ and covers the complete product, including web.

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
| S2 First authenticated API journey | Create metadata-only Work/MainVersion, publish one text contribution, assign different classification decisions in two Realms, search the eligible public view, then edit and read the prior revision through real APIs. | Shared Work identity, distinct Realm decisions, exact comments, current authority and graph/text completeness remain correct end to end. |
| S3 Broaden to retained backend/API gates | Add ratings, multilingual relevance, qualified private search, all indexing domains, sources and package flows through stages B–G below. | Owning backend/API capability, integration and operations matrices pass before full web flow implementation. |

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
| S2 Authenticated API journey | [Main Version](../contracts/main-version.md), [Space](../contracts/space.md), [classification](../contracts/classification.md), [search](../contracts/search.md) and [vertical workflows](../implementation/vertical-workflows.md). | [Native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and [backend integration](../testing/backend-integration.md): one Work, two Realm decisions, eligible search and exact historical reads through actual APIs. |
| S3 Remaining backend/API capabilities | Select the next unmet dependency from stages A–G and [M01–M10](../product/capabilities.md#capability-coverage); use the corresponding [coverage row](../architecture/coverage.md). | Owning [backend](backend-acceptance.md) and operations evidence for every retained API capability, including G1–G4 and G6 at the backend boundary. |
| Full web journeys | After S3 backend/API qualification, load [frontend acceptance](frontend.md) and the affected [experience](../experience/README.md) owners. | G5 and complete browser journeys over the delivered APIs, then the final recorded full-suite gate. |

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
Current-site inputs refresh each live-source run; verified captures reproduce one
run. The current baseline is 500M business entities/documents; 3B is a future
scenario. Keep derived complexity, executed growth checks and measured rollout
capacity separate. No small-data pass certifies that all existing data fits.
