import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import {
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
  suggestSubjects,
  TOTAL_LIMIT,
} from '../../src/search/query.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const fresh = () => `test-${crypto.randomUUID().slice(0, 8)}-`;
const prefix = fresh();
const large = fresh();
const empty = fresh();
const concrete = fresh();

// Route 0x00a0 sits in partition 10.
const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const subject = (n: number, label: string, patch: Partial<IndexedSubject> = {}): IndexedSubject => ({
  id: id(n),
  type: 'schema:Book',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: label ? [{ language: 'en', value: label }] : [],
  aliases: [],
  descriptions: [],
  statements: [],
  ...patch,
});
const SUBJECTS = [
  subject(1, 'Kokoro'),
  subject(2, 'Kokoro no Kanata'),
  subject(3, 'Botchan', { descriptions: [{ language: 'en', value: 'Written after Kokoro was planned' }] }),
  subject(4, 'Miso soup', { type: 'schema:Recipe' }),
  subject(5, ''),
];
const kokoro = { match: { search_text: { query: 'kokoro', operator: 'and', _name: 't0' } } };

async function seed(target: string, subjects: readonly IndexedSubject[]): Promise<void> {
  await createSubjectIndex(search, target, 1);
  const index = subjectIndexName(target, 1);
  for (let start = 0; start < subjects.length; start += 2000) {
    const chunk = subjects.slice(start, start + 2000);
    const actions = documentActions(
      { partition: 10, position: 1n, subjects: [...chunk] },
      chunk.map((entry) => entry.id),
    );
    await search.bulk(bulkLines(index, actions), { query: { refresh: 'wait_for' } });
  }
  await search.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(target) } }] });
  await installTemplates(search, target);
}

beforeAll(async () => {
  await seed(prefix, SUBJECTS);
  await seed(concrete, SUBJECTS);
  await seed(
    large,
    Array.from({ length: TOTAL_LIMIT + 1 }, (_, index) => subject(index + 1, `Bulk ${index + 1}`)),
  );
  await installTemplates(search, empty);
}, 120_000);

afterAll(async () => {
  for (const target of [prefix, large, empty, concrete]) {
    await search.request('DELETE', `/${subjectIndexName(target, 1)}`).catch(() => undefined);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE]) {
      await search.request('DELETE', `/_scripts/${target}${name}`).catch(() => undefined);
    }
  }
});

test('templates are stored under versioned ids and installing them again changes nothing', async () => {
  expect([SEARCH_TEMPLATE, SUGGEST_TEMPLATE]).toEqual(['subjects-search-v2', 'subjects-suggest-v1']);
  const stored = await search.request<{ found: boolean }>('GET', `/_scripts/${prefix}${SEARCH_TEMPLATE}`);
  expect(stored.body.found).toBe(true);
  await installTemplates(search, prefix);
  expect((await search.request('GET', `/_scripts/${prefix}${SEARCH_TEMPLATE}`)).body).toEqual(stored.body);
});

test('relevance ranks exact names first and reports the matched clause names', async () => {
  const result = await searchSubjects(search, prefix, { query: kokoro, boost: 'kokoro', sort: 'relevance', size: 10 });
  expect(result.hits.map((hit) => hit.id)).toEqual([id(1), id(2), id(3)]);
  expect(result.hits[0]).toMatchObject({
    index: subjectIndexName(prefix, 1),
    partition: 10,
    securityRevision: 1,
    matched: ['t0'],
  });
  expect(result.total).toEqual({ value: 3, relation: 'exact' });
});

test('filters restrict without scoring and report their names', async () => {
  const recipes = await searchSubjects(search, prefix, {
    filter: { terms: { type: ['schema:Recipe'], _name: 'f0' } },
    sort: 'name',
    size: 10,
  });
  expect(recipes.hits.map((hit) => [hit.id, hit.matched])).toEqual([[id(4), ['f0']]]);
  const excluded = await searchSubjects(search, prefix, {
    query: kokoro,
    boost: 'kokoro',
    filter: { bool: { must_not: [{ terms: { type: ['schema:Book'], _name: 'f0' } }] } },
    sort: 'relevance',
    size: 10,
  });
  expect(excluded.hits).toEqual([]);
  expect(excluded.total).toEqual({ value: 0, relation: 'exact' });
});

test('name, id and relevance sorts page with search_after without gaps or duplicates', async () => {
  async function pages(plan: { query?: Record<string, unknown>; boost?: string; sort: 'relevance' | 'name' | 'id' }) {
    const seen: string[][] = [];
    let after: (string | number | null)[] | undefined;
    for (;;) {
      const page = await searchSubjects(search, prefix, { ...plan, size: 2, ...(after ? { after } : {}) });
      seen.push(page.hits.map((hit) => hit.id));
      if (page.hits.length < 2) return seen;
      after = page.hits.at(-1)!.sort;
    }
  }
  expect(await pages({ sort: 'name' })).toEqual([[id(3), id(1)], [id(2), id(4)], [id(5)]]);
  expect((await pages({ sort: 'id' })).flat()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
  expect((await pages({ query: kokoro, boost: 'kokoro', sort: 'relevance' })).flat()).toEqual([id(1), id(2), id(3)]);
  expect(() => searchSubjects(search, prefix, { sort: 'id', size: 201 })).toThrow(RangeError);
});

test('total hits stop counting at 10,000 as a lower bound', async () => {
  expect(TOTAL_LIMIT).toBe(10_000);
  const result = await searchSubjects(search, large, {
    filter: { terms: { type: ['schema:Book'], _name: 'f0' } },
    sort: 'id',
    size: 1,
  });
  expect(result.total).toEqual({ value: 10_000, relation: 'lower_bound' });
  expect(result.hits.map((hit) => hit.id)).toEqual([id(1)]);
});

test('typeahead suggests by word prefix with a bounded size', async () => {
  const ids = async (text: string, size: number) =>
    (await suggestSubjects(search, prefix, { text, size })).map((hit) => hit.id).sort();
  expect(await ids('Koko', 8)).toEqual([id(1), id(2)].sort());
  expect(await ids('Koko', 1)).toHaveLength(1);
  expect(await ids('kanata', 8)).toEqual([id(2)]);
  expect(await ids('soup', 8)).toEqual([id(4)]);
  expect((await suggestSubjects(search, prefix, { text: 'Miso', size: 8 }))[0]).toMatchObject({
    id: id(4),
    index: subjectIndexName(prefix, 1),
    partition: 10,
    securityRevision: 1,
  });
  expect(() => suggestSubjects(search, prefix, { text: 'Koko', size: 51 })).toThrow(RangeError);
});

test('a missing alias is an OpenSearch not-found error', async () => {
  const missing = await searchSubjects(search, empty, { sort: 'id', size: 1 }).catch((error: unknown) => error);
  expect(missing).toBeInstanceOf(OpenSearchError);
  expect(missing).toMatchObject({ status: 404, type: 'index_not_found_exception' });
});

test('a supplied physical generation works without an alias for every ordinary sort and zero hits', async () => {
  await search.request('POST', '/_aliases', {
    actions: [{ remove: { index: subjectIndexName(concrete, 1), alias: subjectAlias(concrete) } }],
  });
  for (const sort of ['name', 'id', 'collections', 'relevance'] as const) {
    const plan = { query: kokoro, boost: 'kokoro', sort, size: 10 };
    const ordinary = await searchSubjects(search, prefix, plan);
    const pinned = await searchSubjects(search, concrete, { ...plan, generation: 1 });
    expect(pinned.generation).toBe(1);
    expect(pinned.hits).toEqual(ordinary.hits.map((hit) => ({ ...hit, index: subjectIndexName(concrete, 1) })));
    expect(pinned.total).toEqual(ordinary.total);
    const empty = await searchSubjects(search, concrete, {
      ...plan,
      generation: 1,
      filter: { term: { type: 'schema:Recipe' } },
    });
    expect(empty).toEqual({ generation: 1, hits: [], total: { value: 0, relation: 'exact' } });
  }
  const omitted = await searchSubjects(search, concrete, { sort: 'id', size: 1 }).catch((error: unknown) => error);
  expect(omitted).toMatchObject({ status: 404, type: 'index_not_found_exception' });
});
