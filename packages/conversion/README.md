# @rezics/conversion

This package turns one licensed source record into bounded, deterministic source data and portable create or proposal commands. It is pure: it does not acquire records or media, call an API, write storage, authorize, accept or adopt a proposal, or retract a prior candidate. The platform importer owns acquisition, replay, rights metadata and ordinary API writes; see the [importer contract](../../services/importer/README.md).

## Package API

The public subpaths are defined in [package.json](package.json).

| Subpath                                 | Public entry                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| @rezics/conversion                      | Shared source and conversion types, diagnostics, errors, and source-classification projection |
| @rezics/conversion/bangumi              | Bangumi converter, revision and result                                                        |
| @rezics/conversion/bangumi-vocabulary   | Bangumi vocabulary mapper and revision                                                        |
| @rezics/conversion/vndb                 | VNDB converter, revision, limits and result                                                   |
| @rezics/conversion/vndb-vocabulary      | VNDB vocabulary mapper, revision, tag-weight producer and row types                           |
| @rezics/conversion/source-vocabulary    | Released binding, identity, row, gap and result types                                         |
| @rezics/conversion/open-library         | Open Library converter, revision and result                                                   |
| @rezics/conversion/wikidata             | Wikidata converter, revision, limits and result                                               |
| @rezics/conversion/cross-media-entities | Cross-source entity converter, revision and source-enumeration mapper                         |

The source files export the current revisions: Bangumi is bangumi@15, VNDB is vndb@8, Open Library is open-library@4, Wikidata is wikidata-6, cross-media entities is cross-media-entities@14, Bangumi vocabulary is bangumi-vocabulary@3, VNDB vocabulary is vndb-vocabulary@4, and shared source vocabulary is source-vocabulary@3. Registration imports these values; a source record cannot choose its converter revision. The selected Bangumi entity registration composes the current cross-media and Bangumi exports, currently cross-media-entities@14+bangumi@15.

ConversionInput carries the provider-native external_id, record_revision and record. Revisions are never inferred from dump dates, checksums, row order or converter versions. A missing native revision remains null where permitted; Wikidata uses literal unversioned only when the entity has no lastrevid. Other required provider revisions must match their native record.

Context carries trusted values separately from source data: the selected source alias, an existing subject UUID, resolved native references, available media UUIDs, normalized vocabulary rows, and admitted source-classification facts. Converters do not resolve a source name to an identity, discover graph rows or treat source-body values as caller bindings.

Results contain normalized source data, its digest, diagnostics and portable commands. The caller sends commands through the ordinary bulk contract in definitions. Ordinary imports create proposals; only a separately authorized review path can accept and adopt them. A converter return is not evidence of acceptance, adoption or public visibility.

## Source mappings and limits

| Provider     | Native input, grain and current mapping                                                                                                                                                                                                                                                                                                      | Rights and exclusions                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi      | One native subject record. Supported types are Book, TVAnime, Music, Game and admitted live-action profiles. The source ID maps to P5732; subjects stay one subject identity. Names keep source locale meaning; summaries become attributed Text abstracts; type-specific dates, infobox facts and citations remain on their source subject. | Summary text carries CC-BY-SA-3.0 attribution and ShareAlike obligations. Cover rights are separate and unknown unless admitted by the media owner. Unsupported types remain source records without invented subjects. |
| VNDB         | Grouped native COPY tables or their supported API form. Visual novels, releases, staff, producers and characters keep their native keys; links, names, measurements, dates and admitted associations retain exact table origins.                                                                                                             | Only the permitted metadata projection uses ODbL-1.0 database and LicenseRef-DbCL-1.0 contents terms. Descriptions, posts, images and other creative material are not proposed.                                        |
| Open Library | A native TSV row carrying a Work or Edition record. Works map to Book; editions map to bf:Instance. Native work/edition IDs and relations are retained. Edition-only page counts, validated ISBN-13 and cited dates stay on the Edition.                                                                                                     | CC0-1.0 covers permitted bibliographic metadata only. Unknown-licensed descriptions are not proposed as prose; covers have separate unknown rights.                                                                    |
| Wikidata     | One JSONL item record. Exact bundled type, property, rank, datatype, qualifier and time/quantity mappings govern supported claims. Unresolved native relations remain unresolved.                                                                                                                                                            | Structured data cites CC0-1.0. Unsupported properties, instruction text, user or talk-page content and Commons images are excluded.                                                                                    |

The input is projected through provider-specific allowlists. Unknown and private subtrees are not traversed; malformed or unadmitted values become bounded diagnostics or omissions rather than substitute facts. No value is truncated to fit. Source identifiers, revisions, labels, citations and language tags retain their provider meaning. Locale normalization uses explicit provider fields and supported language tags; spelling and list order do not infer a preferred label or language.

Bangumi source names preserve field meaning: name is und, name_cn is zh, and localized infobox names use the language specified by the pinned mapping. TVAnime work links are cited descriptive wdt:P973 facts; the separate official-site field is schema:url. Neither link is fetched or used as identity. Game website and work-link fields also remain distinct. Book stays Book or BookSeries according to the selected source profile; ISBN, publisher, volume count and edition facts do not become assertions on the work. Character identity, appearance, aliases and physical quantities remain on the exact Character. Measurement units must be explicit; no missing unit or blood-type Concept is guessed.

Bangumi Game names use the pinned Game template: Chinese name maps to zh and aliases remain und. Publication dates preserve the admitted source date and citation; unavailable, malformed or finer unsupported values are omitted. Source genre literals are not split or translated. Player counts accept only the admitted complete forms. TVAnime run facts, Copyright notices, official websites and descriptive links retain their distinct properties, source citations and field evidence. A malformed occurrence does not suppress an independently valid sibling.

### Bangumi Person careers

The cross-media converter retains at most seven authentic career strings only for an actual type-1 Person. It emits no occupation property. Career proposals are produced separately by the registered vocabulary mapper; the exact binding, source key, current Concept and P106 requirements are in [Registered source vocabulary mapping](../../services/importer/README.md#registered-source-vocabulary-mapping). A malformed career item does not erase an independently valid item. Empty, unknown, malformed and Organization cases do not produce an unsupported occupation. Person identifier, biography, credits and career assertion keep independent citations and refresh behavior.

The reviewed career feature range retains its original revision identities: cross-media-entities@12, bangumi-vocabulary@3 and source-vocabulary@3. These identify that reviewed range, not the current combined registration shown above. The showcase-only fallback is documented under [Explicit local showcase publication](../../services/importer/README.md#explicit-local-showcase-publication).

### Other provider-owned source details

VNDB preserves null and empty native Latin cells distinctly, keeps release-title aliases and preferred names on their selected source entities, and does not rank labels from translation flags. COPY unknown values, absent values and malformed values remain distinct. Open Library page counts and ISBNs are Edition facts only. Wikidata claims are accepted only through the bundled released vocabulary; no label lookup or approximate property mapping is used. Detailed source vocabulary admission is owned by the importer.

## Registered source vocabulary rows

A trusted caller supplies already traversed normalized rows and exact released identity bindings. Each row names its provider path, source code and native identity. The mapper validates the current bundled release digest, subject profile, target type, property, qualifier and published source descriptor before producing ordinary commands. It never follows IDs or searches labels.

Missing or invalid schemes, Concepts, endpoints, profile admissions or release pins produce finite SourceVocabularyGap results. No fallback label match or substitute property is emitted. A request accepts at most 128 source rows, bounded schemes and Concepts, and only the remaining slots in the existing 100-command bulk limit. Unknown subtrees are not inspected. Bangumi reciprocal relations coalesce by canonical direction and stable source-path order. VNDB producer parent and subsidiary rows retain their source direction; no reciprocal association or Person-to-Organization claim is invented.

VNDB tag weights require a selected exact Kana response for the same visual novel and tag. The decimal rating and API endpoint/digest retain their source origin; COPY votes are not weights, confidence or ratings. The producer validates exact request IDs, unique occurrence, spoiler and rating ranges before ordinary descriptor validation.

## Identity, citations and media boundary

An external identifier is not a REZICS identity. Existing subject IDs and resolved references come from trusted caller context. No identity is matched by title. A source statement cites the source record and, where a mapping requires it, its exact source-field occurrence. A source URL is descriptive data, not a citation, canonical identity, fetch instruction or licence.

The converter may return a deferred cover intent without a container when no bound subject or available media exists. It never fetches image bytes or invents a media ID. The importer owns media admission, storage, publication, unknown-delivery replay and takedown fences. See the [importer media and recovery contract](../../services/importer/README.md#explicit-local-showcase-publication) and [deletion policy](../../docs/deletion.md).

## Cost derivation and verification

For one accepted bounded record M, conversion work and serialized result size are O(M). Input projection, hashing, validation, citations and commands operate on that record; work does not grow with unrelated catalogue or history size. These are logical work and output bounds, not machine heap or elapsed-time measurements.

| Converter         | Static input and output envelope                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi           | Projection and infobox each at most 64 KiB; summary Text snapshot at most 32 KiB; bounded tag, title, diagnostic and command arrays; at most one cover intent. |
| VNDB              | Grouped normalized record at most 64 KiB; bounded titles, links and source fields; no media assets.                                                            |
| Open Library      | Normalized record at most 2 MiB; prose at most 1 MiB; bounded field and relation arrays; at most 100 proposals.                                                |
| Wikidata          | Supported item at most 128 KiB; bounded statements, terms, references and snaks; at most 100 commands.                                                         |
| Source vocabulary | At most 128 input rows, bounded released bindings, and no more than the free slots in the 100-command batch.                                                   |

### Cite a VNDB record

Touches one native revision and optional modification timestamp. The record digest includes native source facts; each fact carries the exact source-record reference.

### Project a VNDB release minimum age

One bounded minimum-age scalar, at most one quantity proposal and the existing release citation. No additional source read or identity is created.

### Dispatch a Bangumi record

Identity and type dispatch are constant work. Unsupported source types retain identity-only normalized data; supported records use the 64 KiB projection and existing command limits.

### Project a Bangumi Person birth date

At most one cited day-precision birthDate from the three admitted date integers on one actual Person. Conversion performs no source fetch.

### Project a Bangumi television original run

One bounded TVAnime infobox; at most three cited date, end-date or episode-count facts. Episode, schedule and broadcaster discovery remain outside conversion.

### Project a Bangumi game player count

At most 64 infobox fields and 8 examined count occurrences; one player-count fact and at most one qualifier. Invalid or unsupported count forms produce no count assertion.

### Dispatch a Bangumi book record

One bounded Book profile and infobox dispatch; Book versus BookSeries grain follows the admitted source profile. Counts do not create volumes or editions.

### Project a Bangumi Game environment

At most 64 infobox fields, 16 platform occurrences, 8 engine occurrences and 16 omissions; proposals use current released bindings and the existing batch envelope.

Pure converter behavior is described by the existing [Bangumi outcome tests](tests/bangumi-outcomes.test.ts) and [career mapping tests](tests/bangumi-person-careers.test.ts). Provider tests assert mapping, rights references, diagnostics, identity and limits; native API acceptance and growth evidence remain separate importer and Kernel obligations.
