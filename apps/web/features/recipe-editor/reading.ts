import { readingLine } from './ingredient-line.ts';
import type { RecipeState } from './model.ts';
import type { ReadableRecipe } from '../work-page/types/recipe.tsx';

/** The editor's recipe in the shape the published page renders. */
export function readingOf(state: RecipeState): ReadableRecipe {
  return {
    occurrences: state.nodes.map(node => ({
      occurrence: node.occurrence,
      role: node.role,
      parent: node.parent,
      labels: node.role === 'group' && node.label ? [{ value: node.label.value }] : [],
      ...(node.role === 'step' ? { qualifier: {
        type: 'recipe-step' as const,
        instructionText: node.qualifier.instructionText,
        usesIngredient: node.qualifier.usesIngredient,
      } } : {}),
    })),
    ingredients: state.nodes.flatMap(node => node.role === 'ingredient' ? [{
      occurrence: node.occurrence,
      originalText: node.qualifier.originalText.value,
      line: readingLine(node.qualifier),
    }] : []),
    measures: state.measures.map(measure => ({
      kind: measure.kind,
      value: measure.value,
      ...(measure.unitText ? { unitText: measure.unitText } : {}),
    })),
  };
}
