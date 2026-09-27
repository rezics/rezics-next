import type { SeedApi } from './api.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import type { SeedState } from './state.ts';

interface Session { id: string; token: string; actingSubject: string }
interface Work { work: string; mainVersion: string }

/** A standing five-star question gives readers a shared basis for Discover and Work pages. */
export async function seedGlobalRatings(api: SeedApi, owner: Session, readers: Session[],
  created: ReadonlyMap<string, Work>, operator: Parameters<typeof grantHomeSeedAuthority>[0]) {
  await grantHomeSeedAuthority(operator, [{ action: 'rating.context.create', scope: GLOBAL_CONTEXT_SCOPE }]);
  const { context } = await api.post<{ context: string }>('/v1/global-rating-contexts', {
    profile: 'global-rating-standing-context-v1', question: 'How would you rate this work?',
    actingSubject: owner.actingSubject,
  }, owner.token, seedKey('global-rating-context', 'works'));
  let count = 0;
  for (const [workIndex, id] of ['pride', 'alice', 'serial', 'journey-west', 'red-chamber', 'bun'].entries()) {
    const work = created.get(id);
    if (!work) throw new Error(`Rating target ${id} is unavailable`);
    for (const [readerIndex, reader] of readers.entries()) {
      await api.post('/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1', context, work: work.work,
        mainVersion: work.mainVersion, value: Math.max(1, 5 - ((workIndex + readerIndex) % 4)),
        expectedRevisionHead: null, actingSubject: reader.actingSubject,
      }, reader.token, seedKey('global-rating', `${reader.id}:${id}`));
      count++;
    }
  }
  return { context, count };
}

export async function seedRatings(state: SeedState) {
  if (!state.operatorInput) return;
  const ratings = await state.optional('Global ratings', () => seedGlobalRatings(state.api,
    state.sessions[0]!, state.sessions, state.created, state.operatorInput!));
  if (ratings) console.log(`Ratings: ${ratings.count} observations for ${ratings.context}.`);
}
