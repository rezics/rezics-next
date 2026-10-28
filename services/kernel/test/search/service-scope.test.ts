import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { FilterRelease } from '@rezics/filter';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createKernel, createKernelAccessResolver } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import { bulkLines, documentActions } from '../../src/search/document.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { installTemplates, SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE } from '../../src/search/query.ts';
import type { createSearchScopeSource } from '../../src/search/scope-source.ts';
import { createSearchScopeForService, type ScopeRuntime, type SearchService } from '../../src/search/service-scope.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectPartition, type SubjectSource } from '../../src/search/source.ts';
import { activeRelease } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { closeOwnedSemanticAuth } from '../semantic/outcome-auth.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';

// The negative boundary must not inspect credentials or touch any native transport.
const forbiddenOptions = new Proxy({} as LeafOptions, {
  get() {
    throw new Error('Unregistered service inspected reader context');
  },
});

test('the actual SearchService-bound scope factory contract is staged without a second runtime', () => {
  expectTypeOf<Parameters<typeof createSearchScopeForService>>().toEqualTypeOf<[SearchService, LeafOptions]>();
  expectTypeOf<SearchService>().toEqualTypeOf<ReturnType<typeof createSearchService>>();
  expectTypeOf<ReturnType<typeof createSearchScopeForService>>().toEqualTypeOf<
    ReturnType<typeof createSearchScopeSource>
  >();
  expectTypeOf<ScopeRuntime>().toEqualTypeOf<Omit<Parameters<typeof createSearchScopeSource>[0], 'evidence'>>();
  expectTypeOf<'scope' extends keyof SearchService ? true : false>().toEqualTypeOf<false>();
});

test('unregistered mocks and cloned service methods fail before native I/O or context inspection', () => {
  let calls = 0;
  const forbidden = () => {
    calls++;
    throw new Error('Unregistered service performed native I/O');
  };
  const service: SearchService = { search: forbidden, facets: forbidden, suggest: forbidden };
  for (const unregistered of [service, { ...service }, Object.create(service) as SearchService])
    expect(() => createSearchScopeForService(unregistered, forbiddenOptions)).toThrow(
      expect.objectContaining({ code: 'index_not_ready', headers: { 'retry-after': '1' } }),
    );
  expect(calls).toBe(0);
});

// Permanent implementation regressions. Format-stage acceptance does not claim these native
// tests pass: constructor binding is the first prerequisite, native readiness is a later one.
// Never register the service manually or replace the source factory to make them green.
describe('real constructor binding and native reuse', () => {
  let driver: SemanticOutcomeDriver;
  let runtime: ScopeRuntime;
  let service: SearchService;
  let access: Access;
  let options: LeafOptions;
  let routeKey: Uint8Array;
  let id: string;
  let releaseReads = 0;
  let sourceReads = 0;
  const paths: string[] = [];
  const contexts: unknown[][] = [];
  const prefix = `test-service-scope-${randomUUID().replaceAll('-', '')}-`;
  let engine: OpenSearch;
  let indexCreated = false;
  let templatesCreated = false;

  beforeAll(async () => {
    engine = createOpenSearch(process.env.OPENSEARCH_URL!);
    const client: OpenSearch = {
      bulk: (...args) => engine.bulk(...args),
      request<T>(...args: Parameters<OpenSearch['request']>) {
        paths.push(args[1]);
        return engine.request<T>(...args);
      },
    };
    driver = await createSemanticDriver(
      (config) => {
        routeKey = config.routeKey!;
        const native = subjectSource(config.pool, routeKey);
        const source: SubjectSource = {
          ...native,
          read(...args) {
            sourceReads++;
            return native.read(...args);
          },
        };
        runtime = {
          pool: config.pool,
          client,
          prefix,
          source,
          async release() {
            releaseReads++;
            return ((await activeRelease(config.pool))?.release as FilterRelease | undefined) ?? null;
          },
        };
        service = createSearchService({ ...runtime, cursors: config.tokens! });
        const resolver = createKernelAccessResolver({
          pool: config.pool,
          tokens: config.tokens!,
          clock: config.clock ?? (() => new Date()),
          ...(config.access === undefined ? {} : { access: config.access }),
        });
        return createKernel({
          ...config,
          search: service,
          realmRoleReader: resolver.realmRoleReader,
          access: (catalogue) => (access = resolver.resolveAccess(catalogue)),
        });
      },
      { strictCleanup: true },
    );
    const created = await driver.request(
      'editor',
      'POST',
      '/v1/subjects',
      {
        type: 'schema:Book',
        labels: { en: 'Service scope binding' },
      },
      { 'Idempotency-Key': `"${randomUUID()}"` },
    );
    expect(created.status).toBe(201);
    id = (created.body.subject as { id: string }).id;
    const deadline = Date.now() + 600_000;
    const account = await driver.fixtures.person('editor');
    const actor = await access.authenticate(account.bearer, { pool: runtime.pool, deadline });
    const observed = deriveAccess(
      access,
      new Proxy(access, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (key === 'prepare' || key === 'preparePage') contexts.push(args);
            return value.apply(target, args);
          };
        },
      }),
    );
    options = {
      access: observed,
      actor,
      routeKey,
      deadline,
    };
    await installTemplates(engine, prefix);
    templatesCreated = true;
    await createSubjectIndex(engine, prefix, 1);
    indexCreated = true;
    const snapshot = await runtime.source.read(subjectPartition(id), [id]);
    expect(snapshot.subjects.map((subject) => subject.id)).toEqual([id]);
    await engine.bulk(bulkLines(subjectIndexName(prefix, 1), documentActions(snapshot, [id])), {
      query: { refresh: 'wait_for' },
    });
    await engine.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
  }, 600_000);

  afterAll(async () => {
    if (indexCreated) await engine.request('DELETE', `/${subjectIndexName(prefix, 1)}`);
    if (templatesCreated)
      for (const name of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE])
        await engine.request('DELETE', `/_scripts/${prefix}${name}`);
    await driver?.close();
    await closeOwnedSemanticAuth();
  }, 600_000);

  test('binding proof uses the constructor release reader before canonical readiness', async () => {
    const before = releaseReads;
    const scope = createSearchScopeForService(service, options);
    await expect(scope.prepare({ type: { in: ['schema:Unknown'] } })).rejects.toMatchObject({
      code: 'unsupported_query',
    });
    expect(releaseReads).toBe(before + 1);
    expect(() => createSearchScopeForService({ ...service }, options)).toThrow(
      expect.objectContaining({ code: 'index_not_ready' }),
    );
  });

  test('native readiness reuses the real client prefix source pool and authenticated context', async () => {
    const scope = createSearchScopeForService(service, options);
    const before = sourceReads;
    paths.length = 0;
    contexts.length = 0;
    const prepared = await scope.prepare({ type: { in: ['schema:Book'] } });
    const page = await scope.prefix(prepared, { afterSubject: null, quota: 1, budget: 2 });
    expect(page.hits.map((hit) => hit.id)).toEqual([id]);
    const evaluated = await scope.evaluate(prepared, [id], {
      rawKeys: 1,
      native: { points: 256, witnesses: 8192, rows: 65536, bytes: 4 * 1024 * 1024, emptySeeks: 256 },
    });
    expect(evaluated.values).toEqual([true]);
    expect(sourceReads).toBeGreaterThan(before);
    expect(paths.some((path) => path.includes(prefix))).toBe(true);
    expect(contexts.length).toBeGreaterThan(0);
    for (const args of contexts) {
      expect(args[0]).toBe(options.actor);
      expect(args[3]).toMatchObject({ pool: runtime.pool, deadline: options.deadline });
    }
  });
});
