import type { UiLocale } from '../../i18n/define.ts';
import type { FeedMessages } from '../feed/messages.ts';
import type { MainClient } from '../feed/types.ts';
import { RealmRankingPage } from './ranking-page.tsx';
import { readRankingAnswer, type RankingRequest } from './ranking-read.ts';

/** Narrow content seam: the Realm owner supplies the frame and reader's client. */
export async function RealmRankingContent({ main, request, path, locale, feed }: {
  main: MainClient; request: RankingRequest; path: string; locale: UiLocale; feed: FeedMessages;
}) {
  const page = await readRankingAnswer(main, request);
  return <RealmRankingPage page={page} path={path} sort={request.sort} window={request.window}
    cursor={request.cursor} locale={locale} feed={feed} />;
}
