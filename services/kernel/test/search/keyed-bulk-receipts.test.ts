import { expect, test } from 'bun:test';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName } from '../../src/search/indices.ts';
import { documentActions } from '../../src/search/document.ts';
import { IndexWriteError, writeIndexActions } from '../../src/search/write-actions.ts';

test('a real executed bulk receipt for another document cannot acknowledge the submitted key', async () => {
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `keyed-receipt-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const id = '018f0000-0000-7000-8000-00a000000001';
  await createSubjectIndex(native, prefix, 1);
  try {
    const actions = documentActions(
      {
        partition: 10,
        position: 7n,
        subjects: [
          {
            id,
            type: 'schema:Book',
            visibility: 'visible',
            redirect: null,
            securityRevision: 1,
            labels: [{ language: 'en', value: 'Keyed native receipt' }],
            aliases: [],
            descriptions: [],
            statements: [],
          },
        ],
      },
      [id],
    );
    const forged: OpenSearch = {
      request: native.request,
      async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
        const real = await native.bulk<{ items: { index: { _id: string } }[] }>(...args);
        const body = structuredClone(real);
        expect(body.items[0]!.index._id).toBe(id);
        body.items[0]!.index._id = '018f0000-0000-7000-8000-00a000000002';
        return body as T;
      },
    };
    await expect(writeIndexActions(forged, index, actions)).rejects.toBeInstanceOf(IndexWriteError);
    const stored = await native.request<{ _id: string; _version: number }>('GET', `/${index}/_doc/${id}`);
    expect(stored.body._id).toBe(id);
    expect(stored.body._version).toBe(7);
  } finally {
    await native.request('DELETE', `/${index}`);
  }
}, 60_000);
