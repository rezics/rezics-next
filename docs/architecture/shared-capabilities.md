# Shared capability exceptions

A shared owner does its job without recognising a vertical or a source. The
[platform thesis](../product/platform-thesis.md) makes a new domain
configuration, and its expansion acceptance fails while any owner below still
needs code for a new Work type, profile or provider. This page lists the known
exceptions on the 2026-10-16 wave/3 tree, the owner each repair generalises, and
the proof the repair needs. Remove an entry when its repair lands with that proof.

Three kinds of difference are legitimate and stay. Vocabulary and profile
declarations (types, roles, qualifiers, depth, licence instruments) are
configuration. File decoding and domain arithmetic (Paprika and Mela archives,
MAL and VNDB XML, Schema.org projection, ingredient scaling) belong in adapters.
Distinct meanings stay distinct, such as chapters as Posts and independently
maintained Work parts.

Every repair keeps the existing owner, moves format interpretation to the adapter
or profile boundary, and migrates all callers, stored contracts and readers in
the same change. None adds a second engine or renames a special case. Each proves
failing-before and passing-after behaviour with a consumer that is not the
original one: a non-Recipe profile, or a second provider where the provider is
the boundary. Exact versions, order, unknown authorship, truthful credit, rights
evidence, private, refused and revoked states, idempotent recovery and bounded
cost are preserved.

## Source adoption and credit

Source adoption consumes Open Library's conversion shape. Proposals assume Book,
child correspondence knows only authors and subjects, and synopsis application
and native title and field control require the Open Library mapping
(`source/native-work-proposal.ts`, `source/child-correspondence.ts`,
`source/field-application.ts`, `source/field-control-native.ts`,
`work/title-control.ts`). Intake embeds that provider's capture validation and
rate schedule. Conversions should expose verified mapped values, types and child
occurrences, and adoption should consume those through the existing field
support machinery. Proof: a second provider adopts a Work, a child and a field.

Credit is split by provider and role. External credit adoption accepts only
Open Library author occurrences, a SQL constraint and SHACL shape enforce it, a
separate native Agent owner repeats admission and revision, and public and
discovery readers recognise each representation and filter roles
(`source/author-credit.ts`, `work/author-credit.ts`, `profiles/credits.ts`,
`query/templates/work-credits.rq`, `discovery/credits.ts`). The native credit
owner should accept either a native Agent or a provider-qualified external
reference, with admitted role vocabulary, keeping source-reported and confirmed
status apart. Proof: a non-Open-Library contributor with a non-author role
appears in public and discovery reads.

Automatic rights assessment for reader imports reconstructs Source authority
through an Open Library join inside `rights/store.ts`. Source should verify the
admitted binding and importer policy supply the assessment input, while Rights
keeps persistence and idempotency. Library import matching admits only ISBN and
VNDB identifiers and chooses Open Library unless VNDB applies
(`library-import/match.ts`, `reader-import.ts`, `open-library.ts`). It should use
the generic Release identifier lookup for every admitted identifier, with source
selection in reviewed mappings. Proof: a MAL-identified row matches and adopts.

## Publication, Structure and types

Sourced structured publication interprets Recipe inside Work publication. It
requires `complete-recipe` coverage, reparses with `importRecipe`, requires the
`recipe-composition` profile, checks ingredient, step and group qualifiers and
picks Gutenberg's licence by provider (`work/sourced-structure-publication.ts`,
`work/sourced-publication-credits.ts`). The profile boundary should verify the
correspondence between an exact Source observation and Structure revision, and
publication should consume that evidence with its common admission, disclosure,
rights and attribution rules. Its adopted dependencies are written as
`schema:recipeInstructions`, and Content and Media delivery grants read that
relation (`work/instruction-adoption.ts`, `content-publication/public-selection.ts`);
the dependency relation should be owner-neutral, with Recipe semantics projected
by its profile. Proof: a non-Recipe structured profile publishes from a source.

Structure traversal and refresh encode Book topology: chapter seeking, three-way
refresh and Work contents allow only group, chapter and part roles, and Recipe
keeps its own walker (`structure/reading-order.ts`, `structure/refresh.ts`,
`work-contents/read.ts`, `recipe/work-page.ts`). The shared codec also validates
Recipe ingredient ranges (`structure/format.ts`). Traversal should follow
declared container roles and depth, and relational checks should run through
profile validation hooks. Work type rules mix interest grouping with structural
invariants, and only Book has a dependency guard (`work/activate.ts`,
`work/edit.ts`); required types should derive from attached profiles. Proof: a
section-list composition navigates, refreshes and guards its type.

## Discovery, exchange and release

Phrase search reaches a Work from Content only through Book chapter placement
(`post/patterns.ts`, `work/search-public.ts`, `content-publication/search.ts`).
It should use profile-declared searchable placements. The web discovery page has
its own type list of book, document and recipe (`apps/web/features/discover/state.ts`)
and should read the served type registry. The year directory intersects with a
ten-page Realm roster (`apps/web/features/zones/catalogue-browse.tsx`) and should
pass Realm and conditions to the publication-year query. Proof: an Anime Work is
found by phrase, filtered in discovery and listed past the roster.

Exchange lifecycle lives in Recipe routes. Collection imports reupload files
for continuation outside the import job store, native Structure and Content
export traversal exists only for Recipe, and composition export stops at 255 pins
(`routes/recipe-collections.ts`, `recipe/collection-import.ts`,
`export/readers.ts`, `recipe/export-page.ts`). Imports should use the existing
upload and job custody, and the shared export owner should page native
occurrences. Fixed releases and sealed exports accept only VNDB evidence shapes
(`work/fixed-release.ts`, `export/readers.ts`, `export/operations.ts`); Source
should verify a provider-neutral external release reference. Proof: a non-Recipe
composition exports past 255 pins, and a non-VNDB release link seals and exports.

## Acceptance evidence

Shared grant and disclosure obligations are listed under the Recipe hub row
(`scripts/qa/cases/outcomes/recipes/work-hub-and-reading.ts`), and two of its
prerequisites are stale. Shared obligations belong with their capability owners;
the row stays as a Recipe composition example. A product row passing is not
evidence for this page: each repair reports its own cross-domain proof.
