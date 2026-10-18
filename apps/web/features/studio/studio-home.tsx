import { Skeleton } from '@rezics/ui/skeleton';
import { Badge } from '@rezics/ui/badge';
import { Button, buttonVariants } from '@rezics/ui/button';
import { Field, FieldLabel } from '@rezics/ui/field';
import { Input } from '@rezics/ui/input';
import { ChoiceSelect } from '@rezics/ui/select';
import { cn } from '@rezics/ui/utils';
import { FeatherIcon, ListOrderedIcon, PenLineIcon, PlusIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { AgentOption } from '../auth/acting-identity.ts';
import { relativeTime } from '../feed/time.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import { editingHref, studioHref, workHref } from './agent.ts';
import type { StudioMessages } from './messages.ts';
import { Failure, formatDate, kindLabel, languageName, openStates, reviewModeText, StateBadge, SubmissionBadge } from './parts.tsx';
import type { InventoryView, ReviewPage } from './read.ts';
import { studioAgentName } from './studio-frame.tsx';
import { canonicalLanguage, inventoryAddress, inventoryQuery, type InventoryQuery, type InventoryState, type InventoryWork, type Loaded, workKind }
  from './types.ts';

type T = ContractOf<StudioMessages>;

/** The Agent's own Works (all, drafts, published), what Realms review, and Works it imported or curates. */
export type HomeView = 'all' | Exclude<InventoryState, 'empty'> | 'review' | 'curated';
/** The views a Studio home address may name; Works not started yet show under All. */
export const homeViews = ['all', 'draft', 'published', 'review', 'curated'] as const;

export type HomeContent =
  | { view: Exclude<HomeView, 'review'>; works: Loaded<InventoryView> }
  | { view: 'review'; review: ReviewPage };

function WorkItem({ work, agent, now, locale, t }: {
  work: InventoryWork; agent: AgentOption; now: number; locale: UiLocale; t: T;
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
  const changed = own && work.texts.some(text => text.publicationHead && text.publicationDraft !== text.draftHead);
  const changesRequested = work.submissions.some(item => item.state === 'changes-requested');
  const count = work.chapterCount;
  const chapterCount = !count || (!count.complete && !count.value) ? t.chapterCountUnavailable
    : count.complete ? t.chapterCount(count.value) : t.chapterCountMore(count.value);
  return <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-border/60
    border-b py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_10rem_9rem] sm:gap-x-5">
    <div className="grid min-w-0 gap-1.5">
      <h2 lang={work.title.language} dir="auto" className="font-medium font-work-title text-base/snug [overflow-wrap:anywhere]">
        <Link href={workHref(agent, work.id)} className="rounded-sm hover:underline">{work.title.value}</Link></h2>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        {own ? <StateBadge state={work.state} t={t} /> : <Badge variant="secondary">{t.curatedBadge}</Badge>}
        <span>{work.disclosure === 'public' ? t.publicWork : t.statePrivate}</span>
        {kind === 'book' ? <span>{chapterCount}</span> : null}
        {changed ? <span className="text-foreground">{t.unpublishedChanges}</span> : null}
        {open ? <Link href={workHref(agent, work.id, 'realms')} className="rounded-sm underline underline-offset-4">
          {changesRequested ? t.submissionChanges : t.openSubmissions(open)}</Link> : null}
      </p>
      <details className="text-muted-foreground text-xs">
        <summary className="w-fit cursor-pointer rounded-sm py-1 hover:text-foreground focus-visible:outline-2
          focus-visible:outline-ring">{t.workDetails}<span className="sr-only">: {work.title.value}</span></summary>
        <div className="grid gap-1 py-1">
          <p>{kindLabel(work.types, locale, t)}{languages.length ? ` · ${languages.join(', ')}` : ''}</p>
        </div>
      </details>
    </div>
    <time dateTime={work.updatedAt} title={formatDate(work.updatedAt, locale)}
      className="col-start-1 row-start-2 text-muted-foreground text-xs sm:col-start-2 sm:row-start-1 sm:pt-1 sm:text-sm">
      {t.updated({ time: relativeTime(work.updatedAt, now, locale, 'long') })}</time>
    <div className="col-start-2 row-span-2 row-start-1 flex justify-end sm:col-start-3">
      {!own ? <Link href={workHref(agent, work.id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.openWork}</Link> : <Link href={editHref} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {kind === 'book' ? <><ListOrderedIcon aria-hidden="true" />{t.tabChapters}</>
          : <><PenLineIcon aria-hidden="true" />{latest || kind === 'recipe' && work.state !== 'empty'
            ? t.continueWriting : t.writeFirst}</>}</Link>}
    </div>
  </li>;
}

function Works({ works, view, query, agent, now, locale, t }: {
  works: Loaded<InventoryView>; view: Exclude<HomeView, 'review'>; query: InventoryQuery;
  agent: AgentOption; now: number; locale: UiLocale; t: T;
}) {
  if (!works.ok) {
    return works.failure === 'denied' ? <Failure title={t.worksDenied} help={t.worksDeniedHelp} retry={false} t={t} />
      : <Failure title={t.worksFailed} retry t={t} />;
  }
  // Main's inventory lists Works; chapter Posts belong to their Book's contents.
  const items = works.data.page.items;
  if (!items.length) {
    return <p className="rounded-2xl border border-border/80 border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
      {works.data.page.nextCursor ? t.inventoryContinues : query.q ? t.noMatchingWorks
        : view === 'draft' ? t.draftsEmpty : view === 'published' ? t.publishedEmpty : view === 'curated' ? t.curatedEmpty
        : t.worksEmpty}</p>;
  }
  return <ul className="min-w-0 border-border/60 border-y">{items.map(work =>
    <WorkItem key={work.id} work={work} agent={agent} now={now} locale={locale}
      t={t} />)}</ul>;
}

function InventoryControls({ agent, view, query, locale, t }: {
  agent: AgentOption; view: HomeView; query: InventoryQuery; locale: UiLocale; t: T;
}) {
  return <form action={localizedPath(studioHref(agent), locale)} method="get" role="search" aria-label={t.findWorks}
    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto]">
    {view !== 'all' ? <input type="hidden" name="view" value={view} /> : null}
    <Field className="col-span-2 min-w-0 sm:col-span-1">
      <FieldLabel>{t.findWorks}</FieldLabel>
      <Input key={query.q} name="q" type="search" defaultValue={query.q} maxLength={400} pattern="[\s\S]{0,200}" enterKeyHint="search" />
    </Field>
    <Field className="min-w-0">
      <FieldLabel>{t.sortWorks}</FieldLabel>
      <ChoiceSelect key={query.sort} name="sort" defaultValue={query.sort} label={t.sortWorks}
        options={[{ value: 'recent', label: t.sortRecent }, { value: 'created', label: t.sortCreated },
          { value: 'title', label: t.sortTitle }]} />
    </Field>
    <Button type="submit" variant="outline">{t.applyInventory}</Button>
    {query.q ? <Link href={inventoryAddress(studioHref(agent), view, { ...query, q: '' })}
      className="col-span-2 w-fit rounded-sm text-sm underline underline-offset-4 sm:col-span-3">{t.clearSearch}</Link> : null}
  </form>;
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
export function StudioHome({ agent, content, moreHref, firstHref = null, query = inventoryQuery({}), now, locale, messages }: {
  agent: AgentOption; content: HomeContent; moreHref: string | null;
  firstHref?: string | null; query?: InventoryQuery;
  /** The render time, so the server and the browser print the same relative times. */
  now: number; locale: UiLocale; messages: StudioMessages;
}) {
  const t = materializeData(messages, { locale });
  const views: Array<{ view: HomeView; label: string }> = [{ view: 'all', label: t.viewAll },
    { view: 'draft', label: t.viewDrafts }, { view: 'published', label: t.viewPublished }, { view: 'review', label: t.viewReview },
    { view: 'curated', label: t.viewCurated }];
  const nothing = content.view === 'all' && content.works.ok && !content.works.data.page.items.length
    && !moreHref && !firstHref && !query.q;
  return <PageContainer className="grid gap-6">
    <PageHeader title={t.studio} description={t.homeDescription({ agent: studioAgentName(agent, t) })}
      actions={<Link href={studioHref(agent, '/new')} className={buttonVariants({ size: 'lg' })}>
        <PlusIcon aria-hidden="true" />{t.newWork}</Link>} />
    {nothing ? <EmptyState icon={FeatherIcon} title={t.emptyTitle} description={t.emptyBody}>
      <Link href={studioHref(agent, '/new')} className={buttonVariants()}><PlusIcon aria-hidden="true" />{t.startWriting}</Link>
    </EmptyState> : <>
      <nav aria-label={t.viewsLabel} className="-mx-1 flex gap-1 overflow-x-auto border-border/60 border-b px-1">
        {views.map(({ view, label }) => <Link key={view} href={inventoryAddress(studioHref(agent), view, query)}
          aria-current={content.view === view ? 'page' : undefined}
          className={cn('-mb-px shrink-0 border-transparent border-b-2 px-3 py-2 font-medium text-muted-foreground text-sm',
            'hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground')}>{label}</Link>)}
      </nav>
      {content.view !== 'review' ? <InventoryControls agent={agent} view={content.view} query={query} locale={locale} t={t} /> : null}
      <section aria-label={views.find(item => item.view === content.view)?.label} className="grid gap-4">
        {content.view === 'review' ? <Review review={content.review} agent={agent} locale={locale} t={t} />
          : <Works works={content.works} view={content.view} query={query} agent={agent} now={now} locale={locale} t={t} />}
        {firstHref || moreHref ? <nav aria-label={t.inventoryPages} className="flex flex-wrap gap-3">
          {firstHref ? <Link href={firstHref} className={buttonVariants({ variant: 'ghost' })}>{t.backToFirst}</Link> : null}
          {moreHref ? <Link href={moreHref} className={buttonVariants({ variant: 'outline' })}>{t.loadMore}</Link> : null}
        </nav> : null}
      </section>
    </>}
  </PageContainer>;
}

/** The route streams its inventory or review reads under the same native loading region. */
export function StudioHomePending({ label }: { label: string }) {
  return <PageContainer><div role="status" aria-label={label} aria-busy="true" className="grid gap-5">
    <Skeleton className="h-10 w-48" /><Skeleton className="h-24 rounded-2xl" /><Skeleton className="h-24 rounded-2xl" />
  </div></PageContainer>;
}
