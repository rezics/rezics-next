# Implementation sequence and qualification

## Active execution

| Field | Selection |
| --- | --- |
| Scope | The active Codex [Goal](../../GOAL.md) implements retained M01–M10 backend/API only under the maintainer's 2026-09-26 direction. UI consumes the APIs; frontend, Storybook and browser acceptance are excluded. |
| Program | Retain TypeScript/Bun, Better Auth, PostgreSQL and Jena. Follow the [ten-hour proposal](#backend-only-ten-hour-proposal), API contracts, reusable backups with a 600-second routine preparation ceiling, and affected checks under the [batch cadence](execution-workflow.md#batch-cadence). |
| Agent strategy | Default to local execution; use fresh briefs and at most two workers for justified independent deliverables under the [delegation policy](execution-workflow.md#delegation-and-worker-lifecycle). Workers finish after handoff. Compare accepted results against total main-task and worker usage under [efficiency measurement](execution-workflow.md#efficiency-measurement); no automatic per-batch fan-out or model-driven job monitoring. |
| Authority | This active Goal authorizes local backend implementation, dependency setup, disposable QA stacks and coherent local commits on `main`. Remote pushes, production publication and paid provisioning remain outside this scope. |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Status | B14's first fixed native text release seal and exact-read APIs passed the affected real API journey `20260925t165922-31315b`, backend model tier `20260925t165108-1bd395`, and selected graph-loss recovery `20260925t170009-d283fb`; it is committed at `b6bb597`. B15's first Content typed-query and migration-runner slice passed real owner integration `20260925t170904-8a5086`. B16's current-image small fixture restored in 10.361 seconds; a separate ten-fresh-Work/restart probe and a read-only source probe passed. B17 maps all 276 retained IDs to owner operations. B18's public same-scope group API passed `20260925t174136-90d043`; B19's independent populated-reparent approval passed `20260925t175421-c312b7`; B20's institutional Agent grant API passed `20260925t180337-25c0aa`; B21's recipient-requested representation API passed `20260925t181322-6dc851`; B22's pinned role revision and binding API passed `20260925t182755-e1c783`; B23's registered rating-withdrawal owner test passed `20260925t183302-fd4807`; B24's Realm-local classification resolution passed `20260925t183629-db4f16`; B25's Work address claim and relay integration passed `20260925t190251-2f11d0` and native model tier `20260925t190442-72cd3e`; B26's same-Work uniqueness/call-counter proof passed `20260925t191155-13a371`; B27's address rename/reverse/exact integration passed `20260925t192406-292569` and its model tier passed `20260925t192334-24062c`; B28's direct merge/retire integration passed `20260925t193537-c024de` and model tier `20260925t193558-6ff268`; B30's classification read fault fixture passed `20260925t194147-c1de17`. Selected passes remain partial until one complete QA run qualifies their declared cases. The prior full `yarn qa` `20260925t151147-02d115` remains the last broad result: 11 passed IDs, 35 partial and 231 uncovered. The separate practical 10,000-Work profile `load-20260925t160348-90e989` passed its selected host objective, not the product scope. The [qualification page](qualification.md) remains the final generated evidence owner. |
| Next action | Continue remaining M01–M10 owner schemas and registered boundary cases, prioritizing dependencies for a complete reusable fixture. An indexed route structure for valid chains beyond 32 hops remains a separate availability improvement. Final reconstruction and recorded backend QA remain the final gate. |
| Forecast | At activation, 276 backend IDs are retained and the prior full run passed only 11; B14's selected checks still count WORK05 as partial. The ten-hour 100% target is forecast to miss based on this measured backlog. Continue authorized backend implementation and report the actual qualified scope without counting partial IDs as complete. |

### Backend-only ten-hour proposal

The maintainer's 2026-09-26 direction is authoritative: API operations define
backend scope; UI consumes those APIs. Frontend, Storybook and browser acceptance
are outside this Goal. Ten hours includes setup, implementation, coordination,
checks and repair. The current task activated the Goal from `GOAL.md`; the earlier
planning revision did not start its clock.

**Diagnosis.** The toolchain selected `pg` and confined Kysely to Better Auth.
The inspected stack/toolchain owners contain no ORM comparison justifying that
restriction for ordinary application tables. Content now hand-maintains row
mapping and a migration branch per version. The previous plan already required
fixture reuse; repeating 166/174-minute command seeding did not implement that
requirement. The fix is an enforced preparation path, not another recommendation
to optimize later. Existing 277-ID results mix frontend/backend obligations and
cannot be presented as a backend completion percentage.

**Engineering decisions.**

| Area | Decision | Limit |
| --- | --- | --- |
| PostgreSQL | Adopt a bounded Drizzle ORM typed-query slice over Content's existing `pg` transaction. Keep Content's numbered SQL migrations as the single DDL owner and discover them automatically. | Expand typed table coverage with owner features; do not run Drizzle Kit as a second migration history. A later Kit handoff needs a complete baseline and empty/existing upgrade gate. Keep necessary parameterized locking/recursive/recovery SQL. |
| Database design | Design the retained owners' tables, constraints, indexes and relationships together before bulk fixture creation. | Use ordinary schema definitions and migrations; do not build a universal schema framework. Preserve separate owner credentials and transaction boundaries. |
| Test data | Bulk-build one reusable complete fixture generation, save a consistent backup of PostgreSQL, TDB2/Lucene and objects, restore isolated copies thereafter. | All routine preparation, including restore, startup, migration and minimal readiness, must finish within 600 seconds. Do not seed the background corpus through public commands or re-prove it on every restore. |
| Authentication | Keep Better Auth and its admitted official plugins/schema tooling. | Keep the present adapter during the Content pilot; ordinary account features do not need homemade protocol machinery. |
| APIs | Keep Elysia + TypeBox + generated OpenAPI/Eden. All user-visible business operations have callable API contracts. | No UI/BFF-owned business authorization, direct storage access or workflow steps unavailable to API clients. Backend API tests must run without the web app. |
| Jobs | Candidate pg-boss for a concrete scheduling/retry consumer after pinning and a small compatibility gate. | Preserve domain outbox, idempotency and projection checkpoints; do not rebuild a scheduler or claim exactly-once external effects from a queue. |
| Graph/search | Keep Jena/TDB2/jena-text. | ORM covers PostgreSQL, not RDF/SPARQL/SHACL. No new engine comparison or graph ORM project. |
| Package ecosystems | Thin adapters around admitted native resolvers/installers where semantics fit. | Reuse their algorithms; keep REZICS source/lock/authority semantics and qualify each retained ecosystem. |
| Daily verification | Changed backend behavior, affected contracts and relevant static checks only, using the existing harness. | No unrelated browser build, full restore matrix, full corpus check or full suite per small batch. |
| Final verification | One fresh construction path and complete backend integration, recovery and required load qualification; repair discovered defects. | Final evidence still covers the full retained backend scope. Missing features cannot be replaced with mocks or declared complete. |

Drizzle ORM is used for Content's first typed writes because it reuses `pg`
and infers query types from TypeScript table declarations. The bounded real
PostgreSQL slice passed the transaction/CAS/outbox and bigint gates; broader
table coverage and any migration-owner handoff remain open. This is a fit
judgment, not a measured speedup. Official sources:
[existing PostgreSQL](https://orm.drizzle.team/docs/get-started/postgresql-existing),
[migrations](https://orm.drizzle.team/docs/migrations),
[transactions](https://orm.drizzle.team/docs/transactions) and
[Better Auth adapter](https://better-auth.com/docs/adapters/drizzle).
The Content test covers JSONB/bigint representation, CAS, transaction
connection, receipt/outbox atomicity, empty install and existing v3 upgrade.
Later Kit adoption must baseline the existing migrations; never let two runners
own the same table history. Account integration remains unchanged.

[Kysely](https://www.kysely.dev/) 0.29.6 is the lower-change fallback already in
Account; it offers typed queries but not the proposed schema-diff workflow by
itself. Prisma's [introspection](https://docs.prisma.io/docs/orm/prisma-schema/introspection)
is also viable; its separate model/client workflow has no demonstrated payoff
for this time box. Do not conduct a broad ORM benchmark.
[pg-boss](https://github.com/timgit/pg-boss) supplies scheduling, retries and
transactional enqueue, but its REZICS integration is still a candidate.
Sources were checked on 2026-09-26. Pin new tools and root commands in the
toolchain before installation; current Drizzle onboarding uses `@rc`, which must
not be copied as an unpinned dependency or mixed with another release's APIs.

**Budgeted delivery.** These are allocations, not evidence that the entire
remaining M01–M10 backlog fits. Current evidence cannot support a guaranteed
100% backend completion within ten hours.

| Elapsed window | Work and observable exit |
| --- | --- |
| 0:00–0:30 | Freeze the API operation/acceptance inventory and owner schema design. Identify missing implementations and external prerequisites. Split mixed cases without dropping backend assertions. |
| 0:30–1:30 | Qualify the ORM slice and routine backup/restore path; add explicit backend/affected QA selection. Restore plus startup/readiness must fit 600 seconds. Reuse an existing compatible backup immediately; do not wait for another command-seeded baseline. |
| 1:30–7:30 | Implement API capability slices with tests, in dependency order: authority/commands, Content/Space/classification, query, sources/packages and remaining community/commercial operations. Run affected checks per coherent batch. This is six hours of work allocation, not a claim that all these domains fit. |
| 7:30–8:30 | Close cross-owner gaps and prepare final clean installation/data rebuild and practical-load checks. Start any necessary long final experiment earlier on an isolated pinned source. |
| 8:30–10:00 | Full backend qualification, consolidated repair and final evidence. Report the exact commit, callable APIs, passed/partial/missing cases and blockers. |

At 1:30 and each accepted batch, forecast remaining work using actual elapsed
time and the operation-level backlog. Report a forecast miss immediately; keep
doing authorized independent backend work within budget. Keep one integration
batch; workers only own justified independent modules. Stop new large subsystem
work at 8:30 to reserve integration and repair time.

The user authorized frontend removal only. No other backend requirement is
silently cut to make the percentage reach 100. A reduced ten-hour release would
require an explicit scope decision. At the deadline an incomplete backend remains
incomplete; time exhaustion never satisfies the completion gate.

**General rule.** Check every repeated task for reusable outputs: dependencies,
images, generated schemas, source fixtures, backups, indexes and test environments.
Invalidate only artifacts affected by a format/schema/semantic change. Do not
invalidate data solely because an application commit changed. Full-corpus scans,
receipt replay, source refetches and capacity experiments belong to a relevant
diagnostic or final gate, not normal startup. Keep a short setup/check/feature-time
summary in the existing batch row; do not add another reporting framework.

Backend completion is fully passed retained backend cases divided by the frozen
backend total, with partial cases contributing zero. Report implemented API
operations separately. Follow the [scope rules](backend-acceptance.md#backend-only-scope)
and [harness contract](../testing/test-harness.md#backend-only-goal-scope).

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

The historical P0.6/browser results below remain evidence of prior work; frontend
deliverables and remaining browser gaps are outside the current Goal. New batches
follow affected backend verification and reusable backups, not the historical
full-suite-per-batch cadence.

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
storage, authorization, cross-service and operations behavior. UI consumes those
APIs in a separate future scope. Existing web files remain; browser regression
and new web work are outside this Goal.
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
| B12 | Qualify the 10,000-Work host profile from a command-created 9,900-Work stopped baseline and a fresh 100-Work writable cohort, retaining exact owner/index identity and full 180-second mixed thresholds. | Passed on clean `2f9a0ed`: source `load-20260925t122019-660a32` retained 9,900 Works, 39,608 sealed admissions, exact cold cases after grant expiry, zero relay lag and a hashed stopped owner/index manifest. Compatible-source clone `load-20260925t160348-90e989` verified the same schema/model/analyzer digest and Fuseki image ID, created 100 fresh admitted Works, then passed 2,376 reads and 394 writes in 180 seconds with zero HTTP or writer errors, 15.39 total requests/s, read p95 154 ms and Content p95 316 ms. Relay lag was zero; sampled exact heads/receipts and cold/warm public cases passed after a storage restart; 10,004 MatchUnits remained. The run recorded a stable source and reset its volumes. An earlier clone had one Content 503 after three native index movements; the bounded retry repair passed merged QA before this profile. Podman required an explicit `DOCKER_HOST` after Docker Desktop also became available; cross-engine source selection remains an installation/recovery issue. |
| B13 | Complete the first WORK04 graph-loss recovery boundary: replay an admitted exact Work derivation from retained relay and Access evidence into the held graph, reject changed/missing evidence, preserve the relation and receipt identity, and verify idempotent duplicate replay. Owners are Main's native derivation/recovery modules, relay, the model profile and fault/recovery tests. | Integrated into `main` at `2f9a0ed`; full merged `yarn qa` `20260925t151147-02d115` passed all seven tiers, including 14 recovery cases in 351 seconds, with 11 passed IDs, 35 partial and 231 uncovered. The single-snapshot relay repair passed real WORK04/WORK02 restore and a concurrent PostgreSQL mutation case; a 1,001-position engine test caught and verified numeric relay ordering, and a 12-event Content owner test caught the corresponding outbox ordering bug. The same batch included B12's bounded search-race repair and explicit compatible-source load option with focused tests. |
| B14 | Establish WORK05's first fixed release owner path for an eligible native text selection. A separate release identity must pin an exact Main Version revision, selection, publication decision, selected draft and verified bytes under a complete bounded manifest; later Work metadata edits and default changes must not alter that release. Add admitted seal and exact read APIs with denied, stale, concurrent, idempotent, damaged-byte and restart tests, plus a derived cost contract. Owners are Main release commands/history, Access admission, generated model profile and the integration/recovery tiers. | The first path is implemented: cmd0.5.18 native binding commits one release anchor, receipt and typed relay event; `POST/GET /v1/fixed-releases` pass denied, stale, same-key concurrent convergence, replay, changed-intent conflict, current Work disclosure, retained body after metadata/default changes, service restart and damaged manifest checks. Real API run `20260925t165922-31315b` also held result/body fixed across one and nine unrelated Works and observed equal graph call counts under a working read budget. Model tier `20260925t165108-1bd395`, isolated graph-loss replay `20260925t170009-d283fb` and `yarn check:backend` passed. Replay rejects changed Access intent and missing/changed relay evidence, then retains original identity and exact bytes. These selected passes do not declare full WORK05. Physical graph costs, recovery throughput, multi-member composition, metadata claims, availability and package resolution remain open in B15+; WORK05 stays partial. |
| B15 | Start the typed Content owner pilot without splitting DDL ownership: exact-pinned Drizzle over the existing `pg` transaction for owner position, receipts and outbox; discover the existing numbered SQL migrations rather than branching per version. Prove empty install, v3 upgrade, trigger retention, CAS, forced outbox rollback, JSONB and bigint above 2⁵³. | Selected real PostgreSQL integration `20260925t170904-8a5086` passed. Broader Content table typing, Drizzle Kit baseline adoption, all-owner schema design and reusable full fixture remain open. This infrastructure slice qualifies no full acceptance ID. |
| B16 | Make stopped-state fixture compatibility depend on storage/model inputs rather than application runner code, then provide a root restore command with a 600-second end-to-end deadline and minimal owner/index readiness. Verify it against an isolated retained source and a writable clone; preserve provenance and separate full-corpus certification from routine setup. | `85c23f8` added the facade, storage-only compatibility with legacy manifests, and unit coverage; `9f15aac` fixed Docker daemon selection after a failed source attempt, with unit and backend static checks passing. One-time current-image source `load-20260925t171808-58c1f9` prepared ten Works. `fixture-b16-first` restored in 10.361 seconds with four owner DBs and Fuseki ready; `load:clone-probe` then sealed ten fresh Works, retained old receipts/exact Content, and passed restart. The original stopped source's read-only probe retained graph sequence 51 versus clone sequence 102 after writes. The complete all-owner M01–M10 fixture remains open. |
| B17 | Map every retained backend acceptance ID to a concrete owner API operation, using existing routes where present and explicit planned operations for gaps. Check that the map has exactly the frozen 276 IDs with no duplicate or frontend-only entry; identify the next owner schema/operation dependency from it. | The [operation map](backend-operations.md) assigns all 276 backend IDs once; the unit gate compares it with the frozen inventory and verifies every existing Main method/path against generated OpenAPI. It corrected the Realm selection write to `POST /v1/publication-selections`. `yarn test tests/qa/unit/backend-operation-map.test.ts` and `yarn check:backend` passed. Planned paths are targets, not implemented behavior; IAM05 group/role impact approval is the next owner schema/operation gap. |
| B18 | Expose the existing Access-owner same-scope work.create group profile through admitted API operations for bounded current-state read, create, empty reparent, member/grant add and revocation. Use Account-scoped caller proof, Access permission/assignment ceiling, current recovery gate, typed denied/stale/unavailable outcomes, and bounded owner work. Reject populated reparent and other impact-changing operations until the independent approval schema is delivered. Cover real denied, stale, concurrent, replay/read, grant lifetime and selected-proof invalidation. | The real OAuth/Main/Access journey `20260925t174136-90d043` passed alongside the existing acting-context fixture: an authorized bounded state read, CAS winner, replay across app instances and after grant expiry, changed-intent conflict, grant lifetime ceiling, selected-proof invalidation, populated reparent denial, immutable receipt and over-cap refusal. Generated OpenAPI and backend static checks passed. IAM05/IAM36 remain partial; no independent impact approval or general role/grant administration exists. |
| B19 | Add an Access-owned populated-reparent proposal with bounded potential grant/member impact, then require a distinct current approver and its own work.create approval ceiling for atomic approve-and-activate. Bind preview to exact scope/object generations, fail stale proposals, retain immutable activation identity and prove no self-approval or partial activation through real OAuth/Main/Access. Owners are Access SQL and group transactions, Account scope, Main API/OpenAPI and IAM05/IAM30 owner tests. | Selected real Account/Main/Access integration `20260925t175421-c312b7` passed stale proposal, distinct principal and issuer, separate approval ceiling, key conflict/replay, atomic topology activation, current selected descendant grant and immutable activation receipt. The proposal exposes bounded potential impact and stale/activated status; the generated OpenAPI marks all group routes private and write keys required. General role/representation impact and physical cost remain open; IAM05/IAM30 stay partial. |
| B20 | Add an Access-owner institutional `work.create` Agent grant create/revoke/read API. Separate issuer subject from actual principal, require current Account scope, exact issuer representation and an explicit assignment ceiling through the grant lifetime. Bind scope/object generations and principal/key receipts, advance the authority fence on mutation, and prove a grant survives issuing operator departure but not recipient-path loss. Owners are Access SQL and grant transactions, Account scope, Main API/OpenAPI and IAM13/IAM14 owner tests. | Selected real OAuth/Main/Access integration `20260925t180337-25c0aa` passed denied and over-lifetime assignments, exact replay/conflict, concurrent CAS, 50/51 keyset read, operator departure, new representative issuing as the same recipient Agent, and revocation of selected use. Generated OpenAPI and backend static checks are the batch gate. IAM13/IAM14 remain partial; general roles, mandate creation, dependent grant lifecycle and physical cost remain open. |
| B21 | Admit an ordinary `work.create` representation through a recipient-authenticated, purpose-bound request handle and a manager's exact mandate/assignment ceiling. Accept and revoke under the Access scope fence with principal/key receipts and object generations. Expose only the request/representation handle through Main APIs, retain recipient consent and private Account identity in Access, and test real Account OAuth, current selected Agent and command admission. | Selected real OAuth/Main/Access integration `20260925t181322-6dc851` passed private principal creation from a verified request, purpose-bound handle read, missing and short assignment ceiling denial, exact replay/conflict, selected context and registered command proof, revocation, and a fresh mandate that cannot revive the old claim. Generated OpenAPI and backend static checks are the batch gate. IAM25/IAM26/IAM33 remain partial; protected and composed representation and physical cost remain open. |
| B22 | Introduce immutable same-scope Agent role revisions and bindings pinned to a revision, with the first permission family `work.create`. Role creation/revision and binding activation require separate manager/binder authority and current assignment ceilings. Add an actual represented Work admission proof path for a selected binding; show that a new role revision does not change old bindings or saved admissions. Provide bounded read/write APIs, current discovery, stale/CAS/replay/revoke tests and derived costs. | The real Account/Main/Access selected integration `20260925t182755-e1c783` passed empty revision/binding denial, assignment ceiling, immutable revision append, pinned old binding, new selected admission proof, later revision stability, saved claim invalidation on revocation, exact replay/conflict, stale head, concurrent epoch CAS, bounded current reads and immutable receipts. The operation-map unit and `yarn check:backend` passed. First `work.create` roles are callable; general permissions, protected role approval and physical path costs remain open. IAM05/IAM30/IAM33 stay partial. |
| B23 | Reconcile RATE04's existing exact-head withdrawal operation with the backend operation map and register a real owner fixture that proves current aggregation never resurrects an older opinion after withdrawal while retaining exact immutable history. Use an API consumer and declare complete-case coverage only for that narrow retained scenario. | The planned withdrawal route was redundant: `POST /v1/rating-observations` already writes a `value: null` revision. The registered real Fuseki/Main fixture `20260925t183302-fd4807` passed two-rater correction, withdrawal, immutable prior revisions, current aggregate and restoration. RATE04 is declared for full-run coverage; the selected run still reports it partial. Other rating cadence, context and event-time cases remain open. |
| B24 | Qualify CTX02 through the existing Main resolution operation and the registered real owner fixture: inherited Global acceptance, a Realm-local rejection with its own exact decision, Global independence and another Realm's isolation. Declare complete-case coverage only for this retained scenario. | The two-Realm integration `20260925t183629-db4f16` passed explicit `POST /v1/classification-resolutions` before and after local rejection alongside the joined search checks. CTX02 is declared for full-run coverage; the selected run still reports it partial. CTX03 unavailable-local behavior and rule/vocabulary changes remain open. |
| B25 | Add the first Main-owned `work` namespace address claim and public resolution API. Bind one normalized slug to one current metadata Work, preserve a separate route identity and immutable receipt, require an Account assertion and current Access `address.claim` grant, deny absent targets at resolution, and prove one winner under concurrent claims without retargeting. | The real Account/Access/Main/Fuseki integration `20260925t190251-2f11d0` passed denied claim, normalized claim/replay, changed-key conflict, public resolution, concurrent one-winner claim and relay handoff. The backend model tier `20260925t190442-72cd3e`, `yarn check:backend`, and documentation checks passed. VIEW01 has a complete-case declaration for the final run; selected evidence still reports it partial. Rename, merge, retire, reverse links, private-target disclosure and exact historical route selection remain open. |
| B26 | Before address lifecycle, enforce at most one current `work` address per Work so reverse canonical resolution has a unique target. Preserve the old claim receipt and add an explicit conflict reason for a second slug. Derive a fixed-call and indexed-access cost contract for the claim and public read, with an affected real-owner counterexample. | The selected real owner integration `20260925t191155-13a371` passed a same-Work two-slug race, normalized namespace collision, stable prior receipt and adapter call ceilings; the contract records the conditional indexed-work bound and missing physical counters. VIEW01 is still partial pending full QA; VIEW02 remains open. |
| B27 | Add an admitted, exact-head Work address rename. Retain the old binding and target identity, mint one new current binding, and resolve old slugs directly to the Work's current canonical slug with no redirect chain. Add reverse canonical lookup and exact revision read that never follows the current head. Use an immutable lifecycle revision, receipt and outbox event; qualify denied, stale, replay, concurrent rename and bounded read paths. | The real Account/Access/Main/Fuseki integration `20260925t192406-292569` passed denied, stale, normalized replay, competing renames, direct redirects after two renames, reverse/exact reads, outbox relay and adapter call bounds. The backend model tier `20260925t192334-24062c` and `yarn check:backend` passed. VIEW02 remains partial until merge/retire and full qualification. |
| B28 | Add admitted address merge and retire dispositions at an exact route head. Keep the source binding's original Work identity, point a merge to one current canonical target Work, and leave a retired slug unavailable. Preserve immutable revisions/receipts/events and bounded current, reverse and exact reads; qualify denied, stale, competing, replay and outbox behavior. | The real owner integration `20260925t193537-c024de` passed direct merge/retire, denied, stale, replay, competing dispositions, exact reads and both relay events. The backend model tier `20260925t193558-6ff268` passed. VIEW02 remains partial: a later merge of the target Work can strand an earlier merged or renamed alias. |
| B29 | Make merged and renamed aliases resolve through subsequent target merges within an explicit fixed bound, retaining the original route identity and exact history. Qualify a two-step chain, deeper bounded growth, cycle rejection and error behavior; do not count a long valid chain as an exact missing route. | The real Account/Access/Main/Fuseki integration `20260925t194716-8eaaa2` passed three merge hops, an intervening rename, terminal retirement, a cycle-forming write denial and exact original revision. Unit checks passed the 32nd hop, overflow, a cycle and a missing target. Overflow returns 503. VIEW02 has a complete-case declaration for the final full run; a larger route index and physical plan remain open. |
| B30 | Qualify CTX03 against a real local Realm rejection above Global acceptance. At the Main graph-read boundary, inject an incomplete local decision and a failed read; assert both resolution and public classified search fail closed without returning a Global fallback or private decision details. | The selected real owner integration `20260925t194147-c1de17` passed both fault modes on both API routes after a real local decision. CTX03 has a complete-case declaration for the final run; the selected result remains partial. Total loss of all local application triples is outside this fault model. |
| B31+ | Continue remaining M01–M10 backend/API dependencies through stages A–G: persistence, authority, cross-service contracts, source/package workflows and operations. The [backend map](backend-acceptance.md) selects later batches; no required backend behavior is waived. | Pending; no required backend behavior is waived. |
| W1+ | Future web journeys consuming the delivered APIs, with their own frontend/browser acceptance. | Removed from this Goal by the maintainer on 2026-09-26. |

The backend/API exit gate requires every retained M01–M10 backend behavior to have
a working owner interface and passing owner-boundary evidence, with no failing or
uncovered retained backend case in the [backend map](backend-acceptance.md).
It includes storage, authority, cross-service, recovery, path-level complexity
and scoped practical-load checks. Small growth checks and larger host qualification
have distinct claims; the latter is not a prerequisite for unrelated slices.
Run affected backend checks during this stage. Final qualification uses one clean,
complete backend recorded run after fresh construction; it does not wait for W1+
or include frontend. Use the implemented
[backend harness scope](../testing/test-harness.md#backend-only-goal-scope);
the unscoped command still includes web.

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

Start with the active scope above and the [coverage map](../architecture/coverage.md).
These routes select initial context; follow additional owning links when a change
affects their invariants. They do not redefine contracts or waive acceptance cases.

| Slice | Initial owners and realization | Exit evidence owner |
| --- | --- | --- |
| S0 Graph substrate | [Installation](../operations/installation.md), [Jena](../storage/jena.md), [recovery](../operations/recovery.md). | S0 above and [operations cases](../testing/operations.md): graph/text persistence, restart and isolated restore. |
| S1 Safe commands | [Commands](../contracts/commands.md), [identity/access](../contracts/identity-and-access.md), [model profiles](../contracts/model-profiles.md), [API/events](../implementation/api-and-events.md), [graph records](../implementation/graph-records.md), [model validation](../implementation/model-profile-validation.md), [authorization bridge](../implementation/authorization-bridge.md), [Access implementation](../implementation/access-control.md). | [Model](../testing/model-contracts.md), [IAM](../testing/identity-and-access.md) and [integration](../testing/backend-integration.md): admission, validation coverage, same-head races, idempotency, receipts, outbox and retained revisions. |
| S2 Authenticated API journey | [Main Version](../contracts/main-version.md), [Space](../contracts/space.md), [classification](../contracts/classification.md), [search](../contracts/search.md) and [vertical workflows](../implementation/vertical-workflows.md). | [Native Work](../testing/native-work.md), [classification](../testing/classification.md), [search](../testing/search.md) and [backend integration](../testing/backend-integration.md): one Work, two Realm decisions, eligible search and exact historical reads through actual APIs. |
| S3 Remaining backend/API capabilities | Select the next unmet dependency from stages A–G and [M01–M10](../product/capabilities.md#capability-coverage); use the corresponding [coverage row](../architecture/coverage.md). | Owning [backend](backend-acceptance.md) and operations evidence for every retained API capability, including G1–G4 and G6 at the backend boundary. |
| Full web journeys (outside Goal) | In a separately selected frontend task, load [frontend acceptance](frontend.md) and affected [experience](../experience/README.md) owners. | G5 and browser journeys consume delivered APIs; these do not gate this backend Goal. |

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
| G5 Experience | Separate frontend scope: affected deterministic checks and authorized Storybook reviews. Outside the current backend Goal. |
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
