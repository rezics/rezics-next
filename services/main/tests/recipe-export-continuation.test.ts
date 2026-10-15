import { expect, test } from 'bun:test';
import { assembleRecipeExport, continueRecipeExport, recipeExportCheckpoint,
  type RecipeExportPage, type RecipeExportCheckpoint } from '@rezics/model/recipe-export';
import { exportRecipe, exportRecipeParts } from '../src/modules/recipe/export.ts';
import type { OccurrenceRecord, RecipeMeasure } from '../src/modules/structure/format.ts';
import type { RecipeInstruction } from '../src/modules/recipe/instructions.ts';
import { MAX_RECIPE_IMPORT_BYTES, MAX_RECIPE_IMPORT_OCCURRENCES, MAX_RECIPE_JSON_DEPTH } from '../src/modules/recipe/importer.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const structure = id(1), revision = id(2);
const measures: RecipeMeasure[] = [{ kind: 'preparation-duration', value: { numerator: 5, denominator: 1 }, unitText: 'min',
  basis: 'whole-recipe', coverage: 'complete', provenance: 'declared' }];
const importLimits = { bytes: MAX_RECIPE_IMPORT_BYTES, occurrences: MAX_RECIPE_IMPORT_OCCURRENCES, depth: MAX_RECIPE_JSON_DEPTH };

function corpus(size: number) {
  const roots: OccurrenceRecord[] = Array.from({ length: size }, (_, index) => ({
    occurrence: id(index + 100), state: 'active', parent: structure, role: 'ingredient', labels: [], introducedBy: revision,
    sourceKey: `${id(3)}#ingredient-${index}`, qualifier: { type: 'ingredient-line',
      originalText: { value: `水 ${index} ` + 'x'.repeat(200), language: 'ja' },
      optional: false, scaling: index % 2 ? 'linear' : 'non-linear', substituteFor: [], parseStatus: 'partial' },
  }));
  const group = (occurrence: string, parent: string): OccurrenceRecord => ({ occurrence, parent, state: 'active',
    role: 'group', labels: [{ value: 'Method', language: 'en' }], introducedBy: revision });
  roots.splice(17, 0, group(id(10), structure), group(id(11), structure));
  const nested = group(id(12), id(10));
  const step: OccurrenceRecord = { occurrence: id(13), parent: id(10), state: 'active', role: 'step', labels: [],
    introducedBy: revision, qualifier: { type: 'recipe-step', instructionText: { value: 'Mix', language: 'en' },
      usesIngredient: [roots[0]!.occurrence], media: [], scaling: 'not-scalable' } };
  const selector = { grain: 'content' as const, revision: '00000000-0000-4000-8000-000000000020', variantId: 'urn:rezics:variant:method' };
  const adopted: OccurrenceRecord = { occurrence: id(14), parent: id(12), state: 'active', role: 'instruction', labels: [],
    introducedBy: revision, target: id(15), selection: { mode: 'fixed-revision', revision: selector.revision, selector } };
  const instructions: RecipeInstruction[] = [{ occurrence: adopted.occurrence,
    reference: { target: adopted.target!, selector }, status: 'available', text: 'Serve' }];
  // Same breadth-first order as the original whole-revision reader, including empty groups.
  const records = [...roots, nested, step, adopted];
  const derivations = Array.from({ length: 43 }, (_, index) => ({ derivation: `d${index}`, output: { selector } }));
  return { records, instructions, derivations };
}

function pagesFor(records: OccurrenceRecord[], instructions: RecipeInstruction[]) {
  return (parent: string, after?: string): RecipeExportPage => {
    const siblings = records.filter(record => record.parent === parent);
    const offset = Number(after ?? 0), slice = siblings.slice(offset, offset + 64);
    const selected = instructions.filter(instruction => slice.some(record => record.occurrence === instruction.occurrence));
    return { profile: 'recipe-export-page-v1', structure, revision, parent,
      next: offset + 64 < siblings.length ? String(offset + 64) : null,
      occurrences: slice, instructions: selected,
      contents: selected.map(item => ({ reference: item.reference, body: item.text })),
      parts: exportRecipeParts(slice, parent, selected), rights: [], measures, importLimits,
      cost: { pagesRead: 1, occurrences: slice.length } };
  };
}

for (const size of [4097, 8193]) test(`paged ${size}-ingredient exports are byte-identical to the unbounded producer, including after restart`, async () => {
  const { records, instructions, derivations } = corpus(size);
  let checkpoint = recipeExportCheckpoint(structure);
  const page = pagesFor(records, instructions);
  let calls = 0;
  const read = async (parent: string, after?: string) => {
    if (++calls === 4) throw new Error('connection interrupted');
    return page(parent, after);
  };
  const credits = async (_revision: string, after?: string) => {
    const offset = Number(after ?? 0);
    return { items: derivations.slice(offset, offset + 20), nextCursor: offset + 20 < derivations.length ? String(offset + 20) : null };
  };
  await expect(continueRecipeExport(checkpoint, read, credits)).rejects.toThrow('connection interrupted');
  expect(checkpoint.pages).toHaveLength(3);
  checkpoint = JSON.parse(JSON.stringify(checkpoint)) as RecipeExportCheckpoint;
  await continueRecipeExport(checkpoint, read, credits);
  expect(checkpoint.pages.every(page => page.occurrences.length <= 64)).toBe(true);
  expect(checkpoint.derivations).toEqual(derivations);
  const expected = { profile: 'recipe-schema-org-export-v1', structure, revision, rights: [],
    ...exportRecipe(records, structure, instructions, measures) };
  expected.losses.push({ code: 'derivation-not-representable', occurrence: id(14), pointer: '/derivations/0' });
  const actual = assembleRecipeExport(checkpoint.pages, checkpoint.derivations, 'schema-org');
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  expect(new TextEncoder().encode(JSON.stringify(actual)).byteLength).toBeGreaterThan(1_048_576);
  expect(JSON.stringify(assembleRecipeExport(checkpoint.pages, checkpoint.derivations, 'native'))).toBe(JSON.stringify({
    format: 'native', structure, revision, rights: [], occurrences: records, measures,
    contents: instructions.map(item => ({ reference: item.reference, body: item.text })), derivations, instructions, losses: [],
  }));
});

test('interruption during derivation continuation retains exactly the last successful cut', async () => {
  const { records, instructions, derivations } = corpus(2);
  const checkpoint = recipeExportCheckpoint(structure);
  const page = pagesFor(records, instructions);
  await expect(continueRecipeExport(checkpoint, async (parent, after) => page(parent, after), async (_revision, cursor) => {
    if (cursor) throw new Error('offline');
    return { items: derivations.slice(0, 20), nextCursor: '20' };
  })).rejects.toThrow('offline');
  const pageCount = checkpoint.pages.length;
  await continueRecipeExport(checkpoint, async () => { throw new Error('completed pages must not restart'); }, async (_revision, cursor) => {
    expect(cursor).toBe('20'); return { items: derivations.slice(20), nextCursor: null };
  });
  expect(checkpoint.pages).toHaveLength(pageCount);
  expect(checkpoint.derivations).toEqual(derivations);
});
