import type { Metadata } from 'next';
import { copyOf } from '../../../../../../features/recipe-editor/messages.ts';
import { RecipeEditPage } from '../../../../../../features/recipe-editor/edit-page.tsx';
import { loadWork } from '../../../../../../features/work-page/read.ts';
import { WorkUnavailable } from '../../../../../../features/work-page/work-states.tsx';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await params;
  return { title: copyOf(await requestLocale()).pageTitle, robots: { index: false } };
}

/** `/w/{ref}/edit/recipe`: a cook's editor for one recipe: details, yield and time, ingredient sections and steps. */
export default async function WorkRecipeEditPage({ params }: Props) {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const work = await loadWork(ref, locale);
  if (!work.ok) return <WorkUnavailable messages={await getMessages('workPage', locale)} />;
  return <RecipeEditPage workRef={ref} id={work.id} locale={locale} />;
}
