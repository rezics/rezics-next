import type { Metadata } from 'next';
import { workPageMetadata, workTitle } from '../../../../../../features/seo/work.ts';
import { loadWork, resolveWork } from '../../../../../../features/work-page/read.ts';
import { parseHistoryQuery } from '../../../../../../features/work-page/route.ts';
import { WorkHistory } from '../../../../../../features/work-page/work-views.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, { t }] = await Promise.all([resolveWork(ref, locale), getTranslation('workPage', [locale])]);
  return { title: await workTitle(work, t.history),
    ...await workPageMetadata(work, { tab: 'history' }, query, locale) };
}

export default async function WorkHistoryPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  return <WorkHistory workRef={ref} id={work.id} query={parseHistoryQuery(query)} locale={locale} messages={messages} />;
}
