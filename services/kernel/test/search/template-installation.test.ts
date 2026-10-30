import { expect, test } from 'bun:test';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import * as query from '../../src/search/query.ts';

test('a real executed template PUT with a negative receipt cannot finish installation', async () => {
  const native = createOpenSearch(process.env.OPENSEARCH_URL!),
    prefix = `install-${crypto.randomUUID().slice(0, 8)}-`;
  const owned = new Set<string>();
  const controlled: OpenSearch = {
    bulk: native.bulk,
    async request<T>(...args: Parameters<OpenSearch['request']>) {
      const response = await native.request<T>(...args);
      if (args[0] === 'PUT' && args[1].startsWith(`/_scripts/${prefix}`)) {
        owned.add(args[1]);
        return { ...response, body: { ...(response.body as object), acknowledged: false } as T };
      }
      return response;
    },
  };
  try {
    await expect(query.installTemplates(controlled, prefix)).rejects.toBeInstanceOf(Error);
  } finally {
    for (const path of owned) await native.request('DELETE', path);
  }
});
