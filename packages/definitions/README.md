# @rezics/definitions

The immutable definition catalogue release format stored by the kernel. This package
exports the release types, the JSON Schema 2020-12 document at
`@rezics/definitions/schema/release.json`, and pure validation and digest functions.

Use `validateRelease(input)` before storing a release. An empty array means valid;
otherwise violations carry RFC 6901 pointers and `invalid`, `unsafe_pattern`, or
`limit` codes. Results are sorted, deduplicated by pointer, and capped at 64.
Validation checks references, CURIE expansion, sorted unique lists, datatype-specific
members, fixed value schemas, and regular-expression safety. Pattern checks use
recheck's in-process synchronous entry point, with a three-second timeout per distinct
pattern; inconclusive results fail validation.

Releases allow at most 256 types, 1,024 properties, 64 properties per type, and 1 MiB
of canonical UTF-8 JSON. Collection and size limits precede schema and pattern checks.
Inputs are parsed JSON, without cycles. Validation does not mutate them.

`valueSchema(datatype, options)` builds the fixed Wikibase value-content schema.
`releaseDigest(release)` returns `sha256:` followed by the SHA-256 digest of its
RFC 8785 canonical JSON. Validate first: the digest function does not validate.

## Bundled catalogue

The LinkML sources in `catalogue/` define the bundled terms. `rezics.yaml` imports
the shared `core` terms and the `book`, `recipe` and `works` profiles. These profiles add
types and properties through catalogue data; they do not need package code. The
compiled release is checked in at `release/rezics.json`, and `src/bundled.ts`
exposes both the source files and that release.

To change the catalogue, edit its LinkML source or the language files in
`presentation/`, then run `bun run --cwd packages/definitions release` and review
the resulting release. A term has one meaning for its lifetime. If its meaning
changes, add a new term instead of editing the existing one.

Run `bun run --cwd packages/definitions check` from the repository root.

Release tooling imports `compileCatalogue` and `CatalogueError` from
`@rezics/definitions/compile`. This separate entry point loads
`@neverblink/linkml` 0.17.1; the default entry point never imports the compiler or
LinkML. Compilation runs at release time, with all source text supplied in memory:

```ts
import { compileCatalogue } from '@rezics/definitions/compile';

const release = await compileCatalogue({
  root: 'catalogue.yaml',
  schemas: { 'catalogue.yaml': catalogueYaml, 'core.yaml': coreYaml },
  presentation: { en: englishLabelsYaml, ja: japaneseLabelsYaml },
});
```

Source conventions:

- Supply at most 64 schema files, each at most 256 KiB of UTF-8. YAML is parsed
  with `Bun.YAML.parse`. Imports may reference `linkml:types` or supplied files,
  using LinkML's relative paths and optional `.yaml` or `.yml` extensions.
- Schema keys are limited to `id`, `name`, `title`, `description`, `version`,
  `license`, `prefixes`, `default_prefix`, `default_range`, `imports`, `classes`,
  and `slots`. The root's `id` and `version` identify the release catalogue.
- Class keys are limited to `class_uri`, `description`, `is_a`, `abstract`,
  `slots`, `slot_usage`, `exact_mappings`, and `close_mappings`. Every concrete
  class needs an explicit `class_uri` CURIE and becomes a type. LinkML derives
  its properties through `is_a` and `slot_usage`; each type has at most 64.
- Slot keys are limited to `slot_uri`, `description`, `range`, `any_of`,
  `multivalued`, `pattern`, `minimum_value`, `maximum_value`, `exact_mappings`,
  `close_mappings`, and `annotations`. `slot_usage` entries allow the same keys
  except `slot_uri`. Each `any_of` entry permits only `range`. Every global slot
  needs an explicit `slot_uri` CURIE, including slots used only as qualifiers.
  Class and slot keys must each be unique. Prefix expansions must be consistent
  across files. Different induced contracts for the same property cannot be
  represented in one release and are refused.
- `annotations` permits only `datatype`, `units`, and `qualifiers`. `datatype`
  is required: `wikibase-item` needs a concrete class range or `any_of` concrete
  class ranges; `string`, `external-id`, `monolingualtext`, `document`, and `media` need `string`;
  `url` needs `uri`; `quantity` needs `integer` or `decimal`; `time` needs `date`.
  An omitted range uses the source schema's default, otherwise `string`.
- `external-id` requires exactly one exact mapping, matching `wd:P<digits>`.
  Exact mappings become release mappings; close mappings are accepted as source
  metadata. Quantity requires `units`, a space-separated string of `1` or
  CURIEs, expanded to IRIs, and alone permits minimum and maximum bounds.
  `qualifiers` is a space-separated string of existing slot names.
- Patterns are allowed only on `string`, `external-id`, and `monolingualtext`.
  Every source pattern must compile with JavaScript's `u` flag, contain at most
  256 characters, and receive `safe` from recheck's synchronous checker.
- Each presentation entry uses a BCP 47 language tag and contains a YAML object
  with optional `types` and `properties` maps, keyed by release CURIE. Labels
  must be nonempty strings of at most 256 characters. Unknown terms and other
  keys are refused. Every emitted type and property requires an `en` label;
  other locales may be partial.

Limits and profile checks precede LinkML loading and linting, then mapping, then
labels. Compilation stops at the first stage with violations. LinkML warnings
are permitted; errors are refused. Derived JSON with derivation enabled supplies
classes and induced attributes. An auxiliary abstract class induces all global
slots through LinkML, preserving unused qualifier properties without resolving
inheritance in this compiler. Lists are sorted and deduplicated. Release prefixes
contain exactly those used in keys, mappings, and targets; unit-only prefixes are
expanded but omitted. Generator metadata comes from `LinkML.buildInfo()`.

`CatalogueError.violations` contains `{ file, pointer, code, message }` records,
sorted by file and RFC 6901 pointer and capped at 64. Label files are named
`presentation/<tag>` in diagnostics. Codes are `unsupported`, `invalid`, `limit`,
`unsafe_pattern`, `linkml`, `duplicate`, and `missing_label`. The final release is
checked with `validateRelease`; a failure at that point throws a plain `Error`
because it indicates a compiler defect.

## Bulk subject writes

`@rezics/definitions/bulk` exports the portable TypeBox request and response contract for
`POST /v1/subjects:batchWrite`, together with static types and structural validators.
A request contains 1 to 100 commands. Each command has a printable ASCII idempotency
key, a source identity and exactly one operation: create a subject, propose a statement,
or retract a candidate. `checkBatchWrite` validates shapes, field names, limits, enums,
and duplicate keys, returning RFC 6901 pointers and one of `required`, `unknown_field`,
`invalid_type`, `invalid_format`, `out_of_range`, or `unsupported`. Passing a release
currently throws because release dependent checks are not implemented. Results preserve
one result per command and its request order; each result contains either a value or an
RFC 9457 problem.

The endpoint requires `subject:batch_write` on the Global Context through an explicit
grant with no standing grant, checked once per request. Before reading a receipt, every
command is authorized as its single-command equivalent: create uses `subject:create`
through parent authorization on the Global Context; propose and retract use
`statement:propose`. This authorization also runs on every replay.

Each command runs alone in its subject's partition and uses its own receipt, keyed by
principal and command key, exactly as the corresponding single endpoint does. A batch is
not atomic: commands may run concurrently, and results retain request order. Before any
command runs, the request spends one unit per command from the caller's import rate
budget. If the budget is exceeded, the endpoint returns 429 with `Retry-After` and runs
nothing.

A command failure is returned as its result: 400 `invalid_request` with errors pointing
into the request, 403, 404 `not_found`, 409 `conflict` (with `redirect: { from, to }`
for a redirected subject), 409 `fenced` when that source `(source, external_id,
field_group)` is fenced on the subject, or 503 as for a single request. Fencing is
checked inside the command. Retry a lost response or 5xx result with the same key: the
receipt replays the first outcome, so a command is never lost or applied twice. A
proposal or retraction never changes what a Context adopted; editors decide it.

The contract has no runtime path. `checkBatchWrite` is linear in request size, bounded by
`BATCH_LIMIT` and the statement limits.

### Import field groups

A converter never fabricates a REZICS id or a licence. Subject ids come from an
existing subject or a successful create result; media ids come from an upload.
Use `LicenseRef-unknown` when the source licence is unknown. A source record's
facts, summary and cover have separate provenance and fence identities.

`facts` contains ordinary statements. An unresolved relation uses `somevalue`
with the target's source identifier as a qualifier; it never substitutes an
external identifier for a REZICS subject id. Only `facts` supports `create` and
`retract`. The following commands share this setup:

```ts
import { fromPlainText } from '@rezics/document';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';

// Supplied by subject creation/lookup and media upload, respectively.
declare const subjectId: string;
declare const uploadedMediaId: string;
const source = (field_group: Source['field_group']): Source => ({
  source: 'bangumi',
  external_id: '253',
  record_revision: 'unversioned',
  digest: 'd'.repeat(64),
  converter_revision: 'bangumi@1',
  field_group,
});
const references = [
  {
    parts: [
      {
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content: 'https://bgm.tv/subject/253' },
      },
    ],
  },
];

const fact: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:facts:1',
  source: source('facts'),
  subject: subjectId,
  statement: { property: { id: 'wdt:P5732' }, value: { type: 'value', content: '253' }, references },
};

const unresolvedAuthor: BatchCommand = {
  op: 'propose',
  key: 'openlibrary:OL45804W:author:1',
  source: { ...source('facts'), source: 'openlibrary', external_id: 'OL45804W', converter_revision: 'openlibrary@1' },
  subject: subjectId,
  statement: {
    property: { id: 'schema:author' },
    value: { type: 'somevalue' },
    qualifiers: [{ property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL26320A' } }],
    references: [
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://openlibrary.org/works/OL45804W' },
          },
        ],
      },
    ],
  },
};

const summary: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:summary:1',
  source: source('summary'),
  subject: subjectId,
  rights: {
    license: 'CC-BY-SA-3.0',
    obligations: ['cc:Attribution', 'cc:ShareAlike'],
    attribution: 'Bangumi contributors',
  },
  statement: {
    property: { id: 'schema:abstract' },
    value: { type: 'value', content: { language: 'ja', document: fromPlainText('吾輩は猫である。名前はまだ無い。') } },
    references,
  },
};

const cover: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:cover:1',
  source: source('cover'),
  subject: subjectId,
  statement: { property: { id: 'schema:image' }, value: { type: 'value', content: uploadedMediaId }, references },
};
```

`summary` and `cover` support only `propose` with a concrete `value`. A summary
requires `rights`: an SPDX licence identifier or `LicenseRef-` identifier of at
most 80 characters, zero to four distinct CC REL requirements (`cc:Attribution`,
`cc:ShareAlike`, `cc:Notice`, `cc:SourceCode`), and attribution of 1–500 characters.
Its document uses the `text` profile accepted by `@rezics/document`, with a
`serializeDocument` representation of at most 32,768 UTF-8 bytes. The document
has its own licence and its body is stored by content. `schema:abstract` is
multivalued, with one summary per language by convention.

A cover value is an uploaded media object's UUID. Credit, licence and provenance
belong to that media object. Rights on any command except a summary proposal are
unsupported. Field/property compatibility belongs to release validation: summaries
use `document` properties, covers use `media`, and facts use neither. Until content's
hooks are wired, kernel writes reject document and media contents as `unsupported`.

The launch profiles include books, editions, recipes, television series, albums,
video games and visual novels. Identifier labels follow their Wikidata properties
([Open Library](https://www.wikidata.org/wiki/Property:P648),
[Bangumi subjects](https://www.wikidata.org/wiki/Property:P5732),
[Bangumi people](https://www.wikidata.org/wiki/Property:P6298),
[VNDB](https://www.wikidata.org/wiki/Property:P3180)); the summary and cover terms
follow [schema:abstract](https://schema.org/abstract) and
[schema:image](https://schema.org/image).
