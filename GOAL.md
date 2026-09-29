# REZICS Goal

Status: prepared on 2026-09-29; not started. The maintainer starts it as the
[manager charter](docs/goals/manager.md#starting-the-manager) describes. The
previous, frontend-centred Goal paused after its third milestone on 2026-09-29
at `59a85a96`; its paused tasks G-433 and G-435 and the unsent brief G-432
carry over. Backend phase 1 finished on 2026-09-27: recorded run
`20260927t101230-1616d8`, local tag `goal/backend-phase1`, with its history on
the local orphan branch `archive/goals`.

## Outcome

Make REZICS ready for production: when this Goal ends, deploying it to the
prepared fleet and opening registration is operations work, not more product or
engineering. Deployment itself is the next phase; the
[production plan](docs/operations/deployment.md) records the fleet and what must
be [ready to deploy](docs/operations/deployment.md#ready-to-deploy).

Production means open registration for everyone in the United States, Taiwan,
Singapore, Japan, South Korea and the European Union, with every Zone visible
and filled by large-scale imported catalogues:

- **Every Zone holds real data.** Bulk imports from source dumps fill novels and
  books, visual novels and media: VNDB, Open Library, Wikidata, Bangumi and
  MusicBrainz core data, under the maintainer's broad-intake policy (keep
  provenance, act on concrete complaints; see
  [source data rights](docs/research/source-data-rights.md)). Commercial
  web-novel sites are not scraped; their metadata comes from Wikidata, Bangumi,
  authors and editors. The launch corpus is sized to what the production hosts
  qualify and grows in batches.
- **Open registration is safe.** Content ratings, moderation at Realm and
  platform level, abuse limits and compliance hold for strangers at scale.
- **The core loops are complete.** Readers, writers, communities and catalogue
  editors can do their everyday work without dead ends or lost input.
- **It is operable once deployed** as the production plan lists.

## Decisions

Made on 2026-09-29 in the planning session, where the maintainer delegated
product judgment ("you are the product manager; I want your opinion"). The
maintainer may revise any of them; each moves into code, contracts or the
[frontend direction](docs/plan/frontend.md) as it is implemented.

1. **Content ratings, everywhere.** Four levels as on the old site: `general`,
   `r15`, `r18` (sexual) and `r18g` (grotesque; a separate opt-in, not a
   stronger `r18`). They apply to every rateable object: Works of every domain,
   releases, posts, replies, images (rated apart from their Work) and Realms (a
   default level or an adult Realm). A rating is a platform-level compliance
   fact: a Realm may rate stricter, never looser. Submitters must choose one,
   moderators correct it, and imports map source signals (VNDB age 18 to `r18`;
   VNDB images with sexual level 2 are not stored and violence level 2 is
   `r18g`; Bangumi nsfw to `r18`; no signal to `general`). Signed-out viewers and
   those under 15 see `general`; from 15, `r15`; from 18, people opt in to `r18`
   and separately to `r18g`. A request may narrow but never widen the viewer's
   set. Only `general` and `r15` are indexed; `r18` and `r18g` never reach
   search engines, share previews, email or push. Content warnings are Concepts.
2. **Compliance lines.** Adult text is lightly regulated in these markets; adult
   imagery is not. So: no sexually explicit images anywhere (`r18` is text, and
   images are rated on their own at `r15` or below); no advertising trackers
   (necessary cookies and cookieless analytics, hence no consent banner);
   minimum age 13, 14 in South Korea and 16 in the EEA, from birth year and month
   asked at sign-up; `r18` and `r18g` unavailable in South Korea (its adult
   content needs identity-verified age) and the United Kingdom (not a target
   market; the Online Safety Act is heavy); mainland China is out of scope.
   Region is the request's country. Required: a DMCA designated agent and notice
   page; DSA notice-and-action with statements of reasons; an EU representative
   for GDPR and the DSA; a privacy policy that names cross-border transfers
   (APPI, PIPA); Taiwan's youth-protection gating through ratings. Workers draft
   the legal texts; counsel the maintainer engages reviews them.
3. **Visible is not permitted** (maintainer). Every Zone is visible, and
   creation APIs are gated by role: everyone browses, rates, shelves, reviews,
   discusses and reports data errors; authors create their own original Works;
   editors, granted by administrators, create and edit catalogue entries with
   history; the administrator group creates Zones, official Realms, Software and
   Mod entries and runs imports. Community Realms stay open to members behind
   Turnstile and new-account limits. Screens show actions by permission and
   never hide a Zone because a person cannot create in it.
4. **Languages at sign-up.** The UI locale is the page's language, switchable
   at the page foot as on Google Account, and stored on the Account. Reading
   languages are the first onboarding step: prefilled from the UI locale and the
   browser's languages in order (script-aware, so `zh-TW` is Traditional
   Chinese), reorderable, any BCP 47 language found by its own name, skippable.
   One store each: Account owns the UI locale, Main the reading languages;
   changing the locale anywhere writes to Account, and a signed-out choice joins
   the account at sign-up.
5. **Launch shape.** No closed beta: after deployment, registration opens
   quietly for one to two weeks, then REZICS is announced.
6. **Outside production readiness:** direct messages, commerce and Pro, package
   installation and execution, institutional voting, the translator editor
   (translation T3), Zone custom CSS, 500-million-entity qualification and Redis.
7. **Imports go through the API** (maintainer). Bulk data is read from source
   dumps where providers ask for that (Open Library, VNDB), but every write goes
   through Main's commands with their validation, authority, receipts, history
   and outbox; nothing loads the databases directly. If concurrent API writes
   cannot reach the import target, that is a defect in the command path to find
   and fix, not a reason for a second write path. Rate limits belong to each
   class of principal: ordinary accounts, editors and an importer principal get
   separate limits, and a saturated writer answers with backpressure
   (`Retry-After`) rather than failure. Provider gates, such as Open Library's
   one request per second, stay on the reading side only.

## Milestones

The manager revises them. A milestone counts only when it is merged, its checks
pass and its flows work in a real browser against the local stack with imported
data at launch scale.

- **M4 Persisted foundations.** What shapes stored data comes first, because it
  is costliest to change once people write to it: ratings (model, submission,
  filters, age and regional rules); no default `@en` in the model, API and Jena
  layers, and missing UI keys failing the check; the role-gated creation
  matrix; sign-up age and unified language preferences; a check that fails when
  a persisted profile is edited in place; the bulk import pipeline (dump
  reading, mapping, cross-source identity, batched import commands through
  Main's API under an importer principal, incremental refresh, an operator
  console to run, watch, resume and roll back), proven on the full VNDB dump
  with a measured throughput target; profile and fix the command path where
  it falls short.
- **M5 Real data holds up.** The other imports; Zone and Work presentation for
  games and software (G-433), visual novels and media; multilingual search
  (per-language analysis, Simplified and Traditional folding, aliases and
  romanization); moderation (G-435) plus a platform queue and takedown for
  posts without a Realm; server-side drafts, the writer's private cover,
  scheduled publishing and the web-novel reading loop (G-432); every open
  finding from the milestone reviews; load at launch scale within budgets.
- **M6 Ready to deploy.** Per-principal-class rate limits and backpressure in
  Main and Account (Main has none beyond reader-import budgets); Turnstile and
  new-account limits; legal pages with
  versioned consent; DMCA and DSA flows; email with unsubscribe, suppression and
  bounces; sitemap and robots; cookieless analytics with activation and
  retention events; everything the production plan lists as ready to deploy;
  a final security review of the public surface.

## Completion

The Goal ends when the maintainer stops it, or when M6 passes this check and the
maintainer agrees:

- Browser tests pass for sign-up with age and languages, onboarding, reading,
  shelving and reviewing; a writer drafting on two devices, scheduling and
  readers being notified; a report reaching a moderator or operator and the
  author receiving the reason; data export and account deletion; an import run
  followed by browsing and searching in several scripts.
- Rating and regional rules hold for signed-out, under-15, 15–17 and adult
  viewers and for South Korea and the United Kingdom, across feed, search, Work
  pages, share previews, email and push.
- All eight UI locales are complete, and no content is stamped with a language
  it is not in.
- Launch-scale load meets its budgets, and the restore drill is timed.
- The security review leaves no open High finding.

## Constraints

The manager's authority and the maintainer's standing directions are in the
[manager charter](docs/goals/manager.md). Other documentation records practice
to consult, not rules. The manager runs workers through the
[Goal program](docs/goals/README.md), and workers follow the
[worker protocol](docs/goals/worker.md).
