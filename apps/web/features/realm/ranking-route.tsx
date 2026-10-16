import type { UiLocale } from '../../i18n/define.ts';
import type { FeedMessages } from '../feed/messages.ts';
import type { MainClient } from '../feed/types.ts';
import { RealmRankingPage } from './ranking-page.tsx';
import { readRankingAnswer, type RankingRequest } from './ranking-read.ts';
import { DiscussionBoards } from './discussion-content.tsx';
import { realmDiscussionReads, type DiscussionQuery } from './discussion-read.ts';
import type { RealmView } from './realm-page.tsx';
import { realmPathOf } from './discussion-page.tsx';

/** Ordinary ranking content keeps the boards and the reader supplied by its route. */
export async function RealmRankingBody({ main, view, query, feed }: {
  main: MainClient; view: RealmView; query: DiscussionQuery; feed: FeedMessages;
}) {
  const boards = await realmDiscussionReads(main, view.realm.realm, view.reader.actingSubject ?? undefined).boards();
  return <>
    <DiscussionBoards read={boards} path={realmPathOf(view)} query={query} messages={view.messages} />
    {await RealmRankingContent({ main, request: { realm: view.realm.realm, sort: query.sort,
      window: query.window, cursor: query.cursor, actingSubject: view.reader.actingSubject },
    path: realmPathOf(view), locale: view.context.locale, feed })}
  </>;
}

/** Narrow content seam: the Realm owner supplies the frame and reader's client. */
export async function RealmRankingContent({ main, request, path, locale, feed }: {
  main: MainClient; request: RankingRequest; path: string; locale: UiLocale; feed: FeedMessages;
}) {
  const page = await readRankingAnswer(main, request);
  return <RealmRankingPage page={page} path={path} sort={request.sort} window={request.window}
    cursor={request.cursor} locale={locale} feed={feed} />;
}
