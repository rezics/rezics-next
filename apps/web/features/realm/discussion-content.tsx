'use client';

import { buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { CalendarRangeIcon, MessagesSquareIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import type { FeedMessages } from '../feed/messages.ts';
import type { ThreadsPage } from '../feed/thread.ts';
import { failureText, type Loaded } from '../feed/types.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { DiscussionList } from './discussion-list.tsx';
import { discussionListHref, type BoardPage, type DiscussionQuery } from './discussion-read.ts';
import type { RealmMessages } from './messages.ts';
import { RealmNotFound } from './states.tsx';
import { realmHref } from './route.ts';

export function DiscussionListSkeleton() {
  return <div aria-busy="true" className="overflow-hidden border-border/60 border-y bg-card sm:rounded-2xl sm:border">
    <div className="flex items-center justify-between gap-3 border-border/60 border-b px-4 py-3">
      <Skeleton className="h-5 w-28 rounded-full" /><Skeleton className="h-9 w-40 rounded-full" />
    </div>
    {[0, 1, 2, 3].map(index => <div key={index} className="grid gap-2.5 border-border/60 border-b px-4 py-4">
      <Skeleton className="h-3 w-40 rounded-full" /><Skeleton className="h-5 w-3/4 rounded-full" />
      <SkeletonText lines={2} /><Skeleton className="h-8 w-40 rounded-full" />
    </div>)}
  </div>;
}

/** A refused board list never hides a readable discussion list or invents an empty vocabulary. */
export function DiscussionBoards({ read, path, query, messages }: {
  read: Loaded<BoardPage>; path: string; query: DiscussionQuery; messages: RealmMessages;
}) {
  if (!read.ok && (read.failure === 'missing' || read.failure === 'closed')) return null;
  const first = { ...query, boardsCursor: undefined };
  return <nav aria-label={messages.boards} className="mb-5 grid min-w-0 gap-2">
    <h2 className="font-semibold text-sm">{messages.boards}</h2>
    {read.ok ? <ul className="flex flex-wrap gap-2">
      <li><LocalizedLink href={discussionListHref(path, { ...first, concept: undefined, cursor: undefined })}
        aria-current={!query.concept ? 'page' : undefined}
        className={buttonVariants({ variant: !query.concept ? 'secondary' : 'outline', size: 'sm' })}>
        {messages.allDiscussions}</LocalizedLink></li>
      {read.data.items.map(item => <li key={item.id} className="min-w-0 max-w-full">
        <LocalizedLink href={discussionListHref(path, { ...first, concept: item.id, cursor: undefined })}
          aria-current={query.concept === item.id ? 'page' : undefined}
          className={cn(buttonVariants({ variant: query.concept === item.id ? 'secondary' : 'outline', size: 'sm' }),
            'h-auto min-h-8 max-w-full whitespace-normal py-1.5 [overflow-wrap:anywhere]')}>
          {item.label}</LocalizedLink></li>)}
    </ul> : <p role="status" className="text-muted-foreground text-sm">{messages.boardsFailed}</p>}
    <div className="flex flex-wrap gap-3 text-sm">
      {!read.ok || query.boardsCursor ? <LocalizedLink href={discussionListHref(path, first)}
        className="text-primary underline underline-offset-4">{!read.ok ? messages.retry : messages.firstPage}</LocalizedLink> : null}
      {read.ok && read.data.nextCursor ? <LocalizedLink
        href={discussionListHref(path, { ...query, boardsCursor: read.data.nextCursor })}
        className="text-primary underline underline-offset-4">{messages.moreBoards}</LocalizedLink> : null}
    </div>
  </nav>;
}

/** The route's populated, empty and failed list, shared with the prove-phase page stories. */
export function DiscussionListContent({ page, path, query, locale, feed, messages }: {
  page: Loaded<ThreadsPage>; path: string; query: DiscussionQuery; locale: UiLocale;
  feed: FeedMessages; messages: RealmMessages;
}) {
  const t = materializeData(feed, { locale });
  // A changed selection starts at its first page, while board pagination remains independent.
  const firstQuery = { sort: query.sort, window: query.window, concept: query.concept,
    language: query.language, boardsCursor: query.boardsCursor };
  const top = discussionListHref(path, firstQuery);
  if (!page.ok) {
    if (page.failure === 'missing') return <RealmNotFound messages={messages} />;
    const text = failureText(page.failure, { failedTitle: t.discussionsFailed, offline: t.failedBody,
      server: t.serverBody, missingTitle: t.discussionsMissing, missingBody: t.missingBody,
      deniedTitle: t.deniedTitle, deniedBody: t.deniedBody, movedTitle: t.moved, movedBody: t.movedBody, budget: t.budgetBody });
    if (text.kind === 'absent') return null;
    const quiet = text.action === 'none' || text.action === 'sign-in';
    return <EmptyState icon={TriangleAlertIcon} tone={quiet || text.action === 'restart' ? 'default' : 'destructive'}
      role={quiet ? 'status' : 'alert'} title={text.title}
      description={failureDetail(text.description, page.reference, t.errorReference, text.reference)}>
      {text.action === 'none' ? null : <LocalizedLink
        href={text.action === 'sign-in' ? signInPath(localizedPath(top, locale)) : top}
        className={buttonVariants({ variant: 'outline' })}>
        <RotateCwIcon aria-hidden="true" />{text.action === 'sign-in' ? t.signIn : text.action === 'restart' ? t.refresh : t.retry}
      </LocalizedLink>}
    </EmptyState>;
  }
  const hrefs = {
    sorts: Object.fromEntries((['best', 'new', 'top'] as const).map(sort =>
      [sort, discussionListHref(path, { ...firstQuery, sort })])) as Record<DiscussionQuery['sort'], string>,
    windows: Object.fromEntries((['week', 'month', 'all'] as const).map(window =>
      [window, discussionListHref(path, { ...firstQuery, sort: 'top', window })])) as Record<DiscussionQuery['window'], string>,
    next: (cursor: string) => discussionListHref(path, { ...query, cursor }),
  };
  const empty = query.sort === 'top' && query.window !== 'all'
    ? <EmptyState icon={CalendarRangeIcon} headingLevel={3} title={t.emptyPeriod} description={t.emptyPeriodBody} className="m-3 sm:m-4">
      <LocalizedLink href={hrefs.windows.all} className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.showAllTime}</LocalizedLink>
      <LocalizedLink href={hrefs.sorts.new} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{t.new}</LocalizedLink>
    </EmptyState>
    : <EmptyState icon={MessagesSquareIcon} headingLevel={3} title={t.emptyDiscussions} description={t.emptyDiscussionsBody} className="m-3 sm:m-4">
      {query.concept || query.language ? <LocalizedLink
        href={discussionListHref(path, { sort: query.sort, window: query.window, boardsCursor: query.boardsCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{messages.allDiscussions}</LocalizedLink>
        : <LocalizedLink href={realmHref(locale, page.data.realm, 'works')}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}>{messages.browse}</LocalizedLink>}
    </EmptyState>;
  const listPage = { threads: page.data.items, nextCursor: page.data.nextCursor };
  return <DiscussionList page={listPage} realmPath={path} realmId={page.data.realm} sort={query.sort} window={query.window} hrefs={hrefs}
    first={query.cursor ? top : null} empty={empty} />;
}
