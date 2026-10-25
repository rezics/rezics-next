import { expect, test } from 'bun:test';
import { createOpenSearch, OpenSearchError, SearchUnavailableError } from '../../src/search/opensearch.ts';

const url = process.env.OPENSEARCH_URL;
if (!url) throw new Error("OPENSEARCH_URL must name the check's OpenSearch node");
const search = createOpenSearch(url);
const index = `test-node-${crypto.randomUUID()}`;

test("the check's OpenSearch node is 3.x with analysis-icu and answers through the client", async () => {
  const root = await search.request<{ version: { number: string } }>('GET', '/');
  expect(root.status).toBe(200);
  expect(root.body.version.number).toMatch(/^3\.\d+\.\d+/);
  const plugins = await search.request<{ component: string }[]>('GET', '/_cat/plugins', undefined, {
    query: { format: 'json' },
  });
  expect(plugins.body.map((plugin) => plugin.component)).toContain('analysis-icu');
  const analyzed = await search.request<{ tokens: { token: string }[] }>('POST', '/_analyze', {
    tokenizer: 'icu_tokenizer',
    filter: ['icu_folding'],
    text: 'Ｒｕｓｔ',
  });
  expect(analyzed.body.tokens.map((token) => token.token)).toEqual(['rust']);

  await search.request('PUT', `/${index}`, { settings: { number_of_shards: 1, number_of_replicas: 0 } });
  try {
    const bulk = await search.bulk<{ errors: boolean; items: { index: { status: number } }[] }>(
      [
        { index: { _index: index, _id: 'a', version: 5, version_type: 'external' } },
        { name: 'first' },
        { index: { _index: index, _id: 'a', version: 4, version_type: 'external' } },
        { name: 'older' },
      ],
      { query: { refresh: 'wait_for' } },
    );
    expect(bulk.items.map((item) => item.index.status)).toEqual([201, 409]);
    const document = await search.request<{ _version: number; _source: { name: string } }>('GET', `/${index}/_doc/a`);
    expect(document.body).toMatchObject({ _version: 5, _source: { name: 'first' } });
  } finally {
    await search.request('DELETE', `/${index}`);
  }
});

test('client errors carry the status and the OpenSearch error type', async () => {
  const error = await search.request('GET', `/${index}-missing/_doc/a`).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(OpenSearchError);
  expect(error).toMatchObject({ status: 404, type: 'index_not_found_exception' });
});

test('an unreachable node is a typed unavailability', async () => {
  const closed = createOpenSearch('http://127.0.0.1:9', { timeoutMs: 2000 });
  expect(await closed.request('GET', '/').catch((caught: unknown) => caught)).toBeInstanceOf(SearchUnavailableError);
});
