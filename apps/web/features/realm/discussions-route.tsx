import { buttonVariants } from '@rezics/ui/button';
import { Skeleton, SkeletonText } from '@rezics/ui/skeleton';
import { CalendarRangeIcon, MessagesSquareIcon, PlusIcon, RefreshCwIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import { Suspense } from 'react';
import { signInPath } from '../auth/paths.ts';
import type { FeedMessages } from '../feed/messages.ts';
import { parseThreadSort, parseThreadWindow, type ThreadSort, type ThreadWindow } from '../feed/thread.ts';
import { failureText, settle } from '../feed/types.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { EmptyState, failureDetail } from '../shell/empty-state.tsx';
import LocalizedLink from '../shell/localized-link.tsx';
import { DiscussionFrame, discussionView, readerMain, realmPathOf, type Search } from './discussion-page.tsx';
import { DiscussionList } from './discussion-list.tsx';
import type { RealmView } from './realm-page.tsx';
import { parseCursor } from './route.ts';
import type { RealmRouteProps } from './routes.tsx';

// `/r/{realm}/discussions`: the Realm's threads, sorted as its members choose.

/** A list's address: only what differs from Best this week, and a cursor for a later page. */
function listHref(path: string, sort: ThreadSort, window: ThreadWindow, cursor?: string): string {
  const query = new URLSearchParams();
  if (sort !== 'best') query.set('sort', sort);
  if (sort === 'top' && window !== 'week') query.set('t', window);
  if (cursor) query.set('cursor', cursor);
  return `${path}/discussions${query.size ? `?${query}` : ''}`;
}

function ListSkeleton() {
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

async function Threads({ view, sort, window, cursor, feed }: { view: RealmView; sort: ThreadSort; window: ThreadWindow;
  cursor: string | undefined; feed: FeedMessages }) {
  const { locale } = view.context;
  const t = materializeData(feed, { locale });
  const path = realmPathOf(view);
  const main = await readerMain(view);
  const page = await settle(() => main.v1.realms({ realm: view.realm.realm }).threads.get({ query: { sort,
    ...sort === 'top' ? { window } : {}, ...cursor ? { cursor } : {},
    ...view.reader.actingSubject ? { actingSubject: view.reader.actingSubject } : {} } }));
  const top = listHref(path, sort, window);
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
    sorts: { best: listHref(path, 'best', window), new: listHref(path, 'new', window), top: listHref(path, 'top', window) },
    windows: { week: listHref(path, 'top', 'week'), month: listHref(path, 'top', 'month'), all: listHref(path, 'top', 'all') },
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
  return <DiscussionList items={page.data.items} realmPath={path} sort={sort} window={window} hrefs={hrefs}
    next={page.data.nextCursor ? listHref(path, sort, window, page.data.nextCursor) : null}
    first={cursor ? top : null} empty={empty} />;
}

export async function RealmDiscussionsRoute({ params, searchParams }: RealmRouteProps) {
  const [{ locale, realm }, search] = await Promise.all([params, searchParams]);
  const resolved = await discussionView(locale, realm, search as Search);
  if ('page' in resolved) return resolved.page;
  const { view, feed } = resolved;
  const sort = parseThreadSort(search), window = parseThreadWindow(search), cursor = parseCursor(search);
  return <DiscussionFrame view={view} locale={resolved.locale} feed={feed} search={search}
    here={listHref(realmPathOf(view), sort, window, cursor)}>
    <div className="mb-4 flex justify-end">
      <LocalizedLink href={`${realmPathOf(view)}/submit`} className={buttonVariants({ size: 'sm', pill: true })}>
        <PlusIcon aria-hidden="true" className="size-4" />{view.messages.createPost}</LocalizedLink>
    </div>
    <Suspense fallback={<ListSkeleton />}>
      <Threads view={view} sort={sort} window={window} cursor={cursor} feed={feed} />
    </Suspense>
  </DiscussionFrame>;
}
