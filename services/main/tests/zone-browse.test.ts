import { expect, test } from 'bun:test';
import { QueryRejected } from '../src/modules/query/compile.ts';
import { RecommendationUnavailable } from '../src/modules/recommendation/derived-generation.ts';
import { type BrowseCandidate, browseWindow, filterDocument, readZoneBrowse, textRelevance }
  from '../src/modules/zone-modules/browse.ts';
import { ZONE_BROWSE_COST } from '../src/modules/zone-modules/contract.ts';
import { WorkReadInvalid, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MOD = 'https://rezics.com/vocab/ModPackage', DOC = 'https://schema.org/DigitalDocument';
const BOOK = 'https://schema.org/Book';
const fabric = id(900), forge = id(901);
const candidates: BrowseCandidate[] = [
  { work: id(1), order: 0, title: 'Lumen Lanterns', types: [MOD], concepts: [fabric], status: null, words: null,
    updatedAt: '2026-09-20T00:00:00Z' },
  { work: id(2), order: 1, title: 'Chunk Weaver', types: [MOD], concepts: [forge], status: null, words: null,
    updatedAt: '2026-09-27T00:00:00Z' },
  { work: id(3), order: 2, title: 'Tidy Inventory', types: [MOD], concepts: [fabric], status: null, words: null,
    updatedAt: '2026-09-01T00:00:00Z' },
  { work: id(4), order: 3, title: 'Minecraft shaders: a gentle first setup', types: [DOC], concepts: [],
    status: 'completed', words: 1200, updatedAt: null },
  { work: id(5), order: 4, title: '末班地铁', types: [BOOK], concepts: [], status: 'ongoing', words: 450_000,
    updatedAt: '2026-09-25T00:00:00Z' },
];
const titles = (items: readonly BrowseCandidate[]) => items.map(item => item.title);

test('Conditions within a Facet match any value and Facets match all, with self-excluding counts', () => {
  const { found, facets } = browseWindow(candidates, { type: [MOD], concept: [fabric] }, null, 'newest');
  expect(titles(found)).toEqual(['Lumen Lanterns', 'Tidy Inventory']);
  expect(facets.concept).toEqual([{ value: fabric, count: 2 }, { value: forge, count: 1 }]);
  expect(titles(browseWindow(candidates, { conceptExclude: [fabric] }, null, 'newest').found))
    .toEqual(['Chunk Weaver', 'Minecraft shaders: a gentle first setup', '末班地铁']);
  expect(browseWindow(candidates, { status: ['hiatus'] }, null, 'newest').facets.status)
    .toContainEqual({ value: 'hiatus', count: 0 });
  const excluded = browseWindow(candidates, { statusExclude: ['completed'] }, null, 'newest');
  expect(titles(excluded.found)).not.toContain('Minecraft shaders: a gentle first setup');
  expect(excluded.facets.status).toContainEqual({ value: 'completed', count: 1 });
});

test('status and length bands filter serials, and length bands keep their own order', () => {
  const { found, facets } = browseWindow(candidates, { status: ['ongoing'] }, null, 'newest');
  expect(titles(found)).toEqual(['末班地铁']);
  expect(facets.status).toEqual([{ value: 'completed', count: 1 }, { value: 'ongoing', count: 1 }]);
  expect(browseWindow(candidates, {}, null, 'newest').facets.length)
    .toEqual([{ value: '0-99999', count: 1 }, { value: '300000-999999', count: 1 }]);
  expect(titles(browseWindow(candidates, { length: { min: '100000' } }, null, 'newest').found)).toEqual(['末班地铁']);
  expect(filterDocument({ length: { min: '100000', max: '299999' }, status: ['completed'] }))
    .toEqual({ all: [{ facet: 'status', any: ['completed'] },
      { facet: 'length', range: { min: '100000', max: '299999' } }] });
  expect(filterDocument({ concept: [forge], conceptExclude: [fabric] })).toEqual({ all: [
    { facet: 'concept', any: [forge] }, { facet: 'concept', none: [fabric] }] });
});

test('length ranges preserve inclusive bounds, zero and unknown counts independently of buckets', () => {
  const items = [{ ...candidates[0]!, words: 0 }, { ...candidates[1]!, words: null },
    { ...candidates[2]!, words: 123 }];
  expect(browseWindow(items, { length: { max: '0' } }, null, 'newest').found.map(item => item.work))
    .toEqual([id(1)]);
  const exact = browseWindow(items, { length: { min: '123', max: '123' } }, null, 'newest');
  expect(exact.found.map(item => item.work)).toEqual([id(3)]);
  expect(exact.facets.length).toEqual([{ value: '0-99999', count: 2 }]);
  expect(browseWindow(items, { length: { min: '124' } }, null, 'newest').found).toEqual([]);
});

test('text ranks whole titles, starts and words before inner matches; sorts break ties by adoption', () => {
  expect([textRelevance('lumen lanterns', 'Lumen Lanterns'), textRelevance('lum', 'Lumen Lanterns'),
    textRelevance('lant', 'Lumen Lanterns'), textRelevance('ntern', 'Lumen Lanterns'),
    textRelevance('地铁', '末班地铁'), textRelevance('x', 'Lumen')]).toEqual([4, 3, 2, 1, 1, 0]);
  expect(titles(browseWindow(candidates, {}, 'in', 'relevance').found))
    .toEqual(['Tidy Inventory', 'Minecraft shaders: a gentle first setup']);
  expect(titles(browseWindow(candidates, {}, null, 'updated').found)).toEqual(['Chunk Weaver', '末班地铁',
    'Lumen Lanterns', 'Tidy Inventory', 'Minecraft shaders: a gentle first setup']);
});

const binding = (value: string) => ({ value });
const realm = id(700);

/** A read session over a Realm with `count` adopted Works; records every graph query and batch. */
function session(count: number, options: { cursor?: string; limit?: number; tags?: 'current' | 'stale' | 'none' } = {}) {
  const calls: string[] = [];
  const works = Array.from({ length: count }, (_, n) => id(n + 1));
  const read = {
    options: { limit: options.limit, cursor: options.cursor, language: 'en' },
    position: { dataEpoch: 'epoch', sequence: '9' },
    checkDeadline: () => {},
    realm: async () => { calls.push('realm'); return { space: realm, realmRevision: id(701), visibility: 'public',
      reviewMode: 'open', revision: null }; },
    query: async (body: string, limit: number) => {
      calls.push(body.includes('?evidence') ? 'candidates' : body.includes('SELECT ?work ?type') ? 'types'
        : body.includes('RestoreCutover') ? 'epochs' : 'graph');
      if (body.includes('RestoreCutover')) return [];
      if (body.includes('?evidence')) {
        expect(limit).toBe(ZONE_BROWSE_COST.windowRows + 1);
        return works.slice(0, limit).map((work, n) => ({ work: binding(work), head: binding(id(800 + n)),
          main: binding(id(850 + n)), evidence: binding(id(600 + n)), revisionEpoch: binding('epoch'),
          sequence: binding(String(100 - n)), epochOrder: binding('0') }));
      }
      if (body.includes('SELECT ?work ?type')) return works.slice(0, 60).map(work => ({ work: binding(work), type: binding(MOD) }));
      if (body.includes('SELECT ?work ?head')) {
        return [...body.matchAll(/<(https:\/\/rezics\.com\/id\/[^>]+)>/g)].map(match => match[1]!)
          .filter(value => works.includes(value)).map(work => ({ work: binding(work) }));
      }
      return [];
    },
    summaries: async (resources: string[]) => {
      calls.push(`summaries:${resources.length}`);
      return resources.map(resource => ({ status: 'available', disclosure: 'public',
        type: resource === fabric ? 'concept' : 'work',
        name: { value: resource === fabric ? 'Fabric' : `Mod ${works.indexOf(resource) + 1}`, language: 'en',
          direction: 'ltr', basis: 'requested' },
        avatar: { kind: 'fallback', policy: 'test', key: resource, resourceType: 'work' } }));
    },
    deps: {
      packageModResolutions: { readBrowseListings: async () => {
        throw new Error('Zone browse must not read package listings');
      } },
      serialStats: { batch: async (ids: string[]) => { calls.push(`stats:${ids.length}`); return new Map(); } },
      discovery: options.tags === 'none' ? undefined : {
        active: async () => { calls.push('tags:active');
          return { generation_id: 'g', stale: options.tags === 'stale' }; },
        workTerms: async (_: unknown, ids: string[]) => { calls.push(`tags:${ids.length}`);
          return ids.filter((_, n) => n % 2 === 0).map(work => ({ work, term: id(950), concept: fabric })); },
      },
    },
  };
  return { read: read as unknown as WorkReadSession, calls };
}

test('a browse page reads one window and hydrates one page within its budget', async () => {
  const first = session(ZONE_BROWSE_COST.windowRows + 5, { limit: 20 });
  const page = await readZoneBrowse(first.read, realm, { concept: [fabric] });
  expect(page.items).toHaveLength(20);
  expect(page.matches).toEqual({ value: 30, kind: 'lower-bound' });
  expect(page.window).toEqual({ scanned: ZONE_BROWSE_COST.windowRows, complete: false });
  expect(page.query.filter).toEqual({ all: [{ facet: 'concept', any: [fabric] }] });
  expect(page.facets.concept).toEqual([{ value: fabric, count: 30,
    name: { value: 'Fabric', language: 'en', direction: 'ltr', basis: 'requested' } }]);
  const count = (prefix: string) => first.calls.filter(call => call.startsWith(prefix)).length;
  expect([count('candidates'), count('types'), count('listings'), count('stats'), count('tags:6'), count('realm')])
    .toEqual([1, 1, 0, 2, 1, 2]);
  // Window, Concept names and the page fence; never more than three summary batches of at most 60.
  expect(first.calls.filter(call => call.startsWith('summaries'))).toEqual(['summaries:60', 'summaries:1', 'summaries:20']);
  // The window's statistics, then the page's with its summaries; one serial head query and one metadata
  // read per page Work. Nothing but the window batches scales with the window.
  expect(count('graph')).toBeLessThanOrEqual(1 + 2 * 20 + 20);

  const next = session(ZONE_BROWSE_COST.windowRows + 5, { limit: 20, cursor: page.nextCursor! });
  const second = await readZoneBrowse(next.read, realm, { concept: [fabric] });
  expect(second.items).toHaveLength(10);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...page.items, ...second.items].map(item => item.id)).size).toBe(30);
  // A cursor is bound to its Query: another filter cannot reuse it.
  await expect(readZoneBrowse(session(10, { cursor: page.nextCursor! }).read, realm, { concept: [forge] }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
});

test('Tags built before the latest change withhold Tag-filtered Works; missing Tags refuse Tag Conditions', async () => {
  const stale = await readZoneBrowse(session(6, { tags: 'stale' }).read, realm, { concept: [fabric] });
  expect(stale.tags).toBe('stale');
  expect(stale.items).toEqual([]);
  expect((await readZoneBrowse(session(6, { tags: 'stale' }).read, realm, {})).items).toHaveLength(6);
  const current = await readZoneBrowse(session(6).read, realm, { concept: [fabric] });
  expect(current.items.map(item => item.id)).toEqual([id(1), id(3), id(5)]);
  const none = session(6, { tags: 'none' });
  await expect(readZoneBrowse(none.read, realm, { concept: [fabric] })).rejects.toBeInstanceOf(WorkReadUnavailable);
  await expect(readZoneBrowse(none.read, realm, { excludeConcept: [fabric] }))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  expect((await readZoneBrowse(session(6, { tags: 'none' }).read, realm, {})).tags).toBe('unavailable');
  const failing = session(6);
  (failing.read.deps as unknown as { discovery: { active: () => Promise<never> } }).discovery.active = async () => {
    throw new RecommendationUnavailable('no generation');
  };
  expect((await readZoneBrowse(failing.read, realm, {})).tags).toBe('unavailable');
});

test('relevance needs text, and an empty length range is refused before any graph read', async () => {
  const read = session(3);
  await expect(readZoneBrowse(read.read, realm, { sort: 'relevance' })).rejects.toBeInstanceOf(QueryRejected);
  await expect(readZoneBrowse(read.read, realm, { length: '500-100' })).rejects.toBeInstanceOf(QueryRejected);
  expect(read.calls.filter(call => call !== 'realm')).toEqual([]);
  expect((await readZoneBrowse(session(3).read, realm, { q: 'Mod 2' })).items.map(item => item.title.value))
    .toEqual(['Mod 2']);
});

test('unknown and removed Conditions refuse before any owner read', async () => {
  for (const query of [{ type: ['https://example.com/Unknown'] }, { loader: ['Fabric'] }]) {
    const read = session(2);
    // The HTTP schema closes query parameters; the direct adapter also refuses unknown fields.
    await expect(readZoneBrowse(read.read, realm, query as never)).rejects.toBeInstanceOf(QueryRejected);
    expect(read.calls).toEqual([]);
  }
});
