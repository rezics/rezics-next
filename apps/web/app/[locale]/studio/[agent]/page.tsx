import { Suspense } from 'react';
import type { AgentOption } from '../../../../features/auth/acting-identity.ts';
import type { StudioMessages } from '../../../../features/studio/messages.ts';
import type { UiLocale } from '../../../../i18n/define.ts';
import type { Metadata } from 'next';
import { studioHref } from '../../../../features/studio/agent.ts';
import { readInventory, readReviewPage, validCursor } from '../../../../features/studio/read.ts';
import { studioAgent } from '../../../../features/studio/route.ts';
import { type HomeContent, type HomeView, homeViews, StudioHome, StudioHomePending } from '../../../../features/studio/studio-home.tsx';
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
  const [messages, { t }] = await Promise.all([getMessages('studio', locale), getTranslation('studio', [locale])]);
  return <Suspense fallback={<StudioHomePending label={t.loadingTab} />}>
    <Home agent={agent} view={view} cursor={cursor} locale={locale} messages={messages} />
  </Suspense>;
}

async function Home({ agent, view, cursor, locale, messages }: {
  agent: AgentOption; view: HomeView; cursor: string | undefined; locale: UiLocale; messages: StudioMessages;
}) {
  const content: HomeContent = view === 'review'
    ? { view, review: await readReviewPage(agent.iri, cursor, locale) }
    : { view, works: await readInventory(agent.iri, view === 'curated' ? { view: 'curated' } : { view: 'authored',
      ...(view === 'all' ? {} : { state: view }) }, cursor) };
  const next = content.view === 'review' ? content.review.submissions.ok ? content.review.submissions.data.nextCursor : null
    : content.works.ok ? content.works.data.page.nextCursor : null;
  const base = view === 'all' ? `${studioHref(agent)}?` : `${studioHref(agent)}?view=${view}&`;
  return <StudioHome agent={agent} content={content} now={Date.now()} locale={locale} messages={messages}
    moreHref={next ? `${base}cursor=${encodeURIComponent(next)}` : null} />;
}
