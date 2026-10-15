import type { RecipeExportPage } from '@rezics/model/recipe-export';
import type { WorkReadSession } from '../work/read-session.ts';
import { NATIVE_ID } from '../structure/graph.ts';
import { readCompositionPage, readStructureMeasures } from '../structure/read.ts';
import { readImportedExportBases } from '../rights/read-imported.ts';
import { exportRecipeParts } from './export.ts';
import { isAdoptedInstruction, readRecipeInstructions } from './instructions.ts';
import { MAX_RECIPE_IMPORT_BYTES, MAX_RECIPE_IMPORT_OCCURRENCES, MAX_RECIPE_JSON_DEPTH } from './importer.ts';

export const RECIPE_EXPORT_PAGE_SIZE = 64;

/** A selected Content document is its own page, so a batch of otherwise small
 * uses cannot exceed the instruction owner's document response bound. */
export async function readRecipeExportPage(session: WorkReadSession, input: {
  structure: string; revision: string; work: string; actingSubject: string; parent?: string; after?: string;
}): Promise<RecipeExportPage> {
  const { structure, revision, actingSubject } = input;
  const parent = input.parent ?? structure;
  const read = (limit: number) => readCompositionPage(session.deps.environment, {
    structure, revision, parent, after: input.after, limit,
    canReadTarget: target => NATIVE_ID.test(target)
      ? session.deps.access.canReadWork(session.principal!, actingSubject, target) : Promise.resolve(false),
    canReadOccurrence: record => Promise.resolve(isAdoptedInstruction(record)),
  });
  let page = await read(RECIPE_EXPORT_PAGE_SIZE);
  if (page.occurrences.some(isAdoptedInstruction)) page = await read(1);
  const instructions = await readRecipeInstructions(session, page.occurrences,
    { work: input.work, revision, admitted: true });
  const parts = exportRecipeParts(page.occurrences, parent, instructions);
  const contents = [...new Map(instructions.flatMap(item => item.document || item.text !== undefined
    ? [[JSON.stringify(item.reference), { reference: item.reference,
      ...(item.document ? { document: item.document } : { body: item.text }) }] as const] : [])).values()];
  return { profile: 'recipe-export-page-v1', structure, revision, parent, next: page.next ?? null,
    occurrences: page.occurrences, instructions, contents, parts,
    measures: (await readStructureMeasures(session.deps.environment, { structure, revision })).measures,
    rights: [...await readImportedExportBases(session, input.work, revision)],
    importLimits: { bytes: MAX_RECIPE_IMPORT_BYTES, occurrences: MAX_RECIPE_IMPORT_OCCURRENCES, depth: MAX_RECIPE_JSON_DEPTH },
    cost: { pagesRead: page.cost.pagesRead, occurrences: page.occurrences.length } };
}
