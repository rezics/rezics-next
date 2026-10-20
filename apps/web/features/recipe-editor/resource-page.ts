import { readSuppliedAllowedActions } from '../work-levels-edit/allowed.ts';
import { recipeReadingReads } from '../work-page/recipe-reading-recorded-page.ts';
import type { WorkHeader } from '../work-page/types.ts';
import type { MainClient } from '../studio/types.ts';
import type { BooksRead } from '../work-page/books-edition-page.read.ts';
import type { RecipeWorkPage } from '../work-page/types.ts';

/** The recipe section follows the production projection's link, using its reader's exact identity. */
export async function readSuppliedRecipePage(main: MainClient, actingSubject: string | undefined,
  href: string, servings?: number): Promise<BooksRead<RecipeWorkPage | null>> {
  return recipeReadingReads({ main, actingSubject }).readRecipe(href,
    servings === undefined ? {} : { servings });
}

/** The complete production recipe-region visit: public/pinned recipe, optional selected notes and admitted edit action. */
export async function loadRecipeReading(main: MainClient, actingSubject: string | undefined,
  work: Pick<WorkHeader, 'id' | 'mainVersion' | 'selectedLanguage'>, href: string) {
  const reads = recipeReadingReads({ main, actingSubject });
  const [recipe, text, allowed] = await Promise.all([
    reads.readRecipe(href),
    reads.readText(work.mainVersion, work.selectedLanguage ?? undefined),
    readSuppliedAllowedActions(main, work.id.slice(-36), actingSubject),
  ]);
  return { resource: work.id, recipe, text: text.ok ? text.data.body : null, allowed };
}
