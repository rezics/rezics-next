import type { OccurrenceRecord } from '../structure/format.ts';
import { checkStructureReferences, type StructureReferencePolicy } from '../structure/local-references.ts';

export const ingredientReferences: StructureReferencePolicy = {
  targetRole: 'ingredient',
  predicates: ['https://schema.org/mentions', 'https://rezics.com/vocab/substituteFor', 'https://rezics.com/vocab/usesIngredient'],
  references: record => record.qualifier?.type === 'recipe-step' ? record.qualifier.usesIngredient
    : record.qualifier?.type === 'ingredient-line' ? record.qualifier.substituteFor : [],
};

export function checkIngredientReferences(candidate: readonly OccurrenceRecord[], retained: ReadonlyMap<string, OccurrenceRecord>): void {
  checkStructureReferences(candidate, retained, ingredientReferences);
}
