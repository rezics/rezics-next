import type { Metadata } from 'next';
import { ShowcaseEditPage } from '../../../../../../features/showcase-editor/showcase-page.tsx';
import { copyOf } from '../../../../../../features/work-levels-edit/messages.ts';
import { loadWork } from '../../../../../../features/work-page/read.ts';
import { WorkUnavailable } from '../../../../../../features/work-page/work-states.tsx';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await params;
  const t = copyOf(await requestLocale());
  return { title: `${t.editStructure} · ${t.tabShowcase}`, robots: { index: false } };
}

/** `/w/{ref}/edit/showcase`: the Work's showcase art, previewed on the real stage before it is saved. */
export default async function WorkShowcaseEditPage({ params }: Props) {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const work = await loadWork(ref, locale);
  if (!work.ok) return <WorkUnavailable messages={await getMessages('workPage', locale)} />;
  return <ShowcaseEditPage workRef={ref} id={work.id} locale={locale} />;
}
