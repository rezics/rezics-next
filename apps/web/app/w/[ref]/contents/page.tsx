import type { Metadata } from 'next';
import { loadWork, resolveWork } from '../../../../features/work-page/read.ts';
import { PendingView } from '../../../../features/work-page/pending-view.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

type Params = { params: Promise<{ ref: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const locale = await requestLocale();
  const [work, { t }] = await Promise.all([resolveWork((await params).ref, locale), getTranslation('workPage', [locale])]);
  return { title: work.kind === 'work' ? `${t.contents} · ${work.header.title.value}` : t.contents };
}

// Main has no Work contents read yet; the view says so instead of showing an empty list.
export default async function WorkContentsPage({ params }: Params) {
  const [{ ref }, locale] = await Promise.all([params, requestLocale()]);
  const [work, messages] = await Promise.all([loadWork(ref, locale), getMessages('workPage', locale)]);
  if (!work.ok) return null;
  return <PendingView view="contents" workRef={ref} messages={messages} />;
}
