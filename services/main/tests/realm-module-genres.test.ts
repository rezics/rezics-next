import { expect, test } from 'bun:test';
import { readZoneGenres } from '../src/modules/zone-modules/genres.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { WorkReadMissing, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (value: string) => `https://rezics.com/id/${value}`;
const realm = id('00000000-0000-4000-8000-000000000001');
const context = id('00000000-0000-4000-8000-000000000002');
const concept = id('00000000-0000-4000-8000-000000000003');
const zoneRead = async () => ({ presentation: { ...DEFAULT_ZONE_PRESENTATION,
  modules: [{ id: 'genres', type: 'chip-nav', title: 'Genres',
    source: { kind: 'context', context } }] } }) as never;
const contextRead = async () => ({ state: 'active', disclosure: 'public', revision: context,
  entries: [{ target: concept, state: 'defined' }, { target: realm, state: 'disabled' }] }) as never;

test('genre chips select public concepts and requested-language names from the configured Context', async () => {
  const session = { options: { language: 'fr' }, position: { dataEpoch: 'epoch', sequence: '9' },
    deps: { environment: {} }, summaries: async () => [{ status: 'available',
      disclosure: 'public', type: 'concept', name: { value: 'Fantasy', language: 'fr',
        direction: 'ltr', basis: 'requested' } }] } as unknown as WorkReadSession;
  expect(await readZoneGenres(session, realm, context, zoneRead, contextRead)).toMatchObject({
    profile: 'zone-genres-v1', items: [{ id: concept,
      name: { value: 'Fantasy', language: 'fr', basis: 'requested' } }] });
  await expect(readZoneGenres(session, realm, realm, zoneRead, contextRead))
    .rejects.toBeInstanceOf(WorkReadMissing);
  await expect(readZoneGenres(session, realm, context, zoneRead,
    async () => ({ state: 'active', disclosure: 'private', revision: context,
      entries: [{ target: concept, state: 'defined' }] }) as never))
    .rejects.toBeInstanceOf(WorkReadMissing);
});
