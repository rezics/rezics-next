# Public catalogue comparison

The existing `TypeList` admits one native Search page and retains its original order, planned limit and opaque
continuation. Its existing `CoverList` supplies the shared density, cover treatment and phone preview. Home mounts
these same native document slots in `HomeCatalogue`; Realm-scoped composed Subject lists use the same renderer.
The actual Realm home (`src/community/space-page.tsx`) mounts a publication shelf and `RealmCatalogueCurrent`,
not `TypeList`. Its existing full-catalogue handoff through `RealmCatalogueNavigation` remains Search-owned and is
not replaced by another catalogue.

Decision: disclosed work and creator destinations open in a new tab, preserving the original tab's exact native
type/population/source, locale, cursor, focus and scroll window on return.

## Current producer boundary

The bound native `searchResponse` in `services/kernel/src/search/http/routes.ts` can publish selected `facts`,
but `nativeTypeListPage` previously discarded them. The consumer now admits that existing four-property,
three-value projection and supplied `listPresentation` before using shared presentation defaults. It performs
zero additional requests. Selected date facts preserve year/month/day precision. Item facts do not become creator
links or qualified credits merely because they carry IDs.

The native TypeList planner in `packages/composition/src/registry.ts` currently requests only filter, sort and limit;
the ordinary search response does not supply qualified creator associations or explicit concealed destinations.
`catalogueRowContext` is the named unavailable seam for that missing native projection. The seam is implemented and
examples are authored; **the producer is not activated**. No generated declarations or alternate endpoint are added.
Absence of this projection means context unavailable, never proof that the work has no creator. Malformed explicit
context grants no destination. Existing native disclosed Search targets remain usable when no extension is supplied.

## Exact producer handoff

Semantic must select the released creator/release meanings and qualify their direction, credited names, source and
date precision. Search retains its existing population, type filter, Source observation, ordering and cursors.
The native page composer (`services/kernel/src/presentation/reads.ts`, and the scoped composer in
`services/kernel/src/zones/page-runtime.ts`) must supply bounded context on each existing row, after anonymous
disclosure, in the same response. Publish the operation schema and regenerate the client through its owner.

The reserved `row.catalogueContext` version 1 is defined exactly by `model.ts`:

- Every state carries `subject` matching the row ID, `observation` for the current composition and `target`:
  either the disclosed canonical `{id}` matching that row or `null` for a concealed destination.
- `unknown`, `withheld`, `absent` and `unavailable` are distinct terminal context states. They contain no facts.
- `ready` carries a localized `medium`, at most three creators, four selected facts, one optional provider
  statistic and a `more` flag. Each creator has an admitted property, explicit `subject-to-creator` direction,
  localized role/name, nullable disclosed destination and at most three labeled qualifiers. Each fact has its
  property/label and an existing native `Fact` value. Every creator/fact/statistic has a source label and observation.
- The statistic is a sourced provider measure, value, optional original scale and optional observation count.
  It is never passed to the REZICS vote/rating component. `more` offers the admitted work destination only.

No local role list, login inference, per-card Subject read, graph expansion, global fallback, private state or write
is permitted. This seam must be supplied inside the current native page, not by an independently retained request.
Replacement of route, type, Realm, locale, source observation or native page removes its old context with the rows.
The native continuation owner remains responsible for retiring old cursors and asynchronous completions.

## Bounds and Home insertion

The native page plan caps TypeList previews at 24 rows and continued windows at 12. Context bounds are three creators
with three qualifiers each, four facts and one statistic per row. Localized fields admit at most eight languages and
320 UTF-16 code units per value; display is at most 160 characters per field. No association accumulation is retained.
Producer selection beyond those limits must set `more` and supply a disclosed work target instead of expanding rows.
Withheld/absent/invalid context never renders unqualified raw facts as a substitute.

Home's private receiver owns personal state and action lifetimes. Its insertion point remains outside this public
`TypeList`/`CoverList` metadata: a separately owned private overlay can receive only current disclosed work identities
from Home's admitted page. This public seam contains no account identity, membership, viewer vote or allowed action.

## Reference comparison

Read-only references: `legacy-final:apps/web/features/catalogue/{work-shelf,work-tile,author-names,catalogue-grid}.tsx`
and `work.ts`, and `../rezics/apps/web/features/catalog/components/native-related-lists.tsx`,
`../rezics/libraries/ui/src/custom/{unit-card,content-card}.tsx`. Legacy supplies ordered credited names beside a title;
the earlier native release lists preserve partial dates and bounded continuation. Only presentation is reused here;
the old shelf's private control and rating model do not establish public actions or provider-vote equivalence.
The page/API audit, component parity, API-first coverage and seeded review were read as source leads; the seeded
review has zero captures and establishes no visual defect.
