import { buttonVariants } from '@rezics/ui/button';
import { BookXIcon, TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { EmptyState } from '../../../../../../features/shell/empty-state.tsx';
import Link from '../../../../../../features/shell/localized-link.tsx';
import { PageContainer } from '../../../../../../features/shell/page.tsx';
import { RetryButton } from '../../../../../../features/work-page/retry-button.tsx';
import { studioHref, workHref } from '../../../../../../features/studio/agent.ts';
import { detailsValues } from '../../../../../../features/studio/details-api.ts';
import { openStates } from '../../../../../../features/studio/parts.tsx';
import { readChapters, readPublishedTexts, readRealmChoices, readStudioWork, readTags, readWorkSubmissions, readWorkTexts,
  validCursor, writingLanguageOf } from '../../../../../../features/studio/read.ts';
import { studioAgent } from '../../../../../../features/studio/route.ts';
import { StudioWork, type WorkTabContent, workTabs } from '../../../../../../features/studio/studio-work.tsx';
import { uuid } from '../../../../../../features/studio/types.ts';
import { getMessages, getTranslation, requestLocale } from '../../../../../../i18n/server.ts';

type Params = { params: Promise<{ agent: string; work: string }>;
  searchParams: Promise<{ tab?: string; cursor?: string; from?: string }> };

async function load({ params }: Pick<Params, 'params'>) {
  const { agent: segment, work } = await params;
  if (!uuid.test(work)) notFound();
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  return { agent, locale, loaded: await readStudioWork(agent.iri, work, locale) };
}

export async function generateMetadata(props: Params): Promise<Metadata> {
  const context = await load(props);
  const { t } = await getTranslation('studio', [await requestLocale()]);
  return { title: context?.loaded.ok ? context.loaded.data.header.title.value : t.studio, robots: { index: false } };
}

export default async function StudioWorkPage(props: Params) {
  const [context, query] = await Promise.all([load(props), props.searchParams]);
  if (!context) return null;
  const { agent, locale, loaded } = context;
  const messages = await getMessages('studio', locale);
  const { t } = await getTranslation('studio', [locale]);
  if (!loaded.ok) {
    return <PageContainer className="max-w-2xl">
      {loaded.failure === 'unavailable'
        ? <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1} title={t.workFailed}>
          <RetryButton label={t.retry} pendingLabel={t.retry} /></EmptyState>
        : <EmptyState icon={BookXIcon} headingLevel={1} title={t.workMissing}>
          <Link href={studioHref(agent)} className={buttonVariants({ variant: 'outline' })}>{t.backToStudio}</Link>
        </EmptyState>}
    </PageContainer>;
  }
  const { header, metadata } = loaded.data;
  const tabs = workTabs(header.types);
  const tab = tabs.find(item => item === query.tab) ?? tabs[0]!;
  const cursor = validCursor(query.cursor);
  let content: WorkTabContent;
  switch (tab) {
    case 'chapters': {
      const page = await readChapters(agent.iri, header, cursor);
      const offset = cursor ? Math.max(0, Number.parseInt(query.from ?? '0', 10) || 0) : 0;
      const next = page.ok ? page.data.nextCursor : null;
      const shown = page.ok ? page.data.items.length : 0;
      content = { tab, chapters: { page, offset, moreHref: next
        ? `${workHref(agent, header.id, 'chapters')}&cursor=${encodeURIComponent(next)}&from=${offset + shown}` : null } };
      break;
    }
    case 'text':
      content = { tab, texts: await readWorkTexts(agent.iri, header.id) };
      break;
    case 'details':
      content = { tab, tags: await readTags(agent.iri, header.id, locale), cover: { cover: header.cover },
        details: { status: 'idle', head: metadata.ok ? metadata.data.revision : null,
          values: detailsValues(metadata.ok ? metadata.data : null, writingLanguageOf(header)) } };
      break;
    case 'realms': {
      const [texts, realms, history] = await Promise.all([readPublishedTexts(agent.iri, header.mainVersion),
        readRealmChoices(agent.iri, locale), readWorkSubmissions(agent.iri, header.id, locale)]);
      const open = history.submissions.ok
        ? history.submissions.data.filter(item => openStates.has(item.state)).map(item => item.realm) : [];
      content = { tab, submit: { texts, realms, open }, history };
      break;
    }
  }
  return <StudioWork agent={agent} work={loaded.data} content={content} locale={locale} messages={messages} />;
}
