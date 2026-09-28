import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { facetList } from '../src/modules/facets/contract.ts';

// No Fuseki answers here: the list is built when Main loads and never reads the graph.
const app = createMainApp(new FusekiClient('http://127.0.0.1:1/rezics'), {} as MainWorkDependencies);
const get = (headers: Record<string, string> = {}) =>
  app.handle(new Request('http://main.local/v1/facets', { headers }));

test('Facets: GET /v1/facets serves every admitted Facet with labels, operators and sources', async () => {
  const response = await get();
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('public, max-age=300');
  const body = await response.json() as { profile: string; digest: string; facets: Array<{ id: string; name: string;
    current: boolean; labels: Record<string, string>; operators: string[]; source: string }> };
  expect(Value.Check(facetList, body)).toBe(true);
  expect(body.profile).toBe('facets-v1');
  expect(response.headers.get('etag')).toBe(`"${body.digest}"`);
  const byName = new Map(body.facets.map(facet => [facet.name, facet]));
  expect([...byName.keys()]).toEqual(expect.arrayContaining(['type', 'concept', 'author', 'language', 'realm',
    'rating', 'role']));
  expect(byName.get('type')).toMatchObject({ id: 'https://rezics.com/definition/facet-type-v1', current: true,
    labels: { en: 'Type', 'zh-Hans': '种类', ja: '種類' }, operators: ['any', 'all', 'none'], source: 'global' });
  // The free Concept Facet reads as Tags (docs/contracts/queries.md).
  expect(byName.get('concept')).toMatchObject({ labels: { en: 'Tags', 'zh-Hans': '标签', ja: 'タグ' },
    source: 'context' });
  expect(byName.get('rating')).toMatchObject({ labels: { en: 'Rating', 'zh-Hans': '评分', ja: '評価' },
    operators: ['range'] });
  for (const facet of body.facets) {
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
      expect(facet.labels[locale]?.length).toBeGreaterThan(0);
    }
  }
});

test('Facets: a client holding the current list revalidates without a body', async () => {
  const tag = (await get()).headers.get('etag')!;
  for (const header of [tag, `W/${tag}`, `"other", ${tag}`, '*']) {
    const response = await get({ 'if-none-match': header });
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(tag);
    expect(await response.text()).toBe('');
  }
  expect((await get({ 'if-none-match': '"stale"' })).status).toBe(200);
});
