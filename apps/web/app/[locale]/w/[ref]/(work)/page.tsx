import type { Metadata } from 'next';
import { workPageMetadata } from '../../../../../features/seo/work.ts';
import { loadWork, resolveWork } from '../../../../../features/work-page/read.ts';
import { idOf, iriOf, parseScope } from '../../../../../features/work-page/route.ts';
import { WorkOverview } from '../../../../../features/work-page/work-views.tsx';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

// The layout names the page; this adds its address and search metadata.
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  return workPageMetadata(await resolveWork(ref, locale), { tab: 'overview' }, query, locale);
}

export default async function WorkOverviewPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  const context = typeof query.context === 'string' && idOf(iriOf(query.context)) ? query.context : undefined;
  return <WorkOverview workRef={ref} id={work.id} work={work.header} scope={parseScope(query)} context={context}
    locale={locale} messages={messages} />;
}
