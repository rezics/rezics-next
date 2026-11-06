import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
const first = subjectIndexName(prefix, 1);
const second = subjectIndexName(prefix, 2);

// The legacy analyzer cases: legacy-final:infra/jena/command-module/src/test/java/com/rezics/jena/g585AnalyzerTest.java
const TITLES = [
  '魔法禁書目錄',
  '魔法禁书目录',
  '魔法禁書索引',
  'かたかな',
  'カタカナ',
  'ｶﾀｶﾅ',
  'ガラス',
  'がらす',
  'ｶﾞﾗｽ',
  'がらす',
  'カラス',
  'キャンパス',
  'キヤンパス',
  'ＲＵＳＴ',
  'rust',
];

type Hits = { hits: { hits: { _id: string }[] } };

beforeAll(async () => {
  await createSubjectIndex(search, prefix, 1);
  await search.bulk(
    TITLES.flatMap((title, n) => [{ index: { _index: first, _id: String(n) } }, { names: [title] }]),
    { query: { refresh: 'wait_for' } },
  );
});
afterAll(async () => {
  for (const index of [first, second]) await search.request('DELETE', `/${index}`).catch(() => undefined);
});

async function tokens(text: string): Promise<string[]> {
  const response = await search.request<{ tokens: { token: string }[] }>('POST', `/${first}/_analyze`, {
    analyzer: 'cjk_bigram_v2',
    text,
  });
  return response.body.tokens.map((token) => token.token);
}

async function ids(index: string, body: unknown): Promise<string[]> {
  const response = await search.request<Hits>('POST', `/${index}/_search`, { size: 50, ...(body as object) });
  return response.body.hits.hits.map((hit) => hit._id);
}

test('cjk_bigram_v2 produces the legacy tokens', async () => {
  const mapping = await search.request<
    Record<string, { mappings: { properties: { names: { analyzer: string; index_options?: string } } } }>
  >('GET', `/${first}/_mapping`);
  expect(mapping.body[first]!.mappings.properties.names).toMatchObject({
    analyzer: 'cjk_bigram_v2',
    index_options: 'offsets',
  });
  expect(await tokens('魔法禁書目錄')).toEqual(['魔法', '法禁', '禁书', '书目', '目录']);
  expect(await tokens('ｶﾞﾗｽ')).toEqual(['ガラ', 'ラス']);
  expect(await tokens('ガラス')).toEqual(await tokens('がらす'));
  expect(await tokens('東京がらす')).toEqual(['东京', '京ガ', 'ガラ', 'ラス']);
  expect(await tokens('ＲＵＳＴ')).toEqual(['rust']);
  expect(await tokens('')).toEqual([]);
  expect(await tokens('がらす')).toEqual(['ガラ', 'ラス']);
  const folded = await search.request<{ tokens: { token: string }[] }>('POST', `/${first}/_analyze`, {
    char_filter: ['nfkc_cf'],
    tokenizer: 'keyword',
    filter: ['han_kana_fold'],
    text: '魔法禁書目錄ｶﾞﾗｽ',
  });
  expect(folded.body.tokens.map((token) => token.token)).toEqual(['魔法禁书目录ガラス']);
});

test('phrase matches follow the legacy cases', async () => {
  const cases: [string, number[]][] = [
    ['魔法禁书目录', [0, 1]],
    ['魔法禁書目錄', [0, 1]],
    ['魔法禁书索引', [2]],
    ['かたかな', [3, 4, 5]],
    ['カタカナ', [3, 4, 5]],
    ['ｶﾀｶﾅ', [3, 4, 5]],
    ['ガラス', [6, 7, 8, 9]],
    ['がらす', [6, 7, 8, 9]],
    ['ｶﾞﾗｽ', [6, 7, 8, 9]],
    ['がらす', [6, 7, 8, 9]],
    ['からす', [10]],
    ['きゃんぱす', [11]],
    ['きやんぱす', [12]],
    ['RUST', [13, 14]],
    ['ＲＵＳＴ', [13, 14]],
    ['katakana', []],
    ['魔法禁書目録外伝', []],
  ];
  for (const [query, expected] of cases) {
    const found = (await ids(first, { query: { match_phrase: { names: query } } })).map(Number).sort((a, b) => a - b);
    expect({ query, found }).toEqual({ query, found: expected });
  }
});

test('typeahead, exact names, sort keys, the full-text field and the strict mapping', async () => {
  await createSubjectIndex(search, prefix, 2);
  const documents: [string, object][] = [
    ['kokoro', { names: ['Kokoro'], descriptions: ['A novel by Natsume Sōseki'], name_sort: 'Kokoro' }],
    ['magic', { names: ['魔法禁書目錄'], name_sort: '魔法禁書目錄' }],
    ['beta', { names: ['ｂｅｔａ'], name_sort: 'ｂｅｔａ' }],
    ['unnamed', { names: [], name_sort: '\u{10FFFF}' }],
    ['alpha', { names: ['Alpha'], name_sort: 'Alpha' }],
  ];
  await search.bulk(
    documents.flatMap(([id, document]) => [{ index: { _index: second, _id: id } }, document]),
    { query: { refresh: 'wait_for' } },
  );
  const typeahead = (query: string) =>
    ids(second, {
      query: {
        multi_match: {
          query,
          type: 'bool_prefix',
          fields: ['names.typeahead', 'names.typeahead._2gram', 'names.typeahead._3gram'],
        },
      },
    });
  expect(await typeahead('Koko')).toEqual(['kokoro']);
  expect(await typeahead('魔法')).toEqual(['magic']);
  expect(await ids(second, { query: { term: { 'names.exact': 'ＫＯＫＯＲＯ' } } })).toEqual(['kokoro']);
  expect(await ids(second, { query: { match_all: {} }, sort: [{ name_sort: 'asc' }, { _id: 'asc' }] })).toEqual([
    'alpha',
    'beta',
    'kokoro',
    'magic',
    'unnamed',
  ]);
  expect(await ids(second, { query: { match: { search_text: 'novel' } } })).toEqual(['kokoro']);
  expect(await ids(second, { query: { match: { names: 'novel' } } })).toEqual([]);
  const strict = await search.request('PUT', `/${second}/_doc/x`, { colour: 'red' }).catch((error: unknown) => error);
  expect(strict).toBeInstanceOf(OpenSearchError);
  expect((strict as OpenSearchError).status).toBe(400);
  expect((strict as OpenSearchError).type).toMatch(/strict_dynamic_mapping/);
});

test('generations are listed by index name and the alias names the active one', async () => {
  await createSubjectIndex(search, prefix, 1);
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: null });
  await search.request('POST', '/_aliases', { actions: [{ add: { index: first, alias: subjectAlias(prefix) } }] });
  expect(await subjectGenerations(search, prefix)).toEqual({ generations: [1, 2], active: 1 });
  expect(await subjectGenerations(search, `${prefix}other-`)).toEqual({ generations: [], active: null });
  expect(() => subjectIndexName('Bad Prefix', 1)).toThrow(RangeError);
  expect(() => subjectIndexName(prefix, 0)).toThrow(RangeError);
});
