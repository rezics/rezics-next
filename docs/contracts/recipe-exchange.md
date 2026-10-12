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

Plain ingredient strings remain text. A native ingredient with quantity, unit,
optional status, non-English language or significant surrounding whitespace is a
`PropertyValue` object with these fields:

| Field | Meaning |
| --- | --- |
| `text` | Exact original ingredient line, including its quantity, unit and whitespace. |
| `value` | Exact lower amount as an integer or numerator/denominator string; absent when no amount is stored. |
| `maxValue` | Exact upper endpoint for a range, as a numerator/denominator string. |
| `amountLexical` | Original quantity wording, independent of the exact value; absent when no wording is stored. |
| `unitCode` | Registered inert unit IRI, preserved exactly. |
| `unitText` | Written or unresolved unit text, preserved separately from its IRI. |
| `optional` | `true` for an optional ingredient; omission means false. |
| `parseStatus` | Native `parsed`, `partial` or `unparsed` status; prevents an absent amount from being inferred from the text. |
| `inLanguage` | Ingredient language. |

`text`, `amountLexical`, `optional` and `parseStatus` are the REZICS exchange
conventions alongside Schema.org's
[PropertyValue quantity fields](https://schema.org/PropertyValue). Exact values
remain independent from wording: an authored `1/2` amount with “about half” as
its lexical text keeps both.

Import uses a nonempty `text` verbatim. For foreign structured ingredients with
only `name`, `value` and `unitText`, it assembles the original line from those
pieces. If `name` already contains the quantity, it uses that complete line
without prepending another quantity or unit. Native output therefore keeps
`200 g butter` exactly, rather than creating `200 g 200 g butter`.

The exporter returns `{ recipe, residuals, sourceObservations, importability }`; the file is
`recipe`. Residuals and original source observation identifiers are sidecar
provenance. Instruction source identifiers are omitted from the Recipe because
intake rejects remote URLs in instruction fields. Import's `residual` is the
SHA-256 of the serialized import source; exact source text support uses pointers
into that retained source, subject to the source owner's own pointer bounds.

## Section hierarchy and order

`recipeInstructions` is an ordered array mixing `HowToStep` and `HowToSection`.
Each section's `itemListElement` is another ordered array with the same forms,
as in [Schema.org's section representation](https://schema.org/HowToSection).
Empty sections survive. Step `text`, section `name` and `inLanguage` survive;
language is inherited when a foreign child omits it.

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

Native unit definition identifiers use the Structure owner's native REZICS ID
validation. The finite `NATIVE_RECIPE_UNIT_IRIS` registry in the exporter owns
supported external unit identifiers. Initially it contains exactly:

- `https://qudt.org/vocab/unit/GM`
- `https://qudt.org/vocab/unit/KiloGM`
- `https://qudt.org/vocab/unit/MilliL`
- `https://qudt.org/vocab/unit/L`

These are stored identifiers, not conversion requests. Export rejects an
unregistered native unit rather than silently discarding it. Intake allows
supported identifiers only in a direct `unitCode` string on an ingredient row
in `recipeIngredient` or `recipeIngredient.itemListElement`. It never resolves
them. Adding a query, fragment, trailing slash or whitespace makes a different,
rejected identifier. A registered IRI in `text`, `unitText`, metadata or a step
is also rejected. Unknown remote URLs remain invalid everywhere; the fixed root
Schema.org context remains the other exception.

HTML, scripts, graph references, nested contexts, multiple Recipes, invalid
UTF-8/JSON, JSON depth above 32 and more than 8,192 inspected values remain
`RecipeFileInvalid`. The JSON depth ceiling applies independently of section
depth: a file can reach it before 16 sections, even though direct module
normalization supports 16. Native text and source-key bounds still apply.

## Capacity outcomes

Export supports at most 4,096 occurrences and a 1 MiB serialized export result.
Synchronous import supports at most 128 normalized occurrences, counting all
ingredients, sections and steps, and 256 KiB of UTF-8 input. File byte admission
also has a 256 KiB ceiling. Export capacity does not imply synchronous import
capacity; larger staged import is a separate capability.

Export metadata and intake share one `RecipeImportability` value type: either
`{ status: "importable" }` or the structured value below. Export computes it from
the Recipe's actual normalized occurrence count and serialized Recipe bytes,
independently of its larger export capacity. An exceeded import capacity throws
`RecipeNotImportable`, carrying this exact value as `importability`:

```json
{ "status": "not-importable", "code": "recipe_not_importable", "limit": "occurrences", "measured": 129, "allowed": 128 }
```

`limit` is `occurrences` or `bytes`. `measured` is the total normalized occurrence
count, the serialized source/file byte count, the declared request length, or
the cumulative bytes observed when a stream crosses the ceiling. Streaming
admission cancels the unread body at that point. `RecipeFileTooLarge` is the
byte-admission specialization of this outcome. Intake preserves typed capacity
failures from normalization; it never converts them to generic invalid input.
Routes and clients consume these facts to communicate unsupported synchronous
size and recovery without activating a partial recipe.
