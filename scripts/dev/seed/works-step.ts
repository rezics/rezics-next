import { SeedApiError } from './api.ts';
import { firstSeedTypes, seedKey, semanticTypes, works } from './plan.ts';
import { demoClassics } from '../../../tests/fixtures/sources/open-library.ts';
import type { SeedState, WorkReceipt } from './state.ts';

export async function seedWorks(state: SeedState) {
  const { api, created } = state;
  const owner = state.sessions[0]!;
  const imported = new Set<string>(demoClassics.map(classic => classic.id));
  for (const work of works) {
    if (imported.has(work.id)) continue;
    const session = work.author && work.author !== 'moonlight'
      ? state.sessions.find(candidate => candidate.id === work.author) : owner;
    if (!session) throw new Error(`Work author ${work.author} has no seed session`);
    const author = work.author === 'moonlight' ? state.penAgents.get('moonlight')
      : work.author ? session.actingSubject : undefined;
    if (work.author && !author) throw new Error(`Work author ${work.author} is unavailable`);
    const body = {
      profile: 'metadata-only-v1', title: work.title, semanticTypes: semanticTypes(work.type),
      language: work.language, actingSubject: author ?? owner.actingSubject,
      ...(author ? { authoring: 'own-work' } : {}) };
    const receipt: WorkReceipt = await api.post<WorkReceipt>('/v1/works', body, session.token, seedKey('work', work.id))
      .catch((error: unknown) => {
        // Stacks seeded before Works named their language and kind recorded these intents without them. Main
        // now requires the language and digests a missing one as English, so the replay states that.
        // A clean `task dev:reset` gives every Work both.
        if (!(error instanceof SeedApiError) || error.status !== 409) throw error;
        return api.post<WorkReceipt>('/v1/works', { ...body, language: 'en', semanticTypes: firstSeedTypes(work.type) },
          session.token, seedKey('work', work.id));
      });
    created.set(work.id, receipt);
    if (work.tagline) await state.optional('Work serial summary', () => api.put(
      `/v1/works/${receipt.work.slice(-36)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null,
        state: { kind: 'header', originalTitle: null, completionStatus: work.completionStatus ?? null,
          localized: [{ language: work.language, title: null, description: null,
            mainVersionLabel: null, tagline: work.tagline }] },
        actingSubject: author ?? owner.actingSubject }, session.token, seedKey('serial-metadata', work.id)));
    console.log(`Work ${created.size}/${works.length}: ${work.title}${receipt.replayed ? ' (replayed)' : ''}`);
  }
}
