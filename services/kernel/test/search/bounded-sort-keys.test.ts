import { expect, test } from 'bun:test';
import { bulkLines, documentActions, type IndexAction } from '../../src/search/document.ts';
import { createSubjectIndex, subjectIndexDefinition, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import type { IndexedSubject } from '../../src/search/source.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
type Token = { token: string; position: number; start_offset: number; end_offset: number };
type Analysis = { tokens: Token[] };
type Hit = { _id: string; sort: (string | null)[] };
type Hits = { hits: { hits: Hit[] } };
type Prepare = (search: OpenSearch, index: string, actions: IndexAction[]) => Promise<IndexAction[]>;

function subject(n: number, name: string | null): IndexedSubject {
  return {
    id: `018f0000-0000-7000-8000-00b0${String(n).padStart(8, '0')}`,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 7,
    labels: name === null ? [] : [{ language: 'en', value: name }],
    aliases: [{ language: 'en', value: 'Full alias' }],
    descriptions: [{ language: 'en', value: 'Full description' }],
    statements: [{ property: 'schema:code', value: 'ABC', facet: { kind: 'code' } }],
    relationFacetOverflow: ['schema:author'],
  };
}

function actionsFor(subjects: IndexedSubject[]): IndexAction[] {
  return documentActions(
    { partition: 11, position: 41n, subjects },
    subjects.map(({ id }) => id),
    new Map(subjects.map(({ id }) => [id, 3])),
  );
}

async function nativeKey(index: string, text: string): Promise<string> {
  const { body } = await search.request<Analysis>('POST', `/${index}/_analyze`, {
    normalizer: 'name_key',
    text,
  });
  expect(body.tokens).toHaveLength(1);
  return body.tokens[0]!.token;
}

// A transparent observer: all successful normalization comes from the real target index.
function observe(index: string) {
  const requests: { texts: string[]; tokens: Token[] }[] = [];
  let active = 0;
  let maximum = 0;
  let bulks = 0;
  const client: OpenSearch = {
    request: (async (method, path, body, options) => {
      expect(method).toBe('POST');
      expect(path).toBe(`/${index}/_analyze`);
      const input = body as { normalizer: string; text: string | string[] };
      expect(input.normalizer).toBe('name_key');
      const texts = typeof input.text === 'string' ? [input.text] : input.text;
      expect(texts.length).toBeGreaterThan(0);
      expect(texts.length).toBeLessThanOrEqual(256);
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        const result = await search.request<Analysis>(method, path, body, options);
        requests.push({ texts: [...texts], tokens: result.body.tokens });
        return result;
      } finally {
        active -= 1;
      }
    }) as OpenSearch['request'],
    bulk: (async () => {
      bulks += 1;
      throw new Error('preparation must finish before bulk');
    }) as OpenSearch['bulk'],
  };
  return { client, requests, maximum: () => maximum, bulks: () => bulks };
}

test('native normalization bounds complete name sort values on writes while preserving full names and stable null pagination', async () => {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const mechanics = `${prefix}mapper`;
  const created: string[] = [];
  try {
    const root = await search.request<{ version: { number: string } }>('GET', '/');
    expect(root.body.version.number).toMatch(/^3\./);
    const plugins = await search.request<{ component: string }[]>('GET', '/_cat/plugins', undefined, {
      query: { format: 'json' },
    });
    expect(plugins.body.map(({ component }) => component)).toContain('analysis-icu');
    await createSubjectIndex(search, prefix, 1);
    created.push(index);
    const definition = structuredClone(subjectIndexDefinition()) as {
      mappings: { properties: { name_sort: Record<string, unknown> } };
    };
    definition.mappings.properties.name_sort.ignore_above = 512;
    await search.request('PUT', `/${mechanics}`, definition);
    created.push(mechanics);

    const expanded = '\uFDFA'.repeat(250);
    const cjk = '漢'.repeat(250);
    const fullKey = await nativeKey(index, expanded);
    expect(expanded.length).toBe(250);
    expect(fullKey.length).toBe(4500);
    expect(Buffer.byteLength(fullKey)).toBe(8250);
    expect(await nativeKey(index, cjk)).toBe(cjk);

    // Direct mapper fixtures, not semantic labels: Java String.length counts UTF-16 units.
    const rawFixtures = [expanded, 'x'.repeat(512), 'x'.repeat(513), '𠀀'.repeat(256), '𠀀'.repeat(257)];
    const baseline = await search.bulk<{ errors: boolean }>(
      rawFixtures.flatMap((name_sort, n) => [
        { index: { _index: mechanics, _id: String(n) } },
        { id: String(n), name_sort },
      ]),
      { query: { refresh: 'wait_for' } },
    );
    expect(baseline.errors).toBe(false);
    const probe = await search.request<Hits>('POST', `/${mechanics}/_search`, {
      size: 10,
      sort: [{ id: 'asc' }, { name_sort: { order: 'asc', missing: '_last' } }],
    });
    expect(probe.body.hits.hits.map(({ sort }) => sort[1])).toEqual([
      fullKey,
      rawFixtures[1],
      null,
      rawFixtures[3],
      null,
    ]);

    // The intended red is a missing production preparation helper, after a proven native baseline.
    const moduleUrl = new URL('../../src/search/bounded-sort-keys.ts', import.meta.url).href;
    const { prepareBoundedSortKeys: prepare } = (await import(moduleUrl)) as { prepareBoundedSortKeys: Prepare };
    expect(prepare).toBeFunction();
    const boundary = '\uFDFA'.repeat(28) + 'Ａ'.repeat(8);
    const supplementary = '\uFDFA'.repeat(27) + '𠀀'.repeat(13);
    const names = [expanded, cjk, 'ＲＵＳＴ', 'ＲＵＳＴ', boundary, boundary + 'a', supplementary, supplementary + 'a'];
    expect(names.every((name) => name.length <= 250)).toBe(true);
    const originals = actionsFor(names.map((name, n) => subject(n + 1, name)));
    const nullAction = actionsFor([subject(90, null)])[0]!;
    if (nullAction.op !== 'index') throw new Error('expected visible document');
    // Exercise an already-null key independently of the document builder's missing-name policy.
    Reflect.set(nullAction.document, 'name_sort', null);
    const hidden = { ...subject(91, 'Do not analyze hidden names'), visibility: 'hidden' as const };
    originals.push(nullAction, ...actionsFor([hidden]));
    const before = structuredClone(originals);
    const expected = await Promise.all(names.map((name) => nativeKey(index, name)));
    expect(expected[4]!.length).toBe(512);
    expect(expected[5]!.length).toBe(513);
    expect(expected[6]!.length).toBe(512);
    expect(expected[7]!.length).toBe(513);
    const observed = observe(index);
    const prepared = await prepare(observed.client, index, originals);
    expect(originals).toEqual(before);
    expect(prepared).toHaveLength(originals.length);
    for (const [n, action] of prepared.entries()) {
      const original = before[n]!;
      if (action.op === 'delete' || original.op === 'delete') {
        expect(action).toEqual(original);
        continue;
      }
      expect(action).toEqual({
        ...original,
        document: {
          ...original.document,
          name_sort: n < names.length ? (expected[n]!.length <= 512 ? expected[n] : null) : null,
        },
      });
    }
    expect(observed.bulks()).toBe(0);
    expect(observed.requests.flatMap(({ texts }) => texts).sort()).toEqual([...new Set(names)].sort());
    for (const { texts, tokens } of observed.requests) {
      expect(tokens.map(({ token }) => token)).toEqual(await Promise.all(texts.map((text) => nativeKey(index, text))));
      // Real array responses must preserve one token per input, including duplicates at call boundaries.
      expect(tokens).toHaveLength(texts.length);
    }

    const bulk = await search.bulk<{ errors: boolean }>(bulkLines(index, prepared), {
      query: { refresh: 'wait_for' },
    });
    expect(bulk.errors).toBe(false);
    for (const action of prepared) {
      if (action.op === 'delete') continue;
      const stored = await search.request<{ _version: number; _source: unknown }>('GET', `/${index}/_doc/${action.id}`);
      expect(stored.body).toMatchObject({ _version: 41, _source: action.document });
    }
    const exact = await search.request<Hits>('POST', `/${index}/_search`, {
      query: { term: { 'names.exact': expanded } },
    });
    expect(exact.body.hits.hits.map(({ _id }) => _id)).toEqual([subject(1, expanded).id]);
    const sort = [{ name_sort: { order: 'asc', missing: '_last' } }, { id: 'asc' }];
    const all = await search.request<Hits>('POST', `/${index}/_search`, { size: 100, sort });
    const pageHits: Hit[] = [];
    let after: (string | null)[] | undefined;
    for (let page = 0; page <= prepared.length; page += 1) {
      const response = await search.request<Hits>('POST', `/${index}/_search`, {
        size: 2,
        sort,
        ...(after ? { search_after: after } : {}),
      });
      const hits = response.body.hits.hits;
      if (hits.length === 0) break;
      pageHits.push(...hits);
      after = hits.at(-1)!.sort;
      expect(page).toBeLessThan(prepared.length);
    }
    expect(pageHits).toEqual(all.body.hits.hits);
    expect(new Set(pageHits.map(({ _id }) => _id)).size).toBe(9);
    const missing = pageHits.filter(({ sort }) => sort[0] === null);
    expect(missing.map(({ _id }) => _id)).toEqual([1, 6, 8, 90].map((n) => subject(n, null).id));
    expect(pageHits.slice(-missing.length)).toEqual(missing);
    expect(pageHits.find(({ _id }) => _id === subject(1, null).id)!.sort).toEqual([null, subject(1, null).id]);

    // More than one chunk of distinct admitted names, interleaved duplicates and normalization collisions.
    const manyNames = Array.from({ length: 257 }, (_, n) => `Ｋｅｙ ${n}`);
    const many = actionsFor([...manyNames, ...manyNames, 'key 0'].map((name, n) => subject(1000 + n, name)));
    const manyBefore = structuredClone(many);
    const batches = observe(index);
    const bounded = await prepare(batches.client, index, many);
    expect(many).toEqual(manyBefore);
    expect(batches.requests.flatMap(({ texts }) => texts).sort()).toEqual([...manyNames, 'key 0'].sort());
    expect(batches.maximum()).toBeLessThanOrEqual(256);
    const native = new Map<string, string>();
    for (const { texts, tokens } of batches.requests) {
      const keys = await Promise.all(texts.map((text) => nativeKey(index, text)));
      expect(tokens.map(({ token }) => token)).toEqual(keys);
      texts.forEach((text, n) => native.set(text, keys[n]!));
    }
    for (const [n, action] of bounded.entries()) {
      const original = manyBefore[n]!;
      if (action.op !== 'index' || original.op !== 'index') throw new Error('expected index action');
      expect(action).toEqual({
        ...original,
        document: { ...original.document, name_sort: native.get(original.document.name_sort) },
      });
    }
    // Per-value fallback costs one real request per DISTINCT name; never describe it as one batched request.
    if (batches.requests.every(({ texts }) => texts.length === 1)) expect(batches.requests).toHaveLength(258);
    else expect(batches.requests.length).toBeGreaterThanOrEqual(2);

    const empty = observe(index);
    expect(await prepare(empty.client, index, [nullAction, originals.at(-1)!])).toEqual([
      nullAction,
      originals.at(-1)!,
    ]);
    expect(empty.requests).toEqual([]);
    expect(await prepare(empty.client, index, [])).toEqual([]);

    // Only negative transport/shape cases are faked. The helper is a preparation boundary, not an indexer proof.
    for (const malformed of [
      {},
      { tokens: [] },
      { tokens: [{ token: 42 }] },
      { tokens: [{ token: null }] },
      { tokens: [{ token: 'a' }, { token: 'b' }] },
      { tokens: [{ token: '\uD800' }] },
    ]) {
      let writes = 0;
      let checkpoint = 41n;
      const broken: OpenSearch = {
        request: (async () => ({ status: 200, body: malformed })) as OpenSearch['request'],
        bulk: (async () => {
          writes += 1;
        }) as OpenSearch['bulk'],
      };
      const input = actionsFor([subject(8000, 'ＲＵＳＴ')]);
      const saved = structuredClone(input);
      await expect(
        (async () => {
          const output = await prepare(broken, index, input);
          await broken.bulk(bulkLines(index, output));
          checkpoint = 42n;
        })(),
      ).rejects.toThrow();
      expect({ writes, checkpoint }).toEqual({ writes: 0, checkpoint: 41n });
      expect(input).toEqual(saved);
    }
    const failure = new Error('native analyze unavailable');
    const unavailable: OpenSearch = {
      request: () => Promise.reject(failure),
      bulk: (async () => {
        throw new Error('must not bulk');
      }) as OpenSearch['bulk'],
    };
    await expect(prepare(unavailable, index, actionsFor([subject(8001, expanded)]))).rejects.toThrow();
  } finally {
    for (const name of created.reverse()) await search.request('DELETE', `/${name}`);
  }
}, 120_000);
