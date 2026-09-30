import type { Metadata } from 'next';
import { RelationsEditPage } from '../../../../../../features/work-levels-edit/edit-pages.tsx';
import { copyOf } from '../../../../../../features/work-levels-edit/messages.ts';
import { loadWork } from '../../../../../../features/work-page/read.ts';
import { requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await params;
  const t = copyOf(await requestLocale());
  return { title: `${t.editStructure} · ${t.tabRelations}`, robots: { index: false } };
}

/** `/w/{ref}/edit/relations`: record how the Work relates to another, with evidence. */
export default async function WorkRelationsEditPage({ params }: Props) {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const work = await loadWork(ref, locale);
  if (!work.ok) return null;
  return <RelationsEditPage workRef={ref} id={work.id} locale={locale} />;
}
