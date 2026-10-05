import { demoSessions, personName } from './library-people.ts';
import { seedKey } from './plan.ts';
import { stableId, type SeedState } from './state.ts';

/** Each person's public reading-shelf Collection. What they read and when is the reading-lives step's. */
export async function seedLibrary(state: SeedState) {
  const { api } = state;
  for (const person of demoSessions(state.sessions)) await state.optional('Personal collection', () => api.post('/v1/collections', {
    collection: `https://rezics.com/id/${stableId(`collection:${person.id}`)}`,
    name: `${personName(person.id)} · Reading shelf`,
    disclosure: 'public', actingSubject: person.actingSubject },
  person.token, seedKey('collection', person.id)));
}
