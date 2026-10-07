import { readFileSync } from 'node:fs';
import { parseTurtleProfile, type TurtleDeclaration } from '../compiler/shacl.ts';

export const recipeStructureDeclaration = {
  id: 'recipe-structure-v1',
  canonical: {
    'ingredient-line': {
      types: ['rv:IngredientLine'],
    },
    step: {
      types: ['rv:RecipeStep'],
    },
    measure: {
      types: ['rv:RecipeMeasure'],
    },
  },
} as const satisfies TurtleDeclaration;

export const recipeStructureProfile = parseTurtleProfile(
  recipeStructureDeclaration.id,
  readFileSync(new URL('./recipe-structure-v1.ttl', import.meta.url), 'utf8'),
  recipeStructureDeclaration,
);
