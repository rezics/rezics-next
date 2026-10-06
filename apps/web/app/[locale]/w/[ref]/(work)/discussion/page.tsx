import type { Metadata } from 'next';
import { workPageMetadata, workTitle } from '../../../../../../features/seo/work.ts';
import { loadWork, resolveWork } from '../../../../../../features/work-page/read.ts';
import { parseCursor, parseScope } from '../../../../../../features/work-page/route.ts';
import { WorkDiscussion } from '../../../../../../features/work-page/work-views.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, { t }] = await Promise.all([resolveWork(ref, locale), getTranslation('workPage', [locale])]);
  return { title: await workTitle(work, t.discussion),
    ...await workPageMetadata(work, { tab: 'discussion' }, query, locale) };
}

export default async function WorkDiscussionPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  return <WorkDiscussion workRef={ref} id={work.id} scope={parseScope(query)} cursor={parseCursor(query)}
    locale={locale} messages={messages} />;
}
