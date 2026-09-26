# Native recipes

## Recipe structure

A Recipe is a native creative scope with a Main Version and applicable variants.
Ingredient lines are occurrences: the same ingredient can appear in separate
stages with different quantities. Retain original ingredient text, exact amount,
unit definition, preparation, optionality, substitution and group/step references.

Yield, servings, preparation/cooking/total duration, equipment and nutrition have
explicit units, coverage and provenance. Volume-to-mass conversion requires known
unit system and density; unknown cups are not silently converted. Nutrition per
serving and per entire recipe are different values.

## Authoring and operations

Create, revise, reorder/group steps, edit ingredient occurrences, contribute a
variant and adopt it into a Main Version through ordinary commands. Scaling uses
a declared factor and supports non-linear or non-scalable instructions. Preserve
allergen/diet claims as source/evidence-qualified classifications, not guarantees
created by a classification statement. A step can reference media and exact ingredient occurrences.

## Exchange and query

Map Schema.org Recipe/HowToStep/HowToSection without losing arrays, ordering,
free-text ingredients or structured values. Retain unknown properties and source
text when parsing cannot determine exact quantities. Compare original source,
native queries and exported representation; raw JSON retention alone is not
native conversion. Realm statement decisions and ratings use the common Context contracts.

Verify duplicate ingredients, fractional/exact quantities, ambiguous units,
grouped steps, multilingual variants, partial source updates and withdrawal.
Basis: [Recipe](https://schema.org/Recipe) and [HowToStep](https://schema.org/HowToStep).
