# Remaining recipe classification contract

The [Recipe structure profile](../../model/definitions/recipe-structure-v1.ts),
[exact quantity operations](../../services/main/src/modules/recipe/quantity.ts)
and [acceptance cases](../../scripts/qa/cases/recipes.ts) own ingredient
occurrences, ordered steps, measures, source residuals and independent support.

Allergen and diet claims still need source or evidence qualified classification;
a classification statement cannot turn an uncertain claim into a guarantee.
Add a native profile and positive/denied tests for this before retiring the
remaining requirement.
