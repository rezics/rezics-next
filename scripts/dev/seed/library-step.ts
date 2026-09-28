import { communityPeople } from './community-plan.ts';
import { people, seedKey } from './plan.ts';
import { stableId, type SeedState } from './state.ts';

/** Each person's public reading-shelf Collection. What they read and when is the reading-lives step's. */
export async function seedLibrary(state: SeedState) {
  const { api, sessions } = state;
  for (const person of sessions) await state.optional('Personal collection', () => api.post('/v1/collections', {
    collection: `https://rezics.com/id/${stableId(`collection:${person.id}`)}`,
    name: `${[...people, ...communityPeople].find(item => item.id === person.id)!.name} · Reading shelf`,
    disclosure: 'public', actingSubject: person.actingSubject },
  person.token, seedKey('collection', person.id)));
}
