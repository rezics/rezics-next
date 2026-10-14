'use client';

import type { UiLocale } from '../../i18n/define.ts';
import { mayEdit } from '../work-levels-edit/allowed.ts';
import type { BooksRead } from '../work-page/books-edition-page.read.ts';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { RegionFailure } from '../work-page/region.tsx';
import { RecipeExperience } from '../work-page/types/recipe.tsx';
import type { RecipeWorkPage } from '../work-page/types.ts';
import type { RecipeExport, RecipeExportApi } from './export-api.ts';
import { copyOf } from './messages.ts';
import { recipeEditHref } from './route.ts';

/** The production Work page's recipe region; the editor preview reuses its content component. */
export function RecipeResourceBody({ recipe, href, actingSubject, allowed, work, text, locale, messages,
  exportApi, saveExport }: {
  recipe: BooksRead<RecipeWorkPage | null>; href: string; actingSubject: string | null; allowed: readonly string[];
  work: string; text: string | null; locale: UiLocale; messages: WorkPageMessages;
  exportApi?: RecipeExportApi; saveExport?: (value: RecipeExport) => void;
}) {
  if (!recipe.ok) return <RegionFailure title={messages.recipeMethod} failure={recipe.failure} messages={messages} />;
  return <RecipeExperience initial={recipe.data} href={href} actingSubject={actingSubject}
    edit={mayEdit(allowed) ? { href: recipeEditHref(work), label: copyOf(locale).editRecipe } : null}
    text={text} locale={locale} messages={messages} exportApi={exportApi} saveExport={saveExport} />;
}
