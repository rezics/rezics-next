import { expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import {
  createSubjectIndex,
  readSubjectSortFormat,
  subjectGenerations,
  subjectIndexName,
} from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../src/search/opensearch.ts';
import { FACET_TEMPLATE, SEARCH_TEMPLATE, SUGGEST_TEMPLATE } from '../../src/search/query.ts';
import { startSearchIndexing } from '../../src/search/runner.ts';
import { createSearchService, type SearchRequest } from '../../src/search/service.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSemanticDriver } from '../semantic/outcome-driver.ts';

type Native = { hits: { hits: { _id: string }[] } };

test('direct catalogue pagination returns the original Books on a steady generation', async () => {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}-`;
  const index = subjectIndexName(prefix, 1);
  const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
  let driver: Awaited<ReturnType<typeof createSemanticDriver>> | undefined;
  let runner: Awaited<ReturnType<typeof startSearchIndexing>> | undefined;
  try {
    let application!: ReturnType<typeof createKernel>;
    driver = await createSemanticDriver((dependencies) => {
      application = createKernel({
        ...dependencies,
        search: createSearchService({
          pool: dependencies.pool,
          client: engine,
          prefix,
          source: subjectSource(dependencies.pool, dependencies.routeKey),
          cursors: dependencies.tokens!,
        }),
      });
      return application;
    });
    await driver.fixtures.openFeatures(['search', 'search_advanced']);
    const pool = driver.fixtures.pool;
    const source = subjectSource(pool, Buffer.from(driver.fixtures.runtime.routeKey, 'base64url'));
    async function request(body: SearchRequest) {
      return application.handle(
        new Request('https://kernel.test/v1/subjects:search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    }
    const ids: string[] = [];
    for (const suffix of ['Alpha', 'Zeta']) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        { type: 'schema:Book', labels: { en: `Cataloguebook ${suffix}` }, statements: {} },
        { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ids.push((created.body.subject as { id: string }).id);
    }
    // The relay publishes native activation metadata before admitting the read alias.
    await createSubjectIndex(engine, prefix, 1);
    runner = await startSearchIndexing({
      pool,
      search: engine,
      prefix,
      source,
      listing: subjectListingSource(pool),
      intervalMs: 20,
      discoverMs: 60_000,
    });
    const deadline = Date.now() + 30_000;
    for (;;) {
      const native = (await engine.request<Native>('POST', `/${index}/_search`, { size: 10 })).body;
      if (native.hits.hits.length === ids.length) {
        expect(native.hits.hits.map(({ _id }) => _id).sort()).toEqual([...ids].sort());
        break;
      }
      if (Date.now() >= deadline) throw new Error('Search did not index the original Books before the deadline');
      await Bun.sleep(50);
    }
    await runner.pause();
    for (const id of ids) {
      const snapshot = await source.read(subjectPartition(id), [id]);
      expect(snapshot.subjects.map((subject) => subject.id)).toEqual([id]);
      expect(snapshot.position).toBeGreaterThan(0n);
    }
    expect(await readSubjectSortFormat(engine, prefix, 1)).toBe(1);
    const base: SearchRequest = { text: 'Cataloguebook', sort: 'name', limit: 1 };
    const first = await request(base);
    const page = await first.json();
    expect(first.status, JSON.stringify(page)).toBe(200);
    expect(page.subjects).toHaveLength(1);
    expect(ids).toContain(page.subjects[0].id);
    expect(page.next).toBeString();
    const next = await request({ ...base, cursor: page.next });
    expect(next.status).toBe(200);
    const second = await next.json();
    expect(second.subjects).toHaveLength(1);
    expect(new Set([page.subjects[0].id, second.subjects[0].id])).toEqual(new Set(ids));
    if (second.next !== null) {
      const last = await request({ ...base, cursor: second.next });
      expect(last.status).toBe(200);
      expect(await last.json()).toMatchObject({ subjects: [], next: null });
    }
    const emptyRequest: SearchRequest = { text: 'Absentcataloguebook', sort: 'name', limit: 1 };
    const empty = await request(emptyRequest);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ subjects: [], next: null });
  } finally {
    try {
      await runner?.stop();
    } finally {
      try {
        const state = await subjectGenerations(engine, prefix);
        for (const generation of state.generations)
          await engine.request('DELETE', `/${subjectIndexName(prefix, generation)}`);
        for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
          try {
            await engine.request('DELETE', `/_scripts/${prefix}${template}`);
          } catch (error) {
            if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
          }
        }
      } finally {
        await driver?.close();
      }
    }
  }
}, 180_000);
