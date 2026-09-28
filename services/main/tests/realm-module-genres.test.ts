import { expect, test } from 'bun:test';
import { readZoneGenres, ZONE_GENRES_COST } from '../src/modules/zone-modules/genres.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const realm = id('00000000-0000-4000-8000-000000000001');
const context = id('00000000-0000-4000-8000-000000000002');
const concept = id('00000000-0000-4000-8000-000000000003');
const sense = id('00000000-0000-4000-8000-000000000004');
const revision = id('00000000-0000-4000-8000-000000000005');
const zoneRead = async () => ({ presentation: { ...DEFAULT_ZONE_PRESENTATION,
  modules: [{ id: 'genres', type: 'chip-nav', title: 'Genres',
    source: { kind: 'context', context } }] } }) as never;
const contextRead = async () => ({ state: 'active', disclosure: 'public', revision: context,
  entries: [{ target: concept, state: 'defined', definition: revision, relation: null },
    { target: realm, state: 'disabled' }] }) as never;

test('genre chips return Discover Sense IDs and public Concept names from the exact configured Context', async () => {
  const queries: string[] = [];
  const session = { options: { language: 'fr' }, position: { dataEpoch: 'epoch', sequence: '9' },
    query: async (query: string) => { queries.push(query); return [{ sense: { value: sense }, concept: { value: concept } }]; },
    deps: { environment: {} }, summaries: async () => [{ status: 'available',
      disclosure: 'public', type: 'concept', name: { value: 'Fantasy', language: 'fr',
        direction: 'ltr', basis: 'requested' } }] } as unknown as WorkReadSession;
  expect(await readZoneGenres(session, realm, context, zoneRead, contextRead)).toMatchObject({
    profile: 'zone-genres-v1', context, items: [{ id: sense, concept,
      name: { value: 'Fantasy', language: 'fr', basis: 'requested' } }] });
  expect(queries).toHaveLength(ZONE_GENRES_COST.senseQueries);
  expect(queries[0]).toContain(`(<${concept}> <${revision}>)`);
  expect(queries[0]).toContain('rv:head ?revision');
  expect(queries[0]).not.toContain(`(<${realm}>`);
  await expect(readZoneGenres(session, realm, realm, zoneRead, contextRead))
    .rejects.toBeInstanceOf(WorkReadMissing);
  await expect(readZoneGenres(session, realm, context, zoneRead,
    async () => ({ state: 'active', disclosure: 'private', revision: context,
      entries: [{ target: concept, state: 'defined' }] }) as never))
    .rejects.toBeInstanceOf(WorkReadMissing);
});
