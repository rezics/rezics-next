import type { OccurrenceRecord } from '../structure/format.ts';
import { NATIVE_ID } from '../structure/graph.ts';
import { recipeImportability } from './importer.ts';

export const RECIPE_EXPORT_OCCURRENCE_LIMIT = 4096;
/** Exact inert identifiers supported by recipe file exchange; never fetched. */
export const NATIVE_RECIPE_UNIT_IRIS: ReadonlySet<string> = new Set([
  'https://qudt.org/vocab/unit/GM',
  'https://qudt.org/vocab/unit/KiloGM',
  'https://qudt.org/vocab/unit/MilliL',
  'https://qudt.org/vocab/unit/L',
]);

/** Native definition identities and the finite external registry are inert only in unitCode. */
export function isRecipeUnitIdentifier(value: string): boolean {
  return (value === value.trim() && NATIVE_ID.test(value)) || NATIVE_RECIPE_UNIT_IRIS.has(value);
}

export class RecipeExportLimit extends Error {}

/** Build a bounded Schema.org view from one exact Structure revision. */
export function exportRecipe(records: readonly OccurrenceRecord[], structure: string) {
  if (records.length > RECIPE_EXPORT_OCCURRENCE_LIMIT) {
    throw new RecipeExportLimit(`Recipe export exceeds ${RECIPE_EXPORT_OCCURRENCE_LIMIT} occurrences`);
  }
  const children = new Map<string, OccurrenceRecord[]>();
  const ingredients: Array<Record<string, unknown>> = [];
  const residuals: Array<{ sourceKey: string | null; text: string; parseStatus: string;
    residual: string | null }> = [];
  const sourceObservations = new Set<string>();
  for (const record of records) {
    if (record.state !== 'active') continue;
    const siblings = children.get(record.parent) ?? [];
    siblings.push(record);
    children.set(record.parent, siblings);
    const source = record.sourceKey?.split('#')[0];
    if (source?.startsWith('https://rezics.com/id/')) sourceObservations.add(source);
    if (record.role !== 'ingredient' || record.qualifier?.type !== 'ingredient-line') continue;
    const line = record.qualifier;
    if (line.parseStatus !== 'parsed') residuals.push({ sourceKey: record.sourceKey ?? null,
      text: line.originalText.value, parseStatus: line.parseStatus, residual: line.residual ?? null });
    if (line.unit && !isRecipeUnitIdentifier(line.unit)) {
      throw new RecipeExportLimit('Recipe unit is not registered for file exchange');
    }
    // Native lines carry parse status even without quantities, so import never invents facts.
    ingredients.push({ '@type': 'PropertyValue', text: line.originalText.value,
      ...(line.amount ? { value: line.amount.denominator === 1 ? String(line.amount.numerator)
        : `${line.amount.numerator}/${line.amount.denominator}` } : {}),
      ...(line.amountUpper ? { maxValue: `${line.amountUpper.numerator}/${line.amountUpper.denominator}` } : {}),
      ...(line.amountLexical ? { amountLexical: line.amountLexical } : {}),
      ...(line.unit ? { unitCode: line.unit } : {}), ...(line.unitText ? { unitText: line.unitText } : {}),
      ...(line.optional ? { optional: true } : {}), parseStatus: line.parseStatus,
      inLanguage: line.originalText.language });
  }
  let instructionOccurrences = 0;
  const instructions = (parent: string, depth: number): Array<Record<string, unknown>> => {
    if (depth > 16) throw new RecipeExportLimit('Recipe sections exceed depth 16');
    return (children.get(parent) ?? []).flatMap((record): Record<string, unknown>[] => {
      if (record.role === 'step' && record.qualifier?.type === 'recipe-step') {
        instructionOccurrences++;
        return [{ '@type': 'HowToStep', text: record.qualifier.instructionText.value,
          inLanguage: record.qualifier.instructionText.language }];
      }
      if (record.role === 'group') {
        instructionOccurrences++;
        return [{ '@type': 'HowToSection', name: record.labels[0]?.value ?? 'Untitled section',
          ...(record.labels[0] ? { inLanguage: record.labels[0].language } : {}),
          itemListElement: instructions(record.occurrence, depth + 1) }];
      }
      return [];
    });
  };
  const recipe = { '@context': 'https://schema.org', '@type': 'Recipe',
    recipeIngredient: ingredients, recipeInstructions: instructions(structure, 0) };
  const occurrences = ingredients.length + instructionOccurrences;
  const importability = recipeImportability(occurrences, Buffer.byteLength(JSON.stringify(recipe), 'utf8'));
  const result = { recipe, residuals, sourceObservations: [...sourceObservations], importability };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) {
    throw new RecipeExportLimit('Recipe export exceeds 1 MiB');
  }
  return result;
}
