import { expect, test } from 'bun:test';
import { createOpenSearch, SearchUnavailableError, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectAlias, subjectGenerations, subjectIndexName } from '../../src/search/indices.ts';

test('contradictory duplicate alias receipts cannot choose their first native target', async () => {
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `metadata-${crypto.randomUUID().slice(0, 8)}-`;
  const first = subjectIndexName(prefix, 1),
    second = subjectIndexName(prefix, 2),
    alias = subjectAlias(prefix);
  await createSubjectIndex(native, prefix, 1);
  await createSubjectIndex(native, prefix, 2);
  try {
    await native.request('POST', '/_aliases', { actions: [{ add: { index: first, alias } }] });
    const client: OpenSearch = {
      bulk: native.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await native.request<T>(...args);
        if (!args[1].startsWith('/_resolve/index/')) return response;
        const body = structuredClone(response.body) as { aliases: { name: string; indices: string[] }[] };
        expect(body.aliases.find((value) => value.name === alias)?.indices).toEqual([first]);
        body.aliases.push({ name: alias, indices: [second] });
        return { ...response, body: body as T };
      },
    };
    await expect(subjectGenerations(client, prefix)).rejects.toBeInstanceOf(SearchUnavailableError);
  } finally {
    await native.request('DELETE', `/${first}`);
    await native.request('DELETE', `/${second}`);
  }
});
