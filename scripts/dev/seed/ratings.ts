import type { SeedApi } from './api.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { people, seedKey, works } from './plan.ts';
import { readingLives } from './reading-lives-plan.ts';
import { reviews } from './reviews-plan.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../../../services/main/src/modules/rating/global.ts';
import type { SeedState } from './state.ts';

interface Session { id: string; accountId: string; token: string; actingSubject: string }
interface Work { work: string; mainVersion: string }
interface Current { revision: string; value: number | null }

/** The first demo's ratings: every base person on six Works, spread so Discover shows a range. */
const firstRated = ['pride', 'alice', 'serial', 'journey-west', 'red-chamber', 'bun'] as const;

/**
 * Each person's planned five-star ratings by Work: the first spread, then what
 * their reading life and reviews say. `null` means no rating, so a rating the
 * first spread gave is withdrawn. Authors do not rate their own Works.
 */
export function ratingPlan(): Map<string, Map<string, number | null>> {
  const plan = new Map<string, Map<string, number | null>>();
  const set = (person: string, work: string, value: number | null) => {
    const own = plan.get(person) ?? new Map<string, number | null>();
    own.set(work, works.find(item => item.id === work)?.author === person ? null : value);
    plan.set(person, own);
  };
  for (const [workIndex, work] of firstRated.entries()) {
    for (const [readerIndex, person] of people.entries()) {
      set(person.id, work, Math.max(1, 5 - ((workIndex + readerIndex) % 4)));
    }
  }
  for (const life of readingLives) for (const [work, value] of Object.entries(life.ratings)) set(life.person, work, value);
  for (const review of reviews) set(review.reader, review.work, review.rating);
  return plan;
}

/** A person's own global rating on a Work, as their reader state shows it (the web's rating control reads it too). */
async function currentRating(api: SeedApi, reader: Session, work: string, context: string): Promise<Current | null> {
  const state = await api.get<{ rating: { global: { context: string; value: number | null;
    availability: 'available' | 'withdrawn'; revision: string } | null } }>(`/v1/works/${work.slice(-36)}/reader-state?actingSubject=${
    encodeURIComponent(reader.actingSubject)}`, reader.token);
  const own = state.rating.global;
  if (own && own.context !== context) throw new Error(`${reader.id} rated under another global question`);
  return own ? { revision: own.revision, value: own.availability === 'available' ? own.value : null } : null;
}

/**
 * A standing five-star question gives readers a shared basis for Discover and
 * Work pages. Each planned rating is read first and set only when it differs,
 * as the person would change it, so a replay writes nothing.
 */
export async function seedGlobalRatings(api: SeedApi, owner: Session, readers: readonly Session[],
  targets: ReadonlyMap<string, Work>, operator: Parameters<typeof grantHomeSeedAuthority>[0]) {
  await grantHomeSeedAuthority(operator, [{ action: 'rating.context.create', scope: GLOBAL_CONTEXT_SCOPE }]);
  const { context } = await api.post<{ context: string }>('/v1/global-rating-contexts', {
    profile: 'global-rating-standing-context-v1', question: 'How would you rate this work?',
    actingSubject: owner.actingSubject,
  }, owner.token, seedKey('global-rating-context', 'works'));
  const plan = ratingPlan();
  let count = 0, changed = 0;
  for (const reader of readers) {
    const planned = plan.get(reader.id);
    if (!planned) continue;
    await grantHomeSeedAuthority({ ...operator, ownerAccountSubject: reader.accountId,
      actingSubject: reader.actingSubject },
    [{ action: 'rating.observation.set', scope: `rating:observe:${context}` }]);
    for (const [id, value] of planned) {
      const work = targets.get(id);
      if (!work) throw new Error(`Rating target ${id} is unavailable`);
      const head = await currentRating(api, reader, work.work, context);
      if (value !== null) count++;
      if ((head?.value ?? null) === value) continue;
      await api.post('/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1', context, work: work.work,
        mainVersion: work.mainVersion, value, expectedRevisionHead: head?.revision ?? null,
        actingSubject: reader.actingSubject,
      }, reader.token, seedKey('global-rating', `${reader.id}:${id}${head ? `:${head.revision.slice(-12)}` : ''}`));
      changed++;
    }
  }
  return { context, count, changed };
}

/** Ratings follow the reading lives, so they run once every rated Work is public. */
export async function seedRatings(state: SeedState) {
  if (!state.operatorInput) return;
  const targets = new Map<string, Work>(state.created);
  for (const [id, shared] of state.publicWorks) targets.set(id, shared.work);
  const ratings = await state.optional('Global ratings', () => seedGlobalRatings(state.api,
    state.sessions[0]!, state.sessions, targets, state.operatorInput!));
  if (ratings) {
    console.log(`Ratings: ${ratings.count} planned, ${ratings.changed} set for ${ratings.context}.`);
    state.ratingContext = ratings.context;
  }
}
