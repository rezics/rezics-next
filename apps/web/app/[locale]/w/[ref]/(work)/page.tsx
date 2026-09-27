import { loadWork } from '../../../../../features/work-page/read.ts';
import { idOf, iriOf, parseScope } from '../../../../../features/work-page/route.ts';
import { WorkOverview } from '../../../../../features/work-page/work-views.tsx';
import { getMessages, requestLocale } from '../../../../../i18n/server.ts';

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function WorkOverviewPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  const context = typeof query.context === 'string' && idOf(iriOf(query.context)) ? query.context : undefined;
  return <WorkOverview workRef={ref} id={work.id} work={work.header} scope={parseScope(query)} context={context}
    locale={locale} messages={messages} />;
}
