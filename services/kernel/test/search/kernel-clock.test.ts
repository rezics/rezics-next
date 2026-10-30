import { expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { documentActions, bulkLines } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch } from '../../src/search/opensearch.ts';
import { createSearchService } from '../../src/search/service.ts';
import { createFakeSource } from './support/fake-source.ts';

test('an actual native continuation expires using the injected module clock instead of wall Date.now', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `clock-${crypto.randomUUID().slice(0, 8)}-`,
    index = subjectIndexName(prefix, 1);
  const source = createFakeSource();
  let now = Date.now() - 2 * 60 * 60_000;
  const subjects = [1, 2, 3].map((n) => ({
    id: `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`,
    type: 'schema:Book',
    visibility: 'visible' as const,
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: `Clock ${n}` }],
    aliases: [],
    descriptions: [],
    statements: [],
  }));
  try {
    await createSubjectIndex(engine, prefix, 1);
    await engine.request('POST', '/_aliases', { actions: [{ add: { index, alias: subjectAlias(prefix) } }] });
    for (const subject of subjects) source.put(subject);
    await engine.bulk(
      bulkLines(
        index,
        documentActions(
          { partition: 10, position: 7n, subjects },
          subjects.map((s) => s.id),
        ),
      ),
      { query: { refresh: 'wait_for' } },
    );
    const dependencies = {
      pool,
      client: engine,
      prefix,
      source,
      cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(11)]]) },
    };
    Object.defineProperty(dependencies, 'clock', { value: () => new Date(now), enumerable: true });
    const service = createSearchService(dependencies);
    const page = await service.search('anonymous', { sort: 'id', limit: 1 });
    expect(typeof page.next).toBe('string');
    now += 16 * 60_000;
    await expect(service.search('anonymous', { sort: 'id', limit: 1, cursor: page.next! })).rejects.toMatchObject({
      code: 'search_restart_required',
    });
  } finally {
    await engine.request('DELETE', `/${index}`).catch(() => undefined);
    for (const name of ['subjects-hits-v1', 'subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1'])
      await engine.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
    await pool.end();
  }
}, 60_000);
