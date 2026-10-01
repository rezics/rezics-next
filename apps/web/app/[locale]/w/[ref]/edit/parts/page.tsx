import type { Metadata } from 'next';
import { PartsEditPage } from '../../../../../../features/work-levels-edit/edit-pages.tsx';
import { copyOf } from '../../../../../../features/work-levels-edit/messages.ts';
import { loadWork } from '../../../../../../features/work-page/read.ts';
import { WorkUnavailable } from '../../../../../../features/work-page/work-states.tsx';
import { getMessages, requestLocale } from '../../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await params;
  const t = copyOf(await requestLocale());
  return { title: `${t.editStructure} · ${t.tabParts}`, robots: { index: false } };
}

/** `/w/{ref}/edit/parts`: an editor's parts list, with the controls to add, reorder, relabel and remove parts. */
export default async function WorkPartsEditPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const work = await loadWork(ref, locale);
  if (!work.ok) return <WorkUnavailable messages={await getMessages('workPage', locale)} />;
  const after = typeof query.after === 'string' && query.after.length <= 2048 ? query.after : undefined;
  return <PartsEditPage workRef={ref} id={work.id} after={after} locale={locale} />;
}
