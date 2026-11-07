import type { Actor } from '../request/access.ts';
import { createFeedApplication } from './application/index.ts';
import { createNativeFeedPorts, type FeedDependencies } from './adapters/feed-native.ts';
import { feedRoute } from './feed-activity.ts';
import { readFeedKind, type FeedPage, type FeedSelection } from './feed-contract.ts';
import {
  FEED_ACCOUNT_BATCH_LIMIT,
  FEED_AUTHOR_KEYS_PER_CANDIDATE,
  FEED_CANDIDATE_LIMIT,
  FEED_CONTINUE_CANDIDATES,
  FEED_CONTINUE_WIDTH,
  FEED_DISCOVERY_CANDIDATES_PER_RESULT,
  FEED_DISCOVERY_FIXED_CANDIDATES,
  FEED_PAGE_LIMIT,
  FEED_SPACE_BOARD_KEYS_PER_CANDIDATE,
  FEED_SPACE_FIXED_KEYS,
  type FeedActor,
} from './contract/index.ts';
import { feedCandidateBound } from './core/index.ts';

export type { FeedDependencies } from './adapters/feed-native.ts';
export {
  FEED_ACCOUNT_BATCH_LIMIT,
  FEED_AUTHOR_KEYS_PER_CANDIDATE,
  FEED_CANDIDATE_LIMIT,
  FEED_CONTINUE_CANDIDATES,
  FEED_CONTINUE_WIDTH,
  FEED_DISCOVERY_CANDIDATES_PER_RESULT,
  FEED_DISCOVERY_FIXED_CANDIDATES,
  FEED_PAGE_LIMIT,
  FEED_SPACE_BOARD_KEYS_PER_CANDIDATE,
  FEED_SPACE_FIXED_KEYS,
};
export { feedCandidateBound };

export type FeedReadQuery = {
  stream?: 'home' | 'following';
  limit?: number;
  cursor?: string;
  kind?: string;
} & FeedSelection;
export type FeedReads = {
  list(actor: Actor, query: FeedReadQuery, deadline: number, languages: readonly string[]): Promise<FeedPage>;
};

function toFeedActor(actor: Actor): FeedActor {
  return actor.kind === 'account'
    ? { kind: 'account', accountId: actor.accountId, scopes: actor.scopes }
    : { kind: 'anonymous' };
}

/** Native factory. HTTP mapping stays on the route; construction runs through the Content application. */
export function createFeedReads(deps: FeedDependencies): FeedReads {
  let actor: Actor;
  const application = createFeedApplication(createNativeFeedPorts(deps, () => actor), { route: feedRoute });
  return {
    list(requestActor, query, deadline, languages) {
      actor = requestActor;
      const kind = readFeedKind(query.kind);
      return application.list(
        toFeedActor(requestActor),
        { ...query, ...(kind === undefined ? {} : { kind }) },
        deadline,
        languages,
      ) as Promise<FeedPage>;
    },
  };
}
