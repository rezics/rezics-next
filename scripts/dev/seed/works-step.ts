import { seedKey, semanticTypes, works } from './plan.ts';
import type { SeedState, WorkReceipt } from './state.ts';

export async function seedWorks(state: SeedState) {
  const { api, created } = state;
  const owner = state.sessions[0]!;
  for (const work of works) {
    const session = work.author && work.author !== 'moonlight'
      ? state.sessions.find(candidate => candidate.id === work.author) : owner;
    if (!session) throw new Error(`Work author ${work.author} has no seed session`);
    const author = work.author === 'moonlight' ? state.penAgents.get('moonlight')
      : work.author ? session.actingSubject : undefined;
    if (work.author && !author) throw new Error(`Work author ${work.author} is unavailable`);
    const body = {
      profile: 'metadata-only-v1', title: work.title, semanticTypes: semanticTypes(work.type),
      actingSubject: author ?? owner.actingSubject };
    const receipt: WorkReceipt = await api.post<WorkReceipt>('/v1/works', {
      ...body, ...(author ? { authoring: 'own-work' } : {}) },
    session.token, seedKey('work', work.id));
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
