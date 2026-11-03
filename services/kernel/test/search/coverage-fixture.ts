import { expect } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import pg, { type Pool } from 'pg';
import { createHash } from 'node:crypto';
import { accessCheck } from '../../src/request/access.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  createSubjectProjectionCoordinator,
  readSubjectCoverage,
  type IndexIncarnation,
} from '../../src/search/coverage.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { compileFilter } from '../../src/search/filter.ts';
import { createSubjectIndexer } from '../../src/search/indexer.ts';
import { createSubjectIndex, subjectAlias, subjectIndexName } from '../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError, type OpenSearch } from '../../src/search/opensearch.ts';
import {
  installTemplates,
  searchSubjects,
  SEARCH_TEMPLATE,
  SUGGEST_TEMPLATE,
  FACET_TEMPLATE,
} from '../../src/search/query.ts';
import { subjectConsumer } from '../../src/search/runner.ts';
import { createSearchScopeSource } from '../../src/search/scope-source.ts';
import { subjectPartition } from '../../src/search/source.ts';
import { activeRelease, bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { populateControlledSubjects } from './support/controlled-population.ts';

export type CoverageFixtureResources = {
  readonly pool: Pool;
  readonly admin: pg.Pool;
  readonly search: OpenSearch;
};

/** Real baseline first; no missing export or stub can stand in for working commands/source/engine. */
export async function createCoverageFixture(resources?: CoverageFixtureResources) {
  if (
    resources !== undefined &&
    (!resources || resources.pool === undefined || resources.admin === undefined || resources.search === undefined)
  )
    throw new TypeError('Coverage fixture resources must include pool, admin and search together');
  const databaseUrl = process.env.DATABASE_URL;
  const searchUrl = process.env.OPENSEARCH_URL;
  if (resources === undefined && (!databaseUrl || !searchUrl))
    throw new Error('DATABASE_URL and OPENSEARCH_URL must name real check services');

  const prefixes: string[] = [];
  let pool: Pool | undefined = resources?.pool;
  let admin: pg.Pool | undefined = resources?.admin;
  let search: OpenSearch | undefined = resources?.search;
  let ownedPool: Pool | undefined;
  let ownedAdmin: pg.Pool | undefined;

  async function close() {
    const failures: unknown[] = [];
    if (search) {
      for (const prefix of prefixes) {
        try {
          const resolved = await search.request<{ indices: { name: string }[] }>(
            'GET',
            `/_resolve/index/${prefix}subjects*`,
            undefined,
            { query: { expand_wildcards: 'all' } },
          );
          for (const { name } of resolved.body.indices) {
            try {
              await search.request('DELETE', `/${name}`);
            } catch (error) {
              if (!(error instanceof OpenSearchError && error.status === 404)) failures.push(error);
            }
          }
        } catch (error) {
          failures.push(error);
        }
        for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
          try {
            await search.request('DELETE', `/_scripts/${prefix}${template}`);
          } catch (error) {
            if (!(error instanceof OpenSearchError && error.status === 404)) failures.push(error);
          }
        }
      }
    }

    for (const owned of [ownedPool, ownedAdmin]) {
      if (!owned) continue;
      try {
        await owned.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Coverage fixture cleanup failed');
  }

  try {
    if (resources === undefined) {
      pool = createPool(databaseUrl!);
      ownedPool = pool;
      admin = new pg.Pool({ connectionString: databaseUrl!, max: 2 });
      ownedAdmin = admin;
      search = createOpenSearch(searchUrl!);
    }
    if (!pool || !admin || !search) throw new Error('Coverage fixture resources are incomplete');
    const runtimePool = pool;
    const runtimeAdmin = admin;
    const runtimeSearch = search;

    const routeKey = new Uint8Array(32).fill(83);
    const source = subjectSource(runtimePool, routeKey);
    const listing = subjectListingSource(runtimePool);
    const actions = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide'];
    const accountId = newId(30001);
    const access = await createRealAccess(runtimeAdmin, { editor: accountId }, actions);
    for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
    await bootstrapRelease(runtimePool, bundledRelease);
    const kernel = createKernel({
      pool: runtimePool,
      routeKey,
      access: access.access,
      writeRate: access.writeRate,
      receiptKeys: testReceiptKeys(),
    });
    const filter = parseFilter({ type: { in: ['schema:Book'] } });
    const compiled = compileFilter(admitFilter(filter, (await activeRelease(runtimePool))!.release), {
      prefix: 'f',
      relationOverflow: true,
    });
    function fresh() {
      const prefix = `coverage-${crypto.randomUUID().slice(0, 8)}-`;
      prefixes.push(prefix);
      return prefix;
    }
    async function post(path: string, body: unknown, key = crypto.randomUUID()) {
      const response = await kernel.handle(
        new Request(`http://kernel.test${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${access.bearer('editor')}`,
            'idempotency-key': `"${key}"`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      );
      const result = (await response.json()) as { subject: { id: string } };
      expect(response.status, JSON.stringify(result)).toBe(path === '/v1/subjects' ? 201 : 200);
      return result;
    }
    async function books(count = 3): Promise<[string, ...string[]]> {
      if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('Book count must be a positive integer');
      const ids: string[] = [];
      for (let n = 0; n < count; n++)
        ids.push(
          (
            await post('/v1/subjects', {
              type: 'schema:Book',
              labels: { en: `Canonical coverage ${n}` },
            })
          ).subject.id,
        );
      const [first, ...rest] = ids.sort();
      if (first === undefined) throw new Error('Native book creation returned no subjects');
      return [first, ...rest];
    }
    const options = (prefix: string, transport = runtimeSearch) => ({
      pool: runtimePool,
      search: transport,
      source,
      listing,
      prefix,
    });
    async function population(transport = runtimeSearch) {
      const prefix = fresh();
      const config = options(prefix, transport);
      const { incarnation, coordinator } = await populateControlledSubjects(config, { deadline: Date.now() + 30_000 });
      return { prefix, incarnation, coordinator, config };
    }
    async function raw(prefix: string) {
      return (await searchSubjects(runtimeSearch, prefix, { filter: compiled.query, sort: 'id', size: 100 })).hits;
    }
    const fixture = {
      pool: runtimePool,
      admin: runtimeAdmin,
      search: runtimeSearch,
      source,
      listing,
      filter,
      compiled,
      options,
      fresh,
      post,
      books,
      population,
      raw,
      close,
      accountId,
      async settleIdentity() {
        const relay = linkProjection(runtimePool);
        let changed;
        do {
          changed = false;
          for (let partition = 0; partition < 4096; partition++) {
            const result = await relay.run(partition);
            if (result.status === 'read' && result.envelopes > 0) changed = true;
            expect(result.status).toBe('read');
          }
        } while (changed);
      },
      scope(prefix: string, transport = runtimeSearch) {
        return createSearchScopeSource({ pool: runtimePool, client: transport, prefix, source });
      },
      read(prefix: string) {
        return readSubjectCoverage(options(prefix), { deadline: Date.now() + 30_000 });
      },
      async disclosed(prefix: string) {
        return checkHits(source, await raw(prefix), new Map(compiled.leaves.map((leaf) => [leaf.name, leaf])), {
          filter,
        });
      },
      async merge(original: string, survivor: string) {
        const realAccess = access.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
        const resource = { route: routeOf(original)!, id: original };
        const deadline = Date.now() + 30_000;
        const actor = await realAccess.authenticate(access.bearer('editor'), { pool: runtimeAdmin, deadline });
        const check = await accessCheck(realAccess, actor, 'subject:merge', resource, {
          pool: runtimeAdmin,
          deadline,
        });
        const key = crypto.randomUUID();
        return mergeSubjects(runtimePool, {
          subjects: [original, survivor],
          survivor,
          actor,
          idempotencyKey: key,
          digest: createHash('sha256').update(key).digest(),
          release: (await activeRelease(runtimePool))!,
          authorization: {
            action: 'subject:merge',
            resource,
            denied: () => new Error('Native merge denied'),
            async authorize(tx, attempt) {
              if (!(await check(tx, attempt.time))) throw new Error('Native merge denied');
              return 'execute';
            },
          },
        });
      },
      async consume(incarnation: IndexIncarnation, ids: readonly string[], transport: OpenSearch = runtimeSearch) {
        const coordinator = createSubjectProjectionCoordinator(options(incarnation.prefix, transport));
        for (const partition of new Set(ids.map(subjectPartition))) {
          let result;
          do {
            result = await coordinator.run(incarnation, partition);
          } while (result.status === 'busy' || (result.status === 'read' && result.envelopes > 0));
          expect(result.status).toBe('read');
        }
        return coordinator.certify(incarnation, { deadline: Date.now() + 30_000 });
      },
    };

    const ids = await books();
    const prefix = fresh();
    await createSubjectIndex(runtimeSearch, prefix, 1);
    const relay = createSubjectIndexer({
      ...options(prefix),
      index: subjectIndexName(prefix, 1),
      consumer: subjectConsumer(prefix, 1),
    });
    for (const partition of new Set(ids.map(subjectPartition))) {
      let result;
      do {
        result = await relay.run(partition);
      } while (result.status === 'busy' || (result.status === 'read' && result.envelopes > 0));
      expect(result.status).toBe('read');
    }
    await runtimeSearch.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
    await installTemplates(runtimeSearch, prefix);
    const hits = await raw(prefix);
    expect(hits.map(({ id }) => id)).toEqual(ids);
    expect(hits.map(({ matched }) => matched)).toEqual([['f0'], ['f0'], ['f0']]);
    return fixture;
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Coverage fixture initialization and cleanup failed');
    }
    throw error;
  }
}

/** Transport scheduling only: real source, real payloads and real engine responses are preserved. */
export function holdBulk(search: OpenSearch) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let armed = true;
  const transport: OpenSearch = {
    request: search.request.bind(search),
    async bulk<T>(...args: Parameters<OpenSearch['bulk']>) {
      if (armed) {
        armed = false;
        entered.resolve();
        await release.promise;
      }
      return search.bulk<T>(...args);
    },
  };
  return { transport, entered: entered.promise, release: () => release.resolve() };
}
