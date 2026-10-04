---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch). Migrations are not listed:
# each task reserves its own numbers. The manager widens them as briefs land.
areas:
  - services/main/src/modules/rating/**
  - services/main/src/modules/projection/**
  - services/main/src/modules/continuity/**
  - model/definitions/projection-*
  - model/definitions/continuity-*
  - model/definitions/canonicity-*
---

# Subjects, variants and scoped judgments

Status: started on 2026-10-04 by the maintainer, manager `rezics-next-97`.
[state.md](state.md) records where the work stands.

## Outcome

People can say exactly what they mean when they rate, review, discuss or state
facts about a character, a person or a thing:

- **One identity by default.** A character such as Misaka Mikoto is one
  Character across every Work, volume, adaptation and age; per-Work roles,
  credited names, ages and forms are scoped facts on that identity, not new
  entities.
- **Separate identities only on evidence.** A variant that coexists with its
  original in the narrative or is independently named with irreconcilable
  identity facts (Saber Alter) is its own Character linked to one hub; a
  playable unit (Hoshino (Swimsuit)) is a unit that represents a Character; a
  title held by several individuals (Batman, the Saber class) is a title, not
  an identity.
- **"X in F" is addressable.** A projection names a subject within a
  subject-side frame (a Work, continuity, chapter, episode, match, map, game
  version or in-story time) and is the target of ratings, reviews, discussion
  and pages, minted only when something targets it.
- **Scope is never confused with the evaluator.** Applicability and frames say
  what is judged and are the same in every Realm; Contexts say whose
  acceptance and definitions apply; RatingContexts say which question and
  population. Continuity, canonicity and canon policy are three separate
  records.
- **Numbers stay honest.** Scoped ratings never flow silently into unscoped
  ones; any roll-up is a named derived metric with its formula, coverage,
  sample counts and display thresholds.

Every capability is accepted through the API and the browser, on phones and
desktops, in the eight UI locales, and as configuration of the one engine:
new subject or frame types are data, not new backend paths.

## Basis

The research report and notes (local material, not a record):
`.temp/reports/角色變體與情境評分語義網方案.md` and
`.temp/research_notes/角色變體與情境評分語義網方案/`. The decisions and their
primary sources go into their owner documents in S1; briefs cite those owners.

## Milestones

The manager revises them. A milestone counts when merged, its checks pass and
its journeys pass through the API and in a real browser against the local stack.

- **S1 Decisions in their owners.** Identity tests, projection semantics,
  typed applicability dimensions, the rating grain and roll-up rules, and the
  continuity / canonicity / canon-policy split, written into the semantic
  model, classification, Context and rating owners with their reasons and
  primary sources.
- **S2 Identity.** Variant links to a hub with a kind and spoiler level, title
  holding, units that represent characters, credited names on participations
  and spoiler-aware alternative names; merge and split keep working.
- **S3 Projections.** The projection type, get-or-create with one identity per
  key, frame validation that admits only subject-side dimensions, typed
  applicability with OR within and AND across dimensions, and the projection
  view of in-scope facts.
- **S4 Scoped judgments.** A `projection` rating grain; reviews and discussion
  on projections; additive aggregate components (sum, count, histogram);
  named derived roll-ups; display thresholds; variant-family views; merge
  de-duplication; Discover and rating projections kept current.
- **S5 Continuity and canon.** Continuity resources, work-in-continuity
  statements, canonicity statements with authority and stance, canon policy
  in Contexts, and a labelled, switchable default continuity per Realm or Zone.
- **S6 Surfaces and export.** Character, variant-family, unit and projection
  pages; "rate this character in this episode" and per-match player rating;
  continuity switch; Web Annotation and DQV export.

Acceptance fixtures through the API and the browser: Misaka Mikoto across
*Index* and *Railgun*; Saber and Saber Alter; Hoshino (Swimsuit); Goku's
ages and forms; Conan / Shinichi; a player's per-map and season ratings;
Excalibur in *Fate/Zero* episode 24; Anakin in Canon and Legends.

## Models

Maintainer, 2026-10-04, for this Goal: Sonnet 5.5 for frontend work; Sonnet
for backend work while Claude usage allows, otherwise GPT-6.1 Sol; Grok 4.7 for
simple tasks; the manager (Opus 5.5) designs and reviews. Use Claude as fully
as is useful before its weekly reset on 2026-10-05 23:00 CST.

## Completion

The Goal ends when S1–S6 pass and the maintainer agrees, or when the maintainer
stops it, closing with `task goal -- goal close scoped-subjects`.

## Constraints

The [manager charter](../manager.md) gives the authority and standing
directions; the [Goal program](../README.md) runs the workers; workers follow
the [worker protocol](../worker.md). Backend complexity is the main risk: one
new kernel type and one rating grain, everything else configuration.
