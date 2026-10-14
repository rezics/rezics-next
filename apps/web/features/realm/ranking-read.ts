import type { ThreadsPage, ThreadSort, ThreadWindow } from '../feed/thread.ts';
import { isOfflineError, settle, type Loaded, type MainClient } from '../feed/types.ts';
import { settleRealmRead } from './browse-page-read.ts';
import type { Loaded as RealmLoaded, RankingMetric, RankingPage } from './types.ts';
import { idOf } from './route.ts';

export interface RankingRequest {
  realm: string;
  sort: ThreadSort;
  window: ThreadWindow;
  cursor?: string;
  actingSubject: string | null;
}

/** Each page reads as the same represented viewer; the cursor remains Main's opaque value. */
export function readRankingAnswer(main: MainClient, request: RankingRequest): Promise<Loaded<ThreadsPage>> {
  const { realm, sort, window, cursor, actingSubject } = request;
  return settle(async () => {
    const answer = await main.v1.realms({ realm: idOf(realm) ?? realm }).threads.get({ query: {
      sort, window: sort === 'best' ? 'all' : window,
      ...(cursor ? { cursor } : {}), ...(actingSubject ? { actingSubject } : {}),
    } });
    // Eden can return a transport exception as error.value instead of throwing it.
    if (answer.error && isOfflineError(answer.error.value)) throw answer.error.value;
    return answer;
  });
}

/** The chart module consumes its own ranking operation, never the thread ordering. */
export function readRankingModuleAnswer(main: MainClient, realm: string,
  interval: 'day' | 'week' | 'month', metric: RankingMetric): Promise<RealmLoaded<RankingPage>> {
  return settleRealmRead(async () => {
    const answer = await main.v1.realms({ realm: idOf(realm) ?? realm }).rankings.get({ query: { interval, metric, limit: 10 } });
    if (answer.error && isOfflineError(answer.error.value)) throw answer.error.value;
    return answer;
  });
}
