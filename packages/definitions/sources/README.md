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
mechanism.

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
