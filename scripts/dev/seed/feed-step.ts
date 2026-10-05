import { seedFeed } from './feed.ts';
import { seedHomeV2 } from './home-v2.ts';
import { works } from './plan.ts';
import { refreshSeedTokens, type SeedState } from './state.ts';

export async function seedHomeFeed(state: SeedState) {
  // Access tokens last five minutes and the votes take longer, so each phase starts on fresh ones.
  const feed = await state.optional('Home follows and votes', () =>
    seedFeed(state.api, state.sessions, state.createdRealms,
      new Set(works.flatMap(work => state.created.get(work.id)?.work ?? [])), () => refreshSeedTokens(state)));
  if (feed) console.log(`Home: ${feed.activities} activities, ${feed.followed} follows, ${feed.votes} votes.`);
  await refreshSeedTokens(state);
  await state.optional('Home Continue and new activity', () =>
    seedHomeV2(state.api, state.sessions, state.created, state.createdRealms));
}
