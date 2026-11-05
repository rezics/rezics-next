# @rezics/conversion

This pure package deterministically turns one licensed provider record into bounded source data and portable create/proposal commands. It does not acquire data or media, call APIs, write storage, authorize, accept, adopt or retract. The platform importer owns acquisition, replay, rights and API writes; see the [importer contract](../../services/importer/README.md).

## Package API

The public subpaths are defined in [package.json](package.json).

| Subpath                                 | Public entry                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| @rezics/conversion                      | Shared source and conversion types, diagnostics, errors and source-classification projection |
| @rezics/conversion/bangumi              | Bangumi converter, revision and result                                                       |
| @rezics/conversion/bangumi-vocabulary   | Bangumi vocabulary mapper and revision                                                       |
| @rezics/conversion/vndb                 | VNDB converter, revision, limits and result                                                  |
| @rezics/conversion/vndb-vocabulary      | VNDB vocabulary mapper, revision, tag-weight producer and row types                          |
| @rezics/conversion/source-vocabulary    | Released binding, identity, row, gap and result types                                        |
| @rezics/conversion/open-library         | Open Library converter, revision and result                                                  |
| @rezics/conversion/wikidata             | Wikidata converter, revision, limits and result                                              |
| @rezics/conversion/cross-media-entities | Cross-source converter, revision, source mapper and Person-name projection                   |

Current exports are Bangumi bangumi@16, VNDB vndb@8, Open Library open-library@5, Wikidata wikidata-6, cross-media entities cross-media-entities@15, Bangumi vocabulary bangumi-vocabulary@3, VNDB vocabulary vndb-vocabulary@4 and source vocabulary source-vocabulary@3. Selected Bangumi entities compose cross-media-entities@15+bangumi@16. Registration imports these revisions; source records cannot choose them.

ConversionInput carries the provider-native external ID, record revision and record. Revisions are not inferred from dump dates, checksums, row order or converter versions. A missing native revision stays null where permitted; Wikidata uses unversioned only when the entity has no lastrevid. Other required provider revisions must match the native record. The importer records the source revision or unversioned digest alongside the converter revision.

Context separates trusted caller values from source data: alias, existing subject UUID, resolved references, available media, normalized vocabulary rows and admitted source classifications. Converters do not resolve identities, discover graph rows or treat body values as bindings. Results contain normalized data, a digest, diagnostics and portable commands for the ordinary bulk contract. A converter return proves neither acceptance, adoption nor current public return.

## Source mappings and rights

| Provider     | Native input, grain and current mapping                                                                                                                                                                                                                                                                                                                                                         | Rights and exclusions                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi      | One native subject; supported types are Book, TVAnime, Music, Game and admitted live action. Source identity retains its native ID; names retain locale, attributed summaries become Text abstracts, and type facts and citations stay on that subject. Unsupported types remain source records without invented subjects. P5732 is admitted only for the exact Bangumi source-site rule below. | Metadata and attributed summaries use CC BY-SA 3.0. Cover rights are separate and unknown until admitted by the media owner.                            |
| VNDB         | Grouped native COPY tables or supported API; visual novels, releases, staff, producers and characters retain native keys and exact table origins.                                                                                                                                                                                                                                               | Permitted metadata uses ODbL 1.0 database and LicenseRef-DbCL-1.0 contents terms. Descriptions, posts, images and other creative material are excluded. |
| Open Library | Native TSV Work and Edition rows map to Book and bf:Instance and retain IDs and relations. Work first_publish_date maps to cited schema:datePublished; page counts, validated ISBN-13 and dates stay on Edition.                                                                                                                                                                                | CC0-1.0 permits bibliographic metadata only; unknown-licensed prose and covers are excluded.                                                            |
| Wikidata     | One JSONL item; exact bundled type, property, rank, datatype, qualifier and time/quantity mappings govern claims. Unresolved relations remain unresolved.                                                                                                                                                                                                                                       | CC0-1.0 structured data. Unsupported properties, instructions, user/talk content and Commons images are excluded.                                       |

Provider allowlists never traverse unknown or private subtrees or truncate values. Malformed or unadmitted input becomes bounded diagnostics and omissions, not substitutes. IDs, revisions, labels, citations and locales retain explicit provider fields, not spelling or order inference. URLs are descriptive evidence, never identities, fetch instructions or licences.

### Bangumi people, works and games

For a type-1 Person, the original name remains under und and name_cn or the exact PersonDetail key 简体中文名 supplies zh. Keep Chinese names beside careers because one selected PersonDetail response may provide both. Preserve exact text and digest input; ETag and Last-Modified are cache metadata. Biography, names, careers and credits remain independent. Careers require the actual Person, exact person key, source-owned careers Scheme, current bound Concept, released P106 and exact career citation. Conversion emits no P106 by itself; source Concepts assert neither canonical occupation nor cross-provider equivalence. Malformed careers omit only their field.

Bangumi identity comes only from an admitted source-site row containing a parsed public /subject/N URL, which yields that exact numeric P5732 identifier. Person and Character URLs, other sites, title lookup and adaptation heuristics never resolve identity. TVAnime work links remain cited descriptive P973, separate from unfetched schema:url sites. Game website and work-link values keep exact URL bytes and separate properties. Source profile selects Book or BookSeries; Book remains a work distinct from bf:Instance, and ISBN, publisher, volume and edition facts never assert on the work. Book formatting retains only the current released value union in this existing mapping section; formatting resemblance does not widen it.

For TVAnime, top-level name_cn and infobox 中文名 are independent observations. Keep differing values as separate cited schema:name facts; deduplicate only exact property, language and text tuples. Original-run values, copyright notices, official sites and descriptive links retain separate properties and citations. Malformed fields omit only themselves.

Game environment and genre mappings stay separate from names, publication dates and player counts. Genres remain unsplit source literals; player counts require complete admitted forms. Platforms and engines require exact released Concept bindings. After Game environment, creator and voice mappings retain the selected source relationships, exact role and Person citations, and released qualifiers. Character identity and appearances follow the credit mapping.

Character mappings preserve exact source values and uncertainty. The spoil_gender field uses only its released enumeration; unknown or malformed values remain omitted instead of being inferred. Character identity, appearances, aliases and physical quantities stay on Character. Units and blood-type Concepts are never guessed.

The bangumi@16 converter admits only the archive's closed { / [value] / } alias lists for TVAnime, Book, Manga and Game templates. Manga retains its Book identity and Book name properties. Preserve exact source text and und language, the 24-name and 500-character limits, and occurrence citations. Unclosed, nested or mixed lists omit only that field and never publish bracket syntax as a name. Ordinary and selected-family registration revisions trigger the existing finite per-record refresh.

### VNDB

COPY preserves null, empty and missing Latin cells as different source values in the normalized digest. An exactly empty optional Latin cell omits only its Romanized alias; whitespace, missing and wrong-type values remain errors. Selected release names and aliases do not rank from translation flags. Dates retain year/month/day precision; TBA and absent are distinct gaps where no released status property exists. Producer par and sub rows map child to parent under P749; P355 and reciprocal rows are not invented. VNDB releases_supersedes.id maps to rid through rezics:releaseSupersedes, while P155/P156 remain chronology. Spoilers remain qualifiers. Votes, list membership and user data are excluded from catalogue conversion. COPY unknown, absent and malformed values stay distinct.

VNDB tag weights require a current exact Kana response for the same selected visual novel and tag. The decimal rating and API endpoint/digest retain source origin; COPY votes and aggregate weights are not native votes, confidence, acceptance, adoption, publication or ratings. Validate exact request IDs, unique occurrence, spoiler and rating ranges before ordinary descriptor validation. Unresolved author/work links stay cited external identifiers until actual resolution; Open Library unresolved links use somevalue with the Open Library ID qualifier.

### Open Library

Only an optional Work first_publish_date is eligible for schema:datePublished. Its exact bounded value participates in the normalized digest and yields an independently keyed, cited proposal only after complete released-statement validation. Existing publish_date and Edition behavior remain separate; malformed or unsupported values are diagnosed, never guessed. Page counts and ISBNs stay on Editions.

### Wikidata time, quantity and word evidence

Validate actual cited statements against released properties and public Definitions before emission. Preserve complete signed partial Gregorian or Julian time values, including every present timezone, before and after value even when zero; absent components stay absent. Quantity amount, bounds and unit remain exact lexical strings. Never coerce or normalize. If any exact-quantity qualifier is skipped, unsupported, unresolved or narrowed, withhold the entire measurement, including loss during projection. The serialized exact quantity has only amount and unit and no exactness flag. Somevalue and novalue remain distinct.

WordCount requires admitted whole-holder identity, language, version and coverage. Include its digest when text is supplied. Partial or unknown coverage omits WordCount; characterCount is separate. Do not invent vocabulary, options, holder identity or qualifier support. Item qualifiers, new mappings and unresolved discovery remain unsupported. These rules do not deliver a producer, runtime or schema release.

## Reviewed source vocabulary

A trusted caller supplies already traversed normalized rows and exact released identity bindings. Each row names its provider path, source code and native identity. The mapper validates the current bundle digest, subject profile, target type, property, qualifier and published source descriptor. It never follows IDs or searches labels. Missing or invalid Schemes, Concepts, endpoints, profile admissions or release pins produce finite addressable SourceVocabularyGap results; valid rows survive malformed neighbors.

A request accepts at most 128 source rows, bounded Schemes and Concepts, and only the remaining slots in the existing 100-command batch. Unknown subtrees are not inspected. Bangumi reciprocal relations coalesce by canonical direction and stable source-path order. VNDB tags retain exact tag code and category and map to cited schema:genre only through supplied exact released Scheme and Concept bindings. Producer parent and subsidiary rows keep source direction; no reciprocal association or Person-to-Organization claim is invented.

Reviewed resolvedReferences keys use v1 plus compact UTF-8 JSON for the exact ordered tuple, with no normalization, hashing or truncation; the key retains its 255-byte cap. Platform-seed v1 identities are a separate namespace: unpadded base64url of the UTF-8 tuple JSON. Their external ID and complete public command key are each checked against the 255-byte cap before effects, and native receipts retain the exact owner and command. Neither representation rewrites provider identity.

## Exact-quantity handoff

For every exact-quantity assertion, preserve every actual source qualifier losslessly in the same native statement through reviewed mappings and the admitted property's schema. If any qualifier would be skipped, unsupported, unresolved or semantically narrowed, withhold the whole measurement and diagnose the loss. The value schema is closed to amount and unit, with neither lowerBound nor upperBound and no serialized exact flag; see the [Definitions owner API](../definitions/README.md#exact-quantities).

Wikidata wikidata-6 composes the complete cited candidate with the actual bundled property and calls public checkStatementInput before emission, retaining final batch validation. Time keeps signed 4–16 digit nonzero years, Gregorian/Julian calendar, precision 9/10/11 and optional safe timezone and nonnegative uncertainty. Quantity amount, bounds and unit remain exact lexical strings. Unsupported or incomplete values withhold the entire statement with bounded diagnostics. The complete candidate and all source references remain intact; rejecting a proposal does not authorize rewriting evidence or prior commands.

## Identity, citations and media boundary

Caller context supplies existing subject IDs and resolved references; source IDs and titles never resolve identity. Statements cite the source record and required field occurrence. Without a bound subject or available media, conversion may return only a deferred cover intent. It never fetches bytes or invents a media ID. The importer owns media admission, publication, replay and takedown; see the [importer media contract](../../services/importer/README.md#shared-showcase-and-media) and [deletion policy](../../docs/deletion.md).

## Cost derivation

For bounded record M, conversion and output are O(M); projection, hashing, validation, citations and commands touch only that record. Logical bounds exclude unrelated catalogue/history and do not claim heap or time measurements.

| Converter         | Static input and output envelope                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi           | Projection and infobox at most 64 KiB; summary Text snapshot at most 32 KiB; bounded tag, title, diagnostic and command arrays; at most one cover intent. |
| VNDB              | Grouped normalized record at most 64 KiB; bounded titles, links and source fields; no media assets.                                                       |
| Open Library      | Normalized record at most 2 MiB; prose at most 1 MiB; bounded field and relation arrays; at most 100 proposals.                                           |
| Wikidata          | Supported item at most 128 KiB; bounded statements, terms, references and snaks; at most 100 commands.                                                    |
| Source vocabulary | At most 128 input rows, bounded released bindings and no more than the free slots in the 100-command batch.                                               |

- VNDB citation touches one native revision and optional modification timestamp; each fact carries the exact source-record reference.
- VNDB release minimum age touches one bounded scalar, at most one quantity proposal and its existing citation; no additional read or identity.
- Bangumi dispatch is constant work; supported records use the 64 KiB projection and command limits, while unsupported types retain identity-only normalized data.
- Bangumi Person birth date emits at most one cited day-precision fact from the three admitted date integers on an actual Person, without a source fetch.
- Bangumi Person Chinese name uses one actual Person, at most two schema:name facts, a 64 KiB record, 64 infobox entries, 4,096 UTF-8 bytes and 500 codepoints per name, and at most 16 diagnostics.
- Bangumi TVAnime original run uses one bounded infobox and emits at most three cited date, end-date or episode-count facts. Episode, schedule and broadcaster discovery are outside conversion.
- Bangumi Game player count examines at most 8 count occurrences across 64 fields and emits one count with at most one qualifier.
- Bangumi Book dispatch uses one bounded Book profile and infobox. Book versus BookSeries follows the admitted source profile; counts do not create volumes or editions.
- Bangumi Game environment examines at most 64 fields, 16 platform occurrences and 8 engine occurrences with at most 16 omissions; proposals use current released bindings.
- Open Library Work first publication uses one optional scalar of at most 1,500 characters in the 2 MiB projection, one cited proposal, no Edition lookup or extra read, and the 100-command ceiling.

Pure mapping cases establish determinism, provenance and bounds. They do not replace native importer/Kernel acceptance or growth evidence; see [Imports capability acceptance](../../docs/goals/imports.capabilities.md).
