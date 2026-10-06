---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
# Migrations are not listed: each task reserves its own numbers. Route files are
# claimed by the task that owns their behaviour. The manager widens areas as briefs land.
areas:
  - apps/web/**
  - packages/ui/**
  - packages/zone-sdk/**
  - packages/wiki-toolkit/**
  - services/main/src/modules/library/**
  - services/main/src/modules/library-import/**
  - services/main/src/modules/library-export/**
  - services/main/src/modules/progress/**
  - services/main/src/modules/progress-summary/**
  - services/main/src/modules/reading-position/**
  - services/main/src/modules/realm/**
  - services/main/src/modules/realm-admin/**
  - services/main/src/modules/realm-profile/**
  - services/main/src/modules/realm-reads/**
  - services/main/src/modules/realm-reply/**
  - services/main/src/modules/realm-submission/**
  - services/main/src/modules/space/**
  - services/main/src/modules/zone/**
  - services/main/src/modules/zone-browse/**
  - services/main/src/modules/zone-modules/**
  - services/main/src/modules/presentation/**
  - services/main/src/modules/theme/**
  - services/main/src/modules/saved-filter/**
  - services/main/src/modules/follows/**
  - services/main/src/modules/notification/**
  - services/main/src/modules/notification-producers/**
  - scripts/dev/seed/**
  - scripts/ops/bootstrap/**
---

# Launch

Status: designed on 2026-10-07; [state.md](state.md) records where the work
stands. The [program](../program/GOAL.md) holds main-wide regression, the
contracts board and shared resources.

## Outcome

The first public scope works end to end through authorized APIs and an
accessible browser experience, on phones and desktops, in the eight UI locales,
at the quality the comparable products set for the same job (standing
direction 1).

**First public scope** (maintainer, 2026-10-07): the book library (書庫), recipes,
a VNDB-like visual-novel catalogue and a Bangumi-like catalogue of anime, manga
and games with collection tracking, plus most Realm and Zone capabilities. Each is
configuration on the shared engine, not a domain backend. It supersedes the
2026-09-30 cut lines in `docs/product/capabilities.md` (light and visual novels
only); fold the change into that document as the work lands.

- **Realm is the community.** Membership, teams, moderators, rules, boards
  (multi-valued tags plus an optional primary board), local placement, moderation
  and appeal. A new Realm only means a new community positioning. `/r/{space}`
  is the community entry; site features live in Zones.
- **Zone is the site.** Routes, pages as Content documents, navigation, theme
  and site publication, with or without a Realm. A page's discussion is the
  attached Realm's thread `about=<resource>`, created on the first post; no
  discussion tag and no forum inside a Zone. `defaultRealm` loses its many roles.
- **Presentation layer.** Semantic components (ResourceSummary, EntityCollection,
  QualifiedFacts and the like) render server-chosen read shapes; json-render is
  one replaceable renderer and never the stored format; a page shares one budget
  with batched hydration; ordinary reading calls no model; third-party blocks
  stay closed (record §8; `.temp/reports/調研_json-render_系統.md`).
- **Gradual opening.** Anything not ready stays closed behind a platform gate
  (trust-ops) and opens later: saved views, Agent mode, the LLM index, events and
  geography, commerce, worldbuilding, developer extras and the rest of the former
  M7. Contribute the launch operation matrix to trust-ops.
- **Defaults** (maintainer, 2026-10-07): community surfaces may lag (counts,
  ranks, sections show their freshness); moderators and team roles are public;
  member counts are public and member lists visible to the Realm's members (the
  Realm can change it); follower counts and lists are public and each person can
  hide their list.

## First wave

Drafts from D2 (`.temp/goal-design/raw/D2-goal-decomposition.md`); real IDs come
from `task goal -- new`.

| Draft | Outcome | Engine; depends |
| --- | --- | --- |
| L1 | Editing keeps meaning: status-only saves keep dates; empty saves, spoilers, position and anonymous SEO keep their semantics; a 202 shows pending and reads back | `sonnet` high |
| L2 | The inherited failing journeys and recovery entries (list below), against the real API, keyboard and axe | `cursor` high; auth with trust-ops T3 |
| L3 | Showcase wrap-up: slide alt text, the double title announcement, banner helpers, logo-slot UI, native-reviewed locales, the pending showcase acceptance | `sonnet` high; trust-ops T7 for labels and slots |
| L4 | A Zone without a Realm: home page as a Content document with text and a first-party Showcase block; draft and publish bundle apart | `sonnet` xhigh; kernel K2, trust-ops T5 |
| L5 | Cross-Space Realm discussion: lazily created `about=<Work>` thread, author Person kept, post and reply persisted by the owner operation | `codex` high backend, `sonnet` UI; L4, trust-ops T1 |
| L6 | Scheme navigation and Realm boards over the shared classification capability; the four scope choices stay apart | `sonnet` high; kernel C4, trust-ops C1 |
| L7 | Presentation first slice: one read-only Resource page, 3–5 semantic components, the plain frontend and a json-render adapter over the same data and query contracts | `sonnet` xhigh with `claude` xhigh review; kernel K7, K2, trust-ops T5 |
| L8 | One fixed source of 1,000 records: agent-written mapping, human review, deterministic transform through the API, re-scored by a stronger model; representative fixtures for the four launch kinds | `grok` high mapping, `codex` high transform, `claude` xhigh re-score; kernel K6, trust-ops T1 |

L6 and L7 wait for kernel contracts and may start in the second wave. Each
launch kind still needs its own paired API and browser journeys; a 1,000-record
import does not replace them.

## Inherited

- Main-wide failures recorded in production-readiness state.md on 2026-10-05,
  to re-verify first: Zone browse keyboard filter loses the release query; Light
  Novels and Visual Novels "Zone editor" links fail axe target size; library
  export hides "The download stopped after N records"; library import misses
  "Unfinished imports" and the Korean ambiguous tab; `/auth/start` lands on the
  Work page instead of `/sign-in`; the wiki claims dialog lacks the "Chapter
  1000" link; the franchise wiki seed answers 409 `alias_conflict` on a
  persistent stack.
- showcase: the acceptance at 390 and 1280 px signed in and out; slide alt text
  and announcement; legacy banner helpers in `apps/web/features/realm/adapt.ts`;
  native review of the editors' strings.
- write-concurrency: the seed in operator mode tells absent from denied; review
  queue age; the checkbox journeys `g-839-work-levels-edit`,
  `g-843-catalogue-intake` and `library`.
- scoped-subjects: a per-Zone default continuity and the standalone link in
  `apps/web/features/zones/site-entity.tsx`.
- Record §10: `follows/recipients.ts` broadcasts with a durable cursor and
  bounded batches.
- First-round review, re-verify first: spoilers reduced to titles, anonymous SEO
  with private preferences, lost positions, public reads without an eligible
  Agent, an old intent overwriting a new one, 202 taken as success, the Saved
  Filter cap and missing cursor, public shelf counts over the whole population,
  progress `MAX(updated_at)` without an index.
- Salvage material: `goal/g-433` (Games UI, fixtures, filters, provenance; not
  the `game-facts` tables), `goal/g-422` (Games and Software Zone presentation;
  no domain facts backend), `goal/g-418` (WebNovel research).

## Cut lines

No domain backend per vertical, no forum inside a Zone, no discussion tag, no
browser-side persistence orchestration or compensation, no mock contract
presented as a landed dependency, no stored json-render spec, AI tools registry
or per-component queries, and no third-party blocks this round.

## Completion

Each launch kind and the listed Realm and Zone capabilities pass paired API and
browser journeys with real data (ambiguous editions, mixed formats, non-UI
languages, thousand-chapter inventories, revoked editors, interrupted exports,
two-device progress), the launch matrix is enforced, and the program's
regression is green on a pinned candidate.
