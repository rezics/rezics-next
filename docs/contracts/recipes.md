# Recipe profile and adoption

The [content-adoption decision](../architecture/content-adoption.md#decision-supermanager-2026-10-14)
is the target boundary. The current [Recipe structure profile](../../model/definitions/recipe-structure-v1.ts)
still stores ingredient and step qualifiers; it is not evidence that the new
forms are implemented. Recipes open publicly only after
[`recipes/instructions-in-any-form`](../../scripts/qa/cases/outcomes/recipes/instructions-in-any-form.ts)
passes for all six personas. Owned drafts, publications, supports and revision
pins must be inventoried before choosing conversion or reimport. Exact history
is never rewritten or silently retargeted.

## Facts, content and placement

A Recipe Work is `schema:Recipe`. Its constrained standard facts use
`schema:recipeIngredient`, `schema:recipeInstructions`, `schema:recipeYield`,
`schema:prepTime`, `schema:cookTime` and `schema:nutrition`. Quantities use
`schema:PropertyValue`/`schema:QuantitativeValue` with exact value, lower/upper
bounds and unit identifiers; durations use explicit duration semantics.
SHACL checks the admitted subset, positive serving denominator, paired range
endpoints, unit admission and finite reference membership. Standard terms do
not authorize edits, implement arithmetic or establish dietary accuracy.

Source owns retained wording, spans and extraction outcomes. Content owns
authored wording, notes, Resource references and the single structured procedure
form. A quantity note is authored Content referencing that exact ingredient
occurrence; it never replaces or reparses the quantity. Structure owns duplicate
occurrence identity, parent, order and exact adopted selections. Food identity
does not identify its repeated uses.

An `instruction` occurrence admits an authored Post's exact Content revision,
an exact audio/video Media representation, or a procedure block at an exact
Content revision. Several such occurrences form an ordered combination in the
existing Structure; there is no second Recipe instruction store. `HowToSection`
and `HowToStep` describe procedure projection and exchange. They do not require
every instruction to be a step or create a second authoritative procedure.
The [Content adoption contract](content-adoption.md) specifies selectors,
payloads and API requests/responses. The Work-only reference block retains its
existing Work meaning.

Recipe-local semantic terms are limited to occurrence substitution
(`substituteFor`), scaling policy (`linear`, `non-linear`, `not-scalable`) and
measurement basis/coverage (`per-serving`, `whole-recipe`; `complete`, `partial`,
`unknown`). Existing shared Resource, revision and occurrence identities stay
with their owners; this limit does not rename those identities. Source support
and PROV derivation remain independent of authorship and rights clearance.

## Existing task operations

Exact [quantity operations](../../services/main/src/modules/recipe/operations.ts)
and the bounded [Work page](../../services/main/src/modules/recipe/cost-contract.md)
remain task APIs. Scaling takes explicit servings/factor and returns exact
amounts, held quantities and judgment hints. Nutrition takes caller-supplied
inputs and basis and returns exact nutrient/unit buckets and truthful coverage;
it does not fetch an ingredient catalogue. The page does not recursively expand
referenced intermediate recipes. Publication pins the adopted dependencies;
later edits remain drafts. Membership, moderation and platform status alone do
not widen the read or edit boundary.

The [exchange contract](recipe-exchange.md) owns preservation and explicit loss.
Allergen and diet claims still need source or evidence qualified classification;
a classification statement cannot turn an uncertain claim into a guarantee.
