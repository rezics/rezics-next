import { SeedApiError } from './api.ts';
import { person, publicWork } from './community-step.ts';
import { seedKey } from './plan.ts';
import { reviews } from './reviews-plan.ts';
import { refreshSeedTokens, type SeedState } from './state.ts';

// Reviews on the global rating question, written after each reviewer's rating
// (the ratings step) and shelf dates (the reading-lives step), which Main copies
// onto the review. A review is read first and written only when it differs;
// helpful votes replay by their keys.

const short = (id: string) => id.slice(-36);

interface Own { id: string; author: string; rating: number; language: string; text: string | null;
  spoiler: boolean; revision: string }

export async function seedReviews(state: SeedState) {
  const context = state.ratingContext;
  if (!context) {
    state.findings.add('Reviews: the global rating question is unavailable');
    return;
  }
  const written = new Map<string, string>();
  let changed = 0;
  for (const review of reviews) {
    await refreshSeedTokens(state);
    await state.optional(`Review ${review.reader} on ${review.work}`, async () => {
      const reader = person(state, review.reader);
      const work = publicWork(state, review.work)?.work.work ?? state.created.get(review.work)?.work;
      if (!work) throw new Error(`Review target ${review.work} is unavailable`);
      const page = await state.api.get<{ items: Own[] }>(`/v1/works/${short(work)}/reviews?context=${
        encodeURIComponent(context)}&showSpoilers=true&limit=1&actingSubject=${encodeURIComponent(reader.actingSubject)}`,
      reader.token);
      const own = page.items.find(item => item.author === reader.actingSubject);
      let id = own?.id;
      if (!own || own.text !== review.text || own.spoiler !== (review.spoiler ?? false)
        || own.language !== review.language || own.rating !== review.rating) {
        id = (await state.api.post<{ review: string }>('/v1/reviews', { profile: 'reader-review-command-v1',
          actingSubject: reader.actingSubject, context, work, expectedRevision: own?.revision ?? null,
          language: review.language, text: review.text, spoiler: review.spoiler ?? false }, reader.token,
        seedKey('review', `${review.reader}:${review.work}${own ? `:${own.revision.slice(-12)}` : ''}`))).review;
        changed++;
      }
      written.set(`${review.reader}:${review.work}`, id!);
    });
  }
  let helpful = 0;
  for (const review of reviews) {
    const id = written.get(`${review.reader}:${review.work}`);
    if (!id) continue;
    for (const voter of (review.helpful ?? []).map(key => person(state, key))) {
      await refreshSeedTokens(state);
      const done = await state.optional('Helpful review vote', () => state.api.put(`/v1/reviews/${id}/helpful`, {
        profile: 'reader-review-helpful-v1', actingSubject: voter.actingSubject, helpful: true, expectedRevision: null },
      voter.token, seedKey('review-helpful', `${voter.id}:${id}`)).catch((error: unknown) => {
        // A vote the voter already holds under another key stands.
        if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
      }));
      if (done !== null) helpful++;
    }
  }
  state.reviewCount = written.size;
  console.log(`Reviews: ${written.size}/${reviews.length} (${changed} written), ${helpful} helpful votes.`);
}
