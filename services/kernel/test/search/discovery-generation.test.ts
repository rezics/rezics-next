import { expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createSearchService } from '../../src/search/service.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSubjectIndex, subjectIndexName, subjectAlias } from '../../src/search/indices.ts';
import { installTemplates, SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../src/search/query.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { newId } from '../../src/route/route.ts';
import { createFakeSource } from './support/fake-source.ts';

test('native suggestions cannot publish their old physical hits after an alias switch', async () => {
  const pool = createPool(process.env.DATABASE_URL!),
    native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `discover-${crypto.randomUUID().slice(0, 8)}-`,
    alias = subjectAlias(prefix);
  const first = subjectIndexName(prefix, 1),
    second = subjectIndexName(prefix, 2),
    id = newId(160);
  const subject = {
    id,
    type: 'schema:Book',
    visibility: 'visible' as const,
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Lantern generation' }],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const source = createFakeSource();
  source.put(subject);
  await createSubjectIndex(native, prefix, 1);
  await createSubjectIndex(native, prefix, 2);
  await installTemplates(native, prefix);
  try {
    await native.bulk(bulkLines(first, documentActions({ partition: 10, position: 1n, subjects: [subject] }, [id])), {
      query: { refresh: 'wait_for' },
    });
    await native.request('POST', '/_aliases', { actions: [{ add: { index: first, alias } }] });
    let switched = false;
    const client: OpenSearch = {
      bulk: native.bulk,
      async request<T>(...args: Parameters<OpenSearch['request']>) {
        const response = await native.request<T>(...args);
        if (!switched && args[1].endsWith('/_search/template')) {
          switched = true;
          await native.request('POST', '/_aliases', {
            actions: [{ remove: { index: first, alias } }, { add: { index: second, alias } }],
          });
        }
        return response;
      },
    };
    const service = createSearchService({
      pool,
      client,
      prefix,
      source,
      cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
    });
    await expect(service.suggest('Lantern')).rejects.toMatchObject({ code: 'search_restart_required' });
    expect(switched).toBe(true);
  } finally {
    await native.request('DELETE', `/${first}`);
    await native.request('DELETE', `/${second}`);
    for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
      await native.request('DELETE', `/_scripts/${prefix}${name}`);
    await pool.end();
  }
}, 60_000);
