import { buttonVariants } from '@rezics/ui/button';
import { BookXIcon, TriangleAlertIcon } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { EmptyState } from '../../../../../../features/shell/empty-state.tsx';
import Link from '../../../../../../features/shell/localized-link.tsx';
import { PageContainer } from '../../../../../../features/shell/page.tsx';
import { RetryButton } from '../../../../../../features/work-page/retry-button.tsx';
import type { AgentOption } from '../../../../../../features/auth/acting-identity.ts';
import { studioHref, workHref } from '../../../../../../features/studio/agent.ts';
import { detailsValues } from '../../../../../../features/studio/details-api.ts';
import type { StudioMessages } from '../../../../../../features/studio/messages.ts';
import { openStates } from '../../../../../../features/studio/parts.tsx';
import { readChapterFacts, readChapters, readPublishedTexts, readRealmChoices, readStudioWork, readTags,
  readWorkLanguages, readWorkSubmissions, readWorkTexts, type StudioWork, validCursor }
  from '../../../../../../features/studio/read.ts';
import { studioAgent, studioContext } from '../../../../../../features/studio/route.ts';
import { StudioWorkFrame, WorkTabBody, WorkTabPending, workTabs } from '../../../../../../features/studio/studio-work.tsx';
import { uuid } from '../../../../../../features/studio/types.ts';
import type { UiLocale } from '../../../../../../i18n/define.ts';
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

interface TabProps {
  tab: 'text' | 'details' | 'realms';
  agent: AgentOption;
  work: StudioWork;
  language: string;
  locale: UiLocale;
  messages: StudioMessages;
}

/** A tab other than a Book's chapters, read while the header already shows. */
async function StreamedTab({ tab, agent, work, language, locale, messages }: TabProps) {
  const { header, metadata } = work;
  switch (tab) {
    case 'text': return <WorkTabBody agent={agent} work={work} language={language} locale={locale} messages={messages}
      content={{ tab, texts: await readWorkTexts(agent.iri, header.id) }} />;
    case 'details': return <WorkTabBody agent={agent} work={work} language={language} locale={locale} messages={messages}
      content={{ tab, tags: await readTags(agent.iri, header.id, locale), cover: { cover: header.cover },
        details: { status: 'idle', head: metadata.ok ? metadata.data.revision : null,
          values: detailsValues(metadata.ok ? metadata.data : null, language) } }} />;
    case 'realms': {
      const [texts, realms, history] = await Promise.all([readPublishedTexts(agent.iri, header.mainVersion),
        readRealmChoices(agent.iri, locale), readWorkSubmissions(agent.iri, header.id, locale)]);
      const open = history.submissions.ok
        ? history.submissions.data.filter(item => openStates.has(item.state)).map(item => item.realm) : [];
      return <WorkTabBody agent={agent} work={work} language={language} locale={locale} messages={messages}
        content={{ tab, submit: { texts, realms, open }, history }} />;
    }
  }
}

export default async function StudioWorkPage(props: Params) {
  const [{ agent: segment, work }, query] = await Promise.all([props.params, props.searchParams]);
  if (!uuid.test(work)) notFound();
  const agent = await studioAgent(segment);
  if (!agent) return null;
  const locale = await requestLocale();
  const cursor = validCursor(query.cursor);
  const [loaded, messages, { t }] = await Promise.all([readStudioWork(agent.iri, work, locale),
    getMessages('studio', locale), getTranslation('studio', [locale])]);
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
  const { header } = loaded.data;
  const tabs = workTabs(header.types);
  const tab = tabs.find(item => item === query.tab) ?? tabs[0]!;
  const frame = { agent, work: loaded.data, tab, locale, messages };
  if (tab !== 'chapters') {
    const languages = await readWorkLanguages(agent.iri, header);
    return <StudioWorkFrame {...frame} languages={languages.all}>
      <Suspense fallback={<WorkTabPending label={t.loadingTab} />}>
        <StreamedTab tab={tab} agent={agent} work={loaded.data} language={languages.own} locale={locale}
          messages={messages} />
      </Suspense>
    </StudioWorkFrame>;
  }
  const [chapters, languages, { agents }] = await Promise.all([readChapters(agent.iri, header, { cursor }),
    readWorkLanguages(agent.iri, header), studioContext(segment)]);
  // Who writes each chapter and where it stands streams in after the list.
  const facts = readChapterFacts(agent, agents, header.id, chapters);
  const offset = cursor ? Math.max(0, Number.parseInt(query.from ?? '0', 10) || 0) : 0;
  const next = chapters.page.ok ? chapters.page.data.nextCursor : null;
  const shown = chapters.page.ok ? chapters.page.data.items.length : 0;
  const moreHref = next ? `${workHref(agent, header.id, 'chapters')}&cursor=${encodeURIComponent(next)}&from=${offset + shown}`
    : null;
  return <StudioWorkFrame {...frame} languages={languages.all}>
    <WorkTabBody agent={agent} work={loaded.data} language={chapters.language} locale={locale} messages={messages}
      content={{ tab, chapters: { page: chapters.page, offset, moreHref, facts } }} />
  </StudioWorkFrame>;
}
