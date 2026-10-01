import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { readZonePopulation, realmPopulation, collectionPopulation, editorialPopulationKey,
  ZONE_POPULATION_COST } from '../src/modules/zone/route-population.ts';
import { zoneCards } from '../src/modules/zone-modules/cards.ts';
import { zoneEditorLists, zoneReplyPage } from '../src/modules/zone-modules/contract.ts';
import { readZoneReplies } from '../src/modules/zone-modules/replies.ts';
import { WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const realm = id(1), member = id(2), outside = id(3), collection = id(4), unmounted = id(5);
const bind = (value: string) => ({ type: 'uri' as const, value });
const name = { value: 'Work', language: 'en', direction: 'ltr' as const, basis: 'fallback' as const };

test('G893: one batch flags a full page including duplicate cards and unread membership errors', async () => {
  const calls: string[] = [];
  const session = { query: async (query: string, rows: number) => {
    calls.push(query);
    expect(rows).toBe(2);
    expect(query).toContain(realmPopulation(realm, '?work'));
    return [{ work: bind(member) }];
  } } as unknown as WorkReadSession;
  expect(await zoneCards(session, { realm }, [{ id: member }, { id: outside }, { id: member }]))
    .toEqual([{ id: member, inZone: true }, { id: outside, inZone: false }, { id: member, inZone: true }]);
  expect(calls).toHaveLength(1);
  expect(await zoneCards(session, { realm }, [])).toEqual([]);
  expect(calls).toHaveLength(1);
  for (const rows of [[{}], [{ work: bind(id(99)) }], [{ work: bind(member) }, { work: bind(member) }]]) {
    await expect(readZonePopulation(async () => rows, { realm }, [member]))
      .rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  await expect(readZonePopulation(async () => [], { realm },
    Array.from({ length: ZONE_POPULATION_COST.resources + 1 }, (_, n) => id(n))))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G893: editorial membership stays specific to each Collection for repeated Works', async () => {
  let calls = 0;
  const population = { realm, editorial: { zone: id(6), members: [
    { work: member, collection }, { work: member, collection: unmounted },
    { work: outside, collection: unmounted }] } };
  const members = await readZonePopulation(async (query, rows) => {
    calls++;
    expect(rows).toBe(3);
    expect(query).toContain(collectionPopulation('?structure', '?head', '?generation', '?work'));
    expect(query).toContain('rv:disclosure rv:Public');
    expect(query).toContain('FILTER NOT EXISTS { ?mount rv:removedBy ?mountRemoval }');
    return [{ work: bind(member), collection: bind(collection) }];
  }, population, [member, outside]);
  expect(calls).toBe(1);
  expect(members.has(editorialPopulationKey(member, collection))).toBe(true);
  expect(members.has(editorialPopulationKey(member, unmounted))).toBe(false);
  await expect(readZonePopulation(async () => [{ work: bind(member) }], population, [member]))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G893: discussions and quotes retain public replies after adoption removal with inZone false', async () => {
  for (const kind of ['discussions', 'reader-quotes'] as const) {
    const queries: string[] = [];
    const candidates = [member, outside].map((work, n) => ({ id: bind(id(10 + n)), reply: bind(id(20 + n)),
      work: bind(work), author: bind(id(30)), authorName: bind('Reader'),
      revision: bind(`urn:rezics:content:revision:${id(40 + n).slice(-36)}`),
      review: bind(`urn:rezics:realm-review:${id(50 + n).slice(-36)}`),
      revisionEpoch: bind('epoch'), sequence: bind(String(7 - n)), epochOrder: bind('0') }));
    const session = { options: { limit: 20 }, position: { dataEpoch: 'epoch', sequence: '8' },
      realm: async () => ({ visibility: 'public', realmRevision: id(60), space: id(61), reviewMode: 'open' }),
      query: async (query: string): Promise<ReadRow[]> => {
        queries.push(query);
        if (query.includes('rv:RestoreCutover')) return [];
        if (query.includes('# Zone population batch')) return [{ work: bind(member) }];
        return candidates;
      }, summaries: async () => [member, outside].map(() => ({ status: 'available', disclosure: 'public', name })),
      deps: { realmReplies: { visible: async (_realm: string, reply: string) => {
        const n = reply === id(20) ? 0 : 1;
        return { placement: id(10 + n), revisionId: id(40 + n).slice(-36), reviewDecisionId: id(50 + n).slice(-36) };
      } }, content: { readExactBatch: async () => [0, 1].map(n => ({ status: 'available',
        reference: { resourceId: id(20 + n) }, body: { body: 'A public discussion about a formerly adopted Work.' } })) } },
    } as unknown as WorkReadSession;
    const page = await readZoneReplies(session, realm, kind);
    expect(page.items.map(item => item.work)).toEqual([
      { id: member, title: name, inZone: true }, { id: outside, title: name, inZone: false }]);
    expect(queries.filter(query => query.includes('# Zone population batch'))).toHaveLength(1);
    expect(Value.Check(zoneReplyPage, page)).toBe(true);
  }
});

test('G893: public editorial contract requires a boolean population flag', () => {
  const page = { profile: 'zone-editor-lists-v1', realm, sourcePosition: { dataEpoch: 'epoch', sequence: '1' },
    lists: [{ collection, name, state: 'complete', items: [{ id: member, title: name,
      cover: { kind: 'fallback', policy: 'zone', key: member, resourceType: 'work' }, inZone: false }] }] };
  expect(Value.Check(zoneEditorLists, page)).toBe(true);
  const { inZone: _flag, ...withoutFlag } = page.lists[0]!.items[0]!;
  expect(Value.Check(zoneEditorLists, { ...page, lists: [{ ...page.lists[0], items: [withoutFlag] }] })).toBe(false);
});
