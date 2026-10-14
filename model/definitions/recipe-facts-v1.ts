import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

const profile = '<https://rezics.com/definition/recipe-facts-v1>';
const when = [{ path: 'rv:definitionProfile', value: profile }] as const;
export const recipeFactsDeclaration = {
  id: 'recipe-facts-v1',
  canonical: {
    ingredient: { types: ['schema:HowToSupply'], when },
    step: { types: ['schema:HowToStep'], when },
    quantity: { types: ['schema:QuantitativeValue'], when },
    servings: { types: ['schema:QuantitativeValue'], when: [...when,
      { path: 'schema:propertyID', value: 'schema:numberOfItems' }] },
    extraction: { types: ['prov:Entity'], when },
    recipe: { types: ['schema:Recipe'], when },
    nutrition: { types: ['schema:NutritionInformation'], when },
    activity: { types: ['prov:Activity'], when },
  },
} as const satisfies TurtleDeclaration;

export const recipeFactsProfile = parseTurtleProfile(recipeFactsDeclaration.id,
  readFileSync(new URL('./recipe-facts-v1.ttl', import.meta.url), 'utf8'), recipeFactsDeclaration);
