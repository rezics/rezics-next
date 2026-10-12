# Recipe file exchange

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

Foreign ingredient strings remain text. Every native ingredient is a
`PropertyValue` object with these fields, including lines with no parsed facts:

| Field | Meaning |
| --- | --- |
| `text` | Exact original ingredient line, including its quantity, unit and whitespace. |
| `value` | Exact lower amount as an integer or numerator/denominator string; absent when no amount is stored. |
| `maxValue` | Exact upper endpoint for a range, as a numerator/denominator string. |
| `amountLexical` | Original quantity wording, independent of the exact value; absent when no wording is stored. |
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

Import uses a nonempty `text` verbatim. Quantity fields (`value`, `maxValue` and
the unit) describe the quantity; `name` describes the food. Both endpoints accept
finite numbers or strings and go through the same exact scalar/range parser as
free text. Descending or invalid ranges retain their source line as unparsed,
with neither endpoint admitted. A quantity in `name` is parsed once: a leading
quantity followed by a recognized written unit (or the explicitly supplied unit)
is a complete line and receives no prefix. Thus `½cup flour` and
`1.5–2 cups cream` remain exact, while `name: "5 spice powder", value: "2", unitText: "g"`
becomes `2 g 5 spice powder`. Otherwise the supplied quantity, written unit and
name compose the line. An IRI never becomes written unit text: composition uses
the registered symbol, or omits an unresolved symbol while retaining the IRI
separately. Short unparsed free-text quantities retain their wording in
`amountLexical`, within its native 100-character bound, as well as `originalText`.

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
shape. Only recognized instruction-list arrays are transparent cardinality
wrappers for this depth measure; arbitrary metadata objects and arrays still
count every nesting edge against 32. Section nesting separately admits 16 levels
and refuses level 17 with a typed `depth` outcome. Native text and source-key
bounds still apply.

## Capacity outcomes

Export supports at most 4,096 occurrences and a 1 MiB serialized export result.
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

`limit` is `occurrences`, `bytes` or `depth`. Section-depth refusals allow 16;
general shape-depth capacity allows 32. `measured` is the total normalized occurrence
count, the serialized source/file byte count, the declared request length, or
the cumulative bytes observed when a stream crosses the ceiling. Streaming
admission cancels the unread body at that point. `RecipeFileTooLarge` is the
byte-admission specialization of this outcome. Intake preserves typed capacity
failures from normalization; it never converts them to generic invalid input.
Unsupported inert units instead carry `{ status: "not-importable", code:
"recipe_unit_not_registered", unit: "…" }` in export metadata.
Routes and clients consume these facts to communicate unsupported synchronous
size and recovery without activating a partial recipe.
