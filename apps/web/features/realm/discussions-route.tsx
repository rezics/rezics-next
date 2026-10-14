import { buttonVariants } from '@rezics/ui/button';
import { PlusIcon } from 'lucide-react';
import { Suspense } from 'react';
import { parseThreadSort, parseThreadWindow } from '../feed/thread.ts';
import LocalizedLink from '../shell/localized-link.tsx';
import { DiscussionFrame, discussionView, readerMain, realmPathOf, type Search } from './discussion-page.tsx';
import { rankingHref, RankingSkeleton } from './ranking-page.tsx';
import { RealmRankingContent } from './ranking-route.tsx';
import { parseCursor } from './route.ts';
import type { RealmRouteProps } from './routes.tsx';

// The Realm frame belongs to the route; ranking reads and rendering share a content seam.

export async function RealmDiscussionsRoute({ params, searchParams }: RealmRouteProps) {
  const [{ locale, realm }, search] = await Promise.all([params, searchParams]);
  const resolved = await discussionView(locale, realm, search as Search);
  if ('page' in resolved) return resolved.page;
  const { view, feed } = resolved;
  const sort = parseThreadSort(search), window = parseThreadWindow(search), cursor = parseCursor(search);
  return <DiscussionFrame view={view} locale={resolved.locale} feed={feed} search={search}
    here={rankingHref(realmPathOf(view), sort, window, cursor)}>
    <div className="mb-4 flex justify-end">
      <LocalizedLink href={`${realmPathOf(view)}/submit`} className={buttonVariants({ size: 'sm', pill: true })}>
        <PlusIcon aria-hidden="true" className="size-4" />{view.messages.createPost}</LocalizedLink>
    </div>
    <Suspense fallback={<RankingSkeleton />}>
      <RealmRankingContent main={await readerMain(view)} request={{ realm: view.realm.realm, sort, window, cursor,
        actingSubject: view.reader.actingSubject }} path={realmPathOf(view)} locale={resolved.locale} feed={feed} />
    </Suspense>
  </DiscussionFrame>;
}
