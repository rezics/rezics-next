import { Badge } from '@rezics/ui/badge';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { FeatherIcon, ListOrderedIcon, PenLineIcon, PlusIcon, SendIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { relativeTime } from '../feed/time.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { editingHref, studioHref, workHref } from './agent.ts';
import type { StudioMessages } from './messages.ts';
import { Failure, formatDate, kindLabel, languageName, openStates, reviewModeText, StateBadge, SubmissionBadge } from './parts.tsx';
import type { BookChapters, InventoryView, ReviewPage } from './read.ts';
import { StudioCover } from './studio-cover.tsx';
import { studioAgentName } from './studio-frame.tsx';
import { canonicalLanguage, type InventoryState, type InventoryWork, type Loaded, workKind }
  from './types.ts';

type T = ContractOf<StudioMessages>;

/** The Agent's own Works (all, drafts, published), what Realms review, and Works it imported or curates. */
export type HomeView = 'all' | Exclude<InventoryState, 'empty'> | 'review' | 'curated';
/** The views a Studio home address may name; Works not started yet show under All. */
export const homeViews = ['all', 'draft', 'published', 'review', 'curated'] as const;

export type HomeContent =
  | { view: Exclude<HomeView, 'review'>; works: Loaded<InventoryView> }
  | { view: 'review'; review: ReviewPage };

function WorkItem({ work, chapters, agent, now, locale, t }: {
  work: InventoryWork; chapters: BookChapters | undefined; agent: AgentOption; now: number; locale: UiLocale; t: T;
}) {
  const kind = workKind(work.types);
  const open = work.submissions.filter(item => openStates.has(item.state as never)).length;
  const own = work.relationship === 'authored';
  // A book is written chapter by chapter; a recipe opens in its editor; other Works reopen their latest text.
  const latest = kind === 'book' || !own ? undefined : work.texts[0];
  const editHref = editingHref(agent, work.id, kind, {
    language: canonicalLanguage(work.title.language),
    text: latest ? { id: latest.contribution, revision: latest.draftHead } : null,
  });
  const languages = [...new Set(work.texts.map(text => languageName(text.language, locale)))];
  return <li className="grid grid-cols-[4rem_minmax(0,1fr)] items-start gap-x-4 gap-y-3 rounded-2xl border
    border-border/60 bg-card p-3 shadow-(--aura-shadow-card) sm:grid-cols-[4rem_minmax(0,1fr)_auto] sm:items-center sm:p-4">
    <StudioCover id={work.id} title={work.title} cover={work.cover} types={work.types}
      authors={own && agent.label ? [agent.label] : []} actingSubject={agent.iri} />
    <div className="grid min-w-0 gap-1.5">
      <h2 lang={work.title.language} className="font-medium font-work-title text-lg/snug [overflow-wrap:anywhere]">
        <Link href={workHref(agent, work.id)} className="rounded-sm hover:underline">{work.title.value}</Link></h2>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
        <span>{kindLabel(work.types, locale, t)}</span>
        {chapters ? <><span aria-hidden="true">·</span><span>{chapters.more ? t.chapterCountMore(chapters.count)
          : t.chapterCount(chapters.count)}</span></> : null}
        {chapters?.published ? <><span aria-hidden="true">·</span><span>{t.publishedCount(chapters.published)}</span></>
          : null}
        {languages.length ? <><span aria-hidden="true">·</span><span>{languages.join(', ')}</span></> : null}
        <span aria-hidden="true">·</span>
        <time dateTime={work.updatedAt}>{t.updated({ time: relativeTime(work.updatedAt, now, locale, 'long') })}</time>
      </p>
      <p className="flex flex-wrap items-center gap-1.5">
        {own ? <StateBadge state={work.state} t={t} /> : <Badge variant="secondary">{t.curatedBadge}</Badge>}
        {work.disclosure === 'public' ? <Badge variant="soft">{t.publicWork}</Badge> : null}
        {open ? <Badge variant="info"><SendIcon aria-hidden="true" />{t.openSubmissions(open)}</Badge> : null}
      </p>
    </div>
    <div className="col-span-2 flex flex-wrap gap-2 sm:col-span-1 sm:justify-end">
      {!own ? <Link href={workHref(agent, work.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.openWork}</Link> : <Link href={editHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {kind === 'book' ? <><ListOrderedIcon aria-hidden="true" />{t.tabChapters}</>
          : <><PenLineIcon aria-hidden="true" />{latest ? t.continueWriting : t.writeFirst}</>}</Link>}
    </div>
  </li>;
}

function Works({ works, view, agent, now, locale, t }: {
  works: Loaded<InventoryView>; view: Exclude<HomeView, 'review'>; agent: AgentOption; now: number; locale: UiLocale; t: T;
}) {
  if (!works.ok) {
    return works.failure === 'denied' ? <Failure title={t.worksDenied} help={t.worksDeniedHelp} retry={false} t={t} />
      : <Failure title={t.worksFailed} retry t={t} />;
  }
  // Chapters are listed in their Book, not here.
  const items = works.data.page.items.filter(work => workKind(work.types) !== 'chapter');
  if (!items.length) {
    return <p className="rounded-2xl border border-border/80 border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
      {view === 'draft' ? t.draftsEmpty : view === 'published' ? t.publishedEmpty : view === 'curated' ? t.curatedEmpty
        : t.worksEmpty}</p>;
  }
  return <ul className="grid gap-3">{items.map(work =>
    <WorkItem key={work.id} work={work} chapters={works.data.books[work.id]} agent={agent} now={now} locale={locale}
      t={t} />)}</ul>;
}

function Review({ review, agent, locale, t }: { review: ReviewPage; agent: AgentOption; locale: UiLocale; t: T }) {
  if (!review.submissions.ok) {
    return review.submissions.failure === 'unavailable' ? <Failure title={t.reviewsFailed} retry t={t} />
      : <p className="text-muted-foreground text-sm">{t.reviewEmpty}</p>;
  }
  // Still open with the Realm first, then decisions, newest first.
  const items = [...review.submissions.data.items].sort((a, b) =>
    Number(openStates.has(b.state)) - Number(openStates.has(a.state)) || b.updatedAt.localeCompare(a.updatedAt));
  if (!items.length) {
    return <p className="rounded-2xl border border-border/80 border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
      {t.reviewEmpty}</p>;
  }
  return <ul className="grid gap-3">{items.map(submission => {
    const realm = review.realms[submission.realm];
    const title = review.works[submission.work];
    return <li key={submission.id} className="grid gap-2 rounded-2xl border border-border/60 bg-card px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-0.5">
          <h2 lang={title?.language} className="font-medium font-work-title text-lg/snug [overflow-wrap:anywhere]">
            <Link href={workHref(agent, submission.work, 'realms')} className="rounded-sm hover:underline">
              {title?.value ?? t.untitled}</Link></h2>
          <p className="text-muted-foreground text-sm"><span lang={realm?.language}>{realm?.name ?? t.realmFallback}</span>
            {' · '}{reviewModeText(realm?.reviewMode ?? null, t)}</p>
        </div>
        <SubmissionBadge state={submission.state} t={t} />
      </div>
      {submission.publicReason ? <p className="text-sm">{submission.publicReason}</p> : null}
      <p className="text-muted-foreground text-xs">{t.submittedOn({ date: formatDate(submission.openedAt, locale) })}</p>
    </li>;
  })}</ul>;
}

/**
 * Studio's home for one Agent: every Work it writes, from Main's inventory,
 * filtered by where each stands, and what Realms are reviewing. Each view is
 * one page of one read; "Show more" follows Main's cursor.
 */
export function StudioHome({ agent, content, moreHref, now, locale, messages }: {
  agent: AgentOption; content: HomeContent; moreHref: string | null;
  /** The render time, so the server and the browser print the same relative times. */
  now: number; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const views: Array<{ view: HomeView; label: string }> = [{ view: 'all', label: t.viewAll },
    { view: 'draft', label: t.viewDrafts }, { view: 'published', label: t.viewPublished }, { view: 'review', label: t.viewReview },
    { view: 'curated', label: t.viewCurated }];
  const nothing = content.view === 'all' && content.works.ok && !content.works.data.page.items.length && !moreHref;
  return <PageContainer className="grid gap-6">
    <PageHeader title={t.studio} description={t.homeDescription({ agent: studioAgentName(agent, t) })}
      actions={<Link href={studioHref(agent, '/new')} className={buttonVariants({ size: 'lg' })}>
        <PlusIcon aria-hidden="true" />{t.newWork}</Link>} />
    {nothing ? <EmptyState icon={FeatherIcon} title={t.emptyTitle} description={t.emptyBody}>
      <Link href={studioHref(agent, '/new')} className={buttonVariants()}><PlusIcon aria-hidden="true" />{t.startWriting}</Link>
    </EmptyState> : <>
      <nav aria-label={t.viewsLabel} className="-mx-1 flex gap-1 overflow-x-auto border-border/60 border-b px-1">
        {views.map(({ view, label }) => <Link key={view} href={view === 'all' ? studioHref(agent) : `${studioHref(agent)}?view=${view}`}
          aria-current={content.view === view ? 'page' : undefined}
          className={cn('-mb-px shrink-0 border-transparent border-b-2 px-3 py-2 font-medium text-muted-foreground text-sm',
            'hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground')}>{label}</Link>)}
      </nav>
      <section aria-label={views.find(item => item.view === content.view)?.label} className="grid gap-4">
        {content.view === 'review' ? <Review review={content.review} agent={agent} locale={locale} t={t} />
          : <Works works={content.works} view={content.view} agent={agent} now={now} locale={locale} t={t} />}
        {moreHref ? <Link href={moreHref} className={buttonVariants({ variant: 'outline', className: 'justify-self-start' })}>
          {t.loadMore}</Link> : null}
      </section>
    </>}
  </PageContainer>;
}
