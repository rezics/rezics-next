import type { OccurrenceRecord } from '../structure/format.ts';

export class RecipeExportLimit extends Error {}

/** Build a bounded Schema.org view from one exact Structure revision. */
export function exportRecipe(records: readonly OccurrenceRecord[], structure: string) {
  if (records.length > 4096) throw new RecipeExportLimit('Recipe export exceeds 4096 occurrences');
  const children = new Map<string, OccurrenceRecord[]>();
  const ingredients: Array<string | Record<string, unknown>> = [];
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
    ingredients.push(line.amount && line.amountLexical !== line.originalText.value
      ? { '@type': 'PropertyValue', name: line.originalText.value,
      value: line.amountLexical ?? `${line.amount.numerator}/${line.amount.denominator}`,
      ...(line.unit ? { unitCode: line.unit } : {}), ...(line.unitText ? { unitText: line.unitText } : {}),
      inLanguage: line.originalText.language } : line.originalText.value);
  }
  const instructions = (parent: string, depth: number): Array<Record<string, unknown>> => {
    if (depth > 16) throw new RecipeExportLimit('Recipe sections exceed depth 16');
    return (children.get(parent) ?? []).flatMap((record): Record<string, unknown>[] => {
      if (record.role === 'step' && record.qualifier?.type === 'recipe-step') {
        return [{ '@type': 'HowToStep', text: record.qualifier.instructionText.value,
          inLanguage: record.qualifier.instructionText.language,
          ...(record.sourceKey ? { sourceKey: record.sourceKey } : {}) }];
      }
      if (record.role === 'group') return [{ '@type': 'HowToSection',
        name: record.labels[0]?.value ?? 'Untitled section',
        ...(record.labels[0] ? { inLanguage: record.labels[0].language } : {}),
        itemListElement: instructions(record.occurrence, depth + 1),
        ...(record.sourceKey ? { sourceKey: record.sourceKey } : {}) }];
      return [];
    });
  };
  const recipe = { '@context': 'https://schema.org', '@type': 'Recipe',
    recipeIngredient: ingredients, recipeInstructions: instructions(structure, 0) };
  const result = { recipe, residuals, sourceObservations: [...sourceObservations] };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) {
    throw new RecipeExportLimit('Recipe export exceeds 1 MiB');
  }
  return result;
}
