import { SeedApiError } from './api.ts';
import { seedKey, semanticTypes, works } from './plan.ts';
import type { SeedState, WorkReceipt } from './state.ts';

export async function seedWorks(state: SeedState) {
  const { api, created } = state;
  const owner = state.sessions[0]!;
  for (const work of works) {
    const directAuthor = work.author === 'mei' || work.author === 'moonlight';
    const author = work.author === 'moonlight' ? state.penAgents.get('moonlight')
      : directAuthor ? owner.actingSubject : undefined;
    if (directAuthor && !author) throw new Error(`Work author ${work.author} is unavailable`);
    const body = {
      profile: 'metadata-only-v1', title: work.title, semanticTypes: semanticTypes(work.type),
      actingSubject: author ?? owner.actingSubject };
    let receipt: WorkReceipt;
    try {
      receipt = await api.post<WorkReceipt>('/v1/works', {
        ...body, ...(author ? { authoring: 'own-work' } : {}) },
      owner.token, seedKey('work', work.id));
    } catch (error) {
      // Older shared stacks have the same key for a metadata-only Work. Keep
      // that identity and let the profile phase add its missing native credit.
      if (!(error instanceof SeedApiError) || error.status !== 409 || !author) throw error;
      receipt = await api.post<WorkReceipt>('/v1/works', {
        ...body, actingSubject: owner.actingSubject }, owner.token, seedKey('work', work.id));
    }
    created.set(work.id, receipt);
    if (work.tagline) await state.optional('Work serial summary', () => api.put(
      `/v1/works/${receipt.work.slice(-36)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null,
        state: { kind: 'header', originalTitle: null, completionStatus: work.completionStatus ?? null,
          localized: [{ language: work.language, title: null, description: null,
            mainVersionLabel: null, tagline: work.tagline }] },
        actingSubject: author ?? owner.actingSubject }, owner.token, seedKey('serial-metadata', work.id)));
    console.log(`Work ${created.size}/${works.length}: ${work.title}${receipt.replayed ? ' (replayed)' : ''}`);
  }
}
