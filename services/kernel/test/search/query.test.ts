import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import {
  createOpenSearch,
  type OpenSearch,
  OpenSearchError,
  SearchUnavailableError,
} from '../../src/search/opensearch.ts';
import {
  countFacets,
  FACET_TEMPLATE,
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
    for (const name of installationNames) {
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
// Every control first executes the native request. Only a clone of its completed receipt is corrupted.
const installationNames = [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE];
type Receipt = { status: number; body: unknown };
type InstallationCall = {
  method: string;
  path: string;
  body: unknown;
  raw?: Receipt;
  returned?: Receipt;
  lost?: boolean;
};
type ReceiptControl = (receipt: Receipt, call: InstallationCall) => Receipt | Promise<Receipt>;

function installationTransport(target: string, control?: ReceiptControl) {
  const calls: InstallationCall[] = [];
  const client: OpenSearch = {
    bulk: search.bulk,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body] = args;
      expect(path.startsWith(`/_scripts/${target}`)).toBe(true);
      const call: InstallationCall = { method, path, body: structuredClone(body) };
      calls.push(call);
      let response: { status: number; body: T };
      try {
        response = await search.request<T>(...args);
      } catch (error) {
        if (error instanceof OpenSearchError) call.raw = { status: error.status, body: structuredClone(error.body) };
        else call.lost = true;
        throw error;
      }
      call.raw = structuredClone(response);
      try {
        const returned = control ? await control(structuredClone(response), call) : response;
        call.returned = structuredClone(returned);
        return returned as { status: number; body: T };
      } catch (error) {
        call.lost = true;
        throw error;
      }
    },
  };
  return { client, calls };
}

function installationPaths(target: string) {
  return installationNames.flatMap((name) => [
    ['PUT', `/_scripts/${target}${name}`],
    ['GET', `/_scripts/${target}${name}`],
  ]);
}

function retainInstallation(label: string, calls: InstallationCall[]) {
  console.info('native template installation', JSON.stringify({ label, calls }));
}

async function removeInstalled(target: string) {
  for (const name of installationNames)
    await search.request('DELETE', `/_scripts/${target}${name}`).catch((error: unknown) => {
      if (!(error instanceof OpenSearchError) || error.status !== 404) throw error;
    });
}

async function verifiedInstallation(target: string) {
  // A new caller and a new transport must revalidate every version, including genuine partial installs.
  const { client, calls } = installationTransport(target);
  try {
    await installTemplates(client, target);
    expect(calls.map(({ method, path }) => [method, path])).toEqual(installationPaths(target));
    for (const [index, name] of installationNames.entries()) {
      const put = calls[index * 2]!;
      const get = calls[index * 2 + 1]!;
      expect(put.raw).toEqual({ status: 200, body: { acknowledged: true } });
      expect(get.raw).toEqual({
        status: 200,
        body: { _id: `${target}${name}`, found: true, script: (put.body as { script: unknown }).script },
      });
      if (name !== FACET_TEMPLATE) {
        const released: unknown = JSON.parse(
          readFileSync(new URL(`../../db/search/templates/${name}.json`, import.meta.url), 'utf8'),
        );
        expect(put.body).toEqual(released);
      } else {
        expect(put.body).toEqual({
          script: {
            lang: 'mustache',
            source: `{
        "size": 0,
        "track_total_hits": 10000,
        "query": {{#toJson}}query{{/toJson}},
        "aggs": {{#toJson}}aggregations{{/toJson}}
      }`,
          },
        });
      }
    }
    return calls;
  } finally {
    retainInstallation('genuine installation/recovery', calls);
  }
}

// Run every original query assertion below the same genuine partial-install recovery boundary.
beforeAll(async () => {
  for (const target of [prefix, large, empty, concrete, keyset]) {
    const { client, calls } = installationTransport(target, (receipt, call) => {
      if (call.method === 'GET' && call.path.endsWith(FACET_TEMPLATE)) throw new Error('lost completed readback');
      return receipt;
    });
    try {
      await expect(installTemplates(client, target)).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(calls.map(({ method, path }) => [method, path])).toEqual(installationPaths(target));
    } finally {
      retainInstallation('original query fixtures lost final readback', calls);
    }
    await verifiedInstallation(target);
  }
}, 120_000);

type NamedControl = { name: string; change: (receipt: Receipt) => Receipt };
const ackControls: NamedControl[] = [
  { name: 'missing acknowledgement', change: (receipt) => ({ ...receipt, body: {} }) },
  ...[false, undefined, null, 0, 1, 'true', {}, []].map((acknowledged) => ({
    name: `acknowledged=${JSON.stringify(acknowledged)}`,
    change: (receipt: Receipt) => ({ ...receipt, body: { acknowledged } }),
  })),
  ...[undefined, null, true, [], 'acknowledged'].map((body) => ({
    name: `body=${JSON.stringify(body)}`,
    change: (receipt: Receipt) => ({ ...receipt, body }),
  })),
  ...[201, 202, 204, 400, 500, 503].map((status) => ({
    name: `HTTP ${status}`,
    change: (receipt: Receipt) => ({ ...receipt, status }),
  })),
  ...[{ error: {} }, { errors: true }, { acknowledged_extra: true }, { _shards: { failed: 1 } }].map((extra) => ({
    name: `contradictory ${JSON.stringify(extra)}`,
    change: (receipt: Receipt) => ({ ...receipt, body: { ...(receipt.body as object), ...extra } }),
  })),
];

function readbackChange(name: string, change: (body: Record<string, unknown>) => void): NamedControl {
  return {
    name,
    change: (receipt) => {
      change(receipt.body as Record<string, unknown>);
      return receipt;
    },
  };
}
const readbackControls: NamedControl[] = [
  ...[201, 202, 204, 404, 500, 503].map((status) => ({
    name: `HTTP ${status}`,
    change: (receipt: Receipt) => ({ ...receipt, status }),
  })),
  ...[undefined, null, [], true, 'script'].map((body) => ({
    name: `body=${JSON.stringify(body)}`,
    change: (receipt: Receipt) => ({ ...receipt, body }),
  })),
  readbackChange('missing id', (body) => {
    delete body._id;
  }),
  readbackChange('wrong version id', (body) => {
    body._id = `${body._id}-other`;
  }),
  readbackChange('missing found', (body) => {
    delete body.found;
  }),
  ...[false, 1, 'true', null].map((found) =>
    readbackChange(`found=${found}`, (body) => {
      body.found = found;
    }),
  ),
  readbackChange('missing script', (body) => {
    delete body.script;
  }),
  readbackChange('malformed script', (body) => {
    body.script = [];
  }),
  readbackChange('missing language', (body) => {
    delete (body.script as Record<string, unknown>).lang;
  }),
  readbackChange('wrong language', (body) => {
    (body.script as Record<string, unknown>).lang = 'painless';
  }),
  readbackChange('missing source', (body) => {
    delete (body.script as Record<string, unknown>).source;
  }),
  readbackChange('object source', (body) => {
    (body.script as Record<string, unknown>).source = { query: { match_all: {} } };
  }),
  readbackChange('changed source bytes', (body) => {
    (body.script as { source: string }).source += ' ';
  }),
  readbackChange('unexpected empty options', (body) => {
    (body.script as Record<string, unknown>).options = {};
  }),
  readbackChange('changed compiler options', (body) => {
    (body.script as Record<string, unknown>).options = { content_type: 'text/plain' };
  }),
  readbackChange('success with error', (body) => {
    body.error = { type: 'script_exception' };
  }),
];

for (const method of ['PUT', 'GET'] as const) {
  test(`first, middle and last native ${method} reject incomplete, contradictory, malformed and lost receipts and recover`, async () => {
    const target = fresh();
    try {
      for (const [index, name] of installationNames.entries()) {
        const cases: { name: string; change: ReceiptControl }[] = [
          ...(method === 'PUT' ? ackControls : readbackControls),
          {
            name: 'lost completed response',
            change: () => {
              throw new Error('lost native response');
            },
          },
          {
            name: 'transport error after native completion',
            change: () => {
              throw new OpenSearchError(500, { error: { type: 'script_exception' } });
            },
          },
        ];
        for (const control of cases) {
          await removeInstalled(target);
          const { client, calls } = installationTransport(target, (receipt, call) =>
            call.method === method && call.path === `/_scripts/${target}${name}`
              ? control.change(receipt, call)
              : receipt,
          );
          try {
            await expect(installTemplates(client, target)).rejects.toBeInstanceOf(SearchUnavailableError);
            const stop = index * 2 + (method === 'PUT' ? 1 : 2);
            expect(calls.map(({ method, path }) => [method, path])).toEqual(installationPaths(target).slice(0, stop));
            expect(calls.at(-1)!.raw!.status).toBe(200);
            if (method === 'PUT') expect(calls.at(-1)!.raw!.body).toEqual({ acknowledged: true });
            else expect(calls.at(-1)!.raw!.body).toMatchObject({ _id: `${target}${name}`, found: true });
          } finally {
            retainInstallation(`${method} ${name}: ${control.name}`, calls);
          }
          await verifiedInstallation(target);
        }
      }
    } finally {
      await removeInstalled(target);
    }
  }, 240_000);
}

test('actual native script substitution and disappearance cannot establish readiness, and independent callers restore every release', async () => {
  const target = fresh();
  try {
    for (const name of installationNames) {
      for (const substitute of ['source', 'options', 'delete'] as const) {
        const { client, calls } = installationTransport(target, async (receipt, call) => {
          if (call.method === 'PUT' && call.path.endsWith(name)) {
            if (substitute === 'delete') await search.request('DELETE', call.path);
            else
              await search.request('PUT', call.path, {
                script: {
                  lang: 'mustache',
                  source: '{"query":{"match_all":{}}}',
                  ...(substitute === 'options' ? { options: { content_type: 'text/plain' } } : {}),
                },
              });
          }
          return receipt;
        });
        try {
          await expect(installTemplates(client, target)).rejects.toBeInstanceOf(SearchUnavailableError);
          expect(calls.at(-1)!.method).toBe('GET');
          expect(calls.at(-1)!.raw!.status).toBe(substitute === 'delete' ? 404 : 200);
        } finally {
          retainInstallation(`actual ${name} ${substitute}`, calls);
        }
        await verifiedInstallation(target);
        await verifiedInstallation(target);
      }
    }
  } finally {
    await removeInstalled(target);
  }
}, 120_000);

test('completed transport request and receipt mutation cannot alter any later release or independent installation', async () => {
  const target = fresh();
  const calls: InstallationCall[] = [];
  const mutating: OpenSearch = {
    bulk: search.bulk,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const [method, path, body] = args;
      const raw = await search.request<T>(...args);
      calls.push({ method, path, body: structuredClone(body), raw: structuredClone(raw) });
      if (method === 'PUT') (body as { script: { source: string } }).script.source = 'transport-owned mutation';
      const returned = structuredClone(raw);
      // A retained response may be mutated by the transport after the adapter has consumed it.
      setTimeout(() => {
        (returned as Receipt).body = null;
      }, 0);
      return returned;
    },
  };
  try {
    await installTemplates(mutating, target);
    await installTemplates(mutating, target);
    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ...installationPaths(target),
      ...installationPaths(target),
    ]);
    await verifiedInstallation(target);
  } finally {
    retainInstallation('request and retained receipt mutation', calls);
    await removeInstalled(target);
  }
}, 120_000);

test('all released native callers still execute after recovery, including facet templates', async () => {
  await verifiedInstallation(prefix);
  expect((await countFacets(search, prefix, { facets: [{ property: 'type', size: 10 }], sample: 100 })).facets).toEqual(
    [
      {
        property: 'type',
        relation: 'exact',
        values: [
          { value: 'schema:Book', count: 4 },
          { value: 'schema:Recipe', count: 1 },
        ],
      },
    ],
  );
});

test('installation work stays fixed at 64, 512 and 4096 unrelated native documents and scripts', async () => {
  const target = fresh();
  const noise: string[] = [];
  let baseline: { method: string; path: string; body: unknown; bytes: number }[] | undefined;
  await createSubjectIndex(search, target, 1);
  try {
    for (const scale of [64, 512, 4096]) {
      const previous = noise.length;
      // Fixture setup and cleanup are bounded batches, separate from the measured installation invocation.
      for (let start = previous; start < scale; start += 16) {
        await Promise.all(
          Array.from({ length: Math.min(16, scale - start) }, async (_, offset) => {
            const path = `/_scripts/${target}noise-${start + offset}`;
            noise.push(path);
            expect(
              await search.request('PUT', path, { script: { lang: 'mustache', source: '{"query":{"match_all":{}}}' } }),
            ).toEqual({ status: 200, body: { acknowledged: true } });
          }),
        );
      }
      for (let start = previous; start < scale; start += 512) {
        const subjects = Array.from({ length: Math.min(512, scale - start) }, (_, offset) =>
          subject(start + offset + 1, 'Unrelated'),
        );
        const actions = documentActions(
          { partition: 10, position: 1n, subjects },
          subjects.map(({ id }) => id),
        );
        const bulk = await search.bulk<{ errors: boolean }>(bulkLines(subjectIndexName(target, 1), actions), {
          query: { refresh: 'wait_for' },
        });
        expect(bulk.errors).toBe(false);
      }
      expect(
        (await search.request<{ count: number }>('GET', `/${subjectIndexName(target, 1)}/_count`)).body.count,
      ).toBe(scale);
      const calls = await verifiedInstallation(target);
      const work = calls.map(({ method, path, body }) => ({
        method,
        path,
        body,
        bytes: body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body)),
      }));
      baseline ??= work;
      expect(work).toEqual(baseline);
      // Repeated and failed work remain visible at every scale, without discovery or a private installed registry.
      expect((await verifiedInstallation(target)).map(({ method, path, body }) => ({ method, path, body }))).toEqual(
        calls.map(({ method, path, body }) => ({ method, path, body })),
      );
      const failed = installationTransport(target, (receipt, call) =>
        call.method === 'GET' && call.path.endsWith(SUGGEST_TEMPLATE)
          ? { ...receipt, body: { ...(receipt.body as object), found: false } }
          : receipt,
      );
      try {
        await expect(installTemplates(failed.client, target)).rejects.toBeInstanceOf(SearchUnavailableError);
        expect(failed.calls.map(({ method, path }) => [method, path])).toEqual(installationPaths(target).slice(0, 4));
      } finally {
        retainInstallation(`scale ${scale} failed readback`, failed.calls);
      }
      await verifiedInstallation(target);
      console.info('native installation growth', JSON.stringify({ scale, work }));
    }
  } finally {
    await search.request('DELETE', `/${subjectIndexName(target, 1)}`);
    await removeInstalled(target);
    for (let start = 0; start < noise.length; start += 16)
      await Promise.all(noise.slice(start, start + 16).map((path) => search.request('DELETE', path)));
  }
}, 600_000);

test('native compiler option substitution with unchanged released source fails and recovers every version', async () => {
  const target = fresh();
  try {
    for (const name of installationNames) {
      const substitutions: Receipt[] = [];
      const { client, calls } = installationTransport(target, async (receipt, call) => {
        if (call.method === 'PUT' && call.path === `/_scripts/${target}${name}`) {
          const replacement = structuredClone(call.body) as { script: Record<string, unknown> };
          replacement.script.options = { content_type: 'text/plain' };
          // Change only native compiler options; a changed source must not mask an options comparison defect.
          substitutions.push(await search.request('PUT', call.path, replacement));
        }
        return receipt;
      });
      try {
        await expect(installTemplates(client, target)).rejects.toBeInstanceOf(SearchUnavailableError);
        expect(substitutions).toEqual([{ status: 200, body: { acknowledged: true } }]);
        const put = calls.at(-2)!;
        const get = calls.at(-1)!;
        expect([put.method, get.method]).toEqual(['PUT', 'GET']);
        expect(get.raw).toEqual({
          status: 200,
          body: {
            _id: `${target}${name}`,
            found: true,
            script: {
              ...(put.body as { script: object }).script,
              options: { content_type: 'text/plain' },
            },
          },
        });
      } finally {
        console.info('native option substitution', JSON.stringify({ name, substitutions }));
        retainInstallation('unchanged released source with substituted options', calls);
      }
      await verifiedInstallation(target);
    }
  } finally {
    await removeInstalled(target);
  }
}, 120_000);

test('genuine recovery preserves an existing older released template byte for byte', async () => {
  const target = fresh();
  const older = `/_scripts/${target}subjects-search-v1`;
  const released = JSON.parse(
    readFileSync(new URL('../../db/search/templates/subjects-search-v1.json', import.meta.url), 'utf8'),
  ) as { script: unknown };
  try {
    expect(await search.request('PUT', older, structuredClone(released))).toEqual({
      status: 200,
      body: { acknowledged: true },
    });
    const original = await search.request('GET', older);
    expect(original).toEqual({
      status: 200,
      body: { _id: `${target}subjects-search-v1`, found: true, script: released.script },
    });
    const { client, calls } = installationTransport(target, (receipt, call) => {
      if (call.method === 'GET' && call.path.endsWith(SUGGEST_TEMPLATE)) throw new Error('lost native readback');
      return receipt;
    });
    try {
      await expect(installTemplates(client, target)).rejects.toBeInstanceOf(SearchUnavailableError);
      expect(calls.map(({ method, path }) => [method, path])).toEqual(installationPaths(target).slice(0, 4));
    } finally {
      retainInstallation('partial installation beside existing older release', calls);
    }
    for (let caller = 0; caller < 2; caller++) {
      await verifiedInstallation(target);
      const retained = await search.request('GET', older);
      expect(retained).toEqual(original);
      console.info('native retained older release', JSON.stringify({ caller, retained }));
    }
  } finally {
    await removeInstalled(target);
    await search.request('DELETE', older);
  }
}, 120_000);
