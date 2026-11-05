# Imports capability acceptance

This file states current requirements for the [Imports Goal](imports.md). Source formats, licences, converter mappings, commands, recovery and costs belong to the [conversion](../../packages/conversion/README.md) and [importer](../../services/importer/README.md) contracts. Semantic proposal, acceptance, adoption and Context return belong to [Semantic](../../services/kernel/src/semantic/README.md); media rights and takedown belong to [Content](../../services/kernel/src/content/README.md).

Revision choice: current claims use checked-in exports; the reviewed Person-career range keeps its original revision identities as history.

## User outcome

A maintainer can import licensed provider records, inspect omissions, recover safely and refresh changed or vanished source facts through the ordinary API and permission model. Community tools can use the same pure revisioned converters. Imported facts remain proposals until separately accepted and adopted. Refresh never erases communal identity or unrelated adopted facts.

## Required source coverage

The four launch sources are Bangumi, VNDB, Open Library and Wikidata. Exact grains, formats, revisions, rights, citations and exclusions are defined in the module contracts. Acceptance uses pinned, legally usable fixtures; live provider availability is not required.

- **Bangumi:** native JSONL and PersonDetail identity, Person Chinese names, supported subject types, attributed summaries, independent cover rights, type-specific omissions, refresh and source fences.
- **VNDB:** real COPY headers and grouped native keys, source revisions, permitted metadata and bounded associations; no creative prose or images.
- **Open Library:** five-column TSV and separate Work/Edition grains, including Work `first_publish_date` and Edition-only page-count/ISBN behavior; no unlicensed prose or covers.
- **Wikidata:** native item JSONL/revision and exact released type, property, qualifier and reference mappings; unresolved relations stay unresolved.

## Ordinary import and recovery acceptance

Cover the authenticated account-key CLI, current Auth/Access decisions, public batch and source-metadata APIs, current subject/candidate reads, independent editor selection and anonymous public return. The importer never writes storage through a private path.

For every source, cover initial import, unchanged reopen, changed record, re-import, disappearance, suspicious mass disappearance, ownership fences, malformed/unsupported values, bounded readers, retryable unavailability, unknown delivery and resume. Denial and unavailability are not success. Retry replays the exact sealed bytes and command key under current authority before replacement; source/field fences prevent replay or refresh from restoring withdrawn material.

Retained metadata remains integrated native acceptance: [coordinator](../../services/kernel/test/library/list-import-metadata-coordinator.test.ts), [entry metadata](../../services/kernel/test/library/entry-import-metadata.test.ts), [VNDB HTTP](../../services/kernel/test/library/list-import-vndb-http.test.ts) and [Bangumi HTTP](../../services/kernel/test/library/list-import-bangumi-http.test.ts) cover selected metadata, partial application, confirmation replay and provider adapters. Extraction/reader corrections remain with their owner.

## Provider-specific contract acceptance

### Source identity and field ownership

A configured alias and exact provider external ID remain one tuple across generations. Registration owns converter revisions and metadata rights. Refresh changes or retracts only the matching importer-owned source-field candidate; it cannot replace identity, independent identifiers, community assertions or adoption.

### Bangumi people and careers

Keep Person identity, biography, credits, names and careers independent. Type-1 `name` is `und`; `name_cn` or exact PersonDetail infobox key `简体中文名` is `zh`; ambiguous Chinese evidence withholds only `zh`. Ordinary P106 requires the actual Person, exact source key, source careers Scheme, exact current bound Concept, released property and career citation. The pure converter emits none; source Concepts claim no canonical occupation or cross-provider equivalence. Showcase-only acquisition and replay belong to [career acquisition](../../services/importer/README.md#bangumi-person-career-acquisition).

Career [conversion](../../packages/conversion/tests/bangumi-person-careers.test.ts), [showcase](../../services/importer/tests/showcase-bangumi-person-careers.test.ts) and [native](../../services/kernel/test/imports/bangumi-person-careers.test.ts) cases cover mapping, replay and current reads. Person-name [projection](../../packages/conversion/tests/bangumi-person-names.test.ts), [ordinary import](../../services/importer/tests/bangumi-person-names.test.ts), [shared acquisition](../../services/importer/tests/showcase-bangumi-person-names.test.ts) and authored [native case](../../services/kernel/test/imports/bangumi-person-names.test.ts) cover each stage; native execution is integration-owned.

### Bangumi work, Book, Game and Character outcomes

Preserve cited TVAnime websites/work evidence; Book and Character mappings; and independent Game names, dates, environment, genres and player count. Creator/voice credits follow Game environment/genres and precede Character identity/appearance; Game cast follows Character immediately. Appearance uses selected source relations and exact released roles. A malformed neighbor cannot suppress a valid fact.

Existing cases cover [TVAnime websites](../../services/importer/tests/bangumi-official-websites.test.ts), [work evidence](../../services/importer/tests/bangumi-work-evidence.test.ts), [Game names](../../services/importer/tests/bangumi-game-names.test.ts), [publication dates](../../services/importer/tests/bangumi-game-publication.test.ts), [creator credits](../../services/importer/tests/bangumi-creator-credits.test.ts) and [Character appearance](../../services/importer/tests/showcase-bangumi-characters.test.ts). Other API/native outcomes stay with their owner suites.

### Open Library Work publication date

Only optional Work `first_publish_date` creates its independently cited `schema:datePublished` assertion; Edition fields and existing `publish_date` behavior stay separate. [Conversion cases](../../packages/conversion/tests/open-library-first-publication.test.ts) pin precision, citation, digest changes, malformed values and Edition exclusion. [Native cases](../../services/kernel/test/imports/open-library-first-publication.test.ts) retain separate selection/adoption and current public reads.

### VNDB, Wikidata and media outcomes

Preserve VNDB table/key, release, staff, producer, Character, tag, language, date, identifier and website meanings, including direction, qualifiers and unknown/absent distinctions. Current Global Context authorization precedes source-statistic receipt evaluation; `source_statistic:write` is VNDB-only and catalogue setup uses a separate credential. Six [pinned cases](../../specs/imports-vndb-statistics.test.ts) and the [native wrapper](../../services/kernel/test/imports/vndb-statistics-outcomes.test.ts) require seven-scope Auth/Access, statistic PUT/current GET, safe reopen/update and exact unknown-delivery replay, no `c_rating` or native votes, reduced-scope/revoked denial, and baseline protection on acquisition/disappearance failure. Wikidata uses exact released property/qualifier mappings. Source metadata, prose, cover intent and bytes have separate permissions; pending reservation is not available media. Replay uses original requests; only available media enters separately accepted/adopted candidates. Rights withdrawal and takedown fences prevent refresh restoring removed material; see [Content](../../services/kernel/src/content/README.md) and [deletion policy](../deletion.md).

## Receiving and growth acceptance

Pure converter cases establish mapping, validation, provenance, bounds and determinism only. They do not prove native acceptance/adoption, Context return, API receiving, public visibility or growth.

Retain receiving obligations for import-to-discovery Context, assertion/return, provider metadata and label extraction, and consumer reads. Source compatibility or documentation is not evidence. Detailed receiving remains with the Person/profession and reviewed-catalogue owners.

### Import-to-discovery

Import supported facts, separately accept/adopt through ordinary Semantic APIs, then discover traceable Work/Edition/Release facts through Search/facets, Collections, Zones and TypeLists using shared released meanings. Cover current Context and public/private separation across importer proposals, editor accept/adopt, anonymous/editor reads, and independent Alice/Bob populations and support/state. Reduced, unscoped/delegated, suspended-valid and revoked callers repeat relevant reads/writes; private grants cannot leak. Hidden Concepts, source fences, aliases with hidden originals and late revocation affect membership, order, counts, cursors and final disclosure.

Use released controls and actual mappings only. Bangumi tag/form and VNDB name/link mappings do not establish platform/form; Open Library and Wikidata mappings do not establish cross-surface populations. Imports owns mapping/transport; Semantic owns shared fixtures, releases, Concept receipts, selection/adoption and identity; Search owns indexing/facets/query; Commerce owns Collections and owner queries; Semantic owns Zone routing; Content owns source/media disclosure; Web owns publication. Keep [discovery user cases](../../services/kernel/test/imports/discovery-user-cases.test.ts) as acceptance, not completion evidence.

Preserve original native scenarios for connected source/CLI recovery, media recovery, import-to-discovery, statistics and source-only refresh. Authored fixtures claim only fields they contain, not native source execution. Retained-metadata cases above remain integrated acceptance; pure-core cases do not replace them.

Three-scale growth evidence covers conversion work and API writes. Preserve existing database statement, row, byte, page, fan-out and command bounds. Pure-core checks do not replace native receiving or growth evidence. Do not claim Goal completion until all scoped outcomes are promoted with their acceptance.

## Acceptance entry points

Use `specs/imports-*.test.ts`, `specs/imported-field-outcomes.test.ts`, conversion tests and importer tests. Native API acceptance remains in `services/kernel/test/imports` and `services/kernel/test/library`. Follow the [verification workflow](../development/verification.md); exact source procedures and commands belong to the [importer contract](../../services/importer/README.md).
