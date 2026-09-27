import type { Metadata } from 'next';
import { loadWork, resolveWork } from '../../../../../../features/work-page/read.ts';
import { parseContentsQuery } from '../../../../../../features/work-page/route.ts';
import { WorkContents } from '../../../../../../features/work-page/work-views.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };
type Props = Params & { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const locale = await requestLocale();
  const [work, { t }] = await Promise.all([resolveWork((await params).ref, locale), getTranslation('workPage', [locale])]);
  return { title: work.kind === 'work' ? `${t.contents} · ${work.header.title.value}` : t.contents };
}

export default async function WorkContentsPage({ params, searchParams }: Props) {
  const [{ ref }, query, locale] = await Promise.all([params, searchParams, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  return <WorkContents workRef={ref} id={work.id} query={parseContentsQuery(query)} locale={locale}
    messages={messages} />;
}
