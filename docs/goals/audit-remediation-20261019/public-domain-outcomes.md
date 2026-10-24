# Public Recipe and Book outcome contract

These are pending specifications for C27, C28 and C30 (A06, A07, A11, A18,
A19). They establish no current product failure or persona proof. The original
audited rich Recipe's publication denial remains a failed fixture premise.
Existing synthetic positives and their assertions retain their original scope.

## Prove selection and personas

| File | Personas | Required task |
| --- | --- | --- |
| `tests/qa/integration/catalogue-public-recipe.test.ts` | visitor, stranger, member, owner, moderator, operator | Read the original public Recipe, preserve duplicate occurrences and linked instructions, scale exact quantities, reopen its publication and recover own Cook standing. |
| `tests/qa/integration/catalogue-real-book-reading.test.ts` | visitor, stranger, member, owner, moderator, operator | Understand a real Book, traverse genuine releases and chapter bodies, navigate previous/next, save an exact release and chapter position, reload and return. |
| `tests/qa/integration/outcomes/recipes/nutrition-and-substitutions.test.ts` | visitor, stranger, member, owner, moderator, operator | Preserve nutrition basis, units, coverage, provenance and exact author-declared substitute occurrence relations; refuse invented nutrition and foreign private state. |

The six declarations in
`scripts/qa/cases/outcomes/recipes/nutrition-and-substitutions.ts` remain
`pending`. Registry enrollment belongs to the registry author. Every standalone
case is also `test.failing`; a baseline runner must retain the actual assertion
diagnostics, since an expected failure is not positive evidence. Preparation is
in `beforeAll`, outside expected-failure bodies, so an unavailable source,
publication denial or missing corpus fails preparation explicitly.

| Persona | Public task and authority |
| --- | --- |
| visitor | Same source-qualified publication and chapter bodies; saved choice/progress commands return 401 without claiming a save. |
| stranger | Public task plus own private saved state; foreign subject reads and writes return 403. |
| member | Same task; Realm membership adds neither publisher authority nor another reader's state. |
| owner | Own state remains private; ordinary reads stay pinned after an unpublished edit. A fixture publisher has an explicit scoped grant separately from Realm ownership. |
| moderator | Ordinary public reader and own-state APIs; moderation grants no source editing/publication or foreign-state access. |
| operator | Ordinary public reader and own state; fixture publication uses an explicit scoped mandate, never platform role alone. |

## Existing operations and selected semantics

Recipe reads use `GET /v1/recipes/works/{id}`, with `servings=3` on the first
page. `next` carries the serving choice; following pages send only the cursor
and optional acting subject. All pages retain the published Structure/revision,
full receipt order and distinct duplicate ingredient identities. Ingredients
keep their original text/unit; linear parsed amounts and ranges scale by exact
rationals. Non-linear, not-scalable and unparsed lines retain their values and
qualification. No client-side estimate replaces the server's quantities.

Recipe nutrition uses existing `measures` entries with `kind=nutrient`,
`nutrient`, `unit`, `value`, `basis`, `coverage`, `provenance` and optional
`evidence`. No additional read endpoint or replacement nutrient engine is
selected. The accepted target makes whole-recipe nutrient quantities track the
requested serving factor; per-serving nutrient quantities stay constant. Both
retain their basis, units, coverage, provenance and evidence. Measures repeat
per page and must never be summed per continuation. An absent source yields no
nutrient entries; unknown/partial coverage remains distinct from complete or
zero. Source-stated, declared and computed values must remain distinguishable.
This serving behavior is an explicit target assertion for implementation review,
not a claim about current behavior.

Alternatives use `occurrences[].qualifier.substituteFor`, pointing to one exact
ingredient occurrence. The source author is qualified by the same public
Work's `rights.source.author` and retained observation; the transcriber remains
a separate Person. A second use of flour is a separate target, and no inferred
allergy, suitability or health recommendation is asserted. The frozen evidence
must actually declare the alternative. An empty relation list means no declared
alternative for that occurrence.

The isolated recipe setup grants only `work.publish` at
`work:publish:<exact Work IRI>` through `grantPersonaFixtureAuthority`, whose
owner is `grantFixtureAuthority`. It consumes previously assessed, retained,
public-domain source evidence via `POST /v1/work-publications`, with exact Work,
main version and Structure heads and `sourceObservation`. It requires 201 and
a publication decision, then an anonymous non-null same-revision read. A 403,
404, 409, 503 or null here is a fixture blocker. The source corpus must already
provide the rightful maintainer's composition authority; no role-based bypass
or broad root grant is added. An unpublished annotation is added afterward to
check publication pinning. Nutrition/editor/publication refusals use the normal
operations and must not mutate the source.

Cook's durable API task uses `GET/PUT /v1/works/{id}/progress`, saving `started`,
reloading with private cache headers, replaying the same idempotency key and
refusing a stale version with 409. This proves whole-Work cooking standing.
Step selection, timers, opening/closing Cook and browser focus recovery remain
the separate browser author's assertions; this API proof does not establish
those interactions.

Book understanding uses the existing Work header's `description`,
`selectedLanguage`, title and paginated credits. It traverses native
`/works/{id}/releases` and each release detail, requiring same-release coverage
of the exact realization, revision, language and platform. A PublicationEvent
or a release from another Book cannot satisfy selection. Contents traversal
uses `/works/{id}/contents` through every group/page, then `/chapters/{id}` and
`/content-revisions/{revision UUID}`. Each chapter must contain a meaningful
source paragraph, equal the exact revision body, retain its digest and link to
the actual adjacent chapters. A heading or generic synthetic body cannot pass.

Book return uses `/me/edition-preferences/{work}` with an exact native release
revision, then `/compositions/{id}/occurrences/{occurrence}/progress` with the
exact content revision. Both writes replay idempotently and reject stale
versions. Reloaded preference, progress, reader-state, reading-positions at
`position=mine`, progress summary and returned chapter must agree. Other
Person reads and writes remain refused even for the Work owner, Realm moderator
and operator. No new resource, endpoint or request parameter is proposed.

## Fixture prerequisite and baseline status

The private fixture interface is
`tests/qa/fixtures/catalogue-public-domain.ts`. Consumers expect
`.temp/goal/public-domain-corpus.json`, built through public commands at pristine
product baseline `69eac3ceeaf885be70205a70248bc951e9d81cc9`. It names one
consistent stopped owner backup, the original 113 Work identities, retained
persona identities/auth, exact import receipts, normalized reviewed source
oracles and SHA-256-pinned local source quotes. Credentials remain in private
`.temp` metadata; none belongs in this document or a recorded answer.

This corrects the future pin to the original audit tree retained in state; the
later nomination cannot replace it, and no execution of the corrected pin is
claimed. Identify authored specification/test/support overlays independently.
Record the fixed-wave revision, restored corpus generation and source snapshot
separately. A fixture unable to run the original revision blocks proof rather
than advancing the product baseline.

The corpus needs a real rich recipe with repeated ingredient names in distinct
occurrences, exact fractional amounts, linked instructions, positive servings
and cooking duration; a real recipe whose source has no nutrients; and
source-qualified nutrition cases covering both bases, complete/partial/unknown
coverage, declared/source-stated/computed provenance and an exact
author-declared alternative. Computed values need retained inputs and a
reviewed calculation; values may not be invented to fill missing source fields.
The Book needs a source-backed description and author, at least two genuine
native releases and at least two meaningful chapter paragraphs (200 or more
characters each) from frozen text. Fixture owners must review the normalized
oracles against their citations before implementation starts.

Use the existing `retainPersonaRealm`, stopped backup and
`createCorpusBackupDriver` lifecycle. Each consumer restores a separate writable
copy; no fresh import, capture, reset or shared stack write occurs in a consumer.
Preparation, including startup/migrations/readiness/smoke, has a 600-second
ceiling; total test setup has the same deadline. Keep the source backup
consistent and reusable. A product code change alone does not justify rebuilding
source data. The existing frozen Gutenberg and Open Library pins are available
for source review, but do not establish this complete qualified corpus by
themselves.

**Baseline not run.** The staged references contain the accepted plan and
decisions, but no `.temp/goal/public-domain-corpus.json`, compatible stopped
backup or reviewed positive nutrition/substitution source. No pristine baseline
checkout or API stack was started. No test body or outcome assertion was
reached; there is no runtime product failure to report. Preparation budget used:
zero API/stack preparation seconds. These missing prerequisites block the named
baseline selection, not specification authorship.

After supplying those prerequisites, pin an isolated pristine product checkout
to the baseline above, overlay only these specs and use one recorded selection:

```sh
bun /home/edge/projects/rezics/rezics-next/scripts/goal/goalctl.ts job -- bun scripts/goal/goalctl.ts test tests/qa/integration/catalogue-public-recipe.test.ts tests/qa/integration/catalogue-real-book-reading.test.ts tests/qa/integration/outcomes/recipes/nutrition-and-substitutions.test.ts
```

Keep the checkout and corpus paths inside the assigned worktree. Record the
actual product/spec revisions, QA run, per-case failing test body, exact
assertion reached (or preparation blocker), preparation timing and backup
identity. All rows remain pending on the wave until separate implementation,
combined proof and manager disposition; no automatic landing is authorized.
