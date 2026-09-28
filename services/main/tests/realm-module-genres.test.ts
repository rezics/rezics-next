import { expect, test } from 'bun:test';
import { readZoneGenres, ZONE_GENRES_COST } from '../src/modules/zone-modules/genres.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

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

function counts(stale = [false, false], rows = [{ term: sense, concept, work_count: '2' }]) {
  let checks = 0;
  return {
    active: async (basis: unknown, _position: unknown, pinned?: string) => {
      expect(basis).toEqual({ scope: 'realm', realm, context: null, owner: null });
      expect(pinned).toBe(checks ? '00000000-0000-4000-8000-000000000006' : undefined);
      return { generation_id: '00000000-0000-4000-8000-000000000006',
        source_epoch: 'epoch', source_sequence: '9', stale: stale[checks++] };
    },
    selectedTerms: async (_generation: unknown, terms: string[]) => {
      expect(terms).toEqual([sense]);
      return rows;
    },
  };
}

function session(discovery = counts()) {
  return { options: {}, position: { dataEpoch: 'epoch', sequence: '9' },
    deps: { environment: {}, discovery },
    query: async () => [{ sense: { value: sense }, concept: { value: concept } }],
    summaries: async () => [{ status: 'available', disclosure: 'public', type: 'concept',
      name: { value: 'Fantasy', language: 'en', direction: 'ltr', basis: 'default' } }],
  } as unknown as WorkReadSession;
}

test('genre chips return Discover Sense IDs and public Concept names from the exact configured Context', async () => {
  const queries: string[] = [];
  const session = { options: { language: 'fr' }, position: { dataEpoch: 'epoch', sequence: '9' },
    query: async (query: string) => { queries.push(query); return [{ sense: { value: sense }, concept: { value: concept } }]; },
    deps: { environment: {}, discovery: counts() }, summaries: async () => [{ status: 'available',
      disclosure: 'public', type: 'concept', name: { value: 'Fantasy', language: 'fr',
        direction: 'ltr', basis: 'requested' } }] } as unknown as WorkReadSession;
  expect(await readZoneGenres(session, realm, context, zoneRead, contextRead)).toMatchObject({
    profile: 'zone-genres-v1', context, stale: false, projectionPosition: session.position,
    items: [{ id: sense, concept, workCount: 2,
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

test('genre counts distinguish fresh zero from stale and concurrently replaced projections', async () => {
  const empty = await readZoneGenres(session(counts([false, false], [])), realm, context, zoneRead, contextRead);
  expect(empty.items[0]?.workCount).toBe(0);
  for (const state of [[true, true], [false, true]]) {
    const page = await readZoneGenres(session(counts(state)), realm, context, zoneRead, contextRead);
    expect(page.stale).toBe(true);
    expect(page.items[0]).toMatchObject({ id: sense, workCount: null });
  }
});

test('genre counts fail closed for invalid projection counts or mismatched Concepts', async () => {
  for (const row of [{ term: sense, concept, work_count: '9007199254740992' },
    { term: sense, concept, work_count: '0' }, { term: sense, concept: realm, work_count: '2' }]) {
    await expect(readZoneGenres(session(counts([false, false], [row])), realm, context, zoneRead, contextRead))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});
