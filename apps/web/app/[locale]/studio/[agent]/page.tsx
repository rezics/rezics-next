import type { Metadata } from 'next';
import { studioHref } from '../../../../features/studio/agent.ts';
import { readInventory, readReviewPage, validCursor } from '../../../../features/studio/read.ts';
import { studioAgent } from '../../../../features/studio/route.ts';
import { type HomeContent, type HomeView, homeViews, StudioHome } from '../../../../features/studio/studio-home.tsx';
import { getMessages, getTranslation, requestLocale } from '../../../../i18n/server.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.studio, robots: { index: false } };
}

export default async function StudioHomePage({ params, searchParams }: {
  params: Promise<{ agent: string }>; searchParams: Promise<{ view?: string; cursor?: string }>;
}) {
  const [{ agent: segment }, query] = await Promise.all([params, searchParams]);
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const view: HomeView = homeViews.find(item => item === query.view) ?? 'all';
  const cursor = validCursor(query.cursor);
  const [content, messages] = await Promise.all([
    view === 'review'
      ? readReviewPage(agent.iri, cursor, locale).then((review): HomeContent => ({ view, review }))
      : readInventory(agent.iri, view === 'curated' ? { view: 'curated' } : { view: 'authored',
        ...(view === 'all' ? {} : { state: view }) }, cursor).then((works): HomeContent => ({ view, works })),
    getMessages('studio', locale)]);
  const next = content.view === 'review' ? content.review.submissions.ok ? content.review.submissions.data.nextCursor : null
    : content.works.ok ? content.works.data.page.nextCursor : null;
  const base = view === 'all' ? `${studioHref(agent)}?` : `${studioHref(agent)}?view=${view}&`;
  return <StudioHome agent={agent} content={content} now={Date.now()} locale={locale} messages={messages}
    moreHref={next ? `${base}cursor=${encodeURIComponent(next)}` : null} />;
}
