import { buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { CalendarRangeIcon, MessagesSquareIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { signInPath } from '../auth/paths.ts';
import type { FeedMessages } from '../feed/messages.ts';
import type { ThreadsPage, ThreadSort, ThreadWindow } from '../feed/thread.ts';
import { failureText, type Loaded } from '../feed/types.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { DiscussionList } from './discussion-list.tsx';
/** Ranking coordinates and an optional opaque continuation, on the existing Discussions route. */
export function rankingHref(path: string, sort: ThreadSort, window: ThreadWindow, cursor?: string): string {
  const query = new URLSearchParams();
  if (sort !== 'best') query.set('sort', sort);
  if (sort === 'top' && window !== 'week') query.set('t', window);
  if (cursor) query.set('cursor', cursor);
  return `${path}/discussions${query.size ? `?${query}` : ''}`;
}

export function RankingSkeleton() {
  return <div aria-busy="true" className="overflow-hidden border-border/60 border-y bg-card sm:rounded-2xl sm:border">
    <div className="flex items-center justify-between border-border/60 border-b px-4 py-3">
      <Skeleton className="h-5 w-28 rounded-full" /><Skeleton className="h-9 w-56 rounded-full" /></div>
    {[0, 1, 2, 3].map(index => <div key={index} className="grid gap-2.5 border-border/60 border-b px-4 py-4">
      <div className="flex items-center gap-2"><Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-3 w-40 rounded-full" /></div>
      <Skeleton className="h-5 w-3/4 rounded-full" /><SkeletonText lines={2} />
      <Skeleton className="h-8 w-60 rounded-full" />
    </div>)}
  </div>;
}

/** The production list and its failures, shared by the route and contract-state stories. */
export function RealmRankingPage({ page, path, sort, window, cursor, locale, feed }: {
  page: Loaded<ThreadsPage>; path: string; sort: ThreadSort; window: ThreadWindow;
  cursor?: string; locale: UiLocale; feed: FeedMessages;
}) {
  const t = materializeData(feed, { locale });
  const top = rankingHref(path, sort, window);
  if (!page.ok) {
    const text = failureText(page.failure, { failedTitle: t.discussionsFailed, offline: t.failedBody, server: t.serverBody,
      missingTitle: t.discussionsMissing, missingBody: t.missingBody, deniedTitle: t.deniedTitle, deniedBody: t.deniedBody,
      movedTitle: t.moved, movedBody: t.movedBody, budget: t.budgetBody });
    if (text.kind === 'absent') return null;
    const moved = text.action === 'restart';
    const quiet = text.action === 'none' || text.action === 'sign-in';
    return <EmptyState icon={moved ? RefreshCwIcon : TriangleAlertIcon} tone={quiet || moved ? 'default' : 'destructive'}
      role={quiet ? 'status' : 'alert'} title={text.title}
      description={failureDetail(text.description, page.reference, t.errorReference, text.reference)}>
      {text.action === 'none' ? null : text.action === 'sign-in'
        ? <LocalizedLink href={signInPath(localizedPath(top, locale))} className={buttonVariants()}>{t.signIn}</LocalizedLink>
        : <LocalizedLink href={top} className={buttonVariants({ variant: 'outline' })}>
          <RotateCwIcon aria-hidden="true" />{moved ? t.refresh : t.retry}</LocalizedLink>}
    </EmptyState>;
  }
  const hrefs = {
    sorts: { best: rankingHref(path, 'best', window), new: rankingHref(path, 'new', window), top: rankingHref(path, 'top', window) },
    windows: { week: rankingHref(path, 'top', 'week'), month: rankingHref(path, 'top', 'month'), all: rankingHref(path, 'top', 'all') },
  };
  const empty = sort === 'top' && window !== 'all'
    ? <EmptyState icon={CalendarRangeIcon} headingLevel={3} title={t.emptyPeriod} description={t.emptyPeriodBody}
      className="m-3 sm:m-4">
      <LocalizedLink href={hrefs.windows.all} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.showAllTime}</LocalizedLink>
      <LocalizedLink href={hrefs.sorts.new} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>{t.new}</LocalizedLink>
    </EmptyState>
    : <EmptyState icon={MessagesSquareIcon} headingLevel={3} title={t.emptyDiscussions}
      description={t.emptyDiscussionsBody} className="m-3 sm:m-4" />;
  return <DiscussionList items={page.data.items} realmPath={path} realmId={page.data.realm} sort={sort} window={window} hrefs={hrefs}
    next={page.data.nextCursor ? rankingHref(path, sort, window, page.data.nextCursor) : null}
    first={cursor ? top : null} empty={empty} />;
}

