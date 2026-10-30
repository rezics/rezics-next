import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import {
  createOpenSearch,
  OpenSearchError,
  SearchUnavailableError,
  type OpenSearch,
} from '../../src/search/opensearch.ts';
import {
  installTemplates,
  SEARCH_TEMPLATE,
  searchSubjects,
  SUGGEST_TEMPLATE,
  suggestSubjects,
  TOTAL_LIMIT,
  type SearchPlan,
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
const keyset = fresh();

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

async function seed(
  target: string,
  subjects: readonly IndexedSubject[],
  counts?: ReadonlyMap<string, number>,
): Promise<void> {
  await createSubjectIndex(search, target, 1);
  const index = subjectIndexName(target, 1);
  for (let start = 0; start < subjects.length; start += 2000) {
    const chunk = subjects.slice(start, start + 2000);
    const actions = documentActions(
      { partition: 10, position: 1n, subjects: [...chunk] },
      chunk.map((entry) => entry.id),
      counts,
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
    keyset,
    KEYSET_SUBJECTS,
    new Map([
      [id(106), 3],
      [id(101), 2],
      [id(102), 2],
    ]),
  );
  for (const n of [105, 107])
    await search.request(
      'POST',
      `/${subjectIndexName(keyset, 1)}/_update/${id(n)}`,
      { doc: { name_sort: null } },
      {
        query: { refresh: true },
      },
    );
  await seed(
    large,
    Array.from({ length: TOTAL_LIMIT + 1 }, (_, index) => subject(index + 1, `Bulk ${index + 1}`)),
  );
  await installTemplates(search, empty);
}, 120_000);

afterAll(async () => {
  for (const target of [prefix, large, empty, concrete, keyset]) {
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

// These two Unicode keys have opposite UTF-16 and native unsigned UTF-8 order.
const KEYSET_SUBJECTS = [
  subject(101, 'Tie'),
  subject(102, 'Ｔｉｅ'),
  subject(103, '\uE000'),
  subject(104, '\u{10000}'),
  subject(105, ''),
  subject(106, 'A'),
  subject(107, ''),
];
type NativePage = {
  hits: {
    total: { value: number; relation: string };
    hits: {
      _id: string;
      _index: string;
      _source: { partition: number; security_revision: number };
      sort: (string | number | null)[];
    }[];
  };
};
function receiptTransport(change?: (page: NativePage) => void) {
  const evidence: { request: unknown; path: string; options: unknown; raw: NativePage; delivered: NativePage }[] = [];
  const client: OpenSearch = {
    bulk: (...args) => search.bulk(...args),
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const response = await search.request<T>(...args);
      const raw = structuredClone(response.body) as NativePage;
      const delivered = structuredClone(raw);
      change?.(delivered);
      evidence.push({ request: structuredClone(args[2]), path: args[1], options: args[3], raw, delivered });
      return { ...response, body: delivered as T };
    },
  };
  return { client, evidence };
}
const ordinarySorts = ['id', 'name', 'collections', 'relevance'] as const;
const nativeSorts = {
  id: [{ id: 'asc' }],
  name: [{ name_sort: 'asc' }, { id: 'asc' }],
  collections: [{ public_collection_count: { order: 'desc', missing: 0 } }, { name_sort: 'asc' }, { id: 'asc' }],
  relevance: [{ _score: 'desc' }, { id: 'asc' }],
};

test('native ordinary tuples preserve UTF-8 order, normalized ties, null-last, descending counts and keyset exhaustion', async () => {
  const expected = {
    id: [101, 102, 103, 104, 105, 106, 107],
    relevance: [101, 102, 103, 104, 105, 106, 107],
    name: [106, 101, 102, 103, 104, 105, 107],
    collections: [106, 101, 102, 103, 104, 105, 107],
  };
  expect('\u{10000}' < '\uE000').toBe(true);
  for (const sort of ordinarySorts) {
    const observed = receiptTransport();
    let after: SearchPlan['after'];
    const seen: string[] = [];
    for (;;) {
      const page = await searchSubjects(observed.client, keyset, {
        sort,
        generation: 1,
        size: 2,
        ...(after ? { after } : {}),
      });
      const evidence = observed.evidence.at(-1)!;
      expect(evidence.path).toBe(`/${subjectIndexName(keyset, 1)}/_search/template`);
      expect(evidence.options).toEqual({ query: { allow_partial_search_results: false } });
      expect(evidence.request).toMatchObject({
        id: `${keyset}${SEARCH_TEMPLATE}`,
        params: {
          sort: nativeSorts[sort],
          size: 2,
          has_after: after !== undefined,
          after,
        },
      });
      expect(page.hits.map(({ id, sort }) => ({ id, sort }))).toEqual(
        evidence.raw.hits.hits.map((hit) => ({ id: hit._id, sort: hit.sort })),
      );
      expect(evidence.delivered).toEqual(evidence.raw);
      seen.push(...page.hits.map(({ id }) => id));
      if (!page.hits.length) break;
      after = page.hits.at(-1)!.sort;
    }
    expect(seen).toEqual(expected[sort].map(id));
    expect(new Set(seen).size).toBe(7);
    console.info('native ordinary keysets', JSON.stringify({ sort, evidence: observed.evidence }));
  }
  const page = await searchSubjects(search, keyset, { sort: 'name', generation: 1, size: 10 });
  expect(page.hits.map(({ sort }) => sort)).toEqual([
    ['a', id(106)],
    ['tie', id(101)],
    ['tie', id(102)],
    ['\uE000', id(103)],
    ['\u{10000}', id(104)],
    [null, id(105)],
    [null, id(107)],
  ]);
});

test('cloned executed native ordinary receipts reject duplicate roots, reordered tuples and inexact physical identities', async () => {
  const faults: { name: string; change: (page: NativePage) => void }[] = [
    {
      name: 'duplicate',
      change: (page) => {
        page.hits.hits[1] = structuredClone(page.hits.hits[0]!);
      },
    },
    {
      name: 'reordered',
      change: (page) => {
        page.hits.hits.reverse();
      },
    },
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((suffix) => ({
      name: `final ${JSON.stringify(suffix)}`,
      change: (page: NativePage) => {
        page.hits.hits[0]!._index += suffix;
      },
    })),
    ...['0', '01', '-1', '1.5', '9007199254740992', '2', '1junk'].map((generation) => ({
      name: `generation ${generation}`,
      change: (page: NativePage) => {
        page.hits.hits[0]!._index = `${keyset}subjects-g${generation}`;
      },
    })),
    {
      name: 'newline root',
      change: (page) => {
        page.hits.hits[0]!._id += '\n';
      },
    },
    {
      name: 'foreign prefix',
      change: (page) => {
        page.hits.hits[0]!._index = 'foreign-subjects-g1';
      },
    },
    {
      name: 'duplicate root with distinct tuple',
      change: (page) => {
        const first = page.hits.hits[0]!;
        const last = page.hits.hits.at(-1)!;
        last._id = first._id;
        last.sort[last.sort.length - 1] = first._id;
      },
    },
  ];
  for (const sort of ordinarySorts) {
    for (const fault of faults) {
      const observed = receiptTransport(fault.change);
      await expect(searchSubjects(observed.client, keyset, { sort, generation: 1, size: 10 })).rejects.toBeInstanceOf(
        SearchUnavailableError,
      );
      expect(observed.evidence).toHaveLength(1);
      expect(observed.evidence[0]!.raw.hits.hits).toHaveLength(7);
      expect(observed.evidence[0]!.delivered).not.toEqual(observed.evidence[0]!.raw);
      console.info(
        'native ordinary rejected receipt',
        JSON.stringify({ sort, fault: fault.name, evidence: observed.evidence }),
      );
    }
    const baseline = receiptTransport();
    const first = await searchSubjects(baseline.client, keyset, { sort, generation: 1, size: 2 });
    const frontier = first.hits.at(-1)!.sort;
    for (const previous of baseline.evidence[0]!.raw.hits.hits) {
      const observed = receiptTransport((page) => {
        page.hits.hits[0] = structuredClone(previous);
      });
      await expect(
        searchSubjects(observed.client, keyset, { sort, generation: 1, size: 2, after: frontier }),
      ).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(observed.evidence).toHaveLength(1);
      expect(observed.evidence[0]!.request).toMatchObject({ params: { after: frontier, has_after: true } });
      expect(observed.evidence[0]!.raw.hits.hits).toHaveLength(2);
      console.info('native ordinary refused frontier', JSON.stringify({ sort, frontier, evidence: observed.evidence }));
    }
  }
}, 120_000);

test('malformed direct ordinary after tuples reject before engine I/O', () => {
  let calls = 0;
  const client: OpenSearch = {
    request: () => {
      calls++;
      throw new Error('must not reach engine');
    },
    bulk: () => {
      calls++;
      throw new Error('must not reach engine');
    },
  };
  const invalid: Record<(typeof ordinarySorts)[number], unknown[]> = {
    id: [null, [], [id(101), id(102)], [id(101) + '\n'], [null], [1]],
    name: [null, [], [id(101)], [7, id(101)], ['\ud800', id(101)], ['a', id(101), id(102)], ['a', id(101) + '\n']],
    collections: [
      null,
      [],
      [0, id(101)],
      [-1, 'a', id(101)],
      [0.5, 'a', id(101)],
      [Number.MAX_SAFE_INTEGER + 1, null, id(101)],
      [0, 2, id(101)],
      [0, '\udfff', id(101)],
    ],
    relevance: [null, [], [id(101)], [NaN, id(101)], [Infinity, id(101)], [null, id(101)], ['1', id(101)]],
  };
  for (const sort of ordinarySorts)
    for (const after of invalid[sort])
      expect(() =>
        searchSubjects(client, keyset, { sort, size: 2, after: after as NonNullable<SearchPlan['after']> }),
      ).toThrow(RangeError);
  expect(calls).toBe(0);
});
