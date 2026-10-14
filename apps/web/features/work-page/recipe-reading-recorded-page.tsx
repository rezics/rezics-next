import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { RegionFailure } from './region.tsx';
import { RecipeExperience, type RecipePageRead } from './types/recipe.tsx';
import type { Loaded, RecipeWorkPage } from './types.ts';

/** The production recipe region. Stories inject the same supplied-client reader for later pages. */
export function RecipeRegionView({ recipe, href, actingSubject, text, edit, locale, messages, readPage }: {
  recipe: Loaded<RecipeWorkPage | null>; href: string; actingSubject: string | null; text: string | null;
  edit?: { href: string; label: string } | null; locale: UiLocale; messages: WorkPageMessages; readPage?: RecipePageRead;
}) {
  if (!recipe.ok) return <RegionFailure title={messages.recipeMethod} failure={recipe.failure} messages={messages} />;
  return <RecipeExperience initial={recipe.data} href={href} actingSubject={actingSubject} text={text}
    edit={edit} locale={locale} messages={messages} readPage={readPage} />;
}
