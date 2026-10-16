import type { RecipeExportPage } from '@rezics/model/recipe-export';
import type { WorkReadSession } from '../work/read-session.ts';
import { readNativeExportPage, NATIVE_EXPORT_PAGE_SIZE } from '../export/native-page.ts';
import { readRecipeInstructions } from './instructions.ts';
import { exportRecipeParts } from './export.ts';
import { MAX_RECIPE_IMPORT_BYTES, MAX_RECIPE_IMPORT_OCCURRENCES, MAX_RECIPE_JSON_DEPTH } from './importer.ts';

export const RECIPE_EXPORT_PAGE_SIZE = NATIVE_EXPORT_PAGE_SIZE;

/** Schema.org parts and importer limits are Recipe's projection of native pages. */
export async function readRecipeExportPage(session: WorkReadSession,
  input: Parameters<typeof readNativeExportPage>[1]): Promise<RecipeExportPage> {
  const { containers: _containers, selections: instructions, ...page } = await readNativeExportPage(session, input, records => readRecipeInstructions(session,records,
    { work: input.work,revision: input.revision,admitted: true }));
  return { ...page, profile: 'recipe-export-page-v1', instructions,
    parts: exportRecipeParts(page.occurrences, page.parent, instructions),
    importLimits: { bytes: MAX_RECIPE_IMPORT_BYTES, occurrences: MAX_RECIPE_IMPORT_OCCURRENCES, depth: MAX_RECIPE_JSON_DEPTH } };
}
