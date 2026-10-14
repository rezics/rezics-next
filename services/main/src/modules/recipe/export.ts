import type { OccurrenceRecord } from '../structure/format.ts';
import { checkOccurrenceQualifier } from '../structure/format.ts';
import { MAX_RECIPE_SECTION_DEPTH, measureRecipeJSON, RecipeNotImportable, recipeImportability } from './importer.ts';
import { RECIPE_UNIT_DEFINITIONS, RecipeUnitNotRegistered } from './display.ts';
import type { RecipeInstruction } from './instructions.ts';
import type { DocumentNode } from '@rezics/document';

export interface RecipeExportLoss { occurrence: string; code: 'instruction-form-unsupported'
  | 'reference-not-representable' | 'derivation-not-representable' | 'measurement-not-representable'; pointer: string }

/** Projection alone has text: the exact Content document remains the stored form. */
function projectInstruction(instruction: RecipeInstruction, pointer: string, losses: RecipeExportLoss[]) {
  const loss = (code: RecipeExportLoss['code'], at = pointer) => losses.push({ occurrence: instruction.occurrence, code, pointer: at });
  if (instruction.status !== 'available' || !instruction.document || instruction.reference.selector.grain !== 'content') {
    loss('instruction-form-unsupported'); return [];
  }
  const text = (nodes: readonly DocumentNode[], at: string): string => nodes.map((node, index) => {
    if (node.type === 'extensionBlock' || node.type === 'extensionInline' || node.type === 'image') {
      loss('reference-not-representable', `${at}/${index}`);
      return typeof node.attrs?.fallback === 'string' ? node.attrs.fallback : '';
    }
    return node.text ?? text(node.content ?? [], `${at}/${index}/content`);
  }).join('');
  const selector = instruction.reference.selector;
  const block = selector.block && instruction.document.doc.content?.find(node => node.attrs?.id === selector.block);
  if (block && block.attrs?.definition === 'https://rezics.com/definition/procedure-v1') {
    type Item = { type: 'HowToSection'; name: { value: string; language: string }; items: Item[] }
      | { type: 'HowToStep'; document: RecipeInstruction['document'] };
    const project = (items: Item[], at: string): Record<string, unknown>[] => items.map((item, index) =>
      item.type === 'HowToSection' ? { '@type': 'HowToSection', name: item.name.value,
        inLanguage: item.name.language, itemListElement: project(item.items, `${at}/${index}/itemListElement`) }
        : { '@type': 'HowToStep', text: text(item.document?.doc.content ?? [], `${at}/${index}/text`) });
    return project((block.attrs.payload as { items: Item[] }).items, pointer);
  }
  loss('instruction-form-unsupported');
  return [{ '@type': 'HowToStep', text: text(instruction.document.doc.content ?? [], `${pointer}/text`) }];
}

export const RECIPE_EXPORT_OCCURRENCE_LIMIT = 4096;
export class RecipeExportLimit extends Error {}

/** Build a bounded Schema.org view from one exact Structure revision. */
export function exportRecipe(records: readonly OccurrenceRecord[], structure: string,
  adopted: readonly RecipeInstruction[] = []) {
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
      ...(line.amountLexical !== undefined ? { amountLexical: line.amountLexical } : {}),
      ...(line.name !== undefined ? { name: line.name } : {}),
      ...(line.textParts ? { textParts: line.textParts } : {}),
      ...(line.unit ? { unitCode: line.unit } : {}), ...(line.unitText ? { unitText: line.unitText } : {}),
      ...(line.optional ? { optional: true } : {}), parseStatus: line.parseStatus,
      inLanguage: line.originalText.language });
  }
  let instructionOccurrences = 0;
  const losses: RecipeExportLoss[] = [];
  const selections = new Map(adopted.map(instruction => [instruction.occurrence, instruction]));
  const instructions = (parent: string, depth: number): Array<Record<string, unknown>> => {
    if (depth > MAX_RECIPE_SECTION_DEPTH) throw new RecipeNotImportable({ status: 'not-importable',
      code: 'recipe_not_importable', limit: 'section-depth', measured: depth, allowed: MAX_RECIPE_SECTION_DEPTH });
    return (children.get(parent) ?? []).flatMap((record): Record<string, unknown>[] => {
      if (record.selection?.mode === 'fixed-revision' && record.selection.selector
        && (record.role === 'instruction' || record.role === 'step')) {
        const pointer = `/recipeInstructions/${instructionOccurrences++}`;
        return projectInstruction(selections.get(record.occurrence) ?? { occurrence: record.occurrence,
          reference: { target: record.target!, selector: record.selection.selector }, status: 'unavailable' }, pointer, losses);
      }
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
  const result = { recipe, residuals, sourceObservations: [...sourceObservations], importability, losses };
  if (Buffer.byteLength(JSON.stringify(result)) > 1_048_576) {
    throw new RecipeExportLimit('Recipe export exceeds 1 MiB');
  }
  return result;
}
