# Implementation sequence and qualification

## Active execution

| Field | Selection |
| --- | --- |
| Scope | Active implementation Goal: deliver and qualify the retained M01–M10 first-delivery product scope in [GOAL.md](../../GOAL.md), including local full-application browser verification. |
| Phase | S0 graph substrate verified; S1 authenticated fixed-profile Work create/edit/exact revision read, Work-scoped Access checks, an isolated graph/Access/object restore, a durable RDF outbox handoff, bounded mixed-cut Work outcome replay, one-deletion two-owner graph release guard and synchronous relay deletion journal handoff verified in part. The first S2 independently controlled text Contribution draft, private read, contributor eligibility, guarded Main Version default and Realm-local adoption/rejection, bounded Main and Realm public text search and fixed Realm-first Space creation are verified in part. Shared classification proposition and Global/Realm context profiles pass scoped model checks; distinct Realm classification context provisioning now passes Account/Access/Main/Fuseki and retained recovery checks. Shared definition admission, contextual decisions, ratings and broader search are next; S1 cross-owner recovery and historical erasure gaps remain open. S2–S3 and remaining stages are pending. |
| Authority | Runtime implementation, local disposable services, installation/recovery qualification and autonomous coherent commits on the current `main` branch are authorized by the activated Goal. Production publication and paid provisioning remain outside this execution scope. |
| Deliverables | S0 pinned Fuseki/TDB2/jena-text drill and evidence; S1 fixed model/shape profile, guarded Main Work commands, receipts/outbox, Account/Access admission, isolated restore and recovery guards with their first consumers; first S2 text Contribution draft/profile, immutable create/edit history, contributor eligibility, guarded Main Version default and Realm-local adoption/rejection, public MatchUnit/phrase search in both contexts, private relay envelopes and retained draft/publication/selection/rejection replay; fixed Space/Realm identities, public read, typed event and retained creation replay; pinned shared classification proposition and Global/Realm context profiles; guarded typed classification context provisioning, public read, relay and retained replay. Next, admit shared definitions with guarded storage and recovery, implement opposite Realm decisions and effective search, then ratings; continue cross-owner recovery qualification. |
| Deployment premise | Principal services concentrated on one assessed host; the other primarily API and unrelated workloads. Account placement remains assessed. |
| Qualification | S0 OPS14 and substrate OPS16 passed. S1 tests passed scoped SYS02/SYS09/SYS10/SYS14, create/edit IAM07 fences, exact immutable history, a partial G3 Account/Access/Main/Fuseki HTTP path, partial OPS03/SYS13 isolated restore, deletion guard and retained journal comparison, and partial SYS04/SYS05/SYS12 outbox handoff on Fuseki 6.2.0/PostgreSQL 18.6. The first S2 private draft create/edit path, guarded contributor eligibility, Main Version default and Realm-local adoption/rejection, bounded Main and Realm public phrase search, fixed Space/Realm creation and retained draft/publication/selection/rejection/Space replay passed scoped checks. Classification proposition and context candidates pass scoped MODEL15/17 checks; typed context provisioning passes a scoped live and retained runtime flow. No classification decision or effective-query result is claimed. Complete G2–G6 and S1–S3 remain pending. |

S0 owners are [installation](../operations/installation.md), [Jena storage](../storage/jena.md), [recovery](../operations/recovery.md) and [operations cases](../testing/operations.md). The reproducible [drill](../../scripts/operations/verify_graph_substrate.py) ran on 2026-09-24 with Fuseki 6.2.0 (published SHA-512 `ba65f5867d2d4741b2ed9e2af5a0d4fbb447909894ab2a0c6bc4dac8997f4fe339c87b13c48d45d054977769f0f8bf763ea346b1f7792d5cdc458041bd43a132`) and isolated Temurin JRE 21.0.12.1. [Executed evidence](../../tests/recovery/evidence/2026-09-24-s0.json) records one RDF and joined-text binding after insertion, restart and isolated restore. After label deletion, the named graph anchor remained and the direct text query returned zero bindings. Graceful process exits, stopped-state backup and checksum verification succeeded. That S0 result qualifies the substrate only. Later S1 evidence below exercises product receipts, authorization and an isolated partial multi-store restore; crash-time index rebuild and complete G2 recovery remain untested.

The S1 owners are [commands](../contracts/commands.md), [identity/access](../contracts/identity-and-access.md), [model profiles](../contracts/model-profiles.md), [API/events](../implementation/api-and-events.md), [graph records](../implementation/graph-records.md), [model validation](../implementation/model-profile-validation.md), [authorization bridge](../implementation/authorization-bridge.md) and [Access implementation](../implementation/access-control.md). Its exit cases include [MODEL](../testing/model-contracts.md), [IAM](../testing/identity-and-access.md) and [SYS](../testing/backend-integration.md). The first [fixed Work metadata profile](../../model/README.md) has a pinned Jena SHACL 6.2.0 helper and [executed candidate evidence](../../model/tests/evidence/2026-09-24-work-profile.json): one valid candidate conformed; removing its Work type or required MainVersion link produced violations on the explicitly selected focus. This covers only the fixed-profile portions of MODEL15/17. The [Main storage slice](../../services/main/README.md) uses a Yarn 4.18 lockfile, Bun 1.4.2 and Elysia 2.0.0-beta.16. Its [executed JUnit result](../../services/main/tests/evidence/2026-09-24-main-storage.xml) records one live-Fuseki/PostgreSQL integration test with 84 assertions and no failures. It exercised guarded metadata Work creation, receipt replay/conflict, lost response, same-key race, stale epoch/input, graph/text and immutable bytes, one-scope strong closure and terminal sealing, plus the first Main HTTP route's create/replay/denial/validation and 202 retry behavior. Early storage cases use synthetic admissions; later cases register real Access admissions and bind ID, scope and epoch in graph receipts. That test's Account verifier is a fixture. These are scoped storage and HTTP checks, not complete SYS/G2/G3 acceptance.

The first [Access migration and registry](../../services/main/README.md) were exercised on a disposable PostgreSQL 18.6 cluster. Its [updated JUnit result](../../services/main/tests/evidence/2026-09-24-access-recovery-fence.xml) records one test, 49 assertions and no failures: admission/receipt/outbox registration, replay/conflict, issuer/action denial, expiry before claim, expired-key reconciliation eligibility, same-key concurrency, ordinary closure, competing claim/strong-closure orders, and a racing principal deactivation. This covers one-scope IAM07 registration, dispatch and principal fencing. The fixture seeds principal and grant records directly; it does not qualify grant creation or the full strong-revocation lifecycle. Main's [Account verifier](../../services/main/README.md) checks a JWKS-signed, audience-bound bearer assertion and forces current introspection before returning issuer/subject for Access; its [local-issuer result](../../services/main/tests/evidence/2026-09-24-account-assertion.xml) covers scoped IAM02/IAM10 rejection cases. The [live Account result](../../services/account/tests/evidence/2026-09-24-account.xml) uses actual Better Auth and PostgreSQL to issue a service resource token and a user authorization-code/PKCE token; Main verifies both and denies the user token after sign-out. A separate member deletion fences Access first, removes an offline refresh token and leaves operator/client owners or users whose Access fence failed intact. The [full Work result](../../services/main/tests/evidence/2026-09-24-full-work.xml) records one test, 254 assertions and no failures for a real user token through Account, Access, Main HTTP and Fuseki. It creates and edits with Work-specific grants, replays both commands, seals a stale-head result, resolves old and current revisions under a current read grant, denies the old revision after that grant is removed, seals an edit admission during strong scope closure, deletes a member through Account after an Access principal fence, settles its pending create, denies historical reads and later creates, and rejects the deleted user token. The [edit/history result](../../services/main/tests/evidence/2026-09-24-work-edit.xml) records one live-Fuseki test, 30 assertions and no failures: competing expected-head edits produced one winner and a terminal stale receipt; old immutable revisions resolved, a lost update response reconciled, and missing/corrupt bytes were rejected. These are partial SYS02/SYS09/SYS10/SYS14, IAM01/IAM07/IAM10 and G3 paths, not complete recovery, consent or product qualification. The [updated recovery result](../../services/main/tests/evidence/2026-09-24-work-outcome-reconcile.xml) records one test, 240 assertions and no failures for a stopped-state Fuseki/Access/object copy and separate Account WAL replay, guarded fresh-epoch cutover, retained receipt/revision reads, stale-worker rejection, held HTTP/readiness responses, mismatched external coverage, a release and a new-lineage edit. A separate timeline committed a later edit after the saved cut; restoring that older cut kept the hold because the final coverage differed, and retry of the missing key caused no admission. An Access recovery fence now blocks ordinary admissions, claims, outcome writes and current decisions during the restore; graph hold release keeps its row locked through Access outbox and authority/admission row coverage checks. The drill rejects a mismatched Access state digest even when its outbox coverage matches. An HMAC authenticated graph/Account/Access/relay coverage envelope, including Account WAL position and row digest, must match the graph cut before release; the capture command requires a held Access recovery fence, rejects a lagging relay or an Access state change between scans, and retains the latest coverage digest in the separate relay database; release rejects a wrong key or older signed capture. An independent retained relay checkpoint and envelope digest must match the graph cut before release; a later handed-off edit kept the older restore held even when older Access coverage was supplied. A second mixed-cut path replayed a later edit, Work creation, cancelled creation, stale edit, a zero-event batch, private Contribution draft creation/edit, contributor eligibility and their stale/cancelled outcomes in source order when current sealed Access admissions and immutable objects survived: original Work/MainVersion identities, revisions, receipts and outbox positions were restored under hold; final Access/relay coverage released the new epoch; earlier replays remained verifiable after the recovery marker advanced; old keys returned their original outcomes; and a new Realm adoption used sequence one before a new edit used sequence two. A strong Work creation closure after the saved cut remained effective with current Access: an older sealed create replayed, while a new create was denied after graph release. A separate [Access WAL drill](../../services/main/tests/evidence/2026-09-24-access-pitr.xml) records one PostgreSQL 18.6 test with 28 assertions and no failures: an older verified base backup replayed archived WAL through a later strong scope closure and principal deactivation; restored Access outbox and state digests matched the retained current frontier; a new registration and pending claim were denied. Omitting the later WAL segment produced a readable older cluster with an active principal whose coverage differed. The Access recovery manifest now authenticates its WAL frontier and complete outbox/authority/admission row digests with the retained HMAC key; the drill rejects changed content, a wrong key and the older cut. The local archive does not qualify off-host custody or continuous monitoring. A separate [Account WAL drill](../../services/account/tests/evidence/2026-09-24-account-pitr.xml) records one PostgreSQL 18.6 test with 36 assertions and no failures: tokens signed before the base backup remained denied after sign-out and a member deletion replayed from WAL; the member and offline refresh row stayed absent. Omitting that segment resurrected both tokens and the deleted member in an isolated older restore. A [two-owner deletion recovery result](../../services/account/tests/evidence/2026-09-24-account-access-recovery.xml) records one test, 53 assertions and no failures with separate Account and Access PostgreSQL clusters plus a retained relay cluster: a relay outage after the Access fence left the Account user intact, retry verified the retained intent and deleted the user, a second user without an Access principal gained a relay subject tombstone, and either owner restored without the later WAL failed the retained joint check; both full replays passed. The per-deletion set requires no unsealed admissions and compares both WAL positions and row coverage; its CLI authenticates the retained envelope with a separate HMAC key. Graph hold release now requires one valid two-owner set for every retained deletion intent and rejects missing or stale evidence before graph release. A separate relay deletion journal copies the Access intent id, principal and epoch; capture and release compare its complete set against Access. Graph release also compares the promoted restored Account WAL position and tables with the signed source cut on every release; the drill rejects an older Account cut with current Access and relay. The drill rejects an older signed Access cut when its missing deletion intent survives in that journal, rejects a formerly valid envelope after a newer recovery head is retained, and rejects an older Account restore that resurrects the tombstoned user without an Access principal. A quiesced backfill reconstructed a missing Access-bound subject tombstone, refused a still-present Account user and was idempotent on retry. With the pinned Fuseki runtime enabled, the drill copied a stopped graph control cut, cut it over under hold, then released it against a separately retained relay checkpoint after both PostgreSQL owners replayed their deletion WAL; graph admission reopened only after the valid set passed. A shared [PostgreSQL frontier CLI](../../services/main/src/pg-recovery-frontier.ts) now captures cluster ID and flushed LSN from a quiesced owner and rejects an isolated restore that replayed less WAL; both Access and Account drills exercise it. A pinned [Account recovery manifest](../../services/account/src/recovery-manifest.ts) now compares all 12 Better Auth tables at a UTC snapshot after Account is quiesced; its HMAC envelope rejects modified content and a wrong key, and the drill rejects missing sign-out/deletion WAL by both LSN and row coverage. Off-host manifest/key and relay-head custody, proof that Account and graph writers remain stopped after capture through backup, timeline ancestry, proof that historical unbound deletions are covered, live graph release with Work outcomes and pending admissions, general coordinated owner cuts, cross-owner erasure state, other event kinds and downstream consumer checkpoints remain unreconciled. This is partial OPS03/SYS13. The [updated outbox relay result](../../services/main/tests/evidence/2026-09-24-relay-recovery-coverage.xml) records one live-Fuseki/PostgreSQL test with 43 assertions and no failures. The separate [relay](../../services/main/src/relay.ts) polls contiguous retained RDF batches, verifies member count, typed Work outcomes, terminal receipts and revision manifests, then durably hands private CloudEvents to PostgreSQL and advances an explicit checkpoint. The runnable relay restarted after a simulated post-delivery crash and replayed one batch without a duplicate durable event; it retained a zero-event batch header, rejected a crash-before-checkpoint coverage scan and conflicting or missing retained headers, then resumed that batch and stopped on duplicate batch headers, a mismatched receipt or ordinal, missing event object, source gap, epoch change and recovery hold. This is partial SYS04/SYS05/SYS12: the handoff can lag committed graph positions, and replay of other missing graph effects, later authority/erasure facts, downstream effects, retention and post-restore consumer reconciliation remain pending. The first S2 draft path now creates an independent text Contribution and immutable private draft with Access admission, replay, typed private create/edit/rejection/cancellation relay events and a current Contribution read grant. The [updated full HTTP result](../../services/main/tests/evidence/2026-09-24-full-work.xml) records 254 assertions, including denied private reads, exact-head draft edits including a same-head race with one winner, old and new private revision reads, stale and fenced edits, and no draft body in RDF or relay. The [pinned shape result](../../model/tests/evidence/2026-09-24-text-contribution-profile.json) verifies valid focus and missing author/type rejection. The [updated mixed-cut recovery result](../../services/main/tests/evidence/2026-09-24-work-outcome-reconcile.xml) now checks retained private draft creation, edit, stale rejection and cancellation replay, rejects missing immutable bytes, and verifies both exact draft texts and original key outcomes after release. The same full HTTP flow now checks denied, successful, replayed, stale, nonauthor and strongly cancelled contributor publication decisions, three typed private relay outcomes, and no draft body or MatchUnit in the graph before context selection. The [publication shape result](../../model/tests/evidence/2026-09-24-text-publication-profile.json) checks valid exact focus and rejects a missing selected draft, private disclosure and missing type. The mixed-cut drill now replays a retained eligibility decision and stale/cancelled publication outcomes, requires the selected private draft and decision manifest, then returns the original key outcomes after release. The [Main default selection shape result](../../model/tests/evidence/2026-09-24-main-default-selection-profile.json) checks valid exact focus and rejects a missing publication decision, wrong basis and missing type. The updated full HTTP flow now records guarded Main Version default selection and atomic public MatchUnit projection, a simultaneous selection race and replacement that removes only the old unit, a public selected read, a text index match, bounded complete phrase query, explicit budget rejection and typed selection relay outcomes. The retained mixed-cut drill now replays a successful Main Version selection and its stale/cancelled outcomes under hold, rejects missing immutable selection bytes, and verifies the selected public body and jena-text MatchUnit after the older stopped graph cut is restored. It returns the original admission outcomes after release. The [Space/Realm shape result](../../model/tests/evidence/2026-09-24-space-realm-profile.json) validates both explicit focuses and rejects missing ownership/type and a changed review policy. The updated full HTTP flow creates two distinct Realm capabilities under separate Space identities through Account, Access and Fuseki, checks denial, replay, conflict, public reads, strong cancellation and a typed private relay event. The mixed-cut drill replays retained Space creation and cancellation only with exact immutable manifests and current sealed Access evidence, then reads the same public identities after release. The recovery capture test intermittently detects owner movement during its disposable source capture; the guard now names the moved owner, and the 240-assertion full replay passed. Next executable step: wire the pinned shared proposition candidate into an Access-admitted, guarded definition command with immutable manifests, receipts, relay and mixed-cut replay; then implement opposite Realm decisions with qualified effective search filters, followed by rating contexts. The installed metadata Work label remains outside the selected-body MatchUnit lane; the bounded phrase queries cover only current public Main Version defaults and Realm-effective selections, not private search. Audit upgraded installations for pre-006 deletions without Access bindings and continue coordinated capture, downstream checkpoint and S1 restart qualification in parallel. Existing relay databases need a verified backfill of earlier batch headers before the new coverage scan can pass. No external credential blocks the local work.

The [Realm-local selection shape result](../../model/tests/evidence/2026-09-24-realm-local-selection-profile.json) checks a valid explicit focus and rejects missing slot, wrong review basis and missing type. The updated full HTTP result checks independent Realm A/B adoption, Main fallback, local effective reads, exact-body Realm phrase matches, Main isolation, denied and stale admissions, same-head race, selective MatchUnit replacement, strong cancellation, typed private relay, and whole-public-population budget rejection. The 225-assertion mixed-cut drill replays retained Realm adoption and terminal outcomes under hold, then verifies the exact selected public body after release. These are scoped WORK02/03, CTX01 and SEARCH01/03 evidence; classification, rating, private search and larger population strategies remain open.

The [Realm-local rejection shape result](../../model/tests/evidence/2026-09-24-realm-local-rejection-profile.json) validates explicit focus and rejects missing slot, wrong basis and missing type. The updated full HTTP flow tests denial, successful negative head, replay, stale guard, strong cancellation, typed private relay, selective text-unit removal, fallback suppression, Main and second-Realm isolation, and adoption after rejection. The 225-assertion mixed-cut drill replays a retained rejection and its stale/cancelled outcomes, keeps earlier adoption receipts verifiable after their public unit is removed, returns a body-free suppression read and zero Realm phrase hits after release, then adopts again in the new epoch. This is scoped Context and Work selection evidence, not classification or rating acceptance.

The [classification proposition candidate result](../../model/tests/evidence/2026-09-24-classification-proposition-profile.json)
records one conforming shared Scheme/Concept/Path/Expression/Sense graph and five
nonconforming candidates under pinned Jena SHACL 6.2.0/Java 21. Explicit
focuses catch a missing Path type; bound references reject an Expression
pointing to another Path; fixed scope rejects wrong or ambiguous Global Sense
interpretation; and duplicate English preferred labels fail. This is scoped
MODEL15/17 evidence only. The current `space-realm-v1` shape is immutable, so
classification context allocation uses a separate versioned profile and command. The
[classification context candidate result](../../model/tests/evidence/2026-09-24-classification-context-profile.json)
records one conforming fixed Global/Realm context graph and five rejected
type, reciprocal-link, policy, fallback and cycle cases. This is also scoped
MODEL15/17 candidate evidence only. The context profile now has native
graph admission and retained replay; the proposition profile remains candidate
only. There is no classification Application, decision or effective-query evidence.

The updated [full HTTP result](../../services/main/tests/evidence/2026-09-24-full-work.xml)
records 254 assertions with no failures. It provisions distinct classification
Contexts for two existing public Realms through Account, Access, Main and Fuseki;
checks denial, a concurrent create-only race with one winner, same-key replay,
public context reads, strong cancellation and typed private relay with an
immutable revision manifest. The updated [mixed-cut result](../../services/main/tests/evidence/2026-09-24-work-outcome-reconcile.xml)
records 240 assertions with no failures. It rejects replay without retained
context bytes, replays the successful Context and cancellation in source order
under graph hold with sealed Access evidence, reads the same Context after
release and returns the original key outcomes. This is scoped Context identity,
authority and recovery evidence; Global/Realm classification decisions and
effective search remain open.

The current S2 foundation follows [Main Version](../contracts/main-version.md),
[Space](../contracts/space.md), [classification](../contracts/classification.md),
[search](../contracts/search.md), the [vertical workflow](../implementation/vertical-workflows.md)
and [graph records](../implementation/graph-records.md). A text Contribution needs
its own identity, language, contributor control and immutable draft head; draft
creation/edit cannot silently publish or appear in the public search lane.
Publication needs an exact eligible selection and guarded receipt before a
public MatchUnit can be derived. The draft create, replay, denied read, exact
immutable read and absence of public text are locally exercised through real
Account/Access/Fuseki/object storage. The fixed Main Version default now selects an eligible exact draft and atomically projects one public MatchUnit. A bounded complete phrase query and public selected read are locally exercised. A fixed Space command creates a public Space and distinct Realm capability with pinned initial policies. Guarded local adoption gives two Realms independent exact selected bodies, public fallback reads and complete bounded phrase queries. Local rejection/suppression is verified in the fixed profile. Management grant provisioning, classification Applications and decisions, ratings and broader query filters remain pending. The mixed-cut recovery drill verified one restored public MatchUnit and jena-text lookup; crash-time index rebuilding remains unqualified. WORK02/03, CTX01 and SEARCH01/03 remain partial until classification/rating and broader query paths run together. The
mixed-cut drill covers draft creation/edit, contributor eligibility and their terminal outcome recovery.

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
| Space, Context, classification and Main Version | Selected first-stage foundation. | Fixed Space/Realm creation, Main default and Realm-local adoption/rejection, typed Realm classification context provisioning, two-Realm publication reads and bounded public phrase queries passed scoped engine/HTTP/recovery checks. Classification Applications and decisions, ratings and complete end-to-end gates remain pending. |
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
