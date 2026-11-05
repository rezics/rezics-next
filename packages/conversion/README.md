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

The source files export the current revisions: Bangumi is bangumi@15, VNDB is vndb@8, Open Library is open-library@5, Wikidata is wikidata-6, cross-media entities is cross-media-entities@14, Bangumi vocabulary is bangumi-vocabulary@3, VNDB vocabulary is vndb-vocabulary@4, and shared source vocabulary is source-vocabulary@3. Registration imports these values; a source record cannot choose its converter revision. The selected Bangumi entity registration composes the current cross-media and Bangumi exports, currently cross-media-entities@14+bangumi@15.

ConversionInput carries the provider-native external_id, record_revision and record. Revisions are never inferred from dump dates, checksums, row order or converter versions. A missing native revision remains null where permitted; Wikidata uses literal unversioned only when the entity has no lastrevid. Other required provider revisions must match their native record.

Context carries trusted values separately from source data: the selected source alias, an existing subject UUID, resolved native references, available media UUIDs, normalized vocabulary rows, and admitted source-classification facts. Converters do not resolve a source name to an identity, discover graph rows or treat source-body values as caller bindings.

Results contain normalized source data, its digest, diagnostics and portable commands. The caller sends commands through the ordinary bulk contract in definitions. Ordinary imports create proposals; only a separately authorized review path can accept and adopt them. A converter return is not evidence of acceptance, adoption or public visibility.

## Source mappings and limits

| Provider | Native input, grain and current mapping | Rights and exclusions |
| -------- | --------------------------------------- | --------------------- |
| Bangumi | One native subject; supported types are Book, TVAnime, Music, Game and admitted live action. ID maps to P5732; names retain locale, attributed summaries become Text abstracts, and type facts/citations stay on that subject. Unsupported types remain source records without invented subjects. | Summary text requires CC-BY-SA-3.0 attribution/ShareAlike. Cover rights are separate and unknown unless admitted by the media owner. |
| VNDB | Grouped native COPY tables or supported API; visual novels, releases, staff, producers and characters retain native keys and exact table origins. | Permitted metadata uses ODbL-1.0 database and LicenseRef-DbCL-1.0 contents terms. Descriptions, posts, images and other creative material are excluded. |
| Open Library | Native TSV Work/Edition rows map to Book/bf:Instance and retain IDs/relations. Work `first_publish_date` maps to cited `schema:datePublished`; page counts, validated ISBN-13 and dates stay on Edition. | CC0-1.0 permits bibliographic metadata only; unknown-licensed prose and covers are excluded. |
| Wikidata | One JSONL item; exact bundled type, property, rank, datatype, qualifier and time/quantity mappings govern claims; unresolved relations remain unresolved. | CC0-1.0 structured data. Unsupported properties, instructions, user/talk content and Commons images are excluded. |

Provider allowlists never traverse unknown/private subtrees or truncate values. Malformed/unadmitted input becomes bounded diagnostics or omissions, not substitutes. IDs, revisions, labels, citations and languages retain provider meaning; locale uses explicit fields/tags, not spelling or order.

Bangumi name locales follow pinned fields; TVAnime work links are cited descriptive wdt:P973, separate from unfetched schema:url sites. Game website/work-link stay distinct with exact URL bytes. Source profile selects Book/BookSeries; ISBN, publisher, volume and edition facts never assert on the work. Character identity, appearance, aliases and physical quantities stay on Character; units and blood-type Concepts are never guessed.

Game uses the pinned template: Chinese name→zh, aliases→und; cited dates preserve admitted precision and unsupported forms omit. Genres remain unsplit source literals; player counts require complete admitted forms. TVAnime run facts, Copyright notices, official sites and descriptive links retain separate properties/citations; malformed fields do not suppress valid siblings.

Only a Work may use optional top-level Open Library first_publish_date. The exact bounded value participates in the normalized digest and yields an independently keyed, cited schema:datePublished proposal after complete released-statement validation. Existing publish_date and Edition behavior remain separate; malformed or unsupported values are diagnosed, never guessed.

### Bangumi Person careers

The cross-media converter retains at most seven authentic career strings only for an actual type-1 Person and emits no P106. The separate mapper requires the actual Person, exact Person source key, source-owned careers Scheme, exact current bound Concept, released P106 and exact career citation; see [Registered source vocabulary mapping](../../services/importer/README.md#registered-source-vocabulary-mapping). A malformed item cannot erase a valid neighbor; empty, unknown, malformed or Organization cases produce no unsupported occupation. Identifier, biography, credits and careers keep independent citations and refresh behavior.

The reviewed career feature range retains its original revision identities: cross-media-entities@12, bangumi-vocabulary@3 and source-vocabulary@3. These identify that reviewed range, not the current combined registration shown above. The showcase-only fallback is documented under [Explicit local showcase publication](../../services/importer/README.md#explicit-local-showcase-publication).

### Other provider-owned source details

VNDB preserves null/empty Latin cells, selected release names and aliases, and does not rank labels from translation flags. Dates retain year/month/day precision; TBA and absent are distinct gaps without a released status property. Producer par maps current→selected and sub selected→current under P749; neither P355 nor reciprocal rows are invented. Spoilers remain qualifiers; votes, list membership and user data are excluded. COPY unknown, absent and malformed stay distinct. Open Library page counts/ISBNs stay on Editions; unresolved author/work links use somevalue plus the Open Library ID qualifier. Wikidata uses only bundled released claims, never label lookup or approximate mappings. The importer owns source-vocabulary admission.

## Registered source vocabulary rows

A trusted caller supplies already traversed normalized rows and exact released identity bindings. Each row names its provider path, source code and native identity. The mapper validates the current bundled release digest, subject profile, target type, property, qualifier and published source descriptor before producing ordinary commands. It never follows IDs or searches labels.

Missing or invalid schemes, Concepts, endpoints, profile admissions or release pins produce finite SourceVocabularyGap results. No fallback label match or substitute property is emitted. A request accepts at most 128 source rows, bounded schemes and Concepts, and only the remaining slots in the existing 100-command bulk limit. Unknown subtrees are not inspected. Bangumi reciprocal relations coalesce by canonical direction and stable source-path order. VNDB producer parent and subsidiary rows retain their source direction; no reciprocal association or Person-to-Organization claim is invented.

VNDB tag weights require a selected exact Kana response for the same visual novel and tag. The decimal rating and API endpoint/digest retain their source origin; COPY votes are not weights, confidence or ratings. The producer validates exact request IDs, unique occurrence, spoiler and rating ranges before ordinary descriptor validation.

## Identity, citations and media boundary

Caller context supplies existing subject IDs and resolved references; source IDs and titles never resolve identity. Statements cite the source record and required field occurrence. URLs are descriptive, not citations, identities, fetch instructions or licences.

Without a bound subject or available media, conversion may return only a deferred cover intent. It never fetches bytes or invents a media ID; the importer owns media admission, storage, publication, replay and takedown. See [importer media and recovery](../../services/importer/README.md#explicit-local-showcase-publication) and the [deletion policy](../../docs/deletion.md).

## Cost derivation and verification

For bounded record M, conversion/output are O(M); projection, hashing, validation, citations and commands touch only that record. These logical bounds exclude unrelated catalogue/history and are not heap or time measurements.

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

### Project an Open Library Work first publication date

One optional Work scalar, at most 1,500 characters, in the 2 MiB projection; one cited schema:datePublished proposal, no Edition lookup or extra read, within the 100-command ceiling.

Pure converter behavior is described by the existing [Bangumi outcome tests](tests/bangumi-outcomes.test.ts) and [career mapping tests](tests/bangumi-person-careers.test.ts). Provider tests assert mapping, rights references, diagnostics, identity and limits; native API acceptance and growth evidence remain separate importer and Kernel obligations.
