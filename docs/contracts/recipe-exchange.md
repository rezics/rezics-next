# Recipe file exchange

## Decided Content adoption boundary

The [Recipe profile](recipes.md) and [Content contract](content-adoption.md)
extend instructions to Post, exact recording representation, procedure, or an
ordered combination. The sections below describe the Schema.org adapter and
its preservation bounds.

Native export of one exact authorized Structure revision retains occurrence
IDs/order/parents, exact Resource selectors, Content documents and selected
procedure blocks, Media representation identities, derivation records and
independent source support. It returns `{ format: "native", structure, revision,
occurrences, measures, contents, derivations, instructions, losses: [] }`. Plain-text
Post Content retains its `body` instead of acquiring a synthetic document. It does not expand referenced
Recipes recursively or replace exact bytes with a delivery URL. Missing or
concealed dependencies have explicit unavailable entries; concealed payloads
and identifiers cannot leak through an export sidecar. This result describes
fidelity of the selected accessible cut, not a promise to recover erased bytes.

Schema.org projection uses HowToSection/HowToStep from the single procedure
document. Prose can be exported as text only with a reported flattening loss;
recordings, occurrence-grain references and PROV derivation cannot disappear
silently. In addition to today's result, the API returns
`losses: [{ occurrence, code, pointer }]`, where `code` is
`instruction-form-unsupported`, `reference-not-representable`,
`derivation-not-representable` or `measurement-not-representable`.
An unsupported target form may instead produce 422 with its typed reason.
Loss pointers address the corresponding native export: an instruction's selector
or document node, an occurrence qualifier, the retained derivation, or the retained measure. They do not
pretend that an omitted reference still exists in the flattened Schema.org text.
Procedure hierarchy maps to HowTo terms; projecting its step documents to text
reports the lost document structure and local identities. Legacy occurrence links,
preparation notes and held scaling policy also have explicit loss entries.
Unknown nutrition/media/reference fields stay retained Source evidence or are
explicitly refused; they never become accepted facts. Importability remains
separate from fidelity: an importable file may have reported losses.
The Schema.org adapter currently reports every measure as
`measurement-not-representable`: its plain Recipe output cannot preserve the
native measurement basis, coverage and provenance. Native export retains those
measures exactly. Both export routes report that loss.

`GET /v1/recipes/{structure}/export?revision=<exact>&format=native|schema-org`
returns the selected response above, subject to current read authority, the
4,096-occurrence/1 MiB export bounds and each owner's disclosure. Omitted
`format` keeps today's Schema.org result. Import remains bounded and refuses
unsupported forms, rather than claiming that the larger export capacity
establishes synchronous reimport. New-form native import is a later operation;
this slice proves export retention and truthful loss only.

## Current adapter

Recipe exchange carries ingredient lines and ordered instructions between native
Structures and a single UTF-8 JSON Recipe. The module contract is implemented by
[export](../../services/main/src/modules/recipe/export.ts),
[file intake](../../services/main/src/modules/recipe/file-intake.ts) and
[normalization](../../services/main/src/modules/recipe/importer.ts). The
[kernel tests](../../services/main/tests/recipe-exchange-kernel.test.ts) prove
preservation at those boundaries; they do not prove composition activation or UI
recovery.

## File and ingredient fields

The root has `@type: "Recipe"`, `recipeIngredient` and `recipeInstructions`.
`@context`, when present, is exactly `https://schema.org`; it is required for
`application/ld+json`. Intake accepts that media type and `application/json`,
with an optional UTF-8 charset. It projects only `inLanguage`, ingredients and
instructions into the import source, after inspecting every field for hostile
content. No JSON-LD processor, URL fetch or remote context resolution runs.

Foreign ingredient strings remain text. Export emits each native ingredient as
an enriched `PropertyValue`, followed by the original lines as text in the same
order. [Schema.org recipeIngredient](https://schema.org/recipeIngredient) admits
both types (v30.1, checked 2026-10-15). Text-only consumers can read the text
entries; REZICS intake pairs them with native carriers by exact text and
multiplicity, preserving repeated occurrences without importing both forms.
Foreign objects without native parse status are not paired. The enriched
carrier has these fields, including lines with no parsed facts:

| Field | Meaning |
| --- | --- |
| `text` | Exact original ingredient line, including its quantity, unit and whitespace. |
| `name` | Structured food name, stored verbatim, including leading numbers, quantity-looking text and an empty name. |
| `textParts` | Source spans `{ amount, unit?, name }`, each `{ start, end }` using half-open UTF-16 offsets into `text`; recorded when free text is parsed. |
| `value` | Exact lower amount as an integer or numerator/denominator string; absent when no amount is stored. |
| `maxValue` | Exact upper endpoint for a range, as a numerator/denominator string. |
| `amountLexical` | Quantity wording as supplied or parsed, independent of the exact value and the optional spans; always emitted and retained when stored. |
| `unitCode` | Registered inert unit IRI, preserved exactly. |
| `unitText` | Written or unresolved unit text, preserved exactly, including whitespace, separately from its IRI. |
| `optional` | `true` for an optional ingredient; omission means false. |
| `parseStatus` | Native `parsed`, `partial` or `unparsed` status; prevents an absent amount from being inferred from the text. |
| `inLanguage` | Ingredient language. |

`text`, `amountLexical`, `optional` and `parseStatus` are the REZICS exchange
conventions alongside Schema.org's
[PropertyValue quantity fields](https://schema.org/PropertyValue). Exact values
remain independent from wording: an authored `1/2` amount with “about half” as
its lexical text keeps both.

Manager decision after the second exchange review: source text is never rebuilt
or surgically edited. Quantity fields (`value`, `maxValue`, `unitCode`, `unitText`)
are the quantity. A structured `name` is retained verbatim; no prefix is added or
removed, even when it already contains a quantity. Its `originalText` is the
supplied `text`, or the unchanged name when no text was supplied. Both endpoints
accept finite numbers or strings and use the same exact scalar/range validator.
Invalid ranges admit neither endpoint; their retained source remains available.

The subsequent review made field independence explicit:

| Qualifier field | Stored when | Export | Intake | Display and scaling use |
| --- | --- | --- | --- | --- |
| `amountLexical` | Supplied or parsed | Emit whenever stored, regardless of spans | Keep supplied wording | Expose source wording; never use it to infer or strip food text |
| `amount`, `amountUpper` | Supplied or parsed | Emit exact values | One scalar/range validator | Derive the scaled amount |
| `unitCode`, `unitText` | Supplied or parsed | Emit; registry determines inert unit importability | Validate the unit | Use its display label |
| `name` | Structured name supplied verbatim | Emit when present, including empty | Keep verbatim | Use as the food name when present |
| `textParts` | Recorded when parsing retained text | Emit when present | Keep when valid for source text | Use the recorded food-name remainder |

Spans are recorded facts, not a prerequisite for any other field. Qualifier
validation permits valid spans without lexical, amount or unit fields, and a
verbatim name can coexist with them. Supplied fields are neither manufactured
from spans nor silently omitted because spans are absent.

Free text quantities are parsed when their quantity token ends at whitespace or a
non-letter boundary. Thus `7up soda`, `3M tape`, `200g butter` and `½cup flour`
remain unparsed. Non-leading numeric quantities require a written unit, an
Italian count marker (`N.`), or a trailing Italian count; parenthetical cross references are ignored.
Italian sources also admit units before the number (`grammi 200`), number words
and lexical quantities such as `q.b.` and `quanto basta`. Qualitative quantities,
compound counts and alternatives retain wording without inventing a scalar.
The written-unit registry matches its complete labels, longest
first, at Unicode token boundaries; it recognizes `克` and `fluid ounces` rather
than guessing from the first word. Leading parsing records `textParts` once.
For these lines, parsed `amountLexical` is exactly `text.slice(amount.start, amount.end)`;
the food name is exactly its recorded name span. Non-leading parsing uses the
existing independent fields, recording a name only when a contiguous source
substring identifies it, and leaves spans absent. An unparsed line retains the whole text
only in `originalText`, with no amount or amount lexical. Structured quantities
do not manufacture a lexical from `value` or interpret numbers in `name`; they
do retain an independently supplied `amountLexical`, such as `about half`.

Display and scaling derive quantities from exact amounts and names from these
spans or the verbatim structured name. Doubling `1.50 cups cream` displays
`3 cups cream`; doubling `200 克 牛奶` displays `400 克 牛奶`. Given structured
`name: "2 fluid ounces milk", value: 2, unitText: "fluid ounces"`, display is
`2 fluid ounces 2 fluid ounces milk` and doubled display is
`4 fluid ounces 2 fluid ounces milk`: the source's duplication survives.
Structured IRI units use their registered display symbols without putting an IRI
into retained text. Opening an unparsed line exposes the whole food text; a
no-op save preserves it, and editing the quantity does not remove food text.

Native qualifier storage and exchange preserve `name` and `textParts`; Structure
validates span bounds and ordering against the retained source text. Quantity
wording and unit annotations remain independent of the recorded source spans.
The Recipe projection retains these as `rv:ingredientName` and the bounded
`rv:ingredientTextParts` JSON literal.

Display never locates wording, strips a prefix, or reparses retained text. Its
only source slice is the named `ingredientNameFromSpans` helper, using the
recorded food-name offsets. It composes a line only from that food name or an
explicit structured name, the numeric amount and the unit label. A registered
`unitCode` always supplies its registry label; otherwise the written `unitText`
supplies the label. Neither depends on optional name/spans.

With no numeric amount there is nothing to scale: `line` is always the unchanged
original text, even when a structured name (including an empty name) or recorded
spans exist. `salt to taste` with name `salt` still displays `salt to taste`;
spans on a source quantity never manufacture a missing structured amount.

For an old qualifier with neither a name nor spans, the existing view fields
remain separate: `originalText` and `line` both retain the unchanged original
line, `amount`/`amountUpper` carry exact scaled values, `unitText` carries the
resolved label, and `sourceLexical` carries stored wording. Thus doubling old
`1.50 cups cream` returns that unchanged line plus amount `3` and unit `cups`;
doubling old `200 克 牛奶` returns that line plus amount `400` and unit `克`.
`text: "butter", value: 200, unitCode: "https://qudt.org/vocab/unit/GM"` returns
the unchanged line `butter` plus scaled amount `400` and label `g`. A renderer
shows the separate fields; it must not manufacture a food name from the line.
The API field names stay stable for the separate Launch editor adoption.

There is no production data requiring a compatibility reader or migration.
Retained recipe corpora, including the thirty Gutenberg recipes, are re-imported
with the importer that records spans. Unrecognized quantities remain untouched
source lines with no invented amount or food-name span.

The exporter returns `{ recipe, residuals, sourceObservations, importability }`; the file is
`recipe`. Residuals and original source observation identifiers are sidecar
provenance. Instruction source identifiers are omitted from the Recipe because
intake rejects remote URLs in instruction fields. Import's `residual` is the
SHA-256 of the serialized import source; exact source text support uses pointers
into that retained source, subject to the source owner's own pointer bounds.

## Section hierarchy and order

`recipeInstructions` is an ordered array mixing `HowToStep` and `HowToSection`.
Each section's `itemListElement` has the same forms,
as in [Schema.org's section representation](https://schema.org/HowToSection).
Empty sections survive. Step `text`, section `name` and `inLanguage` survive;
language is inherited when a foreign child omits it. Both instruction properties
accept one object/string or an ordered array. One normalization helper handles
cardinality at every level, retaining exact source pointers. An unrecognized
element throws `RecipeInstructionNotSupported` (`recipe_instruction_not_supported`)
with its pointer; it is never silently omitted.

Normalization exposes one preorder `order` across every step and section.
`sections[i].parent` and `steps[i].section` reference the parent section's array
index; `-1` names the Recipe root. A consumer combines sections and steps and
orders by `order` before placing siblings. Separate section-first and step-first
passes lose root interleaving.

Instruction source keys use `#/recipeInstructions/<order>` as bounded occurrence
identities, independently of nesting. Steps also expose their exact
`sourcePointer` into the input so support lookup does not confuse an ordinal
with an input array index. Export and normalization limit section nesting to 16.

## Unit identifiers and hostile input

Stored unit references use the Structure owner's qualifier reference format;
export validates that format and preserves every admitted IRI. Known inert file
identities and their written symbols live in the Recipe unit owner's
`RECIPE_UNIT_DEFINITIONS` registry, alongside the written unit definitions.
Initially it contains exactly:

- `https://qudt.org/vocab/unit/GM`
- `https://qudt.org/vocab/unit/KiloGM`
- `https://qudt.org/vocab/unit/MilliL`
- `https://qudt.org/vocab/unit/L`
- `https://qudt.org/vocab/unit/OZ`

These are stored identifiers, not conversion requests. Structure's reference
format does not prove unit membership. No native resource namespace grants
membership; no native unit definitions are currently registered. Unsupported
file identities throw `RecipeUnitNotRegistered` (`recipe_unit_not_registered`,
with `unit`), and export marks them not-importable while preserving the stored
reference. They never become capacity errors. Intake allows supported identities
only in a direct `unitCode` string on an ingredient row
in `recipeIngredient` or `recipeIngredient.itemListElement`. It never resolves
them. Adding a query, fragment, trailing slash or whitespace makes a different,
rejected identifier. A registered IRI in `text`, `unitText`, metadata or a step
is also rejected. Unknown remote URLs remain invalid everywhere; the fixed root
Schema.org context remains the other exception.

HTML, scripts, graph references, nested contexts, multiple Recipes, invalid
UTF-8/JSON, JSON depth above 32 and more than 8,192 inspected values remain
`RecipeFileInvalid`. Export and intake use `measureRecipeJSON` on the serialized
shape. Every object-property and array-element edge counts against depth 32.
Sixteen nested sections followed by a step have JSON depth 35 and are therefore
not importable as a file; export metadata reports the same depth. Section nesting
is a separate `section-depth` rule admitting 16 levels and refusing level 17.
Native text and source-key
bounds still apply.

## Capacity outcomes

Recipe file downloads use bounded continuation and have no total occurrence or
byte ceiling. Both export routes accept `page=true`, `revision`, `parent` and
`after`. The first page selects a revision when omitted; every subsequent call
must retain that revision. `recipe-export-page-v1` returns up to 64 ordered
siblings and `next` (pass it as `after`), or one sibling when the neighbourhood
contains an adopted instruction. Visit the root's sibling pages, then each
active group in breadth-first order, including empty groups. Each page repeats
the exact measures, import limits and currently disclosed export rights.
Tokens use the existing Structure cursor and never confer authority.

The protocol's joiner and JSON-serializable checkpoint are exported from
`@rezics/model/recipe-export`. Main projects each atomic part; joining remaps
loss pointers and attaches sections without interpreting native recipe fields.
Native contents are deduplicated by exact reference. For every distinct Content
revision in those contents, follow
`GET /v1/content-revisions/{revision}/derivations` through `nextCursor`, including
empty inventories. The client retains completed pages and the last derivation
cursor after an interrupted request. Repeating a failed read has no side effects.
It rechecks Recipe export authority before delivering the assembled file. A
server restart invalidates process-local cursors; restart the download in that
case. The selected immutable revision remains independently addressable.

Compact responses remain available without `page=true`, with their existing
4,096-occurrence and 1 MiB response bounds. They are compatibility responses,
not the file download path. Keeping continuation explicit preserves existing
consumers' complete-response assumption ([pagination compatibility](https://google.aip.dev/158#backwards-compatibility)).
The pure unbounded projection and the continuation joiner produce identical
ordered file bytes for the same disclosed data.

Synchronous import supports at most 128 normalized occurrences, counting all
ingredients, sections and steps, and 256 KiB of UTF-8 input. File byte admission
also has a 256 KiB ceiling. Export capacity does not imply synchronous import
capacity; larger staged import is a separate capability.

Export metadata and intake share one `RecipeImportability` value type: either
`{ status: "importable" }` or the structured value below. Export computes it from
the Recipe's actual normalized occurrence count, serialized Recipe bytes and
shared shape-depth measure,
independently of its larger export capacity. An exceeded import capacity throws
`RecipeNotImportable`, carrying this exact value as `importability`:

```json
{ "status": "not-importable", "code": "recipe_not_importable", "limit": "occurrences", "measured": 129, "allowed": 128 }
```

`limit` is `occurrences`, `bytes`, `depth` or `section-depth`. Section-depth
refusals allow 16; ordinary JSON depth allows 32. `measured` is the total normalized occurrence
count, the serialized source/file byte count, the declared request length, or
the cumulative bytes observed when a stream crosses the ceiling. Streaming
admission cancels the unread body at that point. `RecipeFileTooLarge` is the
byte-admission specialization of this outcome. Intake preserves typed capacity
failures from normalization; it never converts them to generic invalid input.
Unsupported inert units instead carry `{ status: "not-importable", code:
"recipe_unit_not_registered", unit: "…" }` in export metadata.
Routes and clients consume these facts to communicate unsupported synchronous
size and recovery without activating a partial recipe.
