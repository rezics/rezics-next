import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { ProblemError } from '../../src/http/problem.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { IndexedSubject } from '../../src/search/source.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { createFakeSource } from './support/fake-source.ts';

const databaseUrl = process.env.DATABASE_URL;
const searchUrl = process.env.OPENSEARCH_URL;
if (!databaseUrl || !searchUrl)
  throw new Error('DATABASE_URL and OPENSEARCH_URL must name the check database and node');
const pool = createPool(databaseUrl);
const client = createOpenSearch(searchUrl);
const cursors: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
afterAll(async () => {
  const { generations } = await subjectGenerations(client, prefix);
  for (const generation of generations) await client.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
  for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE])
    await client.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  await pool.end();
});

const book = (n: number, label: string): IndexedSubject => ({
  id: `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`,
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [{ language: 'en', value: label }],
  aliases: [],
  descriptions: [],
  statements: [],
});
const [kokoro, botchan, sanshiro, mon, wagahai] = [
  book(1, 'Kokoro'),
  book(2, 'Botchan'),
  book(3, 'Sanshiro'),
  book(4, 'Mon'),
  book(5, 'Wagahai wa Neko de Aru'),
];

async function deployment() {
  const fake = createFakeSource();
  const all = [kokoro, botchan, sanshiro, mon, wagahai];
  for (const subject of all) fake.put(subject);
  await createSubjectIndex(client, prefix, 1);
  const index = subjectIndexName(prefix, 1);
  const counted = all.slice(0, 4).map(({ id }) => id);
  const snapshot = await fake.read(11, counted);
  const counts = new Map([
    [kokoro.id, 7],
    [botchan.id, 7],
    [sanshiro.id, 2],
  ]);
  await client.bulk(bulkLines(index, documentActions(snapshot, counted, counts)), { query: { refresh: 'wait_for' } });
  const uncounted = await fake.read(11, [wagahai.id]);
  await client.bulk(bulkLines(index, documentActions(uncounted, [wagahai.id])), { query: { refresh: 'wait_for' } });
  await client.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
  return createSearchService({
    pool,
    client,
    prefix,
    source: fake,
    cursors,
    release: async () => ({ types: { 'schema:Book': { facets: [] } }, properties: {} }),
  });
}

const ids = (page: { subjects: { id: string }[] }) => page.subjects.map(({ id }) => id);

test('sort collections orders by public collection count, then name, across pages', async () => {
  const service = await deployment();
  const filter = { type: { in: ['schema:Book'] } };
  const all = await service.search('anonymous', { filter, sort: 'collections', limit: 10 });
  expect(ids(all)).toEqual([botchan.id, kokoro.id, sanshiro.id, mon.id, wagahai.id]);
  const first = await service.search('anonymous', { filter, sort: 'collections', limit: 2 });
  expect(ids(first)).toEqual([botchan.id, kokoro.id]);
  const second = await service.search('anonymous', { filter, sort: 'collections', limit: 2, cursor: first.next! });
  expect(ids(second)).toEqual([sanshiro.id, mon.id]);
  const third = await service.search('anonymous', { filter, sort: 'collections', limit: 2, cursor: second.next! });
  expect(ids(third)).toEqual([wagahai.id]);
  expect(third.next).toBeNull();
  const text = await service.search('anonymous', { text: 'kokoro', sort: 'collections' });
  expect(ids(text)).toEqual([kokoro.id]);
});

test('a cursor is bound to its sort', async () => {
  const service = await deployment();
  const filter = { type: { in: ['schema:Book'] } };
  const first = await service.search('anonymous', { filter, sort: 'collections', limit: 2 });
  const error = await service.search('anonymous', { filter, sort: 'name', limit: 2, cursor: first.next! }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ProblemError);
  expect((error as ProblemError).errors as unknown).toEqual([{ pointer: '/cursor', code: 'invalid_format' }]);
});
