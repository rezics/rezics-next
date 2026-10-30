import { expect, test } from 'bun:test';
import { encodeRatingCursor, decodeRatingCursor } from '../../src/search/rating-cursor.ts';
test('rating cursors bind Global eligibility and phase without treating an epoch change as tampering', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'rating', limit: 2 } };
  const context = {
    questionId: '00000000-0000-8000-8000-000000000001',
    populationId: '00000000-0000-8000-8000-000000000000',
    priorEpoch: 1,
  };
  const position = { generation: 3, phase: 'scored' as const, after: [0, 'A', '00000000-0000-8000-8000-00a000000001'] };
  const token = await encodeRatingCursor(ring, binding, context, position, 1000);
  expect(await decodeRatingCursor(ring, binding, context, token, 1001)).toEqual({ ok: true, ...position });
  expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, token, 1001)).toEqual({
    ok: false,
    reason: 'restart',
  });
  expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: null }, token, 1001)).toEqual({
    ok: false,
    reason: 'restart',
  });
  expect(await decodeRatingCursor(ring, { ...binding, principal: 'account:other' }, context, token, 1001)).toEqual({
    ok: false,
    reason: 'invalid',
  });
});

test('rating continuation time boundaries remain independent of prior restart and request binding', async () => {
  const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
  const request = { sort: 'rating', limit: 1, languages: ['en'] };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request };
  const context = {
    questionId: '00000000-0000-8000-8000-000000000001',
    populationId: '00000000-0000-8000-8000-000000000000',
    priorEpoch: 1,
  };
  const position = { generation: 3, phase: 'unscored' as const, after: ['A', '00000000-0000-8000-8000-00a000000001'] };
  const issued = 1_000_000;
  const token = await encodeRatingCursor(ring, binding, context, position, issued);
  for (const elapsed of [899_999, 900_000, -59_999, -60_000])
    expect(await decodeRatingCursor(ring, binding, context, token, issued + elapsed)).toEqual({
      ok: true,
      ...position,
    });
  expect(await decodeRatingCursor(ring, binding, context, token, issued + 900_001)).toEqual({
    ok: false,
    reason: 'expired',
  });
  expect(await decodeRatingCursor(ring, binding, context, token, issued - 60_001)).toEqual({
    ok: false,
    reason: 'invalid',
  });
  expect(await decodeRatingCursor(ring, binding, { ...context, priorEpoch: 2 }, token, issued)).toEqual({
    ok: false,
    reason: 'restart',
  });
  for (const changed of [
    { ...binding, principal: 'account:00000000-0000-8000-8000-00a000000002' },
    { ...binding, request: { ...request, text: 'other' } },
    { ...binding, request: { ...request, languages: ['ja'] } },
  ])
    expect(await decodeRatingCursor(ring, changed, { ...context, priorEpoch: 2 }, token, issued)).toEqual({
      ok: false,
      reason: 'invalid',
    });
});

test('real Access and native Source preserve clock boundaries, restart and bounded continuation work', async () => {
  const { createKernel } = await import('../../src/http/kernel.ts');
  const { createSemanticDriver } = await import('../semantic/outcome-driver.ts');
  const { closeOwnedSemanticAuth } = await import('../semantic/outcome-auth.ts');
  const { subjectSource } = await import('../../src/semantic/search-source.ts');
  const { createPublicRatingSource } = await import('../../src/rating/public-rating-source.ts');
  const { createSearchService } = await import('../../src/search/service.ts');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { createSubjectIndex, subjectAlias, subjectIndexName } = await import('../../src/search/indices.ts');
  const { bulkLines, documentActions } = await import('../../src/search/document.ts');
  const { subjectPartition } = await import('../../src/search/source.ts');
  const { decodeSearchCursor } = await import('../../src/search/cursor.ts');
  const { decodeRatingCursor } = await import('../../src/search/rating-cursor.ts');
  const { LIST_CURSOR_BOUNDS } = await import('../../src/tokens/list-cursor.ts');
  const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `request-clock-${crypto.randomUUID().slice(0, 8)}-`;
  let now: number | undefined;
  let factorySamples = 0;
  const io = { engine: 0, queries: 0, source: 0, keys: 0, rating: 0 };
  let native!: ReturnType<typeof subjectSource>;
  let ratings!: ReturnType<typeof createPublicRatingSource>;
  let search!: ReturnType<typeof createSearchService>;
  let keys!: import('../../src/tokens/seal.ts').KeyRing;
  const driver = await createSemanticDriver(
    (config) => {
      native = subjectSource(config.pool, config.routeKey);
      ratings = createPublicRatingSource(config.pool);
      keys = config.tokens!;
      search = createSearchService({
        pool: config.pool,
        prefix,
        cursors: keys,
        clock: () => {
          factorySamples++;
          return new Date(now ?? Date.now());
        },
        client: {
          bulk: (...args) => engine.bulk(...args),
          async request<T>(...args: Parameters<typeof engine.request>) {
            io.engine++;
            if (args[1].endsWith('/_search/template')) io.queries++;
            return engine.request<T>(...args);
          },
        },
        source: {
          ...native,
          read(partition, ids) {
            io.source++;
            io.keys += ids.length;
            return native.read(partition, ids);
          },
        },
        ratings: {
          epoch() {
            io.rating++;
            return ratings.epoch();
          },
          read(partition, ids) {
            io.rating++;
            return ratings.read(partition, ids);
          },
        },
      });
      return createKernel({ ...config, clock: () => new Date(now ?? Date.now()), search });
    },
    { strictCleanup: true, linkProjection: 'external' },
  );
  const ids: string[] = [];
  let generation = 1;
  async function create(label: string) {
    const response = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: label },
        statements: {},
      },
      { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    ids.push((response.body.subject as { id: string }).id);
  }
  async function publish(target: number, previous?: number) {
    if (target !== previous) await createSubjectIndex(engine, prefix, target);
    const partitions = new Map<number, string[]>();
    for (const id of ids) {
      const partition = subjectPartition(id);
      partitions.set(partition, [...(partitions.get(partition) ?? []), id]);
    }
    for (const [partition, selected] of partitions) {
      const snapshot = await native.read(partition, selected);
      await engine.bulk(bulkLines(subjectIndexName(prefix, target), documentActions(snapshot, selected)), {
        query: { refresh: 'wait_for' },
      });
    }
    if (target !== previous)
      await engine.request('POST', '/_aliases', {
        actions: [
          ...(previous === undefined
            ? []
            : [{ remove: { index: subjectIndexName(prefix, previous), alias: subjectAlias(prefix) } }]),
          { add: { index: subjectIndexName(prefix, target), alias: subjectAlias(prefix) } },
        ],
      });
    generation = target;
  }
  const request = (body: unknown, persona: 'anonymous' | 'editor' | 'suspended' = 'anonymous') =>
    driver.request(persona, 'POST', '/v1/subjects:search', body);
  function problem(response: Awaited<ReturnType<typeof request>>, status: number, code: string) {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(response.body).toMatchObject({ code, effect_status: 'not_applicable' });
  }
  try {
    // Current default fixture exposes only personal_library/reading_progress controls; this public Search
    // surface needs neither. No additional gate, persona, scope or grant is provisioned here.
    for (let n = 0; n < 3; n++) await create(`Clockprobe ${n}`);
    await publish(1);
    const issued = Date.now() + 2 * 60 * 60_000;
    now = issued;
    for (const sort of ['id', 'rating'] as const) {
      const body = { text: 'Clockprobe', sort, limit: 1, languages: ['en'] };
      const scope = { operation: 'subjects.search', principal: 'anonymous', request: body };
      const first = await request(body);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.body.subjects as unknown[]).toHaveLength(1);
      expect(Date.parse(first.body.as_of as string)).toBeLessThan(issued);
      const cursor = first.body.next as string;
      expect(cursor).toBeString();
      const decoded =
        sort === 'rating'
          ? await decodeRatingCursor(keys, scope, await ratings.epoch(), cursor, issued)
          : await decodeSearchCursor(keys, scope, cursor, issued);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error('Native cursor failed its issue-time binding');
      expect(decoded.generation).toBe(1);
      expect(decoded.after.at(-1)).toBe((first.body.subjects as { id: string }[])[0]!.id);
      for (const elapsed of [899_999, 900_000, -59_999, -60_000]) {
        now = issued + elapsed;
        const next = await request({ ...body, cursor });
        expect(next.status, JSON.stringify(next.body)).toBe(200);
        expect((next.body.subjects as { id: string }[])[0]!.id).not.toBe(decoded.after.at(-1));
      }
      now = issued + 900_001;
      let before = { ...io };
      problem(await request({ ...body, cursor }), 409, 'search_restart_required');
      expect(io).toEqual(before);
      expect((await request(body)).status).toBe(200); // Explicit fresh restart at the advanced clock.
      now = issued - 60_001;
      before = { ...io };
      problem(await request({ ...body, cursor }), 400, 'invalid_request');
      expect(io).toEqual(before);
      now = issued;
      for (const changed of [
        { ...body, text: 'Other' },
        { ...body, languages: ['ja'] },
        { ...body, limit: 2 },
      ]) {
        before = { ...io };
        problem(await request({ ...changed, cursor }), 400, 'invalid_request');
        expect(io).toEqual(before);
      }
      before = { ...io };
      problem(await request({ ...body, cursor }, 'editor'), 400, 'invalid_request');
      expect(io).toEqual(before);
      for (const token of [
        'malformed',
        `${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`,
        'x'.repeat(LIST_CURSOR_BOUNDS.search.maxTokenLength + 1),
      ]) {
        before = { ...io };
        problem(await request({ ...body, cursor: token }), 400, 'invalid_request');
        expect(io).toEqual(before);
      }
      before = { ...io };
      problem(await request({ ...body, cursor }, 'suspended'), 401, 'invalid_credentials');
      expect(io).toEqual(before);
    }
    const facets = await driver.request('anonymous', 'POST', '/v1/subjects:facets', {
      text: 'Clockprobe',
      facets: [{ property: 'type' }],
      languages: ['en'],
    });
    expect(facets.status, JSON.stringify(facets.body)).toBe(200);
    expect((facets.body.facets as { values: { value: string }[] }[])[0]!.values.map((value) => value.value)).toContain(
      'schema:Book',
    );
    expect(Date.parse(facets.body.as_of as string)).toBeLessThan(issued);
    expect(factorySamples).toBe(0); // Routes supply the resolved clock, bypassing the factory default.
    const directBody = { text: 'Clockprobe', sort: 'id' as const, limit: 1 };
    const direct = await search.search('anonymous', directBody);
    expect(factorySamples).toBe(1);
    await expect(
      search.search('anonymous', { ...directBody, cursor: direct.next! }, issued + 900_001),
    ).rejects.toMatchObject({ code: 'search_restart_required' });
    expect(factorySamples).toBe(1); // Explicit numeric callers retain their exact contract.

    const ratingBody = { ...directBody, sort: 'rating' as const };
    const old = await request(directBody);
    const oldRating = await request(ratingBody);
    await publish(2, 1);
    for (const [body, page] of [
      [directBody, old],
      [ratingBody, oldRating],
    ] as const) {
      const before = { ...io };
      problem(await request({ ...body, cursor: page.body.next }), 409, 'search_restart_required');
      expect(io.queries).toBe(before.queries);
      expect(io.source).toBe(before.source);
      expect((await request(body)).status).toBe(200);
    }
    const fresh = await request(directBody);
    expect(fresh.status).toBe(200);
    const current = await decodeSearchCursor(
      keys,
      { operation: 'subjects.search', principal: 'anonymous', request: directBody },
      fresh.body.next as string,
      now,
    );
    expect(current.ok && current.generation).toBe(2);

    // Three unrelated native populations must not increase request work. Count actual transport and Source keys,
    // not returned page length or elapsed time. This is a request bound, not whole-page physical cost proof.
    const receipts = [];
    let unrelated = 0;
    for (const scale of [1, 4, 12]) {
      now = undefined; // New native writes keep their ordinary command time.
      while (unrelated < scale) await create(`Unrelated ${unrelated++}`);
      await publish(generation, generation);
      now = issued;
      const start = { ...io };
      expect((await request(directBody)).status).toBe(200);
      expect((await request(ratingBody)).status).toBe(200);
      receipts.push(
        Object.fromEntries(Object.entries(io).map(([key, value]) => [key, value - start[key as keyof typeof io]])),
      );
      const refused = { ...io };
      now = issued + 900_001;
      problem(await request({ ...directBody, cursor: direct.next }), 409, 'search_restart_required');
      expect(io).toEqual(refused);
      now = issued;
      problem(await request({ ...directBody, cursor: 'malformed' }), 400, 'invalid_request');
      problem(await request({ ...ratingBody, cursor: 'malformed' }), 400, 'invalid_request');
      expect(io).toEqual(refused);
    }
    expect(receipts[1]).toEqual(receipts[0]);
    expect(receipts[2]).toEqual(receipts[0]);
  } finally {
    await driver.close();
    await closeOwnedSemanticAuth();
    for (const target of [1, 2])
      await engine.request('DELETE', `/${subjectIndexName(prefix, target)}`).catch(() => undefined);
    for (const name of ['subjects-hits-v1', 'subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1'])
      await engine.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
}, 120_000);
