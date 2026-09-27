import { people, seedKey } from './plan.ts';
import { stableId, type SeedState } from './state.ts';

export async function seedLibrary(state: SeedState) {
  const { api, created, sessions } = state;
  for (const person of sessions) await state.optional('Personal collection', () => api.post('/v1/collections', {
    collection: `https://rezics.com/id/${stableId(`collection:${person.id}`)}`,
    name: `${people.find(item => item.id === person.id)!.name} · Reading shelf`,
    disclosure: 'public', actingSubject: person.actingSubject },
  person.token, seedKey('collection', person.id)));

  for (const [index, person] of sessions.entries()) {
    const shelf = [
      { id: 'pride', status: 'read', startedOn: '2026-01-02', finishedOn: '2026-01-12' },
      { id: 'alice', status: 'reading', startedOn: null, finishedOn: null },
      { id: 'serial', status: 'want-to-read', startedOn: null, finishedOn: null },
    ] as const;
    const choice = shelf[index % shelf.length]!;
    const target = created.get(choice.id);
    if (!target) continue;
    await state.optional('Reading status', () => api.put(
      `/v1/works/${target.work.slice(-36)}/reader-status`,
      { actingSubject: person.actingSubject, expectedVersion: 0, status: choice.status,
        startedOn: choice.startedOn, finishedOn: choice.finishedOn },
      person.token, seedKey('reading-status', `${person.id}:${choice.id}`)));
  }
}
