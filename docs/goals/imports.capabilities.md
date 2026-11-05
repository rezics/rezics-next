# Imports capability acceptance

This file states current requirements for the [Imports Goal](imports.md). Source formats, licences, converter mappings, commands, recovery and costs belong to the [conversion](../../packages/conversion/README.md) and [importer](../../services/importer/README.md) contracts. Semantic proposal, acceptance, adoption and Context return belong to [Semantic](../../services/kernel/src/semantic/README.md); media rights and takedown belong to [Content](../../services/kernel/src/content/README.md).

Revision choice: current claims use checked-in exports; the reviewed Person-career range keeps its original revision identities as history.

## User outcome

A maintainer can import licensed provider records, inspect omissions, recover safely and refresh changed or vanished source facts through the ordinary API and permission model. Community tools can use the same pure revisioned converters. Imported facts remain proposals until separately accepted and adopted. Refresh never erases communal identity or unrelated adopted facts.

## Required source coverage

Launch sources are Bangumi, VNDB, Open Library and Wikidata. Their grains, formats, revisions, rights, citations and exclusions live in module contracts. Acceptance uses pinned legal fixtures, not live provider availability.

- **Bangumi:** native identity, Person names, attributed summaries, separate cover rights, omissions and source fences.
- **VNDB:** COPY headers/native keys, source revisions, permitted metadata, bounded associations; no prose or images.
- **Open Library:** five-column TSV, separate Work/Edition grains, Work `first_publish_date`, Edition page counts/ISBNs; no unlicensed prose or covers.
- **Wikidata:** item JSONL/revisions and exact released claims; unresolved relations stay unresolved.

## Ordinary import and recovery acceptance

Cover account-key CLI, current Auth/Access, public batch/source-metadata APIs, current subject/candidate reads, editor selection and anonymous return. No private storage writes.

For each source cover initial import, unchanged reopen, changed/reimported records, disappearance and mass-stop, ownership fences, malformed/unsupported values, bounded readers, unavailability, unknown delivery and resume. Denial is not success. Retry replays exact sealed bytes/key under current authority; source/field fences prevent restoring withdrawn material.

Retained metadata stays integrated native acceptance: [coordinator](../../services/kernel/test/library/list-import-metadata-coordinator.test.ts), [entry metadata](../../services/kernel/test/library/entry-import-metadata.test.ts), [VNDB HTTP](../../services/kernel/test/library/list-import-vndb-http.test.ts) and [Bangumi HTTP](../../services/kernel/test/library/list-import-bangumi-http.test.ts) cover selection, partial application, confirmation replay and adapters. Extraction corrections stay with their owner.

## Provider-specific contract acceptance

### Source identity and field ownership

A configured alias and exact provider external ID remain one tuple across generations. Registration owns converter revisions and metadata rights. Refresh changes or retracts only the matching importer-owned source-field candidate; it cannot replace identity, independent identifiers, community assertions or adoption.

### Bangumi people and careers

Keep Person identity, biography, credits, names and careers independent. Type-1 `name` is `und`; `name_cn` or exact PersonDetail infobox key `简体中文名` is `zh`; ambiguous evidence withholds only `zh`. P106 requires the actual Person/source key, source careers Scheme, current bound Concept, released property and exact citation. Pure conversion emits none; source Concepts assert no canonical occupation/equivalence. Showcase-only acquisition/replay belongs to [career acquisition](../../services/importer/README.md#bangumi-person-career-acquisition).

Career [conversion](../../packages/conversion/tests/bangumi-person-careers.test.ts), [showcase](../../services/importer/tests/showcase-bangumi-person-careers.test.ts) and [native](../../services/kernel/test/imports/bangumi-person-careers.test.ts) cases cover mapping, replay and current reads. Person-name [projection](../../packages/conversion/tests/bangumi-person-names.test.ts), [ordinary import](../../services/importer/tests/bangumi-person-names.test.ts), [shared receipt](../../services/importer/tests/showcase-bangumi-person-names.test.ts) and authored [native case](../../services/kernel/test/imports/bangumi-person-names.test.ts) state each stage; execution is integration-owned.

### Bangumi work, Book, Game and Character outcomes

Preserve cited TVAnime websites/work evidence; Book and Character mappings; and independent Game names, dates, environment, genres and player count. Creator/voice credits follow Game environment/genres and precede Character identity/appearance; Game cast follows Character immediately. Appearance uses selected source relations and exact released roles. A malformed neighbor cannot suppress a valid fact.

Existing cases cover [TVAnime websites](../../services/importer/tests/bangumi-official-websites.test.ts), [work evidence](../../services/importer/tests/bangumi-work-evidence.test.ts), [Game names](../../services/importer/tests/bangumi-game-names.test.ts), [publication dates](../../services/importer/tests/bangumi-game-publication.test.ts), [creator credits](../../services/importer/tests/bangumi-creator-credits.test.ts) and [Character appearance](../../services/importer/tests/showcase-bangumi-characters.test.ts). Other API/native outcomes stay with their owner suites.

### Open Library Work publication date

Only optional Work `first_publish_date` creates its independently cited `schema:datePublished` assertion; Edition fields and existing `publish_date` behavior stay separate. [Conversion cases](../../packages/conversion/tests/open-library-first-publication.test.ts) pin precision, citation, digest changes, malformed values and Edition exclusion. [Native cases](../../services/kernel/test/imports/open-library-first-publication.test.ts) retain separate selection/adoption and current public reads.

### VNDB, Wikidata and media outcomes

Preserve VNDB native keys, release/staff/producer/Character/tag, language/date/identifier/website meanings, direction, qualifiers and unknown/absent distinctions. Positive `c_average`/`c_votecount` yields `c_average/100` on 1–10, as of dump date; zero votes remove the statistic. Commerce-owned Global Context authorization precedes receipts; `source_statistic:write` is VNDB-only, separate from catalogue setup. Six [pinned cases](../../specs/imports-vndb-statistics.test.ts) and the [native wrapper](../../services/kernel/test/imports/vndb-statistics-outcomes.test.ts) retain seven-scope Auth/Access, PUT/current GET, reopen/update, exact unknown-delivery replay, no `c_rating`/native votes, reduced-scope/revoked denial and baseline protection on acquisition/disappearance failure. Wikidata uses exact released mappings. Metadata, prose and covers have separate rights; a reservation is not media. Replay uses original requests; only available media enters reviewed candidates. Withdrawal/takedown fences prevent refresh restoring material; see [Content](../../services/kernel/src/content/README.md) and [deletion policy](../deletion.md).

## Receiving and growth acceptance

Pure converter cases establish mapping, validation, provenance, bounds and determinism; they do not prove native acceptance/adoption, Context return, API receiving, visibility or growth.

Retain receiving obligations for import-to-discovery Context, assertion/return, provider metadata and label extraction, and consumer reads. Source compatibility or documentation is not evidence. Detailed receiving remains with the Person/profession and reviewed-catalogue owners.

### Import-to-discovery

Import selected Work/Edition/Release facts, accept/adopt through Semantic, then verify current reads and discover shared meanings via Search/facets, Collections, Zones and TypeLists. Cover Context/public-private separation across importer proposals, editor actions, anonymous/editor reads and separate Alice/Bob populations, grants and state. Reduced, unscoped/delegated, suspended-valid and revoked callers repeat relevant reads/writes; private grants cannot leak. Hidden Concepts, source fences, aliases with hidden originals and late revocation affect membership, order, counts, cursors and disclosure.

Use released controls and actual mappings. Bangumi tag/form and VNDB name/link do not establish platform/form; Open Library/Wikidata do not establish cross-surface populations. Imports owns mapping/transport; Semantic owns fixtures, releases, receipts, selection/adoption, identity and Zone routing; Search owns indexing/facets/queries; Commerce owns Collections/owner queries; Content owns disclosure; Web owns publication. [Discovery cases](../../services/kernel/test/imports/discovery-user-cases.test.ts) remain acceptance, not completion evidence.

Retain original native scenarios for connected CLI recovery, media recovery, import-to-discovery, statistics and source-only refresh. Fixtures claim only authored fields, not native execution. Retained-metadata cases stay integrated; pure-core cases do not replace them.

Three-scale growth covers conversion and API writes with existing statement, row, byte, page, fan-out and command bounds. Pure-core checks do not replace native receiving/growth. Do not claim completion until all outcomes are promoted with acceptance.

## Acceptance entry points

Use `specs/imports-*.test.ts`, `specs/imported-field-outcomes.test.ts`, conversion tests and importer tests. Native API acceptance remains in `services/kernel/test/imports` and `services/kernel/test/library`. Follow the [verification workflow](../development/verification.md); exact source procedures and commands belong to the [importer contract](../../services/importer/README.md).
