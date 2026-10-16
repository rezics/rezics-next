import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { parseThreadSort, parseThreadWindow } from '../feed/thread.ts';
import { DiscussionCollection, DiscussionFrame, discussionView, readerMain, realmPathOf, type Search } from './discussion-page.tsx';
import { DiscussionBoards, DiscussionListContent, DiscussionListSkeleton } from './discussion-content.tsx';
import { discussionListHref, realmDiscussionReads, type DiscussionQuery } from './discussion-read.ts';
import type { RealmReadClient } from './read.ts';
import type { RealmView } from './realm-page.tsx';
import { RealmRankingBody } from './ranking-route.tsx';
import { parseCursor } from './route.ts';
import type { RealmRouteProps } from './routes.tsx';
import type { FeedMessages } from '../feed/messages.ts';

async function Threads({ view, query, feed }: { view: RealmView; query: DiscussionQuery; feed: FeedMessages }) {
  const main = await readerMain(view);
  const reads = realmDiscussionReads(main, view.realm.realm, view.reader.actingSubject ?? undefined);
  const path = realmPathOf(view);
  // Keep ranking's production boundary for its ordinary collection. Board and
  // language selections carry their own address and native request contract.
  if (!query.concept && !query.language && !query.boardsCursor) {
    return RealmRankingBody({ main, view, query, feed });
  }
  const [page, boards] = await Promise.all([reads.threads(query), reads.boards(query.boardsCursor)]);
  if (!page.ok && page.failure === 'missing') notFound();
  return <>
    <DiscussionBoards read={boards} path={path} query={query} messages={view.messages} />
    <DiscussionListContent page={page} path={path} query={query} locale={view.context.locale} feed={feed} messages={view.messages} />
  </>;
}

export async function RealmDiscussionsRoute({ params, searchParams }: RealmRouteProps, client?: RealmReadClient) {
  const [{ locale, realm }, search] = await Promise.all([params, searchParams]);
  const resolved = await discussionView(locale, realm, search as Search, '', client);
  if ('page' in resolved) return resolved.page;
  const { view, feed } = resolved;
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const query: DiscussionQuery = { sort: parseThreadSort(search), window: parseThreadWindow(search), cursor: parseCursor(search),
    concept: first(search.concept), boardsCursor: first(search.boardsCursor), language: first(search.language) };
  return <DiscussionFrame view={view} locale={resolved.locale} feed={feed} search={search}
    here={discussionListHref(realmPathOf(view), query)}>
    <DiscussionCollection view={view}>
      <Suspense fallback={<DiscussionListSkeleton />}><Threads view={view} query={query} feed={feed} /></Suspense>
    </DiscussionCollection>
  </DiscussionFrame>;
}
