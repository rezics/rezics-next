import { searchOperationProblem } from '../../src/search/http/operation-problems.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type IndexedStatement, type IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;

const id = (n: number) => `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`;
const far = '018f0000-0000-7000-8000-01c000000001';
const author = (target: string): IndexedStatement => ({
  property: 'schema:author',
  value: target,
  facet: { kind: 'item' },
});
const published = (year: number): IndexedStatement => ({
  property: 'schema:datePublished',
  value: `+${year}-00-00T00:00:00Z`,
  facet: { kind: 'time', year },
});
const subject = (
  key: string,
  type: string,
  labels: Record<string, string>,
  statements: IndexedStatement[] = [],
  state: Partial<Pick<IndexedSubject, 'visibility' | 'redirect'>> = {},
): IndexedSubject => ({
  id: key,
  type,
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: Object.entries(labels).map(([language, value]) => ({ language, value })),
  aliases: [],
  descriptions: [],
  statements,
  ...state,
});

const subjects = [
  subject(id(1), 'schema:Book', { en: 'The Dispossessed', ja: '所有せざる人々' }, [
    author(id(3)),
    published(1974),
    published(1974),
    { property: 'schema:inLanguage', value: 'en', facet: { kind: 'code' } },
    { property: 'schema:numberOfPages', value: '+387', facet: { kind: 'quantity', amount: 387, unit: '1' } },
    { property: 'schema:alternateName', value: 'Anarres' },
  ]),
  subject(id(2), 'schema:Book', { en: 'The Dispossessed' }, [
    published(2010),
    author(id(6)),
    author(id(6)),
    author(id(7)),
    author(id(3)),
    author(id(8)),
  ]),
  subject(id(9), 'schema:Book', { en: 'The Word for World Is Forest' }, [author(far)]),
  subject(id(11), 'schema:Book', { en: 'Gifts' }, [author(id(10)), author(id(4)), author(id(5)), author(id(6))]),
  subject(id(3), 'schema:Person', { en: 'Ursula K. Le Guin', ja: 'アーシュラ・K・ル＝グウィン' }),
  subject(id(4), 'schema:Person', { en: 'Withdrawn Author' }, [], { visibility: 'hidden' }),
  subject(id(5), 'schema:Organization', { en: 'Merged Group' }, [], { redirect: id(6) }),
  subject(id(6), 'schema:Organization', { en: 'Harper Study Group' }),
  subject(id(7), 'schema:Organization', { en: 'Third Group' }),
  subject(id(8), 'schema:Organization', { en: 'Fourth Group' }),
  subject(far, 'schema:Organization', { en: 'Far Partition Press' }),
  subject(id(12), 'schema:Article', { en: 'Localized article' }, [
    author(id(13)),
    { property: 'schema:inLanguage', value: 'en', facet: { kind: 'code' } },
  ]),
  subject(id(13), 'schema:Thing', { 'zh-Hant': '繁體作者', en: 'English author' }, [
    { property: 'schema:inLanguage', value: 'zh-Hant', facet: { kind: 'code' } },
  ]),
];
const release = {
  types: {
    'schema:Book': { bases: [], facets: ['schema:author', 'schema:datePublished'] },
    'schema:Person': { bases: [], facets: [] },
    'schema:Organization': { bases: [], facets: [] },
    'schema:Article': { bases: [], facets: ['schema:author'] },
    'schema:Thing': { bases: [], facets: [] },
  },
  properties: {
    'schema:author': { datatype: 'wikibase-item' },
    'schema:datePublished': { datatype: 'time' },
    'schema:inLanguage': { datatype: 'string', value: { pattern: '^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$' } },
    'schema:numberOfPages': { datatype: 'quantity', units: ['1'] },
    'schema:alternateName': { datatype: 'string' },
  },
};
const fake = createFakeSource();
let reads = 0;
const source = {
  ...fake,
  read(...args: Parameters<typeof fake.read>) {
    reads++;
    return fake.read(...args);
  },
};
let lookups = 0;
const service = createSearchService({
  pool,
  client,
  prefix,
  source,
  cursors,
  release: async () => {
    lookups++;
    return release;
  },
});
const index = subjectIndexName(prefix, 1);
const filter = { type: { in: ['schema:Book', 'schema:Person'] } };
const all = ['schema:author', 'schema:datePublished', 'schema:inLanguage', 'schema:numberOfPages'];
const factsOf = (answer: { subjects: object[] }) =>
  answer.subjects.map((hit) => [(hit as { id: string }).id, (hit as { facts?: unknown }).facts]);

beforeAll(async () => {
  await createSubjectIndex(client, prefix, 1);
  for (const entry of subjects) fake.put(entry);
  for (const ids of [subjects.map((entry) => entry.id).filter((key) => key !== far), [far]]) {
    const snapshot = await fake.read(subjectPartition(ids[0]!), ids);
    await client.bulk(bulkLines(index, documentActions(snapshot, ids)), { query: { refresh: 'wait_for' } });
  }
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
});
afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => searchOperationProblem(caught),
  );
  expect(error).toBeInstanceOf(ProblemError);
  return [(error as ProblemError).code, (error as ProblemError).errors] as unknown[];
}

test('search hits carry the requested facts in source order without duplicates', async () => {
  const lookupsBefore = lookups;
  const answer = await service.search('anonymous', { filter, sort: 'name', properties: all });
  expect(lookups - lookupsBefore).toBe(1);
  const none = { 'schema:author': [], 'schema:datePublished': [], 'schema:inLanguage': [], 'schema:numberOfPages': [] };
  expect(factsOf(answer)).toEqual([
    [id(11), none],
    [
      id(1),
      {
        'schema:author': [
          { kind: 'item', id: id(3), labels: { en: 'Ursula K. Le Guin', ja: 'アーシュラ・K・ル＝グウィン' } },
        ],
        'schema:datePublished': [{ kind: 'time', year: 1974 }],
        'schema:inLanguage': [{ kind: 'code', value: 'en' }],
        'schema:numberOfPages': [{ kind: 'quantity', amount: 387, unit: '1' }],
      },
    ],
    [
      id(2),
      {
        ...none,
        'schema:author': [
          { kind: 'item', id: id(6), labels: { en: 'Harper Study Group' } },
          { kind: 'item', id: id(7), labels: { en: 'Third Group' } },
          { kind: 'item', id: id(3), labels: { en: 'Ursula K. Le Guin', ja: 'アーシュラ・K・ル＝グウィン' } },
        ],
        'schema:datePublished': [{ kind: 'time', year: 2010 }],
      },
    ],
    [id(9), { ...none, 'schema:author': [{ kind: 'item', id: far, labels: { en: 'Far Partition Press' } }] }],
    [id(3), none],
  ]);

  const plain = await service.search('anonymous', { filter, sort: 'name' });
  expect(plain.subjects.every((hit) => !('facts' in hit))).toBe(true);
});

test('item fact targets of a page are read in one batch per partition', async () => {
  const before = reads;
  await service.search('anonymous', { filter, sort: 'name' });
  const plain = reads - before;
  const middle = reads;
  await service.search('anonymous', { filter, sort: 'name', properties: ['schema:author', 'schema:datePublished'] });
  expect(reads - middle).toBe(plain + 2);
  const dates = reads;
  await service.search('anonymous', { filter, sort: 'name', properties: ['schema:datePublished'] });
  expect(reads - dates).toBe(plain);
});

test('item fact labels follow the requested languages', async () => {
  const answer = await service.search('anonymous', {
    filter,
    sort: 'name',
    properties: ['schema:author'],
    languages: ['ja'],
  });
  expect(factsOf(answer).slice(1, 3)).toEqual([
    [id(1), { 'schema:author': [{ kind: 'item', id: id(3), labels: { ja: 'アーシュラ・K・ル＝グウィン' } }] }],
    [
      id(2),
      {
        'schema:author': [
          { kind: 'item', id: id(6), labels: { en: 'Harper Study Group' } },
          { kind: 'item', id: id(7), labels: { en: 'Third Group' } },
          { kind: 'item', id: id(3), labels: { ja: 'アーシュラ・K・ル＝グウィン' } },
        ],
      },
    ],
  ]);
});

test("item fact labels follow the reader's language chain", async () => {
  for (const languages of [['zh-Hans', 'zh', 'zh-Hant', 'en'], ['zh-TW'], ['ko'], ['en']]) {
    const before = reads;
    const answer = await service.search('anonymous', {
      filter: { type: { in: ['schema:Article'] } },
      properties: ['schema:author'],
      languages,
    });
    const labels = languages[0] === 'en' ? { en: 'English author' } : { 'zh-Hant': '繁體作者' };
    expect(factsOf(answer)).toEqual([[id(12), { 'schema:author': [{ kind: 'item', id: id(13), labels }] }]]);
    expect(reads - before).toBe(2);
  }
});

test('requested properties are validated', async () => {
  const search = (properties: unknown) => service.search('anonymous', { filter, properties } as never);
  const invalid = (pointer: string, code: string) => ['invalid_request', [{ pointer, code }]];
  expect(await refusal(search('schema:author'))).toEqual(invalid('/properties', 'invalid_type'));
  expect(await refusal(search([]))).toEqual(invalid('/properties', 'out_of_range'));
  expect(await refusal(search([...all, 'schema:alternateName']))).toEqual(invalid('/properties', 'out_of_range'));
  expect(await refusal(search([42]))).toEqual(invalid('/properties/0', 'invalid_type'));
  expect(await refusal(search(['schema:author', 'schema:author']))).toEqual(invalid('/properties/1', 'invalid_format'));
  for (const property of ['schema:unknown', 'schema:alternateName'])
    expect(await refusal(search(['schema:author', property]))).toEqual([
      'unsupported_query',
      [{ pointer: '/properties/1', code: 'unsupported' }],
    ]);
});

test('facts need an active release', async () => {
  const bare = createSearchService({ pool, client, prefix, source, cursors, release: async () => null });
  const refused = await refusal(bare.search('anonymous', { text: 'Dispossessed', properties: ['schema:author'] }));
  expect(refused[0]).toBe('semantic_not_ready');
});

test('properties join the cursor binding', async () => {
  const request = { filter, sort: 'name' as const, limit: 1, properties: ['schema:author'] };
  const first = await service.search('anonymous', request);
  expect(first.next).not.toBeNull();
  const second = await service.search('anonymous', { ...request, cursor: first.next! });
  expect(second.subjects.map((hit) => hit.id)).toEqual([id(1)]);
  expect(
    await refusal(
      service.search('anonymous', { ...request, properties: ['schema:datePublished'], cursor: first.next! }),
    ),
  ).toEqual(['invalid_request', [{ pointer: '/cursor', code: 'invalid_format' }]]);
});
