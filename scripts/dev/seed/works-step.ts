import { seedKey, semanticTypes, works } from './plan.ts';
import type { SeedState, WorkReceipt } from './state.ts';

export async function seedWorks(state: SeedState) {
  const { api, created } = state;
  const owner = state.sessions[0]!;
  for (const work of works) {
    const receipt = await api.post<WorkReceipt>('/v1/works', {
      profile: 'metadata-only-v1', title: work.title, semanticTypes: semanticTypes(work.type),
      actingSubject: owner.actingSubject }, owner.token, seedKey('work', work.id));
    created.set(work.id, receipt);
    if (work.tagline) await state.optional('Work serial summary', () => api.put(
      `/v1/works/${receipt.work.slice(-36)}/metadata`, {
        profile: 'work-metadata-details-v1', expectedHead: null,
        state: { kind: 'header', originalTitle: null, completionStatus: work.completionStatus ?? null,
          localized: [{ language: work.language, title: null, description: null,
            mainVersionLabel: null, tagline: work.tagline }] },
        actingSubject: owner.actingSubject }, owner.token, seedKey('serial-metadata', work.id)));
    console.log(`Work ${created.size}/${works.length}: ${work.title}${receipt.replayed ? ' (replayed)' : ''}`);
  }
}
