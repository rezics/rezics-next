# Imports capability acceptance

This file states current outcome requirements for the [Imports Goal](imports.md). Source formats, licenses, converter mappings, commands, recovery and costs belong to the [conversion](../../packages/conversion/README.md) and [importer](../../services/importer/README.md) owners. Semantic proposal, acceptance, adoption and Context return belong to [Semantic](../../services/kernel/src/semantic/README.md); media rights and takedown belong to [Content](../../services/kernel/src/content/README.md).

Revision choice: current claims use checked-in exports; the reviewed Person-career range keeps its original revision identifiers as history.

## User outcome

A maintainer can import licensed provider records, inspect omissions, recover safely, and refresh changed or vanished source facts through the ordinary API and permission model. Community tools can use the same pure revisioned converters. Imported data remains a proposal until separately accepted and adopted. Source refresh never erases communal identity or unrelated adopted facts.

## Required source coverage

The four launch sources are Bangumi, VNDB, Open Library and Wikidata. Their exact record grains, formats, revisions, metadata rights, citations and excluded fields are defined in the module READMEs. Acceptance uses pinned, legally usable fixtures; live provider availability is not required.

| Source       | Required fixture and end-to-end outcomes                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi      | Native JSON-lines identity and supported subject kinds; cite permitted summaries; keep covers separately rights-gated; preserve type-specific omissions; refresh, re-import, disappearance and source fences. |
| VNDB         | Real COPY headers and grouped records; preserve native table keys, metadata terms, source revisions, supported statistics and bounded graph associations; exclude creative prose and images.                  |
| Open Library | Native five-column TSV and Work/Edition distinction; retain edition-only page count and ISBN behavior; exclude unknown-licensed prose and covers.                                                             |
| Wikidata     | Native item JSONL and revision; admit only released exact type/property mappings, qualifiers and references; leave unresolved relationships unresolved.                                                       |

## Ordinary import and recovery acceptance

Acceptance covers the complete ordinary caller path: authenticated account-key CLI, current Auth and Access decisions, public batch and source-metadata APIs, current subject/candidate reads, independent editor selection, and anonymous public return. The ordinary importer never writes storage through a private path.

Each source must cover initial import, unchanged reopen, changed record, re-import, vanished record, suspicious mass disappearance, fenced fields, malformed and unsupported values, bounded readers, retryable unavailability, unknown delivery and resumed runs. A denial or unavailable response remains distinct from success. A retry replays the exact sealed bytes and command key under current authority before any replacement intent. A source/field ownership fence prevents replay or refresh from restoring withdrawn material.

Retained metadata remains part of integrated receiving. Keep native acceptance in [list-import-metadata-coordinator.test.ts](../../services/kernel/test/library/list-import-metadata-coordinator.test.ts), [entry-import-metadata.test.ts](../../services/kernel/test/library/entry-import-metadata.test.ts), [list-import-vndb-http.test.ts](../../services/kernel/test/library/list-import-vndb-http.test.ts) and [list-import-bangumi-http.test.ts](../../services/kernel/test/library/list-import-bangumi-http.test.ts). These cover selected native metadata, partial application, original confirmation replay and provider HTTP behavior. Metadata extraction or reader corrections remain with their existing owner.

## Provider-specific contract acceptance

### Source identity and field ownership

A configured alias and exact provider external ID remain one tuple across generations. Converter revision and metadata rights come from source registration. Refresh can update or retract only the importer-owned candidate for the matching source field. It does not replace source identity, independent identifier facts, community assertions or adoption.

### Bangumi people and careers

Person identity, biography, credits and career assertions are independent. The pure converter retains bounded career strings only for actual Persons and emits no P106. The vocabulary mapper requires the exact Person, person source key, source-owned careers Scheme, current bound Concept, released P106 property and exact career citation. A valid item survives an independently malformed neighbor; empty, unknown, malformed and Organization cases produce no unsupported occupation. The source Concepts do not imply canonical equivalence with other providers.

Only the explicit local showcase can fill missing archive careers from PersonDetail. Archive values, including empty or malformed values, take precedence. Fetches apply only to selected Persons, are bounded to 64 requests, spaced 250 ms apart, limited to 64 KiB each and share the import deadline. The exact endpoint, archive digest, response SHA-256 and optional ETag are journaled for restart replay. A missing dependency withholds only the dependent assertion.

The pure mapping, acquisition/replay and native review/current-read cases are described by [conversion career tests](../../packages/conversion/tests/bangumi-person-careers.test.ts), [showcase career tests](../../services/importer/tests/showcase-bangumi-person-careers.test.ts) and [native career tests](../../services/kernel/test/imports/bangumi-person-careers.test.ts).

### Bangumi work, Book, Game and Character outcomes

Keep ordinary and selected-family mappings aligned with the current converter exports. TVAnime official websites and descriptive work evidence remain separate cited properties. Book and Character contracts remain under Registered source vocabulary mapping. Game names, source publication date, platform, engine, literal source genres and player count retain their exact independent meanings.

Creator and voice credits follow Game environment and genre mapping and precede Character identity/appearance. Game cast follows Character identity/appearance immediately. Character appearance requires actual selected work relations, exact Character identity and released role binding. A malformed optional field does not suppress an independently valid association.

Focused source outcomes remain in [Bangumi importer tests](../../services/importer/tests/) and [native imports tests](../../services/kernel/test/imports/). They include TVAnime websites and work evidence, Book names, Game names and publication date, player count, environment and genres, creator/voice credits, character identity/appearance, Game cast, Person biography and source-owned citation behavior.

### VNDB and other source-specific outcomes

Maintain native table and source-key behavior for VNDB releases, staff, producer relations, Character names, aliases, measurements, traits, language, dates, identifiers, public tags and websites. Parent/subsidiary direction, tag weight, role qualifiers, unknown/absent values and unsupported meanings remain distinct. Open Library edition facts remain on Edition; Wikidata claims remain under exact released property and qualifier mappings. See the linked source-owner contracts and the existing importer, conversion and Kernel tests.

### Media rights and deletion

Source metadata, prose, cover intent and media bytes are separate permissions. A metadata descriptor does not authorize prose or image publication. A pending reservation is not an available media identity. Cover receipt replay uses its original request; only available media may enter a separately accepted/adopted candidate. Rights withdrawal and takedown fences prevent later refresh from reintroducing removed material. See the [Content contract](../../services/kernel/src/content/README.md) and [deletion policy](../deletion.md).

## Receiving and growth acceptance

Converter tests establish pure mapping, validation, cited origins, bounded projections and deterministic output only. They do not establish native acceptance, adoption, current Context return, API receiving, anonymous visibility or growth.

The native receiving journey must preserve the original import-to-discovery obligations: current Context selection; actual assertion and return behavior; provider metadata and label extraction; and ordinary consumer reads. No source-compatibility result or documentation landing supplies this evidence. Detailed receiving work remains with the existing Person/profession and reviewed-catalogue owners, including their Context, assertion/return and label extraction work.

Keep the original native suites and their accepted scenarios unchanged, including connected source/CLI recovery, media recovery, import-to-discovery, statistics and source-only refresh. Authored fixtures describe only the fields they contain and do not claim native source execution. The retained-metadata tests above remain integrated acceptance and are not replaced by pure-core cases.

Three-scale growth evidence must cover conversion work and the API write path. Preserve existing database statement, row, byte, page, fan-out and command bounds in the owner contracts. Pure-core checks do not replace native receiving or growth evidence. Do not claim Goal completion until all scoped outcomes are promoted with their recorded acceptance.

## Acceptance entry points

Use the fixture suites under specs/imports-*.test.ts and specs/imported-field-outcomes.test.ts, the conversion package tests and services/importer/tests. Native API acceptance stays in services/kernel/test/imports and services/kernel/test/library. Apply the [verification workflow](../development/verification.md); source-specific procedures and exact commands are in the [importer README](../../services/importer/README.md).
