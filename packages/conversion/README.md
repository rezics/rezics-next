# `@rezics/conversion`

`@rezics/conversion` is a pure source-record converter shared by platform and
community tools. It returns sanitized source data, deterministic digests, and
portable create or proposal commands. It does not fetch records or images, call
an API, write storage, authorize a caller, create or adopt a subject, run a job,
or retract a previous candidate.

## Package API

The [package exports](package.json) are only these entry points:

| Import                            | Named exports                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `@rezics/conversion`              | `SourceId`, `SourceRecord`, `ConversionInput`, `ConversionDiagnostic`, `ConvertedRecord`, `ConversionError` |
| `@rezics/conversion/bangumi`      | `convertBangumi`, `converter_revision`, `BangumiConversion`                                                 |
| `@rezics/conversion/vndb`         | `convertVndb`, `converter_revision`, `vndbLimits`, `VndbConversion`, `VndbOptions`                          |
| `@rezics/conversion/open-library` | `convertOpenLibrary`, `converter_revision`, `OpenLibraryConversion`                                         |
| `@rezics/conversion/wikidata`     | `convertWikidata`, `converter_revision`, `wikidataLimits`, `WikidataConversion`                             |

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

| Context field        | Meaning                                                                                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjectId`          | Existing or actually created REZICS subject UUID. With no subject, converters that support bootstrap return a `create`; with one, they return `propose` commands. |
| `resolvedReferences` | Source-native relation key to an actual resolved subject UUID. Unresolved relations remain unresolved.                                                            |
| `mediaIds`           | Exact source URL to an actual available media UUID. No image statement is proposed without this mapping.                                                          |
| `source`             | Trusted registration alias written to source envelopes and used in command keys. Set it from registration configuration, never from `record`.                     |

The context shape is accepted by the converter functions, but its implementation
type is internal to [`support.ts`](src/support.ts), not an exported package
subpath. The converter's `converter_revision` option is also trusted
registration data, not a field read from the source body.

Each result includes a `normalizedRecord` containing only the source fields the
converter accepts. Unknown and private subtrees are not carried into it. Its
`digest` is a deterministic SHA-256 digest of that sanitized source projection;
target bindings, source aliases, and converter registration are excluded. The
digest changes when the sanitized source projection changes, but not when that
same data is rebound to a target or registration. Converter revision is part
of command identity, so changing it changes command keys while the source
digest remains data-only.

Invalid input or context throws `ConversionError` with a `code` and an
RFC 6901 `pointer`; it does not expose source text in an error message.
`diagnostics` report fields that were safely retained or skipped because they
have no supported mapping or permission. A diagnostic is not a proposal.

## Bootstrap and proposal example

This example uses a record and nullable native revision supplied by the caller,
plus its existing authorized public bulk transport. It contains no example
identifiers or synthesized revisions:

```ts
import { convertBangumi, converter_revision } from '@rezics/conversion/bangumi';
import type { ConversionInput } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';

type BatchWrite = (request: BatchWriteRequest) => Promise<BatchWriteResult>;

async function importBangumiRecord(input: ConversionInput, batchWrite: BatchWrite) {
  const bootstrap = convertBangumi(input, {}, { converterRevision: converter_revision });
  const create = bootstrap.proposals[0];
  if (bootstrap.proposals.length !== 1 || create?.op !== 'create') {
    throw new Error('Expected one bootstrap create command');
  }

  const response = await batchWrite({ commands: [create] });
  const result = response.results.find((entry) => entry.key === create.key);
  if (!result || !('value' in result) || !('id' in result.value)) {
    throw new Error('The public bulk response did not return a created subject id');
  }

  const converted = convertBangumi(
    { ...input, record: bootstrap.normalizedRecord },
    { subjectId: result.value.id },
    { converterRevision: converter_revision },
  );
  return batchWrite({ commands: converted.proposals });
}
```

The bootstrap command contains subject type and labels only; it has no source
statements. After a successful create response, the second conversion uses the
actual returned subject id and emits source statements as `propose` commands.
The caller owns transport, authorization, response handling, retries, storage,
and any adoption workflow.

## Source mappings and limits

| Source       | Accepted record and mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Rights and exclusions                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bangumi      | A subject whose `type` is `1` (book), `2` (anime, mapped to TV series), or `4` (video game). The external id maps to `wdt:P5732`; names are candidates. A non-empty summary becomes a literal Text-profile `schema:abstract` snapshot, with the serialized snapshot capped at 32 KiB.                                                                                                                                                                                                                                                                                                       | The summary proposal carries CC-BY-SA-3.0 attribution and ShareAlike obligations. A cover has separate unknown rights. The executable converter currently retains other accepted fields such as tags, platform, infobox, date, and NSFW status only in sanitized source data or diagnostics; it does not emit catalogue facts for them. Existing permitted omissions of opaque infobox and image keys remain in force. |
| VNDB         | Grouped metadata from real COPY `.header` tables: `vn`, `vn_titles`, and `entry_meta`. The converter also accepts grouped `vn_extlinks` and `extlinks` data. The projection uses VN identity, native `entry_meta.revision`, titles, and supported external links. Titles become names; only supported website links become URL facts.                                                                                                                                                                                                                                                       | Source metadata identifies ODbL-1.0 database permission and `LicenseRef-DbCL-1.0` contents permission for the permitted metadata projection. Descriptions, covers, posts, and other creative content are not proposed. These source permissions do not license all VNDB contents or set the output database's license.                                                                                                 |
| Open Library | The JSON payload carried by the native TSV row, for `/type/work` or `/type/edition`. A work bootstraps as `schema:Book`; an edition as `bf:Instance`. The native revision is cited as `schema:version`, and `last_modified` is cited as a day-precision `schema:dateModified`. For editions, valid ISBN-10 values are checksum-validated and converted to ISBN-13; only ISBN-13 is proposed. An unresolved author or work relation has value `somevalue` and keeps its Open Library identifier as a `wdt:P648` qualifier; a real native resolution may be supplied in `resolvedReferences`. | `CC0-1.0` describes the permitted bibliographic metadata source. Unknown-licensed descriptions are kept as metadata and never proposed as summary text. Links and publishers are metadata-only. Covers have separate unknown rights. This permission does not claim all dataset contents share the metadata license or set the output database's license.                                                              |
| Wikidata     | A real Q entity with `type: 'item'`. The bundled catalogue vocabulary controls supported types, property mappings, datatypes, ranks, qualifiers, and time/quantity handling. Entity labels become name candidates; supported claims become proposals.                                                                                                                                                                                                                                                                                                                                       | Source metadata cites CC0-1.0 structured data. Unknown property mappings are skipped rather than invented. The converter does not import user or talk-page content. CC0 source data does not set the output database's license.                                                                                                                                                                                        |

Bangumi revision `bangumi@3` recognizes types `3` (music) and `6` (live action)
but returns `outcome: 'ignored'` with a safe `/type` diagnostic and empty
proposals, cover assets, and media intents in both phases. Identity and type
are validated before any discarded field is visited; `normalizedRecord`
contains only `id` and `type` and can be converted again unchanged. Native
revision (or `unversioned`), converter revision, and the sanitized-data-only
digest remain available. Unknown or invalid types still fail with
`unsupported_type`. Types `1`, `2`, and `4` return `outcome: 'converted'` and
retain their bootstrap and bound proposals. Platform and community tools use
this same pure module; importer skipped-count accounting is separate.

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
- VNDB: 64 KiB projection, at most 64 titles, at most 32 external links, and at
  most 98 commands (1 identifier + 64 names + 32 URLs + 1 original language).
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

VNDB revision `vndb@6` cites the required native `entry_meta.revision` as
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

The converter at `vndb@7` now accepts this exact-empty source edge and preserves
it in the normalized projection and data digest. Pure tests verify the name
omission, null distinction, digest stability, and strict invalid controls. The
frozen native COPY acceptance verifies staged empty-cell composition and public
bulk effects. This narrow result does not establish every discovery,
statistics, or publication capability.

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

The current bundle admits schema:wordCount with exact P6570 mapping, integer
amount, unit 1, minimum 0 and qualifiers[]. Its mapping alone is unsafe provider
support: Wikidata snaks() projects only mapped qualifier keys; emission diagnoses
and skips property-unsupported and item qualifiers before pushing the amount.
P1545 maps to the existing string position but is not admitted on wordCount.
P459 method is unmapped; current P518 has no executable exact mapping and targets
StoryArc only, so it cannot stand for an arbitrary counted text part. Do not narrow that scope, widen P518, invent
method/part/digest properties or supply fabricated native identities.

The [handoff evidence and frozen native scenarios](../../docs/research/imports-audit/exact-quantity-qualifiers.md)
exercise rejection on the actual bundled runtime before default converter repair.
The reviewed Q55867126 revision 1717031358 count (+1450/unit 1, P459 Q718390,
P518 Q63246861, no statement references) belongs to a letter/text. Its explicit
transplant into a controlled synthetic Book shell proves no observed Book count.
With qualifiers[] no positive qualified provider case is promised. An unqualified
source count likewise proves neither admitted whole-holder coverage nor a genuine
measurement producer. Positive provider support and whole-scope discovery
eligibility remain unresolved. The word-evidence boundary above is orthogonal to
qualifier preservation; negative rejection proves no measurement/index coverage
or double-index exactness. Converter repair is separate successor work.

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

### Dispatch a Bangumi record

- Touches: source identity and type; only launch types visit the existing
  bounded public-field projection. Excluded types hash only `{id, type}`.
- Bound: constant identity/type dispatch and at most 32 UTF-8 JSON bytes for
  an excluded normalized record, with zero commands, assets, or intents.
  Supported records retain the 64 KiB projection, 500-character title,
  64-tag, 32 KiB summary snapshot, five-command and one-cover-intent caps.
  No skipped-ID set, kernel call, SQL, network, or source-wide work is added.
- Growth check: `bangumi-scope.test.ts` covers launch/ignored outcomes,
  repeat conversion, privacy and named I/O guards; `bangumi-growth.test.ts`
  checks existing caps and unchanged output at unrelated scales 1, 8 and 64.
  These are functional assertions and source-derived bounds, not timing or
  heap measurements.

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

Logical retained footprint means
`Buffer.byteLength(JSON.stringify(entireActualReturn), 'utf8')`, including
normalized record/hash input, diagnostics, metadata, proposals, and assets.
The tests measure actual input JSON bytes and whole-return JSON bytes, then
compare incremental return-byte/input-byte slopes, allowing only 1% variation
for serialization boundaries. They do not infer cost from expected fixture
sizes. This is a logical serialized footprint proof, not a machine heap,
allocation, work-visit, timing, or GC measurement; the work bound above is a
source derivation, not a timing result. Existing native mapping, rights, caps,
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
