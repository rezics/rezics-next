import { expect, expectTypeOf, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import { BOUND_AXES, isBound, sumBounds, withinCeiling } from '@rezics/bounds';
import type { NativeOrdinalKey, RawOrdinalCollectionPrefix } from '../../src/library/collection-source-order.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { createIdentityScopedObservations } from '../../src/semantic/identity-scoped-observations.ts';
import type { IdentityScopedObservations } from '../../src/semantic/identity-scope-types.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork, evaluateScopeSubjects } from '../../src/search/scope-execution.ts';
import { compileCurrentOwnerFilter } from '../../src/search/current-filter-plan.ts';
import { createSearchScopeSource } from '../../src/search/scope-source.ts';
import {
  createSearchScopeOrder,
  sameScopeObservation,
  SEARCH_SCOPE_ORDINAL_OPERATION,
} from '../../src/search/service-scope-order.ts';
import { createSearchScopeForService } from '../../src/search/service-scope.ts';

const nativePreconnect = globalThis.fetch.preconnect;

// These focused cases require no database and exercise actual owned algorithms and the
// real unimplemented native producer. They do not inject verdicts or manufacture captures.
test('closed ordering API imports the canonical native ordinal key and raw row contract', () => {
  type Order = ReturnType<typeof createSearchScopeOrder>;
  expectTypeOf<Parameters<Order['rawOrdinal']>[1]>().toEqualTypeOf<NativeOrdinalKey | null>();
  expectTypeOf<Awaited<ReturnType<Order['rawOrdinal']>>>().toEqualTypeOf<RawOrdinalCollectionPrefix>();
  expectTypeOf<ReturnType<typeof createIdentityScopedObservations>>().toEqualTypeOf<IdentityScopedObservations>();
  expectTypeOf<Parameters<typeof createSearchScopeForService>[1]>().toEqualTypeOf<LeafOptions>();
});

test('selected ordinal dispatch follows its complete immutable Source ceiling and one-row schedule', () => {
  const plan = SEARCH_SCOPE_ORDINAL_OPERATION();
  expect(plan.axes).toEqual(BOUND_AXES);
  expect(plan.rawLimit).toBe(1);
  expect(plan.schedule).toMatchObject({
    definitionGetters: 11,
    membersSnapshots: 4,
    orderCurrentnessReads: 2,
    sourcePrepare: 1,
    ordinalPrefix: 1,
    rawOrdinalRowsMaximum: 1,
    closurePasses: 2,
  });
  expect(plan.nativeStatement).toMatchObject({
    limit: 1,
    requestBytes: expect.any(Number),
    resultBytes: 512,
    work: { engineRequests: 0, statements: 1, candidateKeys: 1 },
  });
  expect(isBound(plan.cost)).toBe(true);
  expect(plan.cost).toEqual(sumBounds(...Object.values(plan.terms)));
  expect(withinCeiling(plan.cost, plan.ceiling)).toBe(true);
  expect(Object.isFrozen(plan)).toBe(true);
  expect(Object.isFrozen(plan.terms)).toBe(true);
});

test('one ledger retains prefix, alias, metadata, native refusal and leaf work without refilling axes', () => {
  const work = new ScopeWork(scopeAllowance(7, 'root'));
  work.consume({ ...zeroScopeWork(), candidateKeys: 2, statements: 1 });
  work.identity({ rows: 3, points: 2, statements: 1, bytes: 16 });
  work.leaf({ keys: 3, points: 1, witnesses: 2, rows: 4, bytes: 64, emptySeeks: 1 });
  expect(work.remaining().remaining.candidateKeys).toBe(2);
  expect(work.leafBudget()?.keys).toBe(2);
  expect(work.receipt().used.identityMetadataRows).toBe(3);
  expect(work.receipt().used.nativeRows).toBe(4);
  expect(() => work.consume({ ...zeroScopeWork(), candidateKeys: 3 })).toThrow(RangeError);
  expect(work.remaining().remaining.candidateKeys).toBe(2);
  expect(() => work.native({ reservationId: 'another-root', used: zeroScopeWork() })).toThrow(TypeError);
});

test('native leaves cap remaining raw keys at 101 and never infer them from ID count', () => {
  const work = new ScopeWork(scopeAllowance(256, 'root'));
  expect(work.leafBudget()?.keys).toBe(101);
  work.leaf({ keys: 100, points: 1, witnesses: 1, rows: 1, bytes: 1, emptySeeks: 1 });
  expect(work.leafBudget()?.keys).toBe(101);
  work.leaf({ keys: 100, points: 1, witnesses: 1, rows: 1, bytes: 1, emptySeeks: 1 });
  expect(work.leafBudget()?.keys).toBe(56);
  work.leaf({ keys: 56, points: 1, witnesses: 1, rows: 1, bytes: 1, emptySeeks: 1 });
  expect(work.leafBudget()).toBeNull();
});

test('the actual missing native leaf remains unknown through NOT and returns no invented evidence', async () => {
  const forbiddenPool = new Proxy({} as Pool, {
    get() {
      throw new Error('Native producer performed unexpected I/O');
    },
  });
  const options = new Proxy({} as LeafOptions, {
    get() {
      throw new Error('Missing producer inspected authority');
    },
  });
  const work = new ScopeWork(scopeAllowance(256, 'root'));
  const result = await evaluateScopeSubjects({
    pool: forbiddenPool,
    options,
    plan: compileCurrentOwnerFilter({
      and: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: 'schema:inLanguage', in: ['ja'] } } }],
    }),
    basis: 'a'.repeat(64),
    subjects: ['018f0000-0000-7000-8000-00a000000001'],
    reservation: {
      rawKeys: 256,
      native: { points: 256, witnesses: 100, rows: 65536, bytes: 4194304, emptySeeks: 256 },
    },
    work,
  });
  expect(result).toEqual({ values: ['not_proven'], evidence: [], progress: null, resume: null });
  expect(work.receipt().used).toEqual(zeroScopeWork());
});

test('an exhausted or all-zero leaf reservation produces no native dispatch', () => {
  const root = scopeAllowance(256, 'root');
  for (const axis of ['candidateKeys', 'nativeRows', 'nativePoints', 'witnessKeys', 'bytes', 'emptySeeks'] as const) {
    const work = new ScopeWork({ ...root, remaining: { ...root.remaining, [axis]: 0 } });
    expect(work.leafBudget(), axis).toBeNull();
  }
});

test('scoped observation equality includes capture, full source locator and committed revision', () => {
  const observation = {
    key: {
      source: {
        kind: 'public' as const,
        identity: { id: 'native', partition: 1, epoch: 2, configuration: 'registered' },
      },
      scopeId: 'scope',
    },
    captureId: 'retained-cut',
    committedRevision: 7n,
  };
  expect(sameScopeObservation(observation, structuredClone(observation))).toBe(true);
  expect(sameScopeObservation(observation, { ...observation, committedRevision: 8n })).toBe(false);
  expect(sameScopeObservation(observation, { ...observation, captureId: 'another-cut' })).toBe(false);
  expect(
    sameScopeObservation(observation, {
      ...observation,
      key: {
        ...observation.key,
        source: { kind: 'public', identity: { ...observation.key.source.identity, configuration: 'changed' } },
      },
    }),
  ).toBe(false);
});

test('the resolved-service scope preserves prepare prefix evaluate compatibility and adds internal ordinal output', () => {
  type Scope = ReturnType<typeof createSearchScopeSource>;
  expectTypeOf<Parameters<Scope['prepare']>[1]>().extract<undefined>().toEqualTypeOf<undefined>();
  expectTypeOf<Parameters<Scope['prefix']>[1]>().toExtend<{
    afterSubject: string | null;
    quota: number;
    budget: number;
  }>();
  expectTypeOf<Parameters<Scope['ordinalPrefix']>[1]['after']>().toEqualTypeOf<NativeOrdinalKey | null>();
});

test('the resolved engine transport settles exact UTF-8 request and response bytes under one allowance', async () => {
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const payload = { word: '世界' };
  const response = '{"word":"λ"}';
  const used: number[] = [];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response(response), { preconnect: nativePreconnect }),
  );
  try {
    const client = createOpenSearch('http://localhost:9200');
    expect(
      await client.request('POST', '/native', payload, {
        work: {
          bytes: 1024,
          deadline: Date.now() + 5000,
          settle(bytes) {
            used.push(bytes);
          },
        },
      }),
    ).toEqual({ status: 200, body: { word: 'λ' } });
    expect(used).toEqual([Buffer.byteLength(JSON.stringify(payload), 'utf8'), Buffer.byteLength(response, 'utf8')]);
  } finally {
    transport.mockRestore();
  }
});

test('an exhausted byte allowance or expired caller deadline dispatches no engine request', async () => {
  const { createOpenSearch, SearchUnavailableError } = await import('../../src/search/opensearch.ts');
  const transport = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response('{}'), { preconnect: nativePreconnect }),
  );
  try {
    const client = createOpenSearch('http://localhost:9200');
    for (const work of [
      { bytes: 2, deadline: Date.now() + 5000 },
      { bytes: 1024, deadline: Date.now() - 1 },
    ])
      await expect(
        client.request(
          'POST',
          '/native',
          {},
          {
            work: {
              ...work,
              settle() {
                throw new Error('Dispatched work without allowance');
              },
            },
          },
        ),
      ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    transport.mockRestore();
  }
});

test('scope response limits and deadlines preserve ordinary transport timeout compatibility', async () => {
  const { createOpenSearch, SearchUnavailableError } = await import('../../src/search/opensearch.ts');
  const transport = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => new Response('{"oversized":true}'), { preconnect: nativePreconnect }),
  );
  const timer = spyOn(globalThis, 'setTimeout');
  try {
    const client = createOpenSearch('http://localhost:9200');
    await client.request('GET', '/native', undefined, { timeoutMs: 20000 });
    expect(timer.mock.calls[0]?.[1]).toBe(20000);
    await expect(
      client.request('GET', '/native', undefined, {
        timeoutMs: 20000,
        work: { bytes: 4, deadline: Date.now() + 5000, settle() {} },
      }),
    ).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(timer.mock.calls[1]?.[1]).toBeGreaterThan(0);
    expect(timer.mock.calls[1]?.[1]).toBeLessThanOrEqual(5000);
  } finally {
    transport.mockRestore();
    timer.mockRestore();
  }
});

// Product creation, normal projection and the actual resolved service share native evidence.
test('a real product-created catalogue subject has ordered native scope evidence through the resolved service', async () => {
  const { randomUUID } = await import('node:crypto');
  const { createOpenSearch } = await import('../../src/search/opensearch.ts');
  const { createSearchService } = await import('../../src/search/service.ts');
  const { createKernel, createKernelAccessResolver } = await import('../../src/http/kernel.ts');
  const { subjectSource } = await import('../../src/semantic/search-source.ts');
  const { createSemanticDriver } = await import('../semantic/outcome-driver.ts');
  const { closeOwnedSemanticAuth } = await import('../semantic/outcome-auth.ts');
  const { createSubjectIndex, subjectIndexName, subjectAlias } = await import('../../src/search/indices.ts');
  const { installTemplates, SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } =
    await import('../../src/search/query.ts');
  const { documentActions, bulkLines } = await import('../../src/search/document.ts');
  const { subjectPartition } = await import('../../src/search/source.ts');
  const search = createOpenSearch(process.env.OPENSEARCH_URL!);
  const prefix = `ordered-${randomUUID().replaceAll('-', '').slice(0, 20)}-`;
  let native:
    | {
        pool: Pool;
        routeKey: Uint8Array;
        access: LeafOptions['access'];
        source: ReturnType<typeof subjectSource>;
        service: ReturnType<typeof createSearchService>;
      }
    | undefined;
  const driver = await createSemanticDriver(
    (config) => {
      const source = subjectSource(config.pool, config.routeKey!);
      const service = createSearchService({
        pool: config.pool,
        client: search,
        prefix,
        source,
        cursors: config.tokens!,
        ...(config.clock ? { clock: config.clock } : {}),
      });
      const resolver = createKernelAccessResolver({
        pool: config.pool,
        tokens: config.tokens!,
        clock: config.clock ?? (() => new Date()),
        ...(config.access ? { access: config.access } : {}),
      });
      return createKernel({
        ...config,
        search: service,
        realmRoleReader: resolver.realmRoleReader,
        access(catalogue) {
          const access = resolver.resolveAccess(catalogue);
          native = { pool: config.pool, routeKey: config.routeKey!, access, source, service };
          return access;
        },
      });
    },
    { strictCleanup: true },
  );
  let created = false;
  try {
    const response = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      { type: 'schema:Book', labels: { en: 'Actual ordered scope outcome' } },
      { 'Idempotency-Key': `"${randomUUID()}"` },
    );
    expect(response.status).toBe(201);
    const subject = response.body.subject;
    if (!subject || typeof subject !== 'object' || !('id' in subject) || typeof subject.id !== 'string' || !native)
      throw new Error('The real product did not create a native subject/runtime');
    const resolved = native;
    const id = subject.id;
    const snapshot = await native.source.read(subjectPartition(id), [id]);
    await installTemplates(search, prefix);
    await createSubjectIndex(search, prefix, 1);
    created = true;
    await search.bulk(bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, [id])), {
      query: { refresh: 'wait_for' },
    });
    await search.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
    const account = await driver.fixtures.person('editor');
    const deadline = Date.now() + 600000;
    const actor = await native.access.authenticate(account.bearer, { pool: native.pool, deadline });
    const scope = createSearchScopeForService(native.service, {
      access: native.access,
      actor,
      deadline,
      routeKey: native.routeKey,
    });
    const prepared = await scope.prepare({ type: { in: ['schema:Book'] } });
    const page = await scope.prefix(prepared, { afterSubject: null, quota: 1, budget: 2 });
    expect(page.hits.map((hit) => hit.id)).toEqual([id]);
    const evaluation = await scope.evaluate(prepared, [id], {
      rawKeys: 256,
      native: { points: 4096, witnesses: 8192, rows: 65536, bytes: 4194304, emptySeeks: 256 },
    });
    expect(evaluation.values).toEqual([true]);
    expect(evaluation.basis).toEqual(prepared.basis);
    expect(evaluation.usage.keys).toBeLessThanOrEqual(256);
    expect((await driver.request('anonymous', 'GET', `/v1/subjects/${id}`)).status).toBe(200);
    expect(() =>
      createSearchScopeForService(
        { ...resolved.service },
        { access: resolved.access, actor, deadline, routeKey: resolved.routeKey },
      ),
    ).toThrow();
  } finally {
    if (created) await search.request('DELETE', `/${subjectIndexName(prefix, 1)}`);
    for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE, 'subjects-suggest-v2'])
      await search.request('DELETE', `/_scripts/${prefix}${template}`);
    await driver.close();
    await closeOwnedSemanticAuth();
  }
}, 600000);
