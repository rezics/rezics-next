import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createFakeSource } from './support/fake-source.ts';
import { activateManifests, manifestQuery, manifestSubjects } from './support/manifests.ts';

const searchUrl = process.env.OPENSEARCH_URL;
if (!searchUrl) throw new Error('OPENSEARCH_URL must name the check node');
const base = createOpenSearch(searchUrl);
const engine = { requests: 0, bytes: 0 };
const client: OpenSearch = {
  request: ((...args: Parameters<OpenSearch['request']>) => {
    engine.requests++;
    engine.bytes += args[1].length + JSON.stringify(args[2] ?? null).length;
    return base.request(...args);
  }) as OpenSearch['request'],
  bulk: ((...args: Parameters<OpenSearch['bulk']>) => {
    engine.requests++;
    return base.bulk(...args);
  }) as OpenSearch['bulk'],
};
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const index = subjectIndexName(prefix, 1);
const fake = createFakeSource();
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
  await createSubjectIndex(base, prefix, 1);
  await base.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  const { generations } = await subjectGenerations(base, prefix);
  for (const generation of generations) await base.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
    await base.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await db?.close();
});

async function indexSubjects(subjects: IndexedSubject[]) {
  const byPartition = new Map<number, string[]>();
  for (const subject of subjects) {
    fake.put(subject);
    const partition = subjectPartition(subject.id);
    byPartition.set(partition, [...(byPartition.get(partition) ?? []), subject.id]);
  }
  for (const [partition, ids] of byPartition) {
    const snapshot = await fake.read(partition, ids);
    await base.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  }
}

async function mappedFields(): Promise<number> {
  type Node = { properties?: Record<string, Node>; fields?: Record<string, unknown> };
  const { body } = await base.request<Record<string, { mappings: Node }>>('GET', `/${index}/_mapping`);
  let count = 0;
  const visit = (node: Node) => {
    for (const child of Object.values(node.properties ?? {})) {
      count++;
      visit(child);
    }
    count += Object.keys(node.fields ?? {}).length;
  };
  visit(body[index]!.mappings);
  return count;
}

const fields = new Map<number, number>();
const perScale = new Map<number, { requests: number; bytes: number }>();

test('filtered search and facet counts stay within budget at 1, 10 and 100 vertical manifests', async () => {
  const service = createSearchService({ pool: db.pool, client, prefix, source: fake, cursors });
  let release: Awaited<ReturnType<typeof activateManifests>> | undefined;
  await checkGrowth(db, {
    name: 'Search and facet counts as vertical manifests grow',
    scales: [1, 10, 100],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(growthDb, scale, previous) {
      release = await activateManifests(growthDb, scale);
      await indexSubjects(manifestSubjects(release, previous, scale));
      fields.set(scale, await mappedFields());
    },
    async operation(_growthDb, scale) {
      const { filter, facets } = manifestQuery(release!);
      const before = { ...engine };
      const found = await service.search('anonymous', { filter, sort: 'name' });
      const counted = await service.facets('anonymous', { filter, facets });
      expect(found.subjects.length).toBeGreaterThan(0);
      expect(counted.facets.length).toBe(facets.length);
      expect(counted.facets.some(({ values }) => values.length > 0)).toBe(true);
      perScale.set(scale, { requests: engine.requests - before.requests, bytes: engine.bytes - before.bytes });
    },
  });
  expect(perScale.get(10)).toEqual(perScale.get(1));
  expect(perScale.get(100)).toEqual(perScale.get(1));
}, 600_000);

test('indexing every vertical adds no mapping field', () => {
  expect([...fields.keys()]).toEqual([1, 10, 100]);
  expect(fields.get(10)).toBe(fields.get(1));
  expect(fields.get(100)).toBe(fields.get(1));
  expect(fields.get(100)!).toBeLessThan(1000);
});
