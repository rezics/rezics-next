import type { OccurrenceRecord } from '../structure/format.ts';
import { checkOccurrenceQualifier } from '../structure/format.ts';
import { MAX_RECIPE_SECTION_DEPTH, measureRecipeJSON, RecipeNotImportable, recipeImportability } from './importer.ts';
import { RECIPE_UNIT_DEFINITIONS, RecipeUnitNotRegistered } from './display.ts';

export const RECIPE_EXPORT_OCCURRENCE_LIMIT = 4096;
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
  let unsupportedUnit: string | undefined;
  for (const record of records) {
    if (record.state !== 'active') continue;
    const siblings = children.get(record.parent) ?? [];
    siblings.push(record);
    children.set(record.parent, siblings);
    const source = record.sourceKey?.split('#')[0];
    if (source?.startsWith('https://rezics.com/id/')) sourceObservations.add(source);
    if (record.role !== 'ingredient' || record.qualifier?.type !== 'ingredient-line') continue;
    const line = record.qualifier;
    checkOccurrenceQualifier(line);
    if (line.parseStatus !== 'parsed') residuals.push({ sourceKey: record.sourceKey ?? null,
      text: line.originalText.value, parseStatus: line.parseStatus, residual: line.residual ?? null });
    if (line.unit && !RECIPE_UNIT_DEFINITIONS.has(line.unit)) unsupportedUnit ??= line.unit;
    // Native lines carry parse status even without quantities, so import never invents facts.
    ingredients.push({ '@type': 'PropertyValue', text: line.originalText.value,
      ...(line.amount ? { value: line.amount.denominator === 1 ? String(line.amount.numerator)
        : `${line.amount.numerator}/${line.amount.denominator}` } : {}),
      ...(line.amountUpper ? { maxValue: `${line.amountUpper.numerator}/${line.amountUpper.denominator}` } : {}),
      ...(line.textParts ? { amountLexical: line.originalText.value.slice(line.textParts.amount.start, line.textParts.amount.end) } : {}),
      ...(line.name !== undefined ? { name: line.name } : {}),
      ...(line.textParts ? { textParts: line.textParts } : {}),
      ...(line.unit ? { unitCode: line.unit } : {}), ...(line.unitText ? { unitText: line.unitText } : {}),
      ...(line.optional ? { optional: true } : {}), parseStatus: line.parseStatus,
      inLanguage: line.originalText.language });
  }
  let instructionOccurrences = 0;
  const instructions = (parent: string, depth: number): Array<Record<string, unknown>> => {
    if (depth > MAX_RECIPE_SECTION_DEPTH) throw new RecipeNotImportable({ status: 'not-importable',
      code: 'recipe_not_importable', limit: 'section-depth', measured: depth, allowed: MAX_RECIPE_SECTION_DEPTH });
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
  const capacity = recipeImportability(occurrences, Buffer.byteLength(JSON.stringify(recipe), 'utf8'),
    measureRecipeJSON(recipe).depth);
  const importability = capacity.status === 'importable' && unsupportedUnit
    ? new RecipeUnitNotRegistered(unsupportedUnit).importability
    : capacity;
  const result = { recipe, residuals, sourceObservations: [...sourceObservations], importability };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) {
    throw new RecipeExportLimit('Recipe export exceeds 1 MiB');
  }
  return result;
}
