import { expect, test } from 'bun:test';
import { readRankedCatalogue } from '../src/modules/search/ranked.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { catalogueNameProjection } from '../src/modules/search/names.ts';
import { discloseCatalogueMatches } from '../src/modules/search/catalogue-disclosure.ts';
import { PublicQueryUnavailable } from '../src/modules/work/search-budget.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b = (value: string, language?: string) => ({ type: 'literal', value, ...language ? { 'xml:lang': language } : {} });
const position: PublicTextPosition = { dataEpoch: 'epoch', sequence: '9',
  generation: 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111',
  population: 3, serverInstanceId: '11111111-1111-4111-8111-111111111111', publicSearchWriteEpoch: '0' };

test('G-911: document continuations consume rejected name/body documents without duplicating a Work or count', async () => {
  const calls: string[] = [];
  const hits = [
    { id: 'urn:rezics:unit:one', key: id(1), score: '1000000', document: 2 },
    { id: 'urn:rezics:unit:one', key: null, score: '1000000', document: 3 },
    { id: 'urn:rezics:unit:two', key: id(2), score: '1000000', document: 4 },
    { id: 'urn:rezics:unit:private', key: null, score: '1000000', document: 5 },
    { id: 'urn:rezics:unit:one', key: null, score: '1', document: 1 },
  ];
  const env = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (sparql: string) => {
      calls.push(sparql);
      if (sparql.includes('rv:rankedText')) {
        expect(sparql).toContain('\\"catalogue\\":true');
        const encoded = /rv:rankedText\(rv:searchBody, "(?:[^"\\]|\\.)*", \d+, ("(?:[^"\\]|\\.)*"),/u.exec(sparql)![1]!;
        const after = JSON.parse(encoded) as string;
        const offset = after ? hits.findIndex(hit => hit.document === (JSON.parse(after) as { document: number }).document) + 1 : 0;
        return { results: { bindings: [{ epoch: b('epoch'), sequence: b('9'), generation: b(position.generation),
          page: b(JSON.stringify({ hits: hits.slice(offset), commit: '7', more: false })) }] } };
      }
      return { results: { bindings: hits.filter(hit => hit.key !== null && sparql.includes(`<${hit.id}>`)).map(hit => ({
        unit: b(hit.id), work: b(hit.key!), main: b(hit.key!), contribution: b(id(9)),
        revision: b(id(10)), selection: b(id(11)), language: b('en'),
      })) } };
    },
  } } as unknown as WorkActivationEnvironment;
  const read = (continuation?: string) => searchGraphSnapshot.run({ clients: new Set([env.fuseki]),
    lineage: env.lineage, position }, () => readRankedCatalogue(env, { phrase: 'Camp Lanterns', language: null,
      pageSize: 1, continuation }));
  const first = await read();
  expect(first.results.map(row => row.work)).toEqual([id(1)]);
  expect(first.count).toEqual({ value: 1, precision: 'lower-bound' });
  const second = await read(first.next!);
  expect(second.results.map(row => row.work)).toEqual([id(2)]);
  expect(second.count).toEqual({ value: 2, precision: 'exact' });
  expect(second.next).toBeNull();
  expect((await read(first.next!)).results).toEqual(second.results);
  expect(calls.filter(query => query.includes('rv:rankedText'))).toHaveLength(3);
});

test('G-911: the name recipe retains individual authored values and only the current header titles', async () => {
  const rows = [ { work: b(id(1)), name: b('Camp Lanterns', 'en') },
    { work: b(id(1)), name: b('魔法禁書目錄', 'zh-Hant') },
    { work: b(id(1)), state: b(JSON.stringify({ kind: 'header', originalTitle: null, localized: [
      { language: 'fr', title: 'Lumières', description: 'Private-looking description', mainVersionLabel: null, tagline: 'Tagline' },
    ] })) } ];
  const env = { fuseki: { query: async () => ({ results: { bindings: rows } }) } } as unknown as WorkActivationEnvironment;
  expect([...(await catalogueNameProjection(env, [id(1)])).get(id(1))!])
    .toEqual(['"Camp Lanterns"@en', '"魔法禁書目錄"@zh-Hant', '"Lumières"@fr']);
  expect([...(await catalogueNameProjection(env, [id(1)], { work: id(1), header: {
    kind: 'header', originalTitle: null, localized: [{ language: 'fr', title: 'Lampes', description: null, mainVersionLabel: null }],
  } })).get(id(1))!]).toEqual(['"Camp Lanterns"@en', '"魔法禁書目錄"@zh-Hant', '"Lampes"@fr']);
  rows.push(...Array.from({ length: 64 }, (_, n) => ({ work: b(id(1)), name: b(`name ${n}`, 'en') })));
  await expect(catalogueNameProjection(env, [id(1)])).rejects.toBeInstanceOf(PublicQueryUnavailable);
});

test('G-911: restricted names are removed on their exact graph heads before counting', async () => {
  const row = { work: id(1), mainVersion: id(2), matchUnit: 'urn:unit:one', contribution: id(3),
    revision: id(4), selection: id(5), language: 'en', score: 1 };
  const env = { fuseki: { query: async () => ({ results: { bindings: [{ work: b(id(1)), head: b(id(6)) }] } }) } } as unknown as WorkActivationEnvironment;
  expect(await discloseCatalogueMatches(env, [row], async (heads, context) => {
    expect(heads).toEqual([{ work: id(1), revision: id(6) }]);
    expect(context).toBe('urn:rezics:semantic-context:global');
    return new Set([id(1)]);
  })).toEqual([]);
});
