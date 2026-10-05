import { seedFeed } from './feed.ts';
import { seedHomeV2 } from './home-v2.ts';
import { demoSessions } from './library-people.ts';
import { works } from './plan.ts';
import { refreshSeedTokens, type SeedState } from './state.ts';

export async function seedHomeFeed(state: SeedState) {
  // The demo people follow and vote; helper accounts such as the scoped-subject raters do not. Access tokens last five
  // minutes and the votes take longer, so each phase starts on fresh ones.
  const sessions = demoSessions(state.sessions);
  const feed = await state.optional('Home follows and votes', () =>
    seedFeed(state.api, sessions, state.createdRealms,
      new Set(works.flatMap(work => state.created.get(work.id)?.work ?? [])), () => refreshSeedTokens(state)));
  if (feed) console.log(`Home: ${feed.activities} activities, ${feed.followed} follows, ${feed.votes} votes.`);
  await refreshSeedTokens(state);
  await state.optional('Home Continue and new activity', () =>
    seedHomeV2(state.api, sessions, state.created, state.createdRealms));
}
