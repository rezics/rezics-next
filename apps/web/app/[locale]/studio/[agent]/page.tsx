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
import { inventoryAddress, inventoryQuery, type InventoryQuery } from '../../../../features/studio/types.ts';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: t.studio, robots: { index: false } };
}

export default async function StudioHomePage({ params, searchParams }: {
  params: Promise<{ agent: string }>; searchParams: Promise<{ view?: string; cursor?: string; q?: string; sort?: string }>;
}) {
  const [{ agent: segment }, query] = await Promise.all([params, searchParams]);
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const view: HomeView = homeViews.find(item => item === query.view) ?? 'all';
  const cursor = validCursor(query.cursor);
  const inventory = inventoryQuery(query);
  const [messages, { t }] = await Promise.all([getMessages('studio', locale), getTranslation('studio', [locale])]);
  return <Suspense fallback={<StudioHomePending label={t.loadingTab} />}>
    <Home agent={agent} view={view} cursor={cursor} query={inventory} locale={locale} messages={messages} />
  </Suspense>;
}

async function Home({ agent, view, cursor, query, locale, messages }: {
  agent: AgentOption; view: HomeView; cursor: string | undefined; query: InventoryQuery; locale: UiLocale; messages: StudioMessages;
}) {
  const content: HomeContent = view === 'review'
    ? { view, review: await readReviewPage(agent.iri, cursor, locale) }
    : { view, works: await readInventory(agent.iri, { ...query,
      ...(view === 'curated' ? { view: 'curated' as const } : { view: 'authored' as const,
        ...(view === 'all' ? {} : { state: view }) }) }, cursor) };
  const next = content.view === 'review' ? content.review.submissions.ok ? content.review.submissions.data.nextCursor : null
    : content.works.ok ? content.works.data.page.nextCursor : null;
  return <StudioHome agent={agent} content={content} now={Date.now()} locale={locale} messages={messages}
    query={query} firstHref={cursor ? inventoryAddress(studioHref(agent), view, query) : null}
    moreHref={next ? inventoryAddress(studioHref(agent), view, query, next) : null} />;
}
