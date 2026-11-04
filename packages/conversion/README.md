# `@rezics/conversion`

`@rezics/conversion` is a pure source-record converter shared by platform and
community tools. It returns sanitized source data, deterministic digests, and
portable create or proposal commands. It does not fetch records or images, call
an API, write storage, authorize a caller, create or adopt a subject, run a job,
or retract a previous candidate.

## Package API

The [package exports](package.json) are only these entry points:

| Import                                    | Named exports                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@rezics/conversion`                      | `SourceId`, `SourceRecord`, `ConversionInput`, `ConversionDiagnostic`, `ConvertedRecord`, `ConversionError`, `projectSourceClassification`             |
| `@rezics/conversion/bangumi`              | `convertBangumi`, `converter_revision`, `BangumiConversion`                                                                                            |
| `@rezics/conversion/bangumi-vocabulary`   | `mapBangumiVocabulary`, `bangumiVocabularyRevision` and Bangumi row types                                                                              |
| `@rezics/conversion/vndb`                 | `convertVndb`, `converter_revision`, `vndbLimits`, `VndbConversion`, `VndbOptions`                                                                     |
| `@rezics/conversion/vndb-vocabulary`      | `mapVndbVocabulary`, `vndbVocabularyRevision` and VNDB row types                                                                                       |
| `@rezics/conversion/source-vocabulary`    | Released binding, identity, row, gap and result types                                                                                                  |
| `@rezics/conversion/open-library`         | `convertOpenLibrary`, `converter_revision`, `OpenLibraryConversion`                                                                                    |
| `@rezics/conversion/wikidata`             | `convertWikidata`, `converter_revision`, `wikidataLimits`, `WikidataConversion`                                                                        |
| `@rezics/conversion/cross-media-entities` | `convertCrossMediaEntity`, `converter_revision`, `mapSourceEnumeration`, `vndbStaffNameLimit`, `vndbCharacterNameLimits`, `CrossMediaEntityConversion` |

Each converter takes an input, an optional context, and optional registered
converter options. The option is `converterRevision`; import the matching
module's `converter_revision` and pass it explicitly, as shown in the example
below. The source value on the input record is never a converter registration.
Core types and `ConversionError` are defined in [`index.ts`](src/index.ts).

Converters emit commands from `@rezics/definitions/bulk`. That package owns
`BatchCommand`, `BatchWriteRequest`, `BatchWriteResult`, their schemas, and
`checkBatchWrite`. Use those public contracts for the caller's chosen transport;
do not define a second batch schema. Conversion functions return portable
commands and do not send them.

The shared input type is:

```ts
type ConversionInput<T = unknown> = {
  external_id: string;
  record_revision: string | null;
  record: T;
};
```

`external_id` and `record_revision` come from the source record. Never derive a
revision from a dump date, file checksum, row position, or converter version.
Where the source contract permits a missing native revision, the source
envelope serializes it as literal `unversioned`; the digest still detects
changes in accepted source fields. Bangumi accepts a missing native revision as
`null`. Wikidata requires
`record_revision: 'unversioned'` when its entity has no `lastrevid`; otherwise
the input must match that native revision. VNDB and Open Library require their
native revisions. A missing revision is never fabricated.

Context supplies trusted, real target bindings separately from the source body:

| Context field          | Meaning                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjectId`            | Existing or actually created REZICS subject UUID. With no subject, converters that support bootstrap return a `create`; with one, they return `propose` commands. |
| `resolvedReferences`   | Source-native relation key to an actual resolved subject UUID. Unresolved relations remain unresolved.                                                            |
| `mediaIds`             | Exact source URL to an actual available media UUID. No image statement is proposed without this mapping.                                                          |
| `source`               | Trusted registration alias written to source envelopes and used in command keys. Set it from registration configuration, never from `record`.                     |
| `sourceVocabulary`     | Optional normalized rows already traversed by the graph caller and explicit released identity bindings; it never discovers rows or creates identities.            |
| `sourceClassification` | Optional admitted sanitized classification facts. Public VNDB dump licences stay unadmitted; this never identifies a native association.                          |

The context shape is accepted by the converter functions, but its implementation
type is internal to [`support.ts`](src/support.ts), not an exported package
subpath. The converter's `converter_revision` option is also trusted
registration data, not a field read from the source body.

## Registered source vocabulary rows

The importer registration invokes the matching pure mapper when a trusted caller
supplies `sourceVocabulary`. Each row names its exact source path, source code,
and already resolved native identities. The graph owner still owns traversal,
entity creation and the reference frontier. A mapper will not follow IDs or
infer a target from names. It validates the bundled immutable release digest,
subject profile admission, target type, property and qualifier against the
published descriptor before returning ordinary `BatchCommand` proposals.

Concepts are resolved by the exact taxonomy and source code in the supplied
bindings. Bangumi's inventory-pinned episode-kind, character-kind and
appearance-role schemes must also match their exact scheme URI. VNDB concept
tables without an inventory scheme URI still require one explicit resolved
released Scheme binding from the caller. Missing release pins, schemes,
concepts, endpoints or profile admissions return finite `SourceVocabularyGap`
records; no fallback label match or substitute property is emitted. Output is
bounded to 64 input rows and the remaining slots in the existing 100-command
batch limit after ordinary source proposals. Unknown
subtrees are never inspected; resolved scheme and concept bindings are capped
at 64 and 512 entries per request. Bangumi reciprocal relation rows coalesce by
canonical direction with a stable source-path order. VNDB tag bindings retain
their exact content, erotic-content or technical category. VNDB `producers_relations`
`par` emits current id → selected pid under released `wdt:P749`; `sub` stores the
same property losslessly reversed as pid → current id. Dictionary `P355` is not
emitted, reciprocal rows are not fabricated, and a Person-typed producer stays a
source loss instead of an Organization parent statement.

VNDB release dates retain year, month or day precision. `TBA` and absent values
remain distinct gaps when the release profile has no admitted status property;
they are not converted to placeholder dates. Release supersession stays a
release-to-release `wdt:P155` relation and reports the missing profile admission
on `wd:Q20631656`; it is never moved to the represented work. Tag spoiler levels
and character-trait spoiler levels remain qualifiers, while votes, list membership
and user data remain outside these proposals. A `chars_traits.lie` true flag is
withheld as a false-positive association rather than published as a trait.
Character appearance roles publish `schema:character` with an exact `wdt:P3831`
concept and spoiler qualifier; a present `chars_vns.rid` withholds the appearance
instead of asserting an unqualified work-level fact. Mapping-specific revisions and the
complete source, reference, statement and rights bytes are part of deterministic
command keys, so a sealed command cannot be replayed with changed mapping bytes.

Each result includes a `normalizedRecord` containing only the source fields the
converter accepts. Unknown and private subtrees are not carried into it. For each
visited source object or array, `node:util`'s `types.isProxy` rejects
Proxies before reflection or property access; own data descriptors then prevent
source getters from running. Classification costs constant work per visited
node within the existing field caps; unknown/private subtrees remain unvisited.
For an exact quantity, one unmapped qualifier's actual key may remain with an empty
snak list so rejection survives importer serialization and reconversion; its
unknown body is never read or retained. This is source-key evidence, not a
serialized exactness or loss flag. Its `digest` is a deterministic SHA-256
digest of that sanitized source projection;
target bindings, source aliases, and converter registration are excluded. The
digest changes when the sanitized source projection changes, but not when that
same data is rebound to a target or registration. Converter revision is part
of command identity, so changing it changes command keys while the source
digest remains data-only.

Invalid input or context throws `ConversionError` with a `code` and an
RFC 6901 `pointer`; it does not expose source text in an error message.
`diagnostics` report fields that were safely retained or skipped because they
have no supported mapping or permission. A diagnostic is not a proposal.

## Public community caller example

[`examples/public-bulk.ts`](examples/public-bulk.ts) is an executable, reusable
four-source example independent of the platform importer. It selects the actual
public converter export and its matching `converter_revision` for `bangumi`,
`vndb`, `openlibrary` or `wikidata`. It is a source example, not another package
entry point. Import it by its file path in a community tool:

```ts
import { publicBulkRecord } from './public-bulk.ts';
import type { ConversionInput } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';

// Acquired and validated source input and an ordinary authorized transport owned by the caller.
declare const input: ConversionInput;
declare const batchWrite: (request: BatchWriteRequest) => Promise<BatchWriteResult>;
const result = await publicBulkRecord(input, 'bangumi', batchWrite, 'community-bangumi');
if (result.outcome === 'submitted') {
  // Inspect result.proposalResponse.results for each command's public outcome.
  console.log(result.subjectId);
}
```

The optional last argument is a trusted source registration alias, defaulting to
the selected source kind (including `openlibrary`). It never comes from the
source body. The example imports each public module's revision itself. The first
write contains only the metadata bootstrap. Before binding any identity, the
example validates the public result schema, exactly one successful create result
for that exact command key, and its returned subject UUID. Missing, mismatched,
malformed or unsuccessful identities throw a safe `ConversionError` before any
bound send. It seals normalized native input before awaiting transport, then
reconverts it through the same selected export with the returned identity and
trusted registration. It leaves the supplied input unchanged.

Ignored Bangumi/Wikidata records return `outcome: 'ignored'` without writes;
unsupported source selection throws `ConversionError`. `submitted` means that
the second batch was sent: it does not mean that all commands succeeded or that
any candidate was adopted. The caller owns credentials, transport, retries,
receipt retention, source fences and editorial selection. Server Auth, Access,
current tuple fences, disclosure and rights checks remain authoritative.
This example adds no importer, registration service, journal or retry system.
It does not resolve relations, acquire media or send source statistics. Its native
journey deliberately supplies metadata only, with no media intents or vote
fields; it makes no claim about media availability or nonzero statistics.

Local protocol-double tests in
[`public-bulk-example.test.ts`](tests/public-bulk-example.test.ts) cover all four
real exports, immutable input, ignored/unsupported input and rejection before
binding. The separate frozen native journey uses real Auth account-key issuance,
ordinary public bulk HTTP requests and actual returned IDs, native receipts and
source/candidate rows, editor selection and public reads. The unchanged native
scenario passed at `a23f3991f07b9d1ed3f970c6d1e914067c789ad2`: one case,
386 assertions. This is metadata-only native evidence; integration, discovery
and media/statistics outcomes remain separate. Its raw log, receipt anchors
and limits are recorded in the
[community caller report](../../docs/research/imports-audit/community-converter-caller.md).
Run that native scenario through the repository check wrapper:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/imports/community-converter-caller.test.ts
```

## Source mappings and limits

| Source                                                                           | Accepted record and mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Rights and exclusions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bangumi                                                                          | A subject whose `type` is `1` (book), `2` (anime, mapped to TV series), `3` (music, mapped to MusicAlbum), `4` (video game), or `6` (live action: movie platform to Movie, pinned TV-template platforms to TVSeries). Archive integer platform ids stringify; public type/type_cn/alias strings are accepted. Grain uses `liveActionWorkType` plus infobox templates; type 1 uses series flag, novel platform and wiki template for Book versus BookSeries. The external id maps to `wdt:P5732`; names are candidates. A non-empty summary becomes a literal Text-profile `schema:abstract` snapshot, with the serialized snapshot capped at 32 KiB. Types `1`, `3` and `6` also cite a parseable `date` as `schema:datePublished`. Type 2 TVAnime infobox `放送开始`, `播放结束` and `话数` become `schema:datePublished`, `schema:endDate` and `schema:numberOfEpisodes` on TVSeries. Type 4 Game infobox `游玩人数` becomes `schema:numberOfPlayers` on VideoGame; a stated inclusive range stores its upper endpoint as the amount and its lower endpoint as `schema:minValue`. | The summary proposal carries CC-BY-SA-3.0 attribution and ShareAlike obligations. A cover has separate unknown rights. The executable converter currently retains other accepted fields such as tags, platform, remaining infobox keys, and NSFW status only in sanitized source data or diagnostics; it does not emit catalogue facts for them. Existing permitted omissions of opaque infobox and image keys remain in force. Type `1` cites a parseable `date` as `schema:datePublished` on Book or BookSeries; types `2` and `4` still retain top-level `date` as a diagnostic. ISBN, publisher and page counts stay off Book/BookSeries rather than inventing an edition. |
| VNDB                                                                             | Grouped metadata from real COPY `.header` tables: `vn`, `vn_titles`, and `entry_meta`. The converter also accepts grouped `vn_extlinks` and `extlinks` data. The projection uses VN identity, native `entry_meta.revision`, titles, and supported external links. Titles become names; only supported website links become URL facts. The `cross-media-entities@4` entity converter admits the same website interpretation on selected staff, producer and release identities through `staff_extlinks` / `producers_extlinks` / `releases_extlinks` plus `extlinks`; one dictionary row may serve several owners. Decision: `schema:url` is a source-listed website, not an official-site, sameAs, or fetch claim; unsupported site codes stay diagnostics.                                                                                                                                                                                                                                                                                                                         | Source metadata identifies ODbL-1.0 database permission and `LicenseRef-DbCL-1.0` contents permission for the permitted metadata projection. Descriptions, covers, posts, and other creative content are not proposed. These source permissions do not license all VNDB contents or set the output database's license. Entity website URLs emit no facts licence or description.                                                                                                                                                                                                                                                                                               |
| Open Library                                                                     | The JSON payload carried by the native TSV row, for `/type/work` or `/type/edition`. A work bootstraps as `schema:Book`; an edition as `bf:Instance`. The native revision is cited as `schema:version`, and `last_modified` is cited as a day-precision `schema:dateModified`. For editions, valid ISBN-10 values are checksum-validated and converted to ISBN-13; only ISBN-13 is proposed. An unresolved author or work relation has value `somevalue` and keeps its Open Library identifier as a `wdt:P648` qualifier; a real native resolution may be supplied in `resolvedReferences`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `CC0-1.0` describes the permitted bibliographic metadata source. Unknown-licensed descriptions are kept as metadata and never proposed as summary text. Links and publishers are metadata-only. Covers have separate unknown rights. This permission does not claim all dataset contents share the metadata license or set the output database's license.                                                                                                                                                                                                                                                                                                                      |
| Wikidata                                                                         | A real Q entity with `type: 'item'`. Bundled exact type mappings plus the reviewed source bindings below control supported types. Bundled properties control claims, datatypes, ranks, qualifiers and time/quantity handling. Labels and descriptions become bootstrap terms; names and supported claims become bound proposals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Labels, descriptions and claims cite CC0-1.0 structured data. Unknown properties, instruction text, `P18` and Commons images are excluded. No image assets or user/talk-page content are imported. CC0 source data does not set the output database's license.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| The default selected-family seed now supplies `vn_extlinks` and only their       |
| matching `extlinks` dictionary rows to each ordinary VN conversion. A selected   |
| `site=website` entry remains a source-listed `schema:url` proposal under the     |
| existing public URL policy. Separately, an admitted `https://bgm.tv/subject/N`   |
| or `https://bangumi.tv/subject/N` citation on that VN may propose exact          |
| `wdt:P5732` value `N`; other website values and entity-owner links remain URL    |
| assertions. The VN and anime keep separate identities and types; work relations  |
| come only from their source relation records. The caller records raw and         |
| normalized link digests under its own `vndb-work-links@1` proposal revision; the |
| upstream VNDB revision stays sourced from `entry_meta.revision`.                 |

Wikidata revision `wikidata-5` adds conversion-local source type bindings. These
classifications do not assert vocabulary equivalence and do not change Definitions:

| Wikidata P31 class (English label verified on its page)                | Proposal type     |
| ---------------------------------------------------------------------- | ----------------- |
| [Q746549 — dish](https://www.wikidata.org/wiki/Q746549)                | `schema:Recipe`   |
| [Q2095 — food](https://www.wikidata.org/wiki/Q2095)                    | `wd:Q2095` (Food) |
| [Q25403900 — food ingredient](https://www.wikidata.org/wiki/Q25403900) | `wd:Q2095` (Food) |

Only direct, non-deprecated P31 classifications participate; there is no subclass
lookup. A dish also classified as food is a Recipe, in either claim order. Any
other mapped-type conflict retains the `Ambiguous mapped Wikidata entity types`
refusal, and unbound types stay ignored. Existing exact mappings remain supported.
Labels and descriptions keep the existing supported-language projection and caps.
Bootstrap terms carry the dish name and description; after subject binding,
name and claim proposals carry Wikidata citations. No method text is generated.

Decision: P186 already names the bundled `wdt:P186` property but has no exact
mapping; bind that existing identity locally without changing Definitions or other
property mappings. This emits `madeFromMaterial` using its bundled datatype and
qualifier rules. Only caller-supplied `resolvedReferences` link ingredients to real
Food subjects; unresolved items retain `somevalue` and their Wikidata identity
citation. No subjects or resolutions are invented. The CC0 boundary covers labels,
descriptions and claims; `P18`, media and document mappings are excluded, including
Commons images with separate file licences and all preparation instructions.

Bangumi revision `bangumi@6` keeps types `3` (music) and `6` (live action)
on the same bootstrap and bound proposal path as types `1`, `2`, and `4`.
Music uses admitted `schema:MusicAlbum` as Semantic's documented fallback;
tracks, recordings and releases are not invented from titles or disc labels.
Live action selects `schema:Movie` or `schema:TVSeries` from pinned platform
and wiki-template evidence; unknown platform codes stay `outcome: 'ignored'`
with an exact `/platform` diagnostic and a full sanitized projection. A prior
identity-only `{id, type}` projection for types `3` and `6` remains ignored so
an interrupted `bangumi@4` baseline can be reconverted, then a named payload
refreshes under this revision. Unknown or invalid types still fail with
`unsupported_type`. Types `2` and `4` keep their previous class bindings and
retry keys. Platform and community tools use this same pure module; importer
skipped-count accounting is separate.

Bangumi revision `bangumi@9` converts the pinned TVAnime infobox fields
`放送开始`, `播放结束` and `话数` on type 2 through the same bound proposal
path, preserving `bangumi@7` TVAnime name extraction. Start and end keep
Gregorian year/month/day precision, including explicit `年月日` spellings;
weekday, relative, range and other schedule text stay field omissions. An
exact episode total becomes the released nonnegative unitless integer
quantity; template `*` and other placeholders are unknown, while an explicit
`0` is a stated zero. OVA, Movie and custom templates remain unmapped.
Unchanged dump bytes refresh under this revision without inventing a native
record revision.
Decision: original-run start is infobox `放送开始`. Type-2 top-level `date`
stays unmapped. If both parse and the top-level date asserts a finer or
different component than the infobox, withhold `datePublished` rather than
emit two scalars or pad the infobox date. An end that cannot overlap the
start withholds both run dates. An end date is not completion, watch or
access authority.
Decision: original-run admission advances `bangumi@7` to `bangumi@8` so
unchanged dumps offer the new facts; TVAnime name extraction is preserved.

Bangumi revision `bangumi@9` converts pinned Game infobox `游玩人数` on type 4
through the same bound proposal path, preserving `bangumi@8` TVAnime original-run
mapping. A single stated maximum emits only `schema:numberOfPlayers`. An
inclusive lower/upper range emits the upper endpoint as the exact unit-1 amount
and the lower endpoint as `schema:minValue`. Quantity uncertainty bounds are not
a substitute for that source range. Mode, platform, edition or other condition
text withholds the whole occurrence. Zero, negatives, reversed ranges, decimals,
unbounded counts, contradictory occurrences and unsupported markup stay field
omissions, and a malformed mixed field contributes no partial count. Unchanged
dump bytes refresh under this revision without inventing a native record
revision.
Decision: Game-template `游玩人数` admits only an entire-field unqualified
positive integer or inclusive range; a lone count invents no minimum.
Decision: player-count admission advances `bangumi@8` to `bangumi@9` so
unchanged dumps offer the new fact; TVAnime original-run mapping is preserved.

Cross-media entity revision `cross-media-entities@6` retains an admitted
Bangumi `person.summary` for the source-selected `schema:Person` or
`schema:Organization` identity. Its exact bytes enter the normalized digest;
nonempty text becomes an `und` `schema:abstract` document proposal with the
Bangumi citation and CC-BY-SA-3.0 attribution and ShareAlike rights. Empty and
absent summaries produce no document. Summary commands remain in `summary`,
separate from identity facts, metadata licences and image rights.
Decision: biography admission advances the existing `@3` converter to `@4`, preserving the prior VNDB release-title projection revision.
Decision: release original language advances the existing `@4` converter to `@5`, preserving biography, websites, staff names and release-title projection.
Decision: release minimum age advances the existing `@5` converter to `@6`, preserving biography, websites, staff names, release titles and original language.

Decision: type 3 uses admitted `schema:MusicAlbum` because Semantic has no music work/release/track split; type 6 uses `schema:Movie` for pinned movie platforms and `schema:TVSeries` for pinned TV-template platforms, sharing `liveActionWorkType`; archive integer platform ids stringify; unknown live-action platform codes stay ignored at `/platform`. MusicAlbum has no library profile. Bangumi episode records stay the graph continuation.

For Bangumi, the canonical default source alias is `bangumi`; for VNDB it is
`vndb`; and for Wikidata it is `wikidata`. Open Library's default source
envelope alias is `open-library`, while importer `sourceKind` and reader
`SourceId` use `openlibrary`. A trusted importer registration may configure
another envelope alias through `context.source`; keep that registration
separate from each input record.

The complete source envelope records `source`, `external_id`,
`record_revision`, `converter_revision`, `digest`, and `field_group` (`facts`,
`summary`, or `cover`). Source permissions apply only to the fields described
above. They are not a blanket license statement for a whole dataset, and they
do not assert a license for the REZICS output database.

Source-specific hard limits reject oversized records and fields rather than
silently truncating them. The main caps are:

- Bangumi: 64 KiB normalized projection, at most 64 tags, and a serialized Text
  snapshot no larger than 32 KiB.
- VNDB: 64 KiB projection, at most 64 titles, 64 alias lines, and 32 external
  links; at most 162 commands (1 identifier + 64 names + 64 alternate names +
  32 URLs + 1 original language). A VideoGameRelease title projection reuses
  those title/alias/byte caps and at most 163 commands (1 identifier + 64 names
  - 64 Romanized alternate names + 32 URLs + 1 original language + 1 GTIN).
- Open Library: 2 MiB projection, at most 64 entries per collection and 64
  combined author/work relations, at most 1 MiB of unlicensed prose retained as
  metadata, and at most 100 commands.
- Wikidata: 128 KiB source record, at most 64 terms and statements, 15
  references per statement, 16 snaks per group, and 100 commands.

See the source implementations for detailed field validation and limits:
[`bangumi.ts`](src/bangumi.ts), [`vndb.ts`](src/vndb.ts),
[`open-library.ts`](src/open-library.ts), and [`wikidata.ts`](src/wikidata.ts).
The canonical digest and source-envelope helpers are in
[`support.ts`](src/support.ts).

VNDB revision `vndb@8` cites the required native `entry_meta.revision` as
`schema:version` on every bound fact, alongside its identifier and revision URL.
When available, `entry_meta.lastmod` is retained exactly in the sanitized source
projection and digest, and cited as a Gregorian day-precision
`schema:dateModified` using its native calendar day. Missing modification dates
remain absent; no fetched, ingested, current or publication time is substituted.

### VNDB optional Latin-cell source contract

The required source contract accepts `vn_titles.latin` as `null`, the exact
zero-length string `''`, or meaningful nonempty Romanization. The sanitized
source projection must preserve each accepted value exactly: `null` retains
native absence, and `''` remains `''` rather than being rewritten to `null`.
For `''`, emit no Romanized name, label or alias in either bootstrap or resolved
conversion. Null continues to emit none; nonempty Romanization retains the
current canonical language behavior. The primary title remains required and
meaningful, with its existing language behavior.

Whitespace-only Latin, missing or wrong-type Latin, and empty, blank or null
primary titles remain invalid. Do not trim invalid data into absence or relax
the shared meaningful-title validation. Accepted sanitized `null` and `''`
must have distinct source digests even when their semantic names agree.
Repeated conversion, bootstrap/resolution bindings and converter revision
changes must preserve each data-only digest. Native `entry_meta` revision and
modification-date policy above remains unchanged.

This is adopted REZICS treatment of schema-permitted zero-length input, not a
claim that VNDB equates `''` with SQL NULL. The complete pinned observation in
the [empty Latin-cell evidence report](../../docs/research/imports-audit/vndb-empty-latin.md)
found 34,600 NULL and 43,433 nonempty Latin values among 78,033 rows, with zero
empty or whitespace-only Latin values. Exact-empty acceptance is therefore a
synthetic schema-edge requirement, not an observed source-record replay.
The report supplies evidence; this README owns the adopted source contract.

The converter at `vndb@8` accepts this exact-empty source edge and preserves it
in the normalized projection and data digest. Pure tests verify the name
omission, null distinction, digest stability, and strict invalid controls. The
frozen native COPY acceptance verifies staged empty-cell composition and public
bulk effects. This narrow result does not establish every discovery,
statistics, or publication capability.

### VNDB character measurements

`cross-media-entities@4` projects admitted `chars.height` and `chars.weight`
COPY cells onto `wd:Q95074` as exact `schema:height` and `schema:weight`
quantities. Height stays centimetres (`wd:Q174728`) and weight kilograms
(`wd:Q11570`); values are not converted. The pinned dump COPY is PostgreSQL
text TSV: height is `smallint NOT NULL DEFAULT 0`, so unknown height is the
cell `0`; weight is nullable, so unknown weight is `\N` after COPY decode.
Exact `0` is never a measured zero. Malformed, signed, nonfinite, fractional
or over-smallint cells stay addressable diagnostics. Withdrawn property or
centimetre/kilogram admission withholds the fact. Missing measurements leave
character identity intact. Measurement cells enter the source digest, so
unchanged dump bytes still refresh under this revision.
Decision: dump-unknown height is COPY `0`; dump-unknown weight is COPY `\N`;
exact `0` is never a measured zero.

### VNDB character blood type and gender variants

Decision: VNDB `chars.bloodt` imports only explicit `a`, `b`, `ab` and `o`
values as source-specific Concepts on `wdt:P1853` at
`https://rezics.com/schemes/vndb/character-blood-types/{code}`; no Wikidata
equivalence is inferred, `unknown` and malformed values are omitted, and both
gender variants stay withheld until the admitted native contract can represent them.

The checked cache manifest identifies `vndb-db-2026-11-04.tar.zst`
(`fadbe611c4d6475ef63a0c1861512bc9ff64d21c6c9804a988522c7c65f6fa85`). Its
`schema_vndbid.sql` SHA-256 is
`d608ec4022029bdb65a5c780bbf8ca46e3348f16eaa7b88290efde35e2dd4758`; that
archive schema spells the fields `bloodt blood_type NOT NULL`, `gender
char_gender` and `spoil_gender char_gender`. The same archive's `chars.header`
confirms `bloodt` as the third column. Its README specifies PostgreSQL COPY
text TSV escaping: `\N` is null after decoding; the explicit source enum code
`unknown` remains a distinct literal. The official
[VNDB API character contract](https://api.vndb.org/nyan) lists `a`, `b`, `ab`
and `o`; the official
[VNDB schema](https://g.blicky.net/vndb.git/tree/sql/schema.sql?id=55866ce6cb150d2de85e5f204828eafae5e50bc5)
defines `blood_type` as `unknown`, `a`, `b`, `ab` and `o`.

`cross-media-entities@10` retains the classification input in the deterministic
digest, preserves measurement cells when the character-name projection is
present, and records actual versus spoiler gender as separate source variants.
Only the four explicit blood types reach `vndb-vocabulary@3`; the bounded
binding reader verifies the current `ConceptScheme` URI, each current Concept
URI and its `skos:inScheme` association before proposing. The URI pattern is
`https://rezics.com/schemes/vndb/character-blood-types/{code}` and does not
assert Wikidata equivalence. The native gender qualifier gap stays explicit.

- Touches: selected-family VNDB Character records, current blood-type scheme
  and Concept reads, and ordinary `wdt:P1853` proposals with `/chars/bloodt`
  citations.
- Bound: at most 256 selected Characters, one scheme and four Concepts; no
  catalogue scan or taxonomy creation. Unsupported values omit only this fact.
- Growth check: importer `vndb-character-profile.test.ts` covers COPY decoding,
  selection, identity/citation, unknown omission, gender withholding and
  measurement retention. Kernel `imports/vndb-character-profile.test.ts`
  authors current API acceptance/adoption and refresh/reopen; its execution is
  deferred to integration.

### VNDB release titles

`cross-media-entities@10` projects admitted `releases_titles` rows onto
`wd:Q20631656`. `title`/`lang` become `schema:name`; nonempty `latin` becomes
`schema:alternateName` with the existing Latn tag. `mtl` is retained technical
metadata and never ranks labels or supplies a translation credit. A second name
in one language is an alias, not an overwrite. Exact-empty latin is unadmitted
on this table and does not inherit the `vn_titles` empty-cell decision. Title
language is not a whole-release `schema:inLanguage` fact. Scalar `{id,title}`
payloads remain the untagged legacy envelope for sealed journals. Date, status
and completeness stay on the release-fidelity vocabulary path.

`releases.olang` is the original language explicitly stated for that release,
not a UI, subtitle or audio list. The raw COPY string (or COPY `\\N`) enters
the sanitized projection and digest. Bound proposals emit one canonical
`schema:inLanguage` string through the inventory `language` enumeration and
`inLanguageTag`, keeping script and region subtags the descriptor admits.
Missing, unknown, malformed and unmapped codes withhold only that fact; they
never become `und`, a title language, the work language or a viewer locale.
Decision: raw `pt-br` stays distinct from canonical `pt-BR` in the digest;
COPY `\\N` is the dump null representation and writes no language statement.

### VNDB release barcodes

The current `cross-media-entities@10` mapping keeps the COPY `releases.gtin`
cell in the sanitized projection. Admitted values are the exact decimal
spelling that matches the released `schema:gtin` lexical contract (8 or 12–14
digits). Dump unknown `0`, null, malformed, unsupported-length and unsafe
JavaScript numbers are withheld as diagnostics and never become a padded
barcode, ISBN, catalog number or `schema:sameAs`. The JSON API's nullable
string is not the dump encoding: COPY bigint cells stay text, and a distinction
already lost as an integer is not guessed back. Barcode equality does not merge
releases. The ordinary entity converter and the release-fidelity operator emit
one `schema:gtin` fact on the existing `facts` group.

Decision: dump COPY `gtin` is a bigint decimal cell with unknown sentinel `0`;
admitted values keep that spelling under the released 8 or 12–14 digit contract.

### VNDB staff preferred and additional source names

Revision `cross-media-entities@4` projects a selected VNDB staff Person from the staff row plus its
bounded `staff_alias` collection. `staff.main` is the preferred-alias selector (source join
bookkeeping, not a published statement). The matching `staff_alias.aid` of the same owner supplies
the initial `und` label. Every distinct admitted `staff_alias.name` is an independently readable
`schema:name` fact on that same identity, also in `und`; proposals put the preferred name first and
sort remaining names by codepoint. The source supplies no per-name language here; script and
`staff.lang` are not inferred. Alias `id`/`aid` remain join keys, never an external Person identity.
Both `staff.main` and `staff_alias.aid` are COPY-decoded PostgreSQL integer text; alias keys must be
positive decimal values, while `main=0` means no available preferred selector.
A matching spelling on another owner never merges identities or supplies the preferred label.
Missing preferred association keeps other admitted names and uses the staff id as the bootstrap label
while diagnosing `/main`. Duplicate or conflicting alias keys, wrong COPY integer text for
`aid`/`main`, another owner's alias row, and more than 64 aliases or a 64 KiB normalized projection
are rejected rather than last-row selection or truncation. One selected staff record contributes at
most 65 conversion commands (identifier plus 64 names), below the existing 100-command batch limit.
`staff_alias.latin`, gender, biography and websites stay outside this mapping. Old scalar `{name}`
payloads remain convertible so sealed journals keep their original body and key; the new revision lets
unchanged dump bytes acquire the additional name facts through the existing refresh path.

Decision: if `staff.main` does not resolve to an admitted same-owner alias, keep the staff key as the
bootstrap label and order remaining distinct names by codepoint.

Focused pure controls live in `tests/vndb-staff-names.test.ts`. Exact credited roles and
credited-as spelling remain the staff-credit coordinator.

### VNDB release minimum age

`cross-media-entities@6` preserves bounded `releases.minage` values in the
sanitized release projection and digest. It accepts canonical COPY integer text
and Kana API integer values from 0 through 18. Zero is the explicit all-ages
value; null and absent values stay unknown. Malformed, nonintegral and
out-of-range representations keep their bounded source scalar and diagnostic
but produce no age fact. An admitted value becomes the exact `wdt:P2899`
quantity in years (`wd:Q577`) with the VNDB release citation. It remains on the
Release and is never copied to a work. Decision: `minage` accepts only canonical
COPY integers or API integers; zero means all ages, while null and absent stay
unknown.

### VNDB release platforms and distribution media

The production release operator carries selected `releases_platforms.platform`
and `releases_media.medium` codes on that same Release. Inventory-admitted
platform codes propose `schema:gamePlatform`; the finite medium inventory
proposes `wdt:P437`. Each requires an independently adopted source Concept in
the matching current scheme. Several codes remain several values; unknown or
unbound codes become source-path gaps. Platform and medium lists never combine,
and `releases_media.qty` is omitted.

- Touches: selected release projection, exact source scheme/Concept bindings,
  and the Release's existing multi-valued classification properties.
- Bound: at most 64 selected releases and 4,096 selected child rows across the
  two tables; per-release vocabulary rows fit the existing 64-row ceiling after
  its date and work-link rows. Binding reads retain at most 64 schemes and 512
  concepts, with one cached current read per identity.
- Growth check: the focused importer test covers shuffled duplicates, multiple
  values, an unknown code and refresh. The connected native review/adoption test
  is registered; native execution is deferred to integration.

Decision: source-specific schemes are `https://vndb.org/releases/platforms` and `https://vndb.org/releases/media`, with taxonomies `vndb.releases.platform` and `vndb.releases.media`; these Concepts do not assert canonical equivalence.
Decision: platform and medium projections advance the converter from `@6` to `@7`, preserving the release minimum-age mapping while enabling deliberate refresh of unchanged source revisions.

### VNDB character names and aliases

`cross-media-entities@10` projects selected `chars_names` and `chars_alias`
rows onto one bound `wd:Q95074`. The `chars_names.lang` tag is preserved on
`schema:name`; its explicit romanized `latin` cell becomes an unqualified
`schema:alternateName` using the source language with a `Latn` script subtag.
VNDB aliases have no language, so `name` uses `und` and its explicit Romanized
cell uses `und-Latn`. The original `chars_alias.spoil` value qualifies both
forms through `rezics:spoilerLevel`; unsupported levels withhold the entire
alias with a source diagnostic. Qualified alias text never enters bootstrap
labels or aliases.

Decision: language-less aliases use `und`, explicit Latin cells use the
admitted Latn form, and empty nullable `latin` cells stay in the normalized
digest without producing an alternate-name fact. Null and empty cells remain
distinct. Labels and bootstrap aliases choose eligible unqualified values in
stable language-then-text order, without claiming a source preference. Per
character limits are 64 localized rows, 64 aliases, 4,096 bytes and 1,500
codepoints per text, 64 KiB normalized input and 257 proposals. Overflow is
rejected rather than truncated.

### Bangumi character names and aliases

`cross-media-entities@10` reads only the selected character's `name`, `name_cn`
and the pinned `Crt` infobox fields `简体中文名` and labelled `别名` rows. Top-level
`name` remains `und`, `name_cn` remains `zh`, and `简体中文名` is a `zh-Hans`
preferred name. Every supported `别名` row is an alternate name; its exact label
supplies `zh`, `en`, `ja`, `und-Latn` or `und`. Romanization and nicknames never
become preferred names. An in-limit infobox contributes a SHA-256 fingerprint
and byte count to the sanitized source digest; oversized or non-string values
contribute only bounded markers. Emitted facts preserve source spelling and cite
the Bangumi character URL. Within a nickname value, only the full-width comma
separator observed in the pinned character record splits individual aliases;
slashes and their language mixture stay inside the exact alias text. Unsupported
custom labels are omitted with exact bounded diagnostics while known labels stay
usable; a structurally malformed alias group is withheld as a whole.

Decision: `第二中文名` uses `zh`, `英文名` uses `en`, `日文名` and `纯假名` use `ja`, `罗马字` uses `und-Latn`, and `昵称` uses `und`; top-level and `简体中文名` fields keep separate preferred-name roles, and only the observed full-width comma splits nicknames.

- Touches: one selected character projection, at most 16 preferred-name facts,
  64 alternate-name facts and 85 public commands, including up to two existing
  physical-profile facts; each fact uses the existing Character profile and
  ordinary importer/publication flow.
- Bound: 32 KiB infobox, nesting depth 2, 64 fields, 64 aliases, 4 KiB and 500
  codepoints per name, 16 bounded diagnostics and the existing 65,536-byte
  normalized-record cap. Structurally malformed alias groups are withheld as a
  whole; unsupported custom labels are diagnosed and omitted. Independent valid
  names and summary remain available.
- Growth check: `tests/bangumi-character-names.test.ts` pins source grammar,
  language distinctions and alias removal. The native default-selection and
  publication scenario is `services/kernel/test/imports/bangumi-character-names.test.ts`.

Combined revision decision: `cross-media-entities@10` preserves the current Bangumi physical profile, VNDB character names and staff aliases, release titles, minimum age and GTIN while adding Bangumi character names and verified VNDB blood types.

### VNDB native alternate-name contract

The scalar `vn.alias` field contains newline-separated alternate names. Use
`und` for nonempty lines in bootstrap aliases and cited `schema:alternateName`
proposals; omit empty lines and never infer from `vn.olang`. At most 64 nonempty
lines are accepted,
each under the existing 4,096-byte and 1,500-codepoint title bounds, with the
whole projection still capped at 64 KiB. Empty cells and empty lines mean no
alias; whitespace-only lines remain invalid. Aliases remain in the source
digest, and bound changes/removals flow through ordinary importer reconciliation.
The 162-command worst case fits the importer's 300-command per-record plan and
is sent in its existing 100-command batches.

### Provider facts required for catalogue use

The table above describes executable mappings on this base. The following are
required capabilities, not claims that the current converters already provide
them. Provider imports must emit permitted public facts in the adopted
portable shapes consumed by definitions and discovery; retaining an opaque
source field alone does not make that fact usable.

- Where adopted definitions admit them, provider platform, date and credit
  facts must likewise become usable catalogue facts, rather than source-only
  metadata.
- Bangumi's public `meta_tags` may produce a harem classification only through
  the reviewed Concept and property binding adopted by Semantic. Personal tags
  and user posts are excluded. A light-novel form must likewise be explicitly
  supported by an adopted Concept, property and profile binding; a generic
  novel platform does not establish light-novel form.
- Word-count discovery requires admitted input declaring machine-readable
  whole-holder coverage, exact holder identity, language and version. A text
  digest is required only where text is supplied. A source's own declared total
  word count for its whole work or serial, or a publisher's stated word length,
  can be admitted without full-text ingestion. Partial, unknown or unsupported
  multilingual coverage omits wordCount discovery evidence. A summary never
  proves whole-holder coverage. Character counts are distinct; do not estimate
  words from characters, pages or reading time, transfer counts across
  translations, or sum a series without an adopted semantic rule. Semantic owns
  the actual typed producer grammar; this rule invents no producer fields.
- Semantic owns reviewed Concepts, property and profile bindings, and
  portable item and quantity shapes. Imports consumes those adopted
  definitions; it does not fabricate IDs or properties, or add a source.

These mappings, their runtime behavior and converter acceptance remain
required work. This prose does not make them executable. The four source
registrations, rights, attribution, native revisions, caps and bounded
immutable memoization evidence above remain unchanged. Opaque infobox and image
keys that current contracts allow the converter to omit remain omittable.
See the [Semantic contract](../../services/kernel/src/semantic/README.md),
[definitions contract](../definitions/README.md), and
[library profile consumers](../../docs/library-profile-consumers.md) for the
owning interfaces. Adopted meanings and source correspondences do not themselves
deliver admitted producer inputs, resolved native bindings or qualifying data.

### Conservative exact-quantity source handoff

For every exact-quantity source assertion, preserve **every actual source
qualifier losslessly in the same native statement**, through reviewed mappings
and the admitted property's schema. If any qualifier would be skipped,
unsupported, unresolved or semantically narrowed, withhold the **entire
measurement** and diagnose the loss. Never publish a less qualified amount.
This includes loss during source projection, before emission can see a qualifier.
Keep the original source input and its references intact; rejecting a proposal
does not authorize rewriting source evidence or immutable earlier receipts.

Exactness comes from the actual admitted closed fixed quantity value schema:
required amount and unit, only those two properties, and neither lowerBound nor
upperBound. The serialized property has no exact flag. Use the
[Definitions owner API](../definitions/README.md#exact-quantities); this is generic
exact-quantity validation, independent of property names or holder types.
Ordinary quantity and default conversion semantics remain unchanged.

Wikidata applies this rule in converter revision `wikidata-4`. It detects
unmapped qualifier keys on exact quantities without reading their bodies. It
also treats a mapped qualifier that cannot be normalized as qualification loss.
If any qualifier was omitted or cannot be carried losslessly, the whole
measurement is withheld with a diagnostic. Detection uses the admitted fixed
value schema, not the source property name. Rejection remains stable when the
importer serializes `normalizedRecord` and converts it again after binding.
Focused pure controls live in
`tests/wikidata-exact-quantity.test.ts`. The three frozen native cases passed
through the ordinary importer and public batch write path (check
`5936c648-22a7-4930-9fcf-c671639056c1`). Their names, final test hash and
bootstrap receipt assertions are recorded in the linked audit report.

The current bundle admits schema:wordCount with exact P6570 mapping, integer
amount, unit 1, minimum 0 and qualifiers[]. Its mapping alone is unsafe provider
support: Wikidata now diagnoses projection and emission loss and skips the whole
exact measurement whenever either stage cannot preserve all qualifiers.
P1545 maps to the existing string position but is not admitted on wordCount.
P459 method is unmapped; current P518 has no executable exact mapping and targets
StoryArc only, so it cannot stand for an arbitrary counted text part. Do not narrow that scope, widen P518, invent
method/part/digest properties or supply fabricated native identities.

The [handoff evidence and frozen native scenarios](../../docs/research/imports-audit/exact-quantity-qualifiers.md)
target rejection on the actual bundled runtime through the ordinary importer
and public batch write path after converter repair; the audit records the latest
runtime result without treating an earlier assertion failure as qualifier proof.
The reviewed Q55867126 revision 1717031358 count (+1450/unit 1, P459 Q718390,
P518 Q63246861, no statement references) belongs to a letter/text. Its explicit
transplant into a controlled synthetic Book shell proves no observed Book count.
With qualifiers[] no positive qualified provider case is promised. An unqualified
source count likewise proves neither admitted whole-holder coverage nor a genuine
measurement producer. Positive provider support and whole-scope discovery
eligibility remain unresolved. The word-evidence boundary above is orthogonal to
qualifier preservation; negative rejection proves no measurement/index coverage
or double-index exactness.

## Covers, candidate identity, and trust boundaries

Bangumi and Open Library return `coverAssets` as deferred source assets without
a `containerId` when there is no bound subject. Once `subjectId` is known,
`mediaImportIntents` contain complete validated requests with that container.
An actual available media UUID can then be supplied in `context.mediaIds`, keyed
by the exact `sourceUrl`, to receive a `schema:image` proposal. The converter
never publishes a source hotlink, downloads bytes, or relays an image.

Each cover request has structured `rightsHolder`, `via`, and
`LicenseRef-unknown` credit plus cover-group source provenance and references.
Image rights are independent of metadata rights; a source metadata license does
not grant a cover license. The request and status shapes are defined in
[`media-import.ts`](../definitions/src/media-import.ts).

For platform imports, the caller uses the public content
`media:importFromUrl` operation with action `media:importFromUrl` and bearer
scope `media:import_from_url`. A reservation or accepted job is not an available
media id: wait for the actual status to become `available` before binding its
returned UUID. Community tools may provide only a media mapping they actually
obtained through their legitimate media workflow. Neither caller may fabricate
an id, relay fetched bytes, or bypass the public media contract with a BFF,
completion operation, or service token.

The converter does not run media jobs, check permissions, or enforce source
fences. Import refreshes check the `(source, external_id, field_group)` fence
again on every refresh, including unchanged source data; the server checks
disclosure authority separately when content is requested. A media item's
`available` state is not public disclosure authorization. See the
[importer contract](../../services/importer/src/import-contract.ts),
[returned-id and media bindings](../../services/importer/src/record-bindings.ts),
and [media authorization path](../../services/kernel/src/content/media.ts).

`create` establishes only subject metadata. `propose` creates source fact
candidates; it does not mean the community adopted those facts. Conversion
modules do not know the server-assigned id of an earlier candidate, so they
cannot safely retract it. The importer tracks actual returned candidate ids
for later reconciliation and retraction.

## Deletion

The [common deletion policy](../../docs/deletion.md) is the lifecycle authority.
Under the [first public scope](../../docs/scope.md), conversion covers Bangumi,
VNDB, Open Library and Wikidata, with no recipe-site source or user posts.
The converters persist nothing and have no delete, restore or purge operation
or job. Their bounded source proposals, citations and deferred asset intents
confer no lifecycle authority; pure conversion has no purge work to schedule.

The caller and authoritative owners enforce lifecycle through public APIs:
[Semantic](../../services/kernel/src/semantic/README.md) owns contributions and
subjects, [Content](../../services/kernel/src/content/README.md) owns media, and
[Access](../../services/kernel/src/access/README.md#account-deletion-policy)
owns account lifecycle. Imported proposals and media remain subject to their
deletion, restore, purge and disclosure rules under the common policy.
Conversion cannot bypass server deletion or authorization. The
[importer](../../services/importer/README.md#deletion) checks takedown tuple
fences even on unchanged refreshes and must not clear them to recreate withheld
material. Only the caller tracking actual returned candidate IDs can reconcile
source disappearance or replacement through public retraction; converters
cannot retract an earlier candidate from source data alone.

## Cost derivation and verification

### Cite a VNDB record

- Touches: the bounded native revision and optional modification timestamp in
  one source record, and each bound fact's reference.
- Bound: one constant-size native timestamp retained within the 64 KiB
  projection; one version part and at most one date part per statement, within
  the existing 98-command cap. CPU and serialized output remain `O(record bytes)`;
  no retained record state, SQL, network or lookup calls are added.
- Growth check: `vndb-growth.test.ts` covers 1, 8 and 64 titles and unchanged
  conversion under unrelated catalogue/history growth. `vndb-native-metadata.test.ts`
  verifies all 98 facts at the combined title/link limit and native timestamp
  semantics; `vndb-native-citations.test.ts` covers citation parts and digest replay.

### Project a VNDB release minimum age

- Touches: the existing selected release rows and ordinary entity conversion; one bounded `minage` scalar, one native quantity proposal, and the release's existing source citation. Work links and all other release facts retain their current owners.
- Bound: at most 64 selected release rows, at most 32 characters for a retained malformed source string, and the existing 64 KiB projection, 300-candidate and journal limits. No additional SQL, native reads, authorization calls or unrelated-release scans.
- Growth check: `services/importer/tests/vndb-release-age-rating.test.ts` exercises the bounded COPY caller, unchanged-input refresh and source change; `services/kernel/test/imports/vndb-release-age-rating.test.ts` exercises native candidate, adoption, current read, fence and reopen behavior. No new PostgreSQL growth series is added.

### Dispatch a Bangumi record

- Touches: source identity and type; admitted types visit the existing
  bounded public-field projection. Identity-only ignored projections hash only `{id, type}`.
- Bound: constant identity/type dispatch and at most 32 UTF-8 JSON bytes for
  an identity-only ignored record, with zero commands, assets, or intents.
  Supported records retain the 64 KiB projection, 500-character title,
  64-tag plus 64-public-meta-tag (each 200 characters), 32 KiB summary snapshot, nine-command and one-cover-intent caps.
  No skipped-ID set, kernel call, SQL, network, or source-wide work is added.
- Growth check: `bangumi-scope.test.ts` covers launch/ignored outcomes,
  repeat conversion, privacy and named I/O guards; `bangumi-growth.test.ts`
  checks existing caps and unchanged output at unrelated scales 1, 8 and 64.
  These are functional assertions and source-derived bounds, not timing or
  heap measurements.

### Project a Bangumi television original run

- Touches: one type-2 TVAnime infobox, the existing subject conversion, at
  most three native facts (`schema:datePublished`, `schema:endDate`,
  `schema:numberOfEpisodes`) and the work's existing Bangumi citation.
  Names, credits, broadcasters and episodes retain their current owners.
- Bound: infobox parse visits at most 64 `|key=` lines inside the existing
  64 KiB projection; date and episode scalars stay on one line. No extra SQL,
  native reads, authorization calls or episode-row aggregation.
- Growth check: `services/importer/tests/bangumi-television-run.test.ts`
  covers the JSON-lines operator, unknown totals, schedule/custom omissions,
  converter-revision refresh and changed episode totals.
  `services/kernel/test/imports/bangumi-television-run.test.ts` covers native
  accept/adopt/read, citation, facts fencing and idempotent reopen. No
  PostgreSQL growth series is added.

### Project a Bangumi game player count

- Touches: one type-4 Game infobox, the existing subject conversion, at most
  one native `schema:numberOfPlayers` fact with at most one `schema:minValue`
  qualifier, and the work's existing Bangumi citation. Names, dates, platforms,
  developer/voice credits, websites and Web presentation retain their current
  owners.
- Bound: infobox parse visits at most 64 `|key=` lines inside the existing
  65,536-character infobox and 64 KiB projection; at most 8 count occurrences
  are examined and at most 16 diagnostics are retained. One supported
  occurrence produces one statement plus at most one qualifier, inside the
  existing command envelope. No extra SQL, native reads, authorization calls
  or release/edition identities.
- Growth check: `services/importer/tests/bangumi-game-player-count.test.ts`
  covers ordinary and selected-family proposals, a mode-qualified omission,
  converter-revision refresh and a malformed-to-corrected same UUID.
  `services/kernel/test/imports/bangumi-game-player-count.test.ts` covers native
  inspect/accept/adopt/current read, citation and facts fencing. No PostgreSQL
  growth series is added. Native execution is deferred to integration.

### Dispatch a Bangumi book record

- Touches: one type-1 subject's series flag, platform and wiki template, the
  existing subject conversion, Book versus BookSeries bootstrap, cited
  publication date, and withheld edition/count diagnostics. Authors, membership
  and editions retain their current owners.
- Bound: one infobox parse within the existing 64 KiB projection and admitted
  key set; no extra SQL, native reads, or volume invention from counts.
- Growth check: `services/importer/tests/showcase-books.test.ts` covers family
  selection, grain, membership direction and refresh. The connected native file
  `services/kernel/test/imports/showcase-books.test.ts` is registered and
  deferred to integration.

The community example touches one supplied bounded record, its exact source
claim, returned subject/candidate identities and ordinary public receipts. It
adds no catalogue/history enumeration. Existing public envelope and transport
bounds apply; the connected outcome adds no growth series and does not replace
the local counted ceilings or canonical/derived PostgreSQL suites. Missing native
growth measurements remain missing.

Pure conversion performs `O(record bytes)` work for one bounded record `M`.
Native field and collection limits bound key counts (including canonical key
sorting); projection, validation, hashing, and command construction operate on
that record. There is no `N` or `U × t` state for unrelated catalogue or history
totals. This package adds no production read, write, authorization, or job path.

The platform record configuration contract is a 256 KiB default and a 1 MiB
hard maximum. These are configuration bounds, not a claim that the current
pure helpers enforce them: Open Library and the shared snapshot helper still
have a 2 MiB projection guard. Separate tighter native guards apply, including
Bangumi/VNDB at 64 KiB and Wikidata at 128 KiB. The logical growth fixtures stay
within the platform hard bound and all applicable native guards.

Source binding audit: [`bangumi.ts`](src/bangumi.ts) has a static type lookup;
[`vndb.ts`](src/vndb.ts) has frozen limits and stateless helpers;
[`open-library.ts`](src/open-library.ts) has scalar limits and calendar constants.
[`wikidata.ts`](src/wikidata.ts) builds vocabulary mapping/type lookups once
from the bundled release and only reads them during conversion. These are
static vocabulary inputs, not retained records. Record projections,
diagnostic arrays, title maps, proposal/asset arrays, and other conversion
work data are created inside each call. [`support.ts`](src/support.ts) also
has bounded cross-call memoization: `textDocument` stores up to 64 entries in
a module-level `Map`, keyed by exact input text, and returns the same deeply
frozen snapshot reference on a hit. When full, it deletes the oldest inserted
key before adding a new one; reads do not refresh insertion order. The module-
level `checkCoverIntent` validator remembers up to 256 accepted bodies as
canonical JSON text in a `Set`, so object member order does not affect a hit.
It stores only bodies with no violations and at most 8192 characters of
canonical text, evicting the oldest accepted key when full; bodies without
canonical text or over that limit are checked without being remembered. These
are bounded snapshots and accepted-body keys, not unbounded per-record state.
`support.test.ts` checks text-document output equality and size/error
boundaries, not reference identity or eviction. `logical-growth.test.ts`
checks that fixed serialized conversion output is unchanged after batches of
unrelated records; it supports deterministic observable output, not absence
of retained state. The source audit establishes the memoization bounds,
eviction, and stored representations; serialized output tests cannot prove
that no unused cache exists.

[`logical-growth.test.ts`](tests/logical-growth.test.ts) calls the four actual
exports with native `ConversionInput`, context, and registered revision options.
It serializes a fixed anchor return before and after each batch of `1`, `8`,
and `64` times eight distinct unrelated records passed through the same
converter, and asserts byte-identical UTF-8 JSON. One native generator per
source also supplies three increasing record sizes. The largest is above 90%
of its applicable byte guard: Bangumi infobox and VNDB titles approach 64 KiB,
Wikidata terms approach 128 KiB, and Open Library description approaches its
1 MiB prose guard while remaining within the platform hard record bound.

Decision: count actual source descriptor reads and owned-key scans on fixed-shape records at 8, 64, and 512 conversions, matching the existing 1/8/64 groups of eight.
The observer counts own-property descriptor reads and
input-owned keys visited through `Object.keys` and `Object.hasOwn` while each
public converter runs. The VNDB seed includes its `vndb@8` native alternate
name, and the Wikidata seed uses the `wikidata-5` dish binding. The test requires
exactly eight times as many visits at each scale step. This measures source
projection visits, not elapsed CPU, heap allocation, or all work over the
converter's local normalized values.

Logical retained footprint means
`Buffer.byteLength(JSON.stringify(entireActualReturn), 'utf8')`, including
normalized record/hash input, diagnostics, metadata, proposals, and assets.
The tests measure actual input JSON bytes and whole-return JSON bytes, then
compare incremental return-byte/input-byte slopes, allowing only 1% variation
for serialization boundaries. They do not infer cost from expected fixture
sizes. This is a logical serialized footprint proof, not a machine heap,
allocation, timing, or GC measurement. The measured work-visit test above
counts actual reads from the seeded source graph; the broader `O(record bytes)`
work bound remains a source derivation. Existing native mapping, rights, caps,
digest, privacy, and I/O guards remain separate checks of behavior and purity.
No SQL or network cost is inferred from a zero counter.

Run the focused actual pure tests with:

```sh
bun specs/support/verify-import-cost-observer.ts
```

The historical command path now directly launches the logical growth test and
the three Bangumi, VNDB, and Open Library native growth files with Bun, and
propagates test failures. It needs no driver, factory, shared harness, or
instrumentation API.

The `*-outcomes.test.ts` wrappers also bind the real converters to narrow typed
drivers and run the existing fixture-based source outcome suites. They cover
converted fields, rights references, diagnostics, and source revisions through
the converter output. These pure converter tests prove mapping, validation,
deterministic output, bounded projection, and source rights references. They do
not prove API authorization, remote media fetching, import-job execution, or
server-side disclosure enforcement. The corresponding public API and importer
contracts remain separate from this package. The package's current checks are declared in
[`package.json`](package.json); README formatting is checked with
`node_modules/.bin/oxfmt --check packages/conversion/README.md`.

More detail lives in the actual [bulk contract](../definitions/src/bulk.ts),
[document implementation](../document/src/index.ts), and the converter source
modules linked above. No design proposal replaces those executable contracts.

## Reviewed Bangumi public tags

`bangumi@6` retains the ordered public `meta_tags` projection (at most 64 own
data strings of 200 characters, within the existing 64 KiB projection). Exact
`后宫` uses only the raw dictionary key
`v1:["https://rezics.com/schemes/bangumi/public-tags","后宫"]`. With a trusted current
source Concept UUID it emits one `schema:keywords` proposal, including the
required dimensionless zero spoiler qualifier and existing public-record citation.
Missing mapping omits that proposal. Popularity `tags`, private Collection labels,
titles, platform, infobox and approximate spellings never substitute. No form,
word measurement, canonical Concept substitution or equivalence is inferred.

The caller owns current native trust; dictionary syntax is no proof of authority.
The production Importer/CLI obtains the dictionary through its existing
`identifierLookup`, after explicit reviewed seeding. Normalization and digesting
remain pure; the source-only digest includes the ordered metadata tags and excludes
bindings. Supported records visit thirteen top-level fields and produce at most nine
commands and one cover intent; byte caps remain unchanged. The new keyword adds one bounded citation and one qualifier.

## Bangumi TVAnime subject names

`bangumi@9` consumes only `中文名` and `别名` from the exact pinned
`{{Infobox animanga/TVAnime` template on Bangumi type 2 `schema:TVSeries` records.
The ordinary Bangumi converter and selected-family registrations share this pure extraction.
The existing top-level `name` and `name_cn` bootstrap labels keep their current
meanings; infobox names become cited native name facts after subject binding and
do not set `inLanguage`. The complete infobox remains in the existing bounded
projection and digest for raw change detection.

The scalar `中文名` is `zh`. Scalar and bullet-list `别名` values are `und`,
because the pinned template defines no alias-language syntax. Equal property,
language and exact-text tuples deduplicate; other spellings remain separate.
Nested templates, links, unknown keys and unconsumed TVAnime fields are bounded
omissions, with no source prose copied into diagnostics. Parsing scans at most 64
field occurrences, retains at most 24 distinct name values, and shares a 16-item
diagnostic cap with retained source-field, TVAnime run and Game player-count
omissions. Each field
occurrence is staged until its complete scalar or bullet-list form is known;
malformed or mixed occurrences contribute no names.

### Bangumi character physical profile

`cross-media-entities@10` parses only `血型`, `身高` and `体重` from the
[pinned `{{Infobox Crt` template](https://github.com/bangumi/common/blob/2ee87b9995353f77cf02e390e8635bf97dbc1fa2/wiki_template.yml#L1321-L1359). Heights keep explicit centimetres/metres and
weights keep explicit kilograms/grams as released exact quantities. The
original scalar and indexed field path enter normalized source evidence, so an
unchanged record is stable and a changed or removed field refreshes its source
digest. Missing units, estimates, ranges, fictional units, mixed prose and
duplicate fields are field-specific omissions. Blank and explicit unknown
values remain unknown; a unit-bearing zero remains literal. Birthday and BWH
remain omitted. Blood type is retained as bounded source evidence but is not
proposed until a released source-to-current-native Concept binding exists.

The parser caps an infobox at 65,536 UTF-8 bytes, depth 2, 64 fields, 128
retained scalar code units, 64 quantity characters, 2 quantity facts and 16
sanitized diagnostics. Overlong values are withheld with byte length and digest;
they are never truncated into plausible quantities. Quantity admission is
checked against the compiled Character property, its fixed amount schema and
its released units before fact emission. Existing identity, names and summary
rights follow their current paths.

- Touches: selected Bangumi Character profile evidence and at most one height
  and one weight statement, each cited to its exact character record.
- Bound: one selected source record, one line-oriented Crt pass within the
  parser caps above, and the converter's existing bounded command ceiling. The
  parser does not interpret arbitrary wiki markup or resolve labels as Concepts.
- Growth check: `tests/bangumi-character-measurements.test.ts` covers exact
  units, unavailable values, independent removal and source bounds. The native
  default-seed/publication scenario is
  `services/kernel/test/imports/bangumi-character-measurements.test.ts` and is
  deferred to integration.

Decision: keep only explicitly unit-bearing released quantities, preserve source units and literal zero, and withhold Bangumi blood type until a current native Concept binding exists.

## Bangumi Book-template subject names

`bangumi@9` extracts Book titles only when the selected converter profile is
`schema:Book` and the first nonempty infobox line is the exact pinned
[`{{Infobox animanga/Book`](https://github.com/bangumi/common/blob/2ee87b9995353f77cf02e390e8635bf97dbc1fa2/wiki_template.yml#L67-L85)
head. **Decision:** separately inventoried `Novel`, `Manga`, `PhotoBook` and
`BookSeries` templates stay excluded from this title mapping. The reviewed Book
mapping sends both `中文名` and `别名` to additional `schema:name` facts; TVAnime
aliases remain `schema:alternateName`.

The scalar `中文名` supplies `zh`. A scalar alias or flat `*` list supplies `und`;
the converter infers no language or preferred label from spelling or list order.
It stages each complete field before emitting it, so mixed scalar/list values,
nested markup and malformed list entries withhold that field while independently
valid top-level names and other fields remain available. Book infobox field
pointers participate in command identity, while assertions keep the Bangumi
record URL citation and bounded source digest.

Touches: one selected Book record, at most 24 distinct name values and 16 shared
omission diagnostics. Bound: the existing 65,536-byte projection/infobox limits,
64 field occurrences, and existing command and journal caps. Growth check:
`services/importer/tests/bangumi-book-names.test.ts` exercises ordinary and
selected-family import, malformed-to-corrected refresh, citations and stable
identity; the connected native acceptance is
`services/kernel/test/imports/bangumi-book-names.test.ts`.

## Bangumi book grain

The current `bangumi@9` converter dispatches type 1 Book versus BookSeries from
the source series flag, novel platform and wiki template. Comic/manga stays
generic Book so a novel family is never filled with manga. Type 1 cites a
parseable `date` as `schema:datePublished` on Book or BookSeries. ISBN,
publisher and pages stay off the work as withheld edition assertions; volume
counts stay counts.
Decision: type 1 Book/BookSeries dispatch uses the current `bangumi@9`
converter, preserving TVAnime names, Book-template names, original-run and Game
player-count rather than advancing to `@10`. One Bangumi subject stays one
identity; ISBN does not create a `bf:Instance`.
