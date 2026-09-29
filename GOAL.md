# REZICS Goal

Status: direction under research since 2026-09-29; not started. Implementation
waits until the research rounds settle the direction below. The previous,
frontend-centred Goal paused after its third milestone at `59a85a96`. Backend
phase 1 finished on 2026-09-27: recorded run `20260927t101230-1616d8`, local tag
`goal/backend-phase1`, with its history on the local orphan branch
`archive/goals`. The planning research behind the decisions below is in
`.temp/research/R1`–`R9` (local; scenarios, Zones, classification, identity,
modes, agents, editor, product audit, API completeness).

## Outcome

Make REZICS complete and ready for production.

**Complete** means as complete and good to use as GitHub, Reddit, Fandom and
Notion are in their areas, for people and for programs. The API is REZICS's
complete user experience; the UI simulates it for people. Every capability is
accepted twice: as an API flow (HTTP, SDK, MCP) and as a UI flow.

**Ready for production** means deploying to the prepared fleet and opening
registration is operations work. Deployment is the next phase; the
[production plan](docs/operations/deployment.md) records the fleet and what must
be [ready to deploy](docs/operations/deployment.md#ready-to-deploy). Registration
opens to everyone in the United States, Taiwan, Singapore, Japan, South Korea
and the European Union.

**First scenarios**, chosen for recurring use and what REZICS can uniquely offer
(native multilingual, versions and translations, community interpretation,
API- and agent-first):

1. **Series tracking across editions and languages**, led by light novels: what
   is available, owned, read and next, per edition and translation.
2. **A portable reading library**: shelves, reading history with DNF, pauses and
   rereads, faithful import and export.
3. **Serial fiction**: dependable writing, scheduling, calm reading, resuming
   and chapter discussion.
4. **Visual-novel discovery**: releases by language and platform, translator
   provenance, lists and updates.

Reviews, catalogue correction and communities serve all four. Every Zone is
visible: Fiction, Books, Light Novels, ACGN, Games, Mods, Software, AI Workshop
and Kitchen.

## Decisions

Made on 2026-09-29 in the planning session, where the maintainer delegated
product judgment ("you are the product manager; I want your opinion"). Marked
"(maintainer)" where the maintainer decided. The maintainer may revise any of
them; each moves into code, contracts or the
[frontend direction](docs/plan/frontend.md) as it is implemented.

1. **Content ratings, everywhere.** Four levels as on the old site: `general`,
   `r15`, `r18` (sexual) and `r18g` (grotesque; a separate opt-in, not a
   stronger `r18`), for Works of every domain, releases, posts, replies, images
   (rated apart from their Work) and Realms (a default level or an adult Realm).
   A rating is a platform-level compliance fact: a Realm may rate stricter,
   never looser. Submitters choose one, moderators correct it, imports map
   source signals (VNDB age 18 to `r18`; VNDB images with sexual level 2 are not
   stored, violence level 2 is `r18g`; Bangumi nsfw to `r18`; no signal to
   `general`). Signed-out viewers and those under 15 see `general`; from 15,
   `r15`; from 18, people opt in to `r18` and separately to `r18g`. A request
   may narrow but never widen the viewer's set. Only `general` and `r15` are
   indexed; `r18` and `r18g` never reach search engines, share previews, email
   or push. Content warnings are Concepts. Classification never overrides a
   rating.
2. **Compliance lines.** No sexually explicit images anywhere; no advertising
   trackers (necessary cookies and cookieless analytics, hence no consent
   banner); minimum age 13, 14 in South Korea and 16 in the EEA, from birth year
   and month asked at sign-up; `r18` and `r18g` unavailable in South Korea and
   the United Kingdom (not a target market); mainland China out of scope; region
   is the request's country. Required: a DMCA designated agent and notice page;
   DSA notice-and-action with statements of reasons; an EU representative for
   GDPR and the DSA; a privacy policy naming cross-border transfers; Taiwan's
   youth-protection gating through ratings. Workers draft legal texts; counsel
   the maintainer engages reviews them.
3. **Visible is not permitted** (maintainer). Every Zone is visible; creation
   APIs are gated by role. Everyone browses, rates, shelves, reviews, discusses
   and reports data errors; authors create their own original Works; editors,
   granted by administrators, create and edit catalogue entries with history;
   administrators create Zones, official Realms, Software and Mod entries and
   run imports. Community Realms stay open behind Turnstile and new-account
   limits. Screens show actions by permission and never hide a Zone.
4. **Sign-up and languages.** Accounts asks for credentials, birth year and
   month; the UI locale is the page's language, switchable at the page foot and
   stored on the Account. The first entry to the main site confirms the public
   identity (the private Account name never becomes public by itself) and the
   reading languages: prefilled from the UI locale and the browser's languages
   in order, script-aware, reorderable, any BCP 47 language found by its own
   name, skippable. Account owns the UI locale and interaction preferences; Main
   owns reading languages; changing the locale anywhere writes to Account.
5. **Launch shape.** No closed beta: after deployment, registration opens
   quietly for one to two weeks, then REZICS is announced.
6. **Outside this Goal:** direct messages, commerce and Pro, package
   installation and execution, institutional voting, Zone custom CSS,
   500-million-entity qualification, Redis and large-scale import runs.
7. **Imports go through the API; functional tests only** (maintainer). Only
   sources with downloadable dumps (VNDB, Open Library, Wikidata, Bangumi,
   MusicBrainz core, the old site's data); no central import from API-only,
   rate-limited upstreams. Every write goes through Main's commands; nothing
   loads databases directly; a slow command path is a defect to fix. Rate limits
   belong to each class of principal (anonymous, account, editor, importer,
   application) with `Retry-After` backpressure. This Goal proves the pipeline
   with functional tests, not a full run.
8. **Two acceptance flows and a capability registry.** Each capability declares
   its API operation, scopes, pagination, idempotency, typed outcomes, SDK call,
   MCP tool (task-oriented toolsets, never one tool per endpoint) and UI journey
   in an executable registry built into the API generator; a check fails when
   one is missing without a recorded reason. A journey the UI can finish but the
   API cannot (or the reverse) is a gap. Client-side orchestration of a
   business task (matching, sorting, multi-command publishing) moves into Main.
9. **Class-level problems become checks.** The `product-audit` skill runs at
   every milestone. Each class found is fixed everywhere, then guarded by a
   lint rule, schema, generator or test in `task check`.
10. **Identity: Account signs in, Agents grant** (maintainer's YouTube model).
    Account authenticates the operator; the operator represents an Agent
    (Person or Organization); that Agent grants authority over resources; app
    and AI credentials only narrow it. First-party REZICS shows no consent and
    appears in Accounts as a product session with "Sign out", not as granted
    access. Accounts owns credentials, recovery, sessions, private information,
    UI locale, interaction preferences and third-party access to Account data.
    Main owns public identities, Organization creation, each Agent's
    permissions page (invite, accept, change, revoke; "manage as yourself" is
    distinct from "act publicly as this identity"), Realm roles, resource-scoped
    app installations and AI assignments. Identity discovery does not depend on
    one task's eligibility. One scoped authorization object serves apps and AI
    (grantor Agent, recipient, acting identities, resources, actions, expiry;
    RFC 9396 authorization details).
11. **Simple, Advanced and a reserved Agent mode.** A mode is a presentation
    preference owned by the viewing Account, never authority: feature override,
    then global default, then Simple. The API never takes a mode. Switching
    preserves all state; an unrepresentable configuration gets a summary and a
    capable editor. Advanced raises density as GitHub does: tables, keyboard,
    bulk actions, exact values, provenance. First features: filters,
    classification, moderation, Realm settings and Studio. Settings get a
    searchable information architecture on both sites.
12. **Types restricted, vocabulary open, governance explicit.** Structural types
    (those that select forms, commands, authority or storage) come only from a
    versioned registry; descriptive types and properties may be added under a
    namespace and a steward without changing behavior; imported classes stay
    source-qualified assertions. Anyone may propose a Concept, property or type;
    defining, applying, accepting and activating are separate permissions
    (member, catalogue editor, Realm vocabulary administrator, platform schema
    publisher; programs and AI get the same limits). Alias, implication, merge,
    split and deprecation are distinct reviewed operations that keep old IDs and
    authored wording. Genres stay Concepts; classification never overrides
    ratings.
13. **Light Novels and ACGN Zones over one catalogue.** `/r/light-novels`
    organises series, volumes, editions, translations and releases;
    `/r/acgn` organises seasons, episodes, adaptations, characters and people.
    One entity model serves every Zone: series membership, independently
    identified volumes, editions and release coverage (omnibus, partial,
    region, platform); anime series, seasons and episodes; characters and
    credits binding person, role, Work or release, character and language;
    spoiler scope tied to a consumption position. Tracking knows its unit
    (episode, chapter, volume), statuses planned, active, paused, dropped and
    completed, rereads, and ownership apart from progress. Zones never
    duplicate entities.
14. **A Notion-level editor on BlockNote.** BlockNote's MPL-2.0 core and React
    packages (never its GPL XL packages) behind a REZICS adapter; Tiptap is the
    fallback. REZICS owns the document contract `content-blocks-v1` with stable
    block IDs, stored as immutable Content revisions; the API reads and writes by
    block with expected heads; a pure static renderer serves reading and SSR;
    paragraph comments anchor to block IDs with quote selectors and survive
    edits. One editor serves Studio, posts, wiki pages, reviews and comments.
    Adoption gates: real CJK IMEs on desktop and phones, a vinext Workers build,
    lossless round trips.
15. **A wiki at Fandom's level.** Pages, links and backlinks, watchlists,
    attributed diff and restore, discussion beside pages and protection, built
    on the shared editor and Content revisions.
16. **Agents, phase 1.** A public Agent, an AI configuration, an assignment of
    authority to it and each run stay distinct. Durable event reads with
    resumable SSE for feeds, notifications and tasks; tasks with runs,
    checkpoints, approvals and owner-confirmed receipts; an inbound `/mcp` on the
    official SDK with task-oriented toolsets; one agent workspace (contextual
    start, progress, artifacts, diff, adoption). Personal and Realm assistants
    are chosen and replaced by their owners. Deferred: signed webhooks,
    scheduled automations, autonomous governance, arbitrary execution.
17. **A developer platform.** A generated portal and explorer from the
    capability registry, an external TypeScript SDK, personal access tokens and
    delegated credentials with scopes, expiry, last use and revocation,
    problem details (RFC 9457) across Main and Account, and a durable change
    feed.
18. **Libraries first.** Use mature libraries; where one falls short, vendor its
    code with its license, upstream commit and a patch record.

## Milestones

The manager revises them. A milestone counts only when it is merged, its checks
pass, its flows work through the API and in a real browser against the local
stack, and the `product-audit` skill finds no open P0 or P1 class in its area.

- **M4 Trust, integrity and native multilingual.** No silent data loss (quick
  status edits keep reading dates; draft covers stay private; empty drafts
  save); reports, blocks and appeals with a platform queue; ratings with age and
  region rules; principal-class rate limits; sign-up with public-identity
  confirmation; the first-party boundary; every item of the multilingual queue
  (a failing catalog gate, no default `@en`, per-language search analysis,
  unified preferences, native seed, language pickers, `lang`/`dir` by script);
  a check against editing persisted profiles in place.
- **M5 Complete core journeys and Zones.** The four first scenarios end to end;
  complete traversal where sampled windows stand today (Zone browse, Studio
  inventory, resume, long threads); independent posts and submission status;
  exact notification destinations; scheduling and the web-novel reading loop;
  corrections and edition choice; the library model and API-side import and
  export; Light Novels and ACGN with their entity profiles; Games and Software
  presentation; Realm moderation; the import pipeline with functional tests.
- **M6 Platform depth.** The identity model (public identity, Organizations and
  delegation, the scoped authorization object); modes and settings; the type
  registry and classification apply, contest and governance flows; the block
  editor with paragraph comments; the wiki; the developer platform; agents
  phase 1.
- **M7 Ready to deploy.** Turnstile and new-account limits; legal pages with
  versioned consent; DMCA and DSA flows; email with unsubscribe, suppression
  and bounces; sitemap and robots; cookieless analytics with activation and
  retention events; complete takeout; everything the production plan lists as
  ready to deploy; a final security review of the public surface.

## Completion

The Goal ends when the maintainer stops it, or when M7 passes this check and the
maintainer agrees:

- The four first scenarios, sign-up, moderation, identity delegation, the
  editor, the wiki and an agent task each pass as an API or MCP journey and as a
  browser journey, including their adverse states.
- Rating and regional rules hold for signed-out, under-15, 15–17 and adult
  viewers and for South Korea and the United Kingdom, across feed, search, Work
  pages, share previews, email and push.
- All eight UI locales are complete and the catalog gate fails on any gap; any
  BCP 47 content language works; no content is stamped with a language it is
  not in.
- The capability registry has no undeclared gap; the `product-audit` skill finds
  no open P0 or P1 class.
- Launch-scale load meets its budgets, and the restore drill is timed.
- The security review leaves no open High finding.

## Constraints

The manager's authority and the maintainer's standing directions are in the
[manager charter](docs/goals/manager.md). Other documentation records practice
to consult, not rules. The manager runs workers through the
[Goal program](docs/goals/README.md), and workers follow the
[worker protocol](docs/goals/worker.md).
