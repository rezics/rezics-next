import { expect } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { admitFilter, parseFilter } from '@rezics/filter';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { accessCheck, type AccountActor } from '../../src/request/access.ts';
import { linkProjection } from '../../src/semantic/links.ts';
import { mergeSubjects } from '../../src/semantic/merges.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  activateSubjectIncarnation,
  createSubjectProjectionCoordinator,
  initializeSubjectIncarnation,
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

/** Real baseline first; no missing export or stub can stand in for working commands/source/engine. */
export async function createCoverageFixture() {
  const databaseUrl = process.env.DATABASE_URL;
  const searchUrl = process.env.OPENSEARCH_URL;
  if (!databaseUrl || !searchUrl) throw new Error('DATABASE_URL and OPENSEARCH_URL must name real check services');
  const pool = createPool(databaseUrl);
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const search = createOpenSearch(searchUrl);
  const routeKey = new Uint8Array(32).fill(83);
  const source = subjectSource(pool, routeKey);
  const listing = subjectListingSource(pool);
  const prefixes: string[] = [];
  const actions = ['subject:create', 'subject:read', 'subject:merge', 'moderation:hide'];
  const accountId = newId(30001);
  const access = await createRealAccess(admin, { editor: accountId }, actions);
  for (const action of actions) await access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await bootstrapRelease(pool, bundledRelease);
  const kernel = createKernel({ pool, routeKey, access: access.access, writeRate: access.writeRate });
  const filter = parseFilter({ type: { in: ['schema:Book'] } });
  const compiled = compileFilter(admitFilter(filter, (await activeRelease(pool))!.release), {
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
  const options = (prefix: string, transport = search) => ({ pool, search: transport, source, listing, prefix });
  async function population(transport = search) {
    const prefix = fresh();
    const config = options(prefix, transport);
    const incarnation = await initializeSubjectIncarnation(config, 1);
    const coordinator = createSubjectProjectionCoordinator(config);
    while ((await coordinator.populate(incarnation)).state === 'more') {}
    const certified = await coordinator.certify(incarnation, { deadline: Date.now() + 30_000 });
    expect(certified.state).toBe('ready');
    await activateSubjectIncarnation(config, incarnation);
    await installTemplates(search, prefix);
    return { prefix, incarnation, coordinator, config };
  }
  async function raw(prefix: string) {
    return (await searchSubjects(search, prefix, { filter: compiled.query, sort: 'id', size: 100 })).hits;
  }
  async function close() {
    try {
      for (const prefix of prefixes) {
        const resolved = await search.request<{ indices: { name: string }[] }>(
          'GET',
          `/_resolve/index/${prefix}subjects*`,
          undefined,
          { query: { expand_wildcards: 'all' } },
        );
        for (const { name } of resolved.body.indices) await search.request('DELETE', `/${name}`);
        for (const template of [SEARCH_TEMPLATE, SUGGEST_TEMPLATE, FACET_TEMPLATE]) {
          try {
            await search.request('DELETE', `/_scripts/${prefix}${template}`);
          } catch (error) {
            if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
          }
        }
      }
    } finally {
      await pool.end();
      await admin.end();
    }
  }
  const fixture = {
    pool,
    admin,
    search,
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
      const relay = linkProjection(pool);
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
    scope(prefix: string, transport = search) {
      return createSearchScopeSource({ pool, client: transport, prefix, source });
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
      const actor: AccountActor = {
        kind: 'account',
        accountId,
        clientId: 'web',
        scopes: actions,
        requestedBy: null,
        authnEpoch: 1,
      };
      const resource = { route: routeOf(original)!, id: original };
      const deadline = Date.now() + 30_000;
      const check = await accessCheck(
        access.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) }),
        actor,
        'subject:merge',
        resource,
        { pool: admin, deadline },
      );
      const key = crypto.randomUUID();
      return mergeSubjects(pool, {
        subjects: [original, survivor],
        survivor,
        actor,
        idempotencyKey: key,
        digest: createHash('sha256').update(key).digest(),
        release: (await activeRelease(pool))!,
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
    async consume(incarnation: IndexIncarnation, ids: readonly string[], transport: OpenSearch = search) {
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
  try {
    const ids = await books();
    const prefix = fresh();
    await createSubjectIndex(search, prefix, 1);
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
    await search.request('POST', '/_aliases', {
      actions: [{ add: { index: subjectIndexName(prefix, 1), alias: subjectAlias(prefix) } }],
    });
    await installTemplates(search, prefix);
    const hits = await raw(prefix);
    expect(hits.map(({ id }) => id)).toEqual(ids);
    expect(hits.map(({ matched }) => matched)).toEqual([['f0'], ['f0'], ['f0']]);
    return fixture;
  } catch (error) {
    await close();
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
