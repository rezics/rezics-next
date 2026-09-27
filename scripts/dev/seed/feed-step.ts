import { seedFeed } from './feed.ts';
import { seedHomeV2 } from './home-v2.ts';
import type { SeedState } from './state.ts';

export async function seedHomeFeed(state: SeedState) {
  const feed = await state.optional('Home follows and votes', () =>
    seedFeed(state.api, state.sessions, state.createdRealms));
  if (feed) console.log(`Home: ${feed.activities} activities, ${feed.followed} follows, ${feed.votes} votes.`);
  await state.optional('Home Continue and new activity', () =>
    seedHomeV2(state.api, state.sessions, state.created, state.createdRealms));
}
