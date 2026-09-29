# REZICS Goal

Status: direction settled by two research rounds on 2026-09-29, awaiting the
maintainer's confirmation; not started. The previous, frontend-centred Goal
paused after its third milestone at `59a85a96`; its stopped tasks G-432, G-433
and G-435 and the drafted briefs in `.temp/research/briefs-draft/` are re-briefed
against this plan before any dispatch. Backend phase 1 finished on 2026-09-27:
recorded run `20260927t101230-1616d8`, local tag `goal/backend-phase1`, with its
history on the local orphan branch `archive/goals`. The research behind every
decision is in `.temp/research/` (local): R1–R9 (round one), R10–R20 and G1
(round two) and R21 (red-team synthesis).

## Outcome

Make REZICS complete and ready for production.

**Complete** means each job REZICS supports can be discovered, completed,
confirmed, revisited, recovered and exported through authorized APIs and an
accessible browser experience, on phones as on desktops, at the quality GitHub,
Reddit, Fandom and Notion set for the same kind of job. Their combined feature
inventories are benchmarks, not the scope. The API is REZICS's complete user
experience; the UI simulates it for people; every capability is accepted
through both.

**First scenarios**, chosen for recurring use and what REZICS can uniquely offer
(native multilingual, versions and translations, community interpretation,
API- and agent-first):

1. **Multilingual series tracking**, led by light novels: what is available,
   owned, read and next, per edition, translation and language.
2. **A portable reading library**: reading sessions across editions and formats,
   DNF, pauses, rereads, ownership and loans, faithful import and export.
3. **Serial fiction**: dependable drafting, scheduling, calm reading, resuming
   and chapter discussion.
4. **Visual-novel discovery by usable release**: language, platform and
   translator provenance.

Reviews, catalogue correction, communities, structured organisation (saved
views) and a maintainable Realm wiki serve all four. The Light Novels and ACGN
Zones present them over one catalogue. Every Zone stays visible and truthful
about what it supports.

**Ready for production** means deploying to the prepared fleet is operations
work. Deployment is the next phase; the
[production plan](docs/operations/deployment.md) records the fleet and what must
be [ready to deploy](docs/operations/deployment.md#ready-to-deploy). Registration
is intended for the United States, Taiwan, Singapore, Japan, South Korea and the
European Union, subject to the market, legal, safety, staffing and operational
gates below.

## Decisions

Made on 2026-09-29, where the maintainer delegated product judgment ("you are
the product manager; I want your opinion"); "(maintainer)" marks the
maintainer's own. The maintainer may revise any of them; each moves into code,
contracts or the [frontend direction](docs/plan/frontend.md) as it is built.

### Trust

1. **Suitability and disclosure.** `general`, `r15`, `r18` (sexual) and `r18g`
   (grotesque) stay the recognisable labels, backed by independent gates:
   content that is both sexual and grotesque needs both opt-ins. A missing
   assessment is `unassessed`, never `general`; imports map source signals
   (VNDB age 18 to `r18`, VNDB image sexual level 2 not stored, violence level 2
   to `r18g`, Bangumi nsfw to `r18`). Signed-out viewers and those under 15 get
   general-eligible representations only; from 15, `r15`; from 18, separate
   opt-ins for `r18` and `r18g`. External indexing and share previews use the
   anonymous representation; internal search follows the viewer's eligibility.
   Adult material never enters email or push. Rules apply to originals, media,
   derivatives, history, caches and exports. Realms may strengthen, never
   weaken; classification never overrides suitability.
2. **Safety and legal readiness.** No sexually explicit images; no advertising
   trackers; minimum age 13, 14 in South Korea, 16 in the EEA; `r18`/`r18g`
   unavailable in South Korea and the United Kingdom (not a target market);
   mainland China out of scope. Birth month and request country are policy
   inputs, not proof of compliance: counsel approves a versioned market and
   feature matrix, representatives (EU GDPR/DSA), transfers and the analytics
   configuration. Build staffed public reporting (also for people without an
   account), platform and Realm enforcement, statements of reasons, accessible
   appeals, DMCA notices, counter-notices and repeat-infringer handling,
   TAKE IT DOWN non-consensual intimate imagery removal within 48 hours with
   identical-copy handling, child-safety response with known-CSAM hash matching
   at upload, and a safety inbox independent of optional notifications.
   REZICS Inc, a US company, operates the site (maintainer).
3. **AI disclosure and consent.** Prose, artwork and translations carry a
   structured, revision-aware declaration of AI use (none, assisted,
   generated) with human-review status; readers filter by it; it is separate
   from rights. REZICS never trains on private drafts or reading records by
   default, never fabricates reviews, votes or community participation,
   discloses automated actors, and never treats an AI detector as a verdict.
4. **Visible is not permitted** (maintainer). Every Zone is visible; creation
   is gated by role and trust. Everyone browses, rates, shelves, reviews,
   discusses and reports; authors create their own Works; editors, granted by
   administrators, edit the catalogue with history; administrators create
   Zones, official Realms, Software and Mod entries and run imports.
   Permission-backed translations have explicit publication eligibility. A
   private unmatched library record never creates a public catalogue entry.
5. **Launch shape.** No closed beta. Registration opens quietly once the launch
   gates pass and is announced after one to two weeks of healthy operation.
   Operators can pause registration, uploads or public posting while keeping
   reporting and recovery working.

### Foundations

These are the shared fixes for the classes of problem the audit found across
many surfaces. Each is built once, used everywhere, and guarded in code
(`product-audit` skill, `task check`).

6. **Explicit identities, targets and units.** Versioned profiles state what an
   object is and what an action targets: series, independently identified
   volumes, editions, releases and coverage (omnibus, partial, region,
   platform); anime series, seasons and episodes; characters and contextual
   credits; reading sessions, copies and loans; review targets (story,
   translation, narration, production); Collection entries versus Works.
   Identity is never inferred from matching titles; unknown correspondence
   stays unknown.
7. **One native-language contract.** One BCP 47 parser and localized-value,
   selection and retrieval contract everywhere; unknown language is kept, never
   replaced by English; UI locale never becomes content language; direction
   comes from script; ruby, emphasis and vertical presentation for Japanese.
   Account owns the UI locale; Main owns reading languages. All eight UI
   catalogs complete, and the catalog gate fails on any gap.
8. **One authority model** (maintainer's YouTube model). Account signs the
   operator in; the operator represents an Agent (Person or Organization); that
   Agent grants authority over resources; app and AI credentials only narrow
   it. First-party REZICS shows no consent and appears in Accounts as a product
   session. Main owns public identities, each Agent's permissions page (invite,
   accept, change, revoke; "manage as yourself" distinct from "act publicly as
   this identity"), Realm roles, resource-scoped installations and AI
   assignments, through one scoped authorization object. Identity discovery is
   independent of task eligibility. Public identity is confirmed before private
   Account data becomes public; private reading history is never shared through
   delegation. Ownership transfer, last-controller protection, recovery and
   revocation cover queued and running work. Handles rename with redirects,
   reuse limits and confusable-name protection; creators can claim imported
   identities.
9. **One disclosure and enforcement policy** evaluated by the server for every
   read and delivery: suitability, blocks (interaction, not mute), privacy,
   spoilers by consumption position, Realm and platform jurisdiction, and
   revocation, over originals and every derivative (search, counts, previews,
   notifications, exports, offline copies, AI context).
10. **Durable custody.** Immutable owner-controlled revisions, stable block
    locators, dependency manifests for historical rendering, recoverable local
    pending writes, explicit conversion losses, empty drafts saved, private
    draft media, restore as a new revision, lossless export and re-import.
11. **Main owns business tasks.** Import matching, publication, scheduling,
    bulk moderation, onboarding, save-and-pin, discovery composition and
    search recovery become resumable Main operations with exact inputs,
    expected heads, idempotency, receipts and explicit pending, partial or
    uncertain outcomes. Clients present and poll.
12. **Complete traversal.** Previews, ranked retrieval and exhaustive
    inventories are distinct; every inventory traverses with continuation and
    states its population, count precision and freshness. No request bound is a
    product limit.
13. **Meaning survives every adapter.** Omitted, null and empty differ; simple
    edits keep richer state; filters, dates, languages, spoilers and advanced
    settings round-trip through every client and mode.
14. **An executable capability registry.** Each supported capability declares
    authority, inputs, outcomes, pagination, retries, recovery, SDK and MCP
    mapping and its human journey (discover, act, confirm, return, recover,
    leave); internal and deferred capabilities are marked with a reason. It
    generates the developer portal and fails the check on an undeclared gap.
15. **Types restricted, vocabulary open.** Structural types come from a
    versioned registry; descriptive types and properties are added under a
    namespace and steward without behavior; anyone proposes; defining,
    applying, accepting and activating are separate permissions. Everyday
    application, contest, translation and alias review ship first; merge and
    split keep IDs for a later workbench.

### Experience

16. **Simple, Advanced and a reserved Agent mode**, as presentation preferences
    owned by the viewing Account (feature override, then global default, then
    Simple), never authority; the API never takes a mode. Advanced raises
    density as GitHub does. Settings are searchable on both sites.
17. **Classification journeys**: shared multilingual selection; apply and
    vote (fit separate from spoiler); position-scoped spoiler reveal; suggest a
    term or translation; review; Concept pages; include/exclude filters saved
    as Home tabs; onboarding interests without a cap.
18. **Search** as one multilingual retrieval capability on Jena and Lucene:
    per-language analysis, aliases and readings, Simplified/Traditional
    folding, cross-entity results (Works, people, Realms, posts, Concepts),
    typo recovery in Main, and discovery with real reasons and controls. A
    dedicated engine only on a measured advantage.
19. **Collaboration at GitHub's level**: one review lifecycle for proposals
    (catalogue corrections, wiki edits, translations) bound to exact
    candidates; stewardship and required reviewers; requests distinct from
    discussions; subscriptions and an inbox with Read, Saved and Done.
20. **Community at Reddit's level**: independent posts with any content
    language; follow distinct from join; newcomer trust levels and budgets;
    case lifecycle with case correspondence; rules per language; founder
    activation; reviewed communities that can receive contributions.
21. **Creators**: manuscript safety, Main-owned scheduling with time zones,
    rights and translation declarations, scoped collaborators (read, suggest,
    edit, publish), a feedback inbox and a complete author backup.
22. **Documents on BlockNote.** BlockNote's MPL-2.0 core and React packages
    (never GPL XL) behind a REZICS-owned immutable block contract with stable
    IDs; Tiptap as fallback; a pure static renderer; paragraph comments anchored
    to blocks. Gates: licence, a vinext Workers build, real CJK IMEs on phones,
    lossless migration. One editor for Studio, posts, wiki, reviews and notes.
23. **Knowledge**: Realm wikis with multilingual addresses, citations, graph
    infoboxes, links and backlinks, discussion, review, watch, history, diff,
    restore and export; saved views (list, table, gallery) over Collections and
    filters; reading notes.
24. **Agents, bounded.** Agent, AI configuration, assignment and run stay
    distinct; tasks with runs, checkpoints, approvals and receipts; durable
    event reads with resumable SSE; an inbound task-oriented `/mcp`. The first
    experience is library migration and edition reconciliation with evidence.
    Owners choose and replace assistants; private data leaves only with
    explicit authority. Taste memory and a spoiler-safe reading companion come
    after, on the same contracts.
25. **Developers and phones.** A registry-generated portal, an external
    TypeScript SDK, scoped personal and delegated credentials, RFC 9457 errors
    and durable event replay. Responsive web, optional installation as a PWA,
    web push, durable cross-device progress and rights-aware offline downloads;
    correctness never depends on background execution.
26. **Imports go through the API; functional tests only** (maintainer). Only
    sources with downloadable dumps (VNDB, Open Library, Wikidata, Bangumi,
    MusicBrainz core, the old site's data); every write through Main's
    commands; rate limits per principal class with backpressure. A bounded,
    rights-cleared launch catalogue seeded through commands, with named
    stewards, is a separate deliverable. Availability is dated observation.
27. **Libraries first**; vendor with licence, upstream commit and patch record.

### Deferred

Direct messages, commerce and Pro, package installation and execution,
institutional voting, Zone custom CSS, 500-million-entity qualification, Redis,
large-scale import runs, native apps, general offline collaboration,
unrestricted formulas and templates, specialist collector and study tools, full
wiki-host migration, reputation gamification, webhooks, character polls and
tournaments, and acquisition campaigns for music, recipes, software, mods and AI
resources (their Zones stay visible and truthful).

## Milestones

The manager revises them. A milestone counts only when merged, its checks pass,
its journeys pass through the API and in a real browser against the local stack,
and the `product-audit` skill finds no open P0 or P1 class in its area.

- **M4 Meaning, authority and preservation.** Foundations 6–8 and 13, the
  suitability model, document identity and operation contracts; repair date
  loss, empty saves, public draft covers and private-name publication; the
  catalog gate and the persisted-profile check. Exit: counterexample fixtures
  pass; simple edits keep richer state; denied and revoked operations fail
  correctly; the language and profile guards fail on deliberate regressions.
- **M5 Shared capabilities and safety.** Foundations 9–12 and 14: indexed
  traversal, shared query execution, resumable operations, document recovery,
  scoped grants, reporting, enforcement and appeals, upload clearance,
  principal budgets, the registry and its adapters. Exit: inventories traverse
  past every former bound; a retried operation has one effect; policy holds on
  every channel; pending contributions and legal cases reach real outcomes.
- **M6 The four scenarios, Light Novels and ACGN.** Library import, sessions and
  export; series, edition and availability tracking; serial drafting,
  scheduling, reading and discussion; VN discovery by release; the two Zones
  over them, with ACGN episode tracking on the same progress foundation. Exit:
  paired API and browser journeys pass with ambiguous editions, expired loans,
  mixed formats, non-UI languages, thousand-chapter inventories, revoked
  editors, interrupted exports and two-device progress.
- **M7 Contribution, knowledge and assistance.** Classification and
  corrections, the review lifecycle, subscriptions and inbox, community
  completeness, settings and modes, saved views, the editor and Realm wikis,
  developer onboarding, the agent platform and the library-migration
  assistant. Exit: propose, review, revise, decide, notify and recover work
  end to end; changed candidates invalidate approval; historical wiki rendering
  and export survive dependency changes; replacing an assistant keeps its
  authorized artifacts.
- **M8 Production qualification.** Deployment artifacts, production bootstrap
  and the launch catalogue, timed recovery, security review, email operations,
  legal configuration, staffed safety drills, privacy-preserving measurement,
  and real-device and accessibility acceptance. Exit: no open P0 or P1 class or
  High security finding; launch workloads meet budgets; recovery and takeout
  demonstrated; every supported capability has acceptance evidence; market
  gates and named responders ready.

Counsel, staffing, catalogue supply and device testing start alongside M4.
After M4's contracts settle, language and search, authority and safety, and
documents and operations run in parallel; in M6 the scenarios run in parallel
against the shared contracts.

## Completion

The Goal ends when the maintainer stops it, or when M8 passes its exit and the
maintainer agrees.

## Constraints

The manager's authority and the maintainer's standing directions are in the
[manager charter](docs/goals/manager.md). Other documentation records practice
to consult, not rules. The manager runs workers through the
[Goal program](docs/goals/README.md), and workers follow the
[worker protocol](docs/goals/worker.md).
