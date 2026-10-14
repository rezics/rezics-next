import { readSuppliedAllowedActions } from '../work-levels-edit/allowed.ts';
import { booksLanguageReads } from '../work-page/books-language-recorded-page.ts';
import type { WorkHeader } from '../work-page/types.ts';
import type { MainClient } from '../studio/types.ts';
import { followHref } from '../entity-page/href.ts';
import { failureOf } from '../work-page/failure.ts';
import type { BooksRead } from '../work-page/books-edition-page.read.ts';
import type { RecipeWorkPage } from '../work-page/types.ts';
import { readRecipePage, recipePageQuery } from './pages.ts';

/** The recipe section follows the production projection's link, using its reader's exact identity. */
export async function readSuppliedRecipePage(main: MainClient, actingSubject: string | undefined,
  href: string, servings?: number): Promise<BooksRead<RecipeWorkPage | null>> {
  try {
    const filled = await readRecipePage(query => followHref<RecipeWorkPage | null>(main, href,
      recipePageQuery(actingSubject, query))(), servings === undefined ? {} : { servings });
    if (!filled.ok) return { ok: false, failure: failureOf(filled.error.status ?? 0),
      ...(filled.error.status ? { status: filled.error.status } : {}),
      ...(filled.error.value !== undefined ? { problem: filled.error.value } : {}) };
    return { ok: true, data: filled.page };
  } catch { return { ok: false, failure: 'unavailable' }; }
}

/** The complete production recipe-region visit: public/pinned recipe, optional selected notes and admitted edit action. */
export async function loadRecipeReading(main: MainClient, actingSubject: string | undefined,
  work: Pick<WorkHeader, 'id' | 'mainVersion' | 'selectedLanguage'>, href: string) {
  const [recipe, text, allowed] = await Promise.all([
    readSuppliedRecipePage(main, actingSubject, href),
    booksLanguageReads({ main, actingSubject }).readText(work.mainVersion, work.selectedLanguage ?? undefined),
    readSuppliedAllowedActions(main, work.id.slice(-36), actingSubject),
  ]);
  return { recipe, text: text.ok ? text.data.body : null, allowed };
}
