# @rezics/definitions

The immutable definition catalogue release format stored by the kernel. This package
exports the release types, the JSON Schema 2020-12 document at
`@rezics/definitions/schema/release.json`, and pure validation and digest functions.

Use `validateRelease(input)` before storing a release. An empty array means valid;
otherwise violations carry RFC 6901 pointers and `invalid`, `unsafe_pattern`, or
`limit` codes. Results are sorted, deduplicated by pointer, and capped at 64.
Validation checks references, CURIE expansion, sorted unique lists, type bases and
facets, datatype-specific members, fixed value schemas, context defaults, saved
filters, and regular-expression safety. A facet is an item, a time, a quantity, or
a code: a `string` whose release definition has a `pattern`. Pattern checks use
one shared structural admission policy and recheck 4.5.0's in-process synchronous
entry point in an isolated VM context. The pinned browser checker's `performance.now`
is a private counter, with a budget of 8,192 native cancellation checkpoints
per expression; it never reads or patches the host clock. This also bounds DFA
construction, which has no native size cap. Safety verdicts have no wall-clock deadline. Admission permits at most
256 source characters, 16 nested groups, repetition endpoints of 64, a sum of 128
repetition endpoints, and 128 expanded structural units (including group and
quantifier overhead). Nested repetitions multiply their costs before analysis.
Backreferences, named groups, Unicode properties, lookbehind, and lookahead of
more than one character atom are refused. All shipped value schemas fit this profile.
The checker caps graph construction at 1,024 transitions and accepts only an
`automaton` safe verdict. Its `auto` selection is used because the pinned version
bypasses graph limits in explicit `automaton` mode; a synchronous diagnostic guard
refuses limit failures and fuzz fallback before seeding or matching. Recall attack
execution is disabled. Invalid, unsupported, over-budget, and inconclusive patterns
fail validation. Proof results are cached only within each release/compiler call.

Releases allow at most 1,024 types, 4,096 properties, 64 properties and 16 facets per
type, 256 context settings, 64 defaults per settings, 1,024 saved filters, 64 per
group, and 4 MiB of canonical UTF-8 JSON. Collection and size limits precede schema
and pattern checks.
A property may name at most 1,024 targets. Compilation allows at most 256 schema files.

The launch grain is three types and twelve properties in one schema file. The bundled
catalogue has 17 types, 68 properties and 12 schema files. One hundred such verticals
add 300 types, 1,200 properties and 100 schema files: 317 types, 1,268 properties and
112 schema files, 874,688 canonical bytes. `foaf:focus` ranges over `Thing`, so its
target is `schema:Thing`; a later type matches through its `bases`.
`schema:exampleOfWork` ranges over `CreativeWork`, so its target stays
`schema:CreativeWork` when a vertical adds a creative-work subtype. Adding a
vertical never changes another vertical's properties. The previous caps of 256
types, 1,024 properties and 64 schema files do not fit that grain. The measured
body is 874,688 bytes, so the previous 1 MiB cap still holds it. The new caps multiply those limits by four: 1,024
types, 4,096 properties, 256 schema files and 4 MiB. Targets are the exception: every
target is a type, so the target cap equals the type cap. That is about three times the
measured type and property counts. Per-type caps stay 64 properties and 16 facets,
because a request touches one type.

A release is validated once per digest per process. Later requests read the subject's
type and the properties on its facts from that cached release. The limits bound
publishing and the cold read. A cold read is linear in the release's canonical bytes
and happens once per digest per process. It does not bound request cost after that.
Inputs are parsed JSON, without cycles. Validation does not mutate them.

`valueSchema(datatype, options)` builds the fixed Wikibase value-content schema.
`releaseDigest(release)` returns `sha256:` followed by the SHA-256 digest of its
RFC 8785 canonical JSON. Validate first: the digest function does not validate.

## Bundled catalogue

The LinkML sources in `catalogue/` define the bundled terms. `rezics.yaml` imports
the shared `core` terms and each profile schema. These profiles add types and
properties through catalogue data; they do not need package code. The compiled
release is checked in at `release/rezics.json`, and `src/bundled.ts` discovers all
catalogue, presentation, context-settings, and saved-filter YAML files for
compilation. Each type release records its structural `bases` as CURIEs, nearest
first, and its registered `facets` in display order. Each vertical declares its own
facets.

`schema:inLanguage` is the BCP 47 language tag of the resource. The catalogue stores
the canonical case of the subtags it uses: a lowercase language, an optional
title-case script, and an optional region. Its pattern is
`^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|[0-9]{3}))?$`. `ja`, `zh-Hant`,
`pt-BR` and `es-419` match. Writers produce that spelling with
`Intl.getCanonicalLocales`.

To add a vertical, add its schema as `catalogue/<vertical>.yaml`, add that schema
to the imports in `catalogue/rezics.yaml`, and add one label file per locale at
`presentation/<vertical>/<tag>.yaml` for each locale the vertical supports. Keep
each term's labels in the group named for the schema file that defines that term.
Profiles with no current terms can contain only metadata and an import of `core`.

Context settings are the defaults a community Context created for that vertical
starts with. Add them beside the vertical layout as `contexts/<id>.yaml`. The id
matches `^[a-z][a-z0-9-]{0,63}$`. Presentation keys stay label files only. The
document has `labels` and `defaults` only. `labels` maps a locale tag to the
Context's name under the rules for type labels: a BCP 47 tag, nonempty text of at
most 256 characters, and an `en` label. `defaults` maps a property CURIE to
`inherit` or `suppress`. A default must name a property in the release. `replace`
is never a default: it needs a per-subject selection. One settings file has at
most 64 defaults, and a release has at most 256 settings. `src/bundled.ts` reads
every `contexts/*.yaml` in id order, and `scripts/release.ts` compiles them, so a
vertical adds a file and edits no code. The release records `contexts` with those
ids sorted and omits `contexts` when there are none. The release format stays
`https://rezics.com/definitions/release/1`. Releases that omit `contexts` stay
valid. A Context keeps the defaults it was created with. A later settings file
applies to Contexts created from that release. This package ships no settings file.

Saved filters are named filter documents a reader picks and a Zone starter uses to
scope itself. Add them beside the vertical layout as `filters/<group>.yaml`. The
group matches `^[a-z][a-z0-9-]{0,63}$`. The document maps each slug, with the same
pattern, to `labels` and `filter`. `labels` follows the rules for type labels: a
BCP 47 tag, nonempty text of at most 256 characters, and an `en` label. `filter`
names types, facets, years and amounts. Subject ids, concepts included, are runtime
data that differs per deployment, so a saved filter that names one is refused. A
saved filter also cannot contain a saved leaf. One group has at most 64 filters,
and a release has at most 1,024. `src/bundled.ts` reads every `filters/*.yaml` in
group order, and `scripts/release.ts` compiles them, so a vertical adds a file and
edits no code. The release records `filters` with keys `<group>/<slug>`, sorted,
and omits `filters` when there are none. Releases that omit `filters` stay valid.
A search request references a saved filter with the leaf `{ saved: '<group>/<slug>' }`,
expanded before admission. A Zone starter scopes itself with that same leaf.
Releases stay cached by digest, with no request path changes. This package ships
no filters file.

To change the catalogue, edit its LinkML source or the language files in
`presentation/`, then run `bun run --cwd packages/definitions release` and review
the resulting release. A term has one meaning for its lifetime. If its meaning
changes, add a new term instead of editing the existing one.

Run `bun run --cwd packages/definitions check` from the repository root.

### Shared terms

`CreativeWork`, `Character` and `CreativeWorkSeries` are abstract anchors. Book
works, editions and launch works extend `CreativeWork`; `FictionalCharacter` and
`Series` extend the other two anchors. An item property's `targets` name its
declared range. `schema:exampleOfWork` ranges over `CreativeWork`, so its target
is `schema:CreativeWork`. A value matches when its subject's type is that target
or the type's `bases` contain it, including editions and any later creative-work
subtype. Adding a vertical never changes another vertical's properties. The two
concrete profiles add no slots of their own here.

A credit is a statement whose property names the job and whose value is a person
or organization. Its qualifiers record the name as credited, credit order and a
detailed role concept, such as a Bangumi staff position. Existing identifier
qualifiers remain available. A voice credit can also name the character portrayed.
Only `schema:contributor` is inherited from `CreativeWork`; profiles attach other
credit properties and character appearances to the types that use them.

An appearance is a `schema:character` statement, qualified by an appearance role
concept (main, supporting, and so on), its credited name and spoiler level. The
custom `rezics:spoilerLevel` quantity uses unit `1`, from 0 (no spoiler) through
2 (major spoiler). This disclosure mechanism has no standard vocabulary term.

Genres, tags and detailed roles are SKOS concepts. A concept and its scheme are
subjects, created and adopted like any other subject; a Realm's board scheme is
one example. When a classification value stands for another subject, the concept
names that subject with `foaf:focus`, whose range is `Thing` and whose target is
`schema:Thing`. Any type under `Thing` matches that target through its `bases`.

Series membership is an adopted `wdt:P179` statement on the member creative work,
with its ordinal in `schema:position`. It is never a list membership. The shared
catalogue adds a fixed set of terms; releases remain cached by digest, with no
runtime path changes.

The following list cites the vocabulary terms and Wikidata mappings used here.
SKOS and FOAF terms cite their publishing vocabularies. New terms have labels in
`en`, `zh-Hant`, `zh-Hans`, `ja`, `ko`, `de`, `fr` and `es`, in their respective
presentation groups. Labels use Wikidata's language-specific labels where available
or the vocabulary's English label; missing labels are authored locally without a
translation service. Existing terms retain their current labels.

| Term                        | Source and meaning                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema:CreativeWork`       | [CreativeWork](https://schema.org/CreativeWork), the shared work anchor                                                                                    |
| `schema:CreativeWorkSeries` | [CreativeWorkSeries](https://schema.org/CreativeWorkSeries), the shared series anchor                                                                      |
| `wd:Q95074`                 | [character](https://www.wikidata.org/wiki/Q95074), the concrete fictional character profile                                                                |
| `wd:Q7725310`               | [series of creative works](https://www.wikidata.org/wiki/Q7725310), the concrete series profile                                                            |
| `schema:exampleOfWork`      | [exampleOfWork](https://schema.org/exampleOfWork), mapped to [edition or translation of (P629)](https://www.wikidata.org/wiki/Property:P629)               |
| `schema:author`             | [author](https://schema.org/author), mapped to [author (P50)](https://www.wikidata.org/wiki/Property:P50)                                                  |
| `schema:translator`         | [translator](https://schema.org/translator), mapped to [translator (P655)](https://www.wikidata.org/wiki/Property:P655)                                    |
| `schema:publisher`          | [publisher](https://schema.org/publisher), mapped to [publisher (P123)](https://www.wikidata.org/wiki/Property:P123)                                       |
| `schema:illustrator`        | [illustrator](https://schema.org/illustrator), mapped to [illustrator (P110)](https://www.wikidata.org/wiki/Property:P110)                                 |
| `schema:director`           | [director](https://schema.org/director), mapped to [director (P57)](https://www.wikidata.org/wiki/Property:P57)                                            |
| `schema:musicBy`            | [musicBy](https://schema.org/musicBy), mapped to [composer (P86)](https://www.wikidata.org/wiki/Property:P86)                                              |
| `schema:producer`           | [producer](https://schema.org/producer), mapped to [producer (P162)](https://www.wikidata.org/wiki/Property:P162)                                          |
| `schema:productionCompany`  | [productionCompany](https://schema.org/productionCompany), mapped to [production company (P272)](https://www.wikidata.org/wiki/Property:P272)              |
| `wdt:P58`                   | [screenwriter](https://www.wikidata.org/wiki/Property:P58)                                                                                                 |
| `wdt:P178`                  | [developer](https://www.wikidata.org/wiki/Property:P178)                                                                                                   |
| `wdt:P725`                  | [voice actor](https://www.wikidata.org/wiki/Property:P725)                                                                                                 |
| `schema:contributor`        | [contributor](https://schema.org/contributor), mapped to [contributor to the creative work or subject (P767)](https://www.wikidata.org/wiki/Property:P767) |
| `wdt:P1932`                 | [object of statement named as](https://www.wikidata.org/wiki/Property:P1932), the name as credited                                                         |
| `schema:position`           | [position](https://schema.org/position), mapped to [series ordinal (P1545)](https://www.wikidata.org/wiki/Property:P1545)                                  |
| `wdt:P3831`                 | [object of statement has role](https://www.wikidata.org/wiki/Property:P3831), a detailed role concept                                                      |
| `wdt:P453`                  | [character role](https://www.wikidata.org/wiki/Property:P453), the character portrayed                                                                     |
| `schema:character`          | [character](https://schema.org/character), mapped to [characters (P674)](https://www.wikidata.org/wiki/Property:P674)                                      |
| `rezics:spoilerLevel`       | `https://rezics.com/vocab/spoilerLevel`, the custom disclosure quantity described above                                                                    |
| `skos:Concept`              | [Concept](https://www.w3.org/2009/08/skos-reference/skos.html#Concept), a classification concept                                                           |
| `skos:ConceptScheme`        | [ConceptScheme](https://www.w3.org/2009/08/skos-reference/skos.html#ConceptScheme), a concept scheme                                                       |
| `skos:inScheme`             | [inScheme](https://www.w3.org/2009/08/skos-reference/skos.html#inScheme), scheme membership                                                                |
| `skos:broader`              | [broader](https://www.w3.org/2009/08/skos-reference/skos.html#broader), a broader concept                                                                  |
| `foaf:focus`                | [focus](http://xmlns.com/foaf/spec/#term_focus), the subject a concept stands for                                                                          |
| `schema:genre`              | [genre](https://schema.org/genre), mapped to [genre (P136)](https://www.wikidata.org/wiki/Property:P136)                                                   |
| `schema:keywords`           | [keywords](https://schema.org/keywords), tag concepts                                                                                                      |
| `wdt:P179`                  | [part of the series](https://www.wikidata.org/wiki/Property:P179), membership on the member                                                                |

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

- Supply at most 256 schema files, each at most 256 KiB of UTF-8. YAML is parsed
  with `Bun.YAML.parse`. Imports may reference `linkml:types` or supplied files,
  using LinkML's relative paths and optional `.yaml` or `.yml` extensions.
- Schema keys are limited to `id`, `name`, `title`, `description`, `version`,
  `license`, `prefixes`, `default_prefix`, `default_range`, `imports`, `classes`,
  and `slots`. The root's `id` and `version` identify the release catalogue.
- Class keys are limited to `class_uri`, `description`, `is_a`, `abstract`,
  `slots`, `slot_usage`, `exact_mappings`, `close_mappings`, and `annotations`.
  Every concrete class needs an explicit `class_uri` CURIE and becomes a type.
  LinkML derives its properties through `is_a` and `slot_usage`; each type has at
  most 64.
- A class may set `annotations.facets` to a space-separated list of slot names.
  A type inherits its ancestors' declarations from root to leaf, retaining that
  display order. Each facet must be one of the type's properties. Its datatype is
  `wikibase-item`, `time`, or `quantity`, or `string` with a `pattern` in the
  release definition. That fourth kind is a code: an identifier such as a language
  tag. A `string` without a pattern, and every other datatype, is refused at the
  same pointer and code as any other unfilterable facet. A slot may appear only
  once in the inheritance chain, and a type may have at most 16 facets. The type
  itself is always a facet and is not listed in this annotation.
- A type's `bases` list contains its `is_a` ancestors that declare `class_uri`,
  nearest first. It omits the type's own CURIE and repeated CURIEs; ancestors
  without `class_uri` are skipped.
- Slot keys are limited to `slot_uri`, `description`, `range`, `any_of`,
  `multivalued`, `pattern`, `minimum_value`, `maximum_value`, `exact_mappings`,
  `close_mappings`, and `annotations`. `slot_usage` entries allow the same keys
  except `slot_uri`. Each `any_of` entry permits only `range`. Every global slot
  needs an explicit `slot_uri` CURIE, including slots used only as qualifiers.
  Class and slot keys must each be unique. Prefix expansions must be consistent
  across files. Different induced contracts for the same property cannot be
  represented in one release and are refused.
- Slot `annotations` permits only `datatype`, `units`, and `qualifiers`. `datatype`
  is required: `wikibase-item` needs a class range or `any_of` class ranges; `string`,
  `external-id`, `monolingualtext`, `document`, and `media` need `string`;
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
- Each presentation entry uses a BCP 47 language tag or `<group>/<tag>`, where
  group matches `^[a-z][a-z0-9-]{0,63}$`, and contains a YAML object with optional
  `types` and `properties` maps, keyed by release CURIE. Files with the same tag
  merge; a term can be labelled only once per tag. Labels must be nonempty strings
  of at most 256 characters. Unknown terms and other keys are refused. Every
  emitted type and property requires an `en` label; other locales may be partial.
- Optional `contexts` supplies Context settings YAML keyed by id. Each id matches
  `^[a-z][a-z0-9-]{0,63}$`. The document allows only `labels` and `defaults`.
  Defaults name properties in the release and use `inherit` or `suppress`. There
  are at most 256 settings and 64 defaults in each. An empty map omits `contexts`.
- Optional `filters` supplies saved-filter YAML keyed by group. Each group and slug
  matches `^[a-z][a-z0-9-]{0,63}$`. Each entry allows only `labels` and `filter`.
  Labels follow the type-label rules, including an `en` label. Each filter is checked
  with `validateFilter` from `@rezics/filter` against the release being built, with
  saved leaves refused. Subject ids are refused. There are at most 1,024 filters and
  64 in each group. An empty map omits `filters`.

Limits and profile checks precede LinkML loading and linting, then mapping, then
labels, then context settings, then saved filters. A `wikibase-item` property's
`targets` name its declared range: the CURIE of each class named by `range` or
`any_of`, sorted and unique. A named class without `class_uri` contributes the
CURIEs of its nearest descendants that have one, resolved across all supplied
schemas; a range that contributes none is invalid. Emitted targets are sorted
and unique, and a property may name at most 1,024. A value matches a target when
its subject's type equals that target or the type's `bases` contain it, so adding
a vertical never changes another vertical's properties. Compilation stops at the
first stage with violations. LinkML
warnings are permitted; errors are refused. Derived JSON with derivation enabled supplies
classes and induced attributes. An auxiliary abstract class induces all global
slots through LinkML, preserving unused qualifier properties without resolving
inheritance in this compiler. CURIE lists are sorted and deduplicated except for
`bases` and `facets`, which retain ancestor and display order. Release prefixes
contain exactly those used in keys, mappings, targets, bases, and facets; unit-only
prefixes are expanded but omitted. Generator metadata comes from `LinkML.buildInfo()`.

`CatalogueError.violations` contains `{ file, pointer, code, message }` records,
sorted by file and RFC 6901 pointer and capped at 64. Label files are named
`presentation/<tag>` in diagnostics. Context settings are named `contexts/<id>`,
and their pointers start at `/contexts/<id>`. A release with more than 256
settings is reported at `/contexts`. Saved filters are named `filters/<group>`.
Pointers use the release key `<group>/<slug>`, with `/` escaped as `~1`. Each
filter error is reported at `/filters/<group>~1<slug>/filter` plus the filter
pointer: `limit` when the filter exceeds a limit, otherwise `invalid`. A release
with more than 1,024 filters is reported at `/filters`. A group with more than 64
is reported at `/filters/<group>`. Codes are `unsupported`, `invalid`, `limit`,
`unsafe_pattern`, `linkml`, `duplicate`, and `missing_label`. The final release is
checked with `validateRelease`; a failure at that point throws a plain `Error`
because it indicates a compiler defect.

## Portable input validation

`@rezics/definitions/validate` exports `Violation`, `ItemTarget`,
`checkSubjectInput(input, release)` and `checkStatementInput(statement, release)`.
These pure checks share the kernel's structural and release validation, including
RFC 6901 pointers, error codes, ordering and a 16-violation cap. Subject pointers
start at the subject root; proposal pointers start at `/statement`. Each returns
`{ violations, targets }`. Item targets carry the value pointer, subject id and
allowed target types for the caller to check against its database. The checks do
not read a database or import the kernel; compiled value validators are cached
per release. Supply an immutable, validated release and parsed JSON inputs.

An item property's release `targets` may name a type key or any CURIE listed in
the `bases` of a release type. This lets a target name an abstract base that has
no entry in the release's `types`. A value matches when its subject's type equals
a target or its type's `bases` contains a target. The compiler emits the declared
range, so adding a subtype matches through `bases` and does not change `targets`.
Expanded lists of concrete type keys remain valid.

Structural limits apply to every release: decimal strings have at most 127
characters and a time's year has at most 16 digits. An oversized value reports
`out_of_range` at its decimal member or `/time`, without further value checks.
The release value schemas retain their Wikibase shapes. Document and media
values are portable. Single-subject writes and single-statement routes still
reject document and media contents as `unsupported`. A sourced bulk command
can carry them, because that command has the provenance and rights the values need.

## Bulk subject writes

`@rezics/definitions/bulk` exports the portable TypeBox request and response contract for
`POST /v1/subjects:batchWrite`, together with static types and structural validators.
A request contains 1 to 100 commands. Each command has a printable ASCII idempotency
key, a source identity and exactly one operation: create a subject, propose a statement,
or retract a candidate. `checkBatchWrite` validates shapes, field names, limits, enums,
and duplicate keys, returning RFC 6901 pointers and one of `required`, `unknown_field`,
`invalid_type`, `invalid_format`, `out_of_range`, or `unsupported`. Passing a release
also runs the shared subject and statement input checks, then field/property compatibility
checks: summaries use `document`, covers use `media`, and facts use neither. Results preserve
one result per command and its request order; each result contains either a value or an
RFC 9457 problem.

The endpoint requires `subject:batch_write` on the Global Context through an explicit
grant with no standing grant, checked once per request. Before reading a receipt, every
command is authorized as its single-command equivalent: create uses `subject:create`
through parent authorization on the Global Context; propose and retract use
`statement:propose`. This authorization also runs on every replay.

The kernel serves `facts`, `summary`, and `cover` on this route. Any other field
group receives a command-local 400 with only `/commands/<i>/source/field_group`
`unsupported`. A create still rejects `summary` and `cover`. Without an active
release the request receives 503 `semantic_not_ready`. Request-level shape errors
receive 400 and nothing runs; command-level errors retain their original pointers
and do not prevent valid peers from running.

Each command runs alone in one partition and uses a receipt keyed by caller, command
key and `subject.batch_<op>`, with a digest covering the whole command. Commands on
the same partition run in request order; at most eight partitions run concurrently.
A batch is not atomic. The 200 response contains `{ results }` in request order,
one `{ key, status, value }` or `{ key, status, problem }` per command. Problems carry
the single-request body without `instance`. The session header merges command
positions in request order, keeping the latest 32 partitions. The shared write-rate
stage charges the request once, using its command count.

A create claims `(source, external_id)` permanently on the route shared with content's
source fences, without a field group in that identity. A new claim creates one subject,
adopts its labels, descriptions and aliases in Global, and returns 201 `{ id, revision: 1 }`.
A resolving create ignores the supplied subject body and returns 200 `{ id, revision }`
with the existing subject's latest revision. A different type conflicts, an invisible
subject is not found, and a redirected subject conflicts with `redirect: { from, to }`;
a claim is never re-created or reassigned. Creates cannot carry statements: importers
propose each fact to the returned id.

Propose returns 201 `{ candidate, revision }`. A source's refresh with the same
`(source, external_id, field_group)` returns 200 with its existing candidate and
the latest subject revision when the statement identity matches. Facts and covers
use the canonical property, value, and qualifiers. A summary uses the property,
language, and SHA-256 of `serializeDocument` after block ids are replaced in
document order, computed before content's hook, so an unchanged summary appends
no document. Generated block ids are not part of that identity. References and rank do not
change that identity. Refreshes cannot restore moderated content. A hidden or
taken-down candidate answers its id only to a command that is currently allowed.
Retract requires a candidate proposed by the same source tuple; another source's
candidate conflicts and an unknown candidate is not found. It appends a cited
retraction revision, removes the source-candidate identity, and returns 200 `{ revision }`.
A retract in `summary` or `cover` uses those same 404 and 409 answers. It carries
no rights, calls no content hook, and leaves the document and the media claim
with content. A later proposal may then create a new candidate. Proposals and
retractions leave Context adoptions unchanged.

Revision listings include the source envelope or null for individual writes.
Candidate listings expose the proposing `source`, latest `retracted` revision and
`retraction: { source, references }`, each null when absent. Provenance follows the
listing's usual visibility rules. Every command with a source reads that tuple's fence through content's
`readFences` before its receipt and before deduplication. A taken-down tuple is
that command's 409 `fenced` with no effect, including an unchanged refresh and a
replay of a command key. Subject views, candidate listings, and the search source
read omit candidates whose source tuple is currently fenced. Command failures
include 400 `invalid_request`, 403 `forbidden`, 404 `not_found`, 409 `conflict`,
409 `fenced`, 422 `idempotency_conflict`, and 503 as for an individual write.
Retry a lost response with the same command key to replay its receipt.

The contract has no runtime path. `checkBatchWrite` is linear in request size, bounded by
`BATCH_LIMIT` and the statement limits. Proposals require nonempty `references`;
missing or empty references report `required`. Proposal ranks are `normal` or
`preferred`.

### Import field groups

A converter never fabricates a REZICS id or a licence. Subject ids come from an
existing subject or a successful create result; media ids come from an upload.
Use `LicenseRef-unknown` when the source licence is unknown. A source record's
facts, summary and cover have separate provenance and fence identities.

`facts` contains ordinary statements. Treat a source title or name as a
`schema:name` candidate; changing it does not change the labels set at subject
creation. Retract the old candidate when the source record changes. For books,
propose an edition's authors on the edition as the source states them, and keep the
work's authors on the work; a converter never copies authors between them. Convert
an ISBN-10 to ISBN-13 under ISO 2108 by prefixing `978` and recomputing the check
digit, and propose only the ISBN-13 under `schema:isbn`. For a month-only date,
use Wikibase time precision 10 with day `00`, cite the source record, and omit
the raw date string. An unresolved relation uses `somevalue` when the target is
known by a Wikidata item URI, stored in a `schema:sameAs` qualifier; it never
substitutes an external identifier for a REZICS subject id. If a converter has
no identifier for a target, it proposes no relation for that target. Only `facts` supports `create`;
a create subject contains only `type`, `labels`, `descriptions` and `aliases`.
`statements` on a create is `unsupported`. Propose each source statement separately
so its source-candidate key can track refresh and retraction.
Every group supports `propose` and `retract`, and a retraction carries no rights. The following
commands share this setup:

Each imported record fact cites the exact source record with its URL, its
catalogued source identifier property, its source revision in `schema:version`,
and its last-modified date in `schema:dateModified`. For example, an Open Library
work can use one reference with these four parts:

```ts
const openLibraryReference = {
  parts: [
    { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://openlibrary.org/works/OL45804W' } },
    { property: { id: 'wdt:P648' }, value: { type: 'value', content: 'OL45804W' } },
    { property: { id: 'schema:version' }, value: { type: 'value', content: revision } },
    {
      property: { id: 'schema:dateModified' },
      value: {
        type: 'value',
        content: {
          time: '+2024-01-11T00:00:00Z',
          precision: 11,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
      },
    },
  ],
};
```

Here `revision` is the revision value from the Open Library record, and the date
is `last_modified` represented at day precision in UTC. Keep `record_revision`
in the source envelope as its separate field.

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

const create: BatchCommand = {
  op: 'create',
  key: 'bangumi:253:create',
  source: source('facts'),
  subject: { type: 'schema:Book', labels: { ja: '吾輩は猫である' } },
};
// After creation returns subjectId, send each statement as a propose command.

const fact: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:facts:1',
  source: source('facts'),
  subject: subjectId,
  statement: { property: { id: 'wdt:P5732' }, value: { type: 'value', content: '253' }, references },
};

const changedTitle: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:title:2',
  source: source('facts'),
  subject: subjectId,
  statement: {
    property: { id: 'schema:name' },
    value: { type: 'value', content: { language: 'en', text: 'Revised source title' } },
    references,
  },
};

declare const previousTitleCandidate: string;
const retractPreviousTitle: BatchCommand = {
  op: 'retract',
  key: 'bangumi:253:title:3',
  source: source('facts'),
  subject: subjectId,
  candidate: previousTitleCandidate,
  references,
};

// The source has ISBN-10 4-10-101013-0; only its ISBN-13 is proposed.
const isbn: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:isbn:1',
  source: source('facts'),
  subject: subjectId,
  statement: {
    property: { id: 'schema:isbn' },
    value: { type: 'value', content: '978-4-10-101013-7' },
    references,
  },
};

const publicationMonth: BatchCommand = {
  op: 'propose',
  key: 'bangumi:253:publication-month:1',
  source: source('facts'),
  subject: subjectId,
  statement: {
    property: { id: 'schema:datePublished' },
    value: {
      type: 'value',
      content: {
        time: '+1980-05-00T00:00:00Z',
        precision: 10,
        calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
      },
    },
    references,
  },
};

const unresolvedAuthor: BatchCommand = {
  op: 'propose',
  key: 'openlibrary:OL45804W:author:1',
  source: { ...source('facts'), source: 'openlibrary', external_id: 'OL45804W', converter_revision: 'openlibrary@1' },
  subject: subjectId,
  statement: {
    property: { id: 'schema:author' },
    value: { type: 'somevalue' },
    qualifiers: [
      {
        property: { id: 'schema:sameAs' },
        value: { type: 'value', content: 'http://www.wikidata.org/entity/Q1001' },
      },
    ],
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
use `document` properties, covers use `media`, and facts use neither. The bulk
route serves summary and cover through content's hooks. Semantic stores the
document id and digest, or the media id, and never the summary body, a licence
of its own, or a fence. Single-subject writes still reject document and media
contents as `unsupported`.

The launch profiles include books, editions, recipes, television series, albums,
video games and visual novels. Identifier labels follow their Wikidata properties
([Open Library](https://www.wikidata.org/wiki/Property:P648),
[Bangumi subjects](https://www.wikidata.org/wiki/Property:P5732),
[Bangumi people](https://www.wikidata.org/wiki/Property:P6298),
[VNDB](https://www.wikidata.org/wiki/Property:P3180)); the summary and cover terms
follow [schema:abstract](https://schema.org/abstract) and
[schema:image](https://schema.org/image).
