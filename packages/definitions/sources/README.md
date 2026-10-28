# Source field inventories

Each inventory records one pinned source schema so profile definitions and import conversions can account for every
source field explicitly. The inventory format is shared across sources; source-specific exceptions belong in the
inventory itself.

## Format

An inventory has a `source` URL, a `snapshot` describing the exact dump and schema file, its SHA-256, and the data
licence named by that dump's README. Each entry under `tables` has a source table `name`, a `type` (the profile type
a row describes, or the statement a link row holds), and one `columns` entry for every source column.

Each column entry has one of these statuses:

- `existing`: `term` is already bundled in the catalogue and `on` names the profile type where it is available.
- `proposed`: `term` is a CURIE for a profile task, with its Wikidata `mapping`, a one-line `meaning`, and direct
  `citations` to the relevant schema.org term page, when used, and Wikidata mapping page.
- `omitted`: `reason` explains why the field does not become a profile statement.

A relation mapping may set `inverse: true`. Its `term` names the canonical bundled property, and the related subject
holds the statement pointing to the source subject. `on` still identifies the source subject's profile; it must be an
admitted target of the canonical property. Without `inverse`, the source subject holds the statement. The external
`mapping` or `wikidata`, meaning and citations describe the source direction. A `table_types` entry keyed by a source
term may supply an explicit canonical `term` alongside `inverse: true`. Omitted mappings are not converted.

A column may also have `licence` when its data has a licence or source condition different from the dump's default.
Enumerated fields include a `values` list with every source value, its term, Wikidata mapping, meaning, and citations.
Shared YAML anchors keep repeated enumerations identical across columns. The `table_types` section describes the type
terms used by the tables, while `semantic_term` records the SKOS term where the selected Wikidata mapping represents a
SKOS concept or relation.

## Vocabulary rules

Propose a schema.org class or property when its meaning matches the source field. Otherwise propose the matching
Wikidata class (`wd:Q…`) or property (`wdt:P…`). Every proposal includes its Wikidata mapping and citations to the
relevant schema.org and Wikidata pages. Use `rezics:` for platform mechanisms and inverse relations with no matching
standard term; the source-specific
`rezics:spoilerLevel` qualifier records spoiler disclosure because no standard property covers that platform
mechanism. The narrowly adopted
[AnimeRelease exception](../README.md#anime-publication-releases) does not broaden
this rule into general permission for local domain vocabulary.

A credit uses its role property as the main value: `schema:author`, `schema:illustrator`, `schema:director`,
`schema:musicBy`, a voice-actor relation, `schema:translator`, or the general `schema:contributor`. Qualify credits
with credited-as (`wdt:P1932`), order (`schema:position`, Wikidata `P1545`), and detailed role (`wdt:P3831`, a
concept). If the pinned source has no order field, record that absence and do not infer an order.

A character appearance is `schema:character` (Wikidata `P674`) qualified by its role. Tags and traits are
`skos:Concept`s in a `skos:ConceptScheme` for each tree, with parent links represented by `skos:broader`. Map the
SKOS terms to their Wikidata equivalents while retaining the SKOS semantic term in the inventory.

Omit user vote records, list statistics, user data, and internal bookkeeping with an explicit reason. A source's
aggregate score may be imported as a source statistic when its licence covers the ratings; it stays separate from
profile fields and is never turned into native votes. Image identifiers that represent profile artwork feed the cover
group; the identifier is not itself an image URL or a grant to republish the image. Record separate image or prose
source conditions on the affected columns.

## Reviewed binding and producer status

The owning [classification and measurement contract](../README.md#public-classification-and-genuine-measurements)
adopts the meanings. The [mapping report](../../../docs/research/catalogue-filter-data-mappings.md)
records revision/source evidence. Inventory statuses describe a pinned schema, not
released property admission, native Concept adoption receipts, executable conversion,
adopted measurements, complete projections or admitted indexed execution.

- Bangumi public harem binds `schema:keywords` to the exact editor-maintained public
  subject `meta_tags` member `后宫`, using the adopted source Concept in the scheme
  with external key `https://rezics.com/schemes/bangumi/public-tags`. A configured
  trusted source alias may bind it, but its spelling proves no identity. The filter
  names that source scope and actual Concept; Q690342 stays close until boundaries
  and reverse-harem equivalence are reconciled. Source/canonical Concepts are not
  merged by label or implicitly expanded through close mappings.
- Missing, empty or withheld metadata has no fallback. Ordinary/popularity tags,
  votes, private/personal Collection tags, arbitrary infobox strings and novel
  platform supply no public harem/light-novel facts. The pinned inventory admits
  `meta_tags` as proposed; it does not prove an observed archived 后宫 Book row or a
  delivered converter. No explicit Bangumi light-novel public category is demonstrated.
- Light novel uses existing `workFormat` / `wdt:P7937`, exact P7937, with Q747381
  exact only for the adopted Japanese literary-form meaning. Book stays work;
  `bf:Instance` stays edition/translation. Wikidata P7937=Q747381 or a trusted cited
  explicit assertion needs actual holder and adopted Concept bindings first.
  Genre's exact P136 remains distinct from keywords; P921 stays close inventory
  correspondence, never executable exact mapping or automatic double-emission.
- Words use `schema:wordCount`, exact P6570; characters require a distinct named
  local property without an invented external exact mapping. Both require exact
  nonnegative integers, unit `1`, explicit zero, and their own holder/text/version/
  language, complete/partial scope, versioned method and evidence association.
  Unknown stays unknown; characters, pages, estimates and incompatible units never
  become words. Wikidata must preserve all measurement qualifiers with resolved
  identities or reject the entire measurement. Current item-qualifier dropping makes
  enabling P6570 alone unsafe. Narou character metadata is not an approved adapter.

At the report pin no harem metadata-tag converter, explicit light-novel producer,
qualifying native million-word Book batch or genuine character producer is delivered.
Trusted contributor/publisher cited assertions through propose/adopt are feasible
future producers, not existing measurements. Wikidata executable mappings come from
catalogue exact mappings; no separate Wikidata inventory registry is introduced.
Concepts/schemes use ordinary create/resolve/adopt and external claims, with returned
real IDs/receipts and same-ID replay before binding conversion. Use actual
`record-bindings`/`resolvedReferences`; optional identifier lookup is not CLI wiring.
QIDs, source URLs, labels and arbitrary fixture numbers prove neither native identity
nor measured data. Release YAML is not a second Concept authority; personal-library
import is not expanded.

Anime release identity follows its [owner contract](../README.md#anime-publication-releases),
and Recipe diet/time follows its [owner contract](../README.md#recipe-diet-and-cooking-time).
Their research reports
supply evidence, not actual source bindings or native data. No anime-release provider,
QID or Source ID is guessed. VegetarianDiet needs an actual adopted Concept explicitly
corresponding to `https://schema.org/VegetarianDiet`; private labels and ingredient
names do not classify public Recipes.

Source URL/catalogued ID references retain upstream `schema:version` and
`schema:dateModified` when available, at native precision. Missing dates remain absent;
never invent ingestion/current/publication dates. Missing revision uses Source
`record_revision: unversioned` plus an actual SHA-256 digest, separate from converter
and REZICS revisions. Available VNDB `lastmod` must not be dropped; its correction
belongs to Imports. The four-part Open Library example is available-data illustration;
old direct fixtures and Bangumi records without dates remain valid. Source name/URL/
licence attribution is distinct from facts-rights. General source-record metadata
production/read admission is not delivered; no registry or licence inference is added.
Facts-rights rejection and separate summary/cover rights remain unchanged.
