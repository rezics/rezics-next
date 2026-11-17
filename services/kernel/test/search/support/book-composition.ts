import assert from 'node:assert/strict';
import { BOOK_CATALOGUE_TYPES } from '@rezics/definitions/contract';
import { planReads, platformRegistry } from '@rezics/composition';
import { subjectAlias, subjectGenerations, subjectIndexName } from '../../../src/search/indices.ts';
import { createOpenSearch, OpenSearchError } from '../../../src/search/opensearch.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  type ReleasedDiscoveryFixture,
} from '../../support/released-discovery.ts';
import {
  composedLimitDocument,
  publishTypeLists,
  requireStatus,
  type TypeListRead,
} from '../../performance/support/composed-discovery-fixtures.ts';

const route = '/book-catalogue-cost';
const lists: TypeListRead[] = BOOK_CATALOGUE_TYPES.flatMap((type, i) =>
  [6, 7, 8, 9, 10].map((limit) => ({ id: `books-${i}-${limit}`, types: [type], limit })),
);
lists.push({ id: 'all-grains', types: BOOK_CATALOGUE_TYPES, limit: 8 });
const document = composedLimitDocument(lists);
const plan = planReads(platformRegistry, document, { subject: null });

export async function createBookComposition() {
  let database: GrowthDatabase | undefined;
  let owner: ReleasedDiscoveryFixture | undefined;
  try {
    const fixture = await createReleasedDiscoveryFixture({
      version: 1,
      search: 'native',
      async kernelPool(url) {
        // The installed worker has its own checkout. Include it in the same native capture.
        if (database) {
          assert.equal(database.url, url);
          return database.openPool(database.pool.options);
        }
        database = await openGrowthDatabase(url);
        const { pool, admin } = database;
        const end = pool.end.bind(pool);
        // The fixture drops its database immediately after closing the application pool.
        pool.end = async () => {
          try {
            await admin.end();
          } finally {
            await end();
          }
        };
        return pool;
      },
    });
    owner = fixture;
    assert(database && fixture.search);
    const engine = createOpenSearch(process.env.OPENSEARCH_URL!);
    const prefix = fixture.search.indexPrefix;
    const index = subjectAlias(prefix);
    async function indexed(ids: readonly string[]) {
      async function count(target: string, signal?: AbortSignal) {
        const { body } = await engine.request<{ count: number; _shards: { failed: number } }>(
          'POST',
          `/${target}/_count`,
          { query: { ids: { values: ids } } },
          signal ? { signal } : undefined,
        );
        assert.equal(body._shards.failed, 0);
        return body.count;
      }

      async function observeGenerations(signal: AbortSignal) {
        try {
          const { active, generations } = await subjectGenerations(engine, prefix, undefined, signal);
          const physical = await Promise.all(
            generations.map(async (generation) => ({
              generation,
              matched: await count(subjectIndexName(prefix, generation), signal).catch(String),
            })),
          );
          return { active, physical };
        } catch (error) {
          return { inventoryError: String(error) };
        }
      }

      const until = Date.now() + 120_000;
      let observed: Awaited<ReturnType<typeof observeGenerations>> | undefined;
      for (;;) {
        let alias: number | 'HTTP 404';
        try {
          alias = await count(index);
          if (alias === ids.length) return;
        } catch (error) {
          if (!(error instanceof OpenSearchError && error.status === 404)) throw error;
          alias = 'HTTP 404';
        }
        const remaining = until - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `Search did not index the ${ids.length} released originals in 120s ` +
              `(alias: ${alias}, generation snapshot: ${JSON.stringify(observed ?? null)})`,
          );
        }
        // Sample native publication and projection once, within the original alias wait.
        if (remaining <= 5_000 && !observed)
          observed = await observeGenerations(AbortSignal.timeout(Math.min(remaining, 2_000)));
        await Bun.sleep(100);
      }
    }
    const anchors: { id: string; type: string }[] = [];
    for (const [grain, type] of BOOK_CATALOGUE_TYPES.entries()) {
      for (let ordinal = 0; ordinal < 11; ordinal++) {
        const { id } = await fixture.createSubject(type, `AAA ${grain} ${String(ordinal).padStart(2, '0')}`);
        anchors.push({ id, type });
      }
    }
    const hidden = await fixture.createSubject('schema:Book', 'AAA 0 00 concealed');
    await indexed([...anchors.map(({ id }) => id), hidden.id]);
    await fixture.grant('editor', ['moderation:hide'], hidden.id);
    requireStatus(
      await fixture.request(
        'editor',
        'POST',
        `/v1/subjects/${hidden.id}:hide`,
        { reason: 'Withhold the catalogue entry' },
        discoveryKey(),
      ),
      200,
      'Hide the indexed Book',
    );
    await publishTypeLists(fixture, [{ route, document }]);
    const request = (who: 'alice' | 'anonymous' | 'suspended') =>
      fixture.request(who, 'POST', '/v1/pages:read', { target: { route }, languages: ['en'] });
    async function read(who: 'alice' | 'anonymous', warm = false) {
      const until = Date.now() + 120_000;
      for (;;) {
        const response = await request(who);
        const reads = response.body.reads as
          | Record<string, { status: number; body: Record<string, unknown> }>
          | undefined;
        const pending = response.status === 200 ? Object.values(reads ?? {}) : [response];
        if (warm && pending.some(({ status }) => status === 503)) {
          for (const entry of pending.filter(({ status }) => status !== 200))
            assert(
              entry.status === 503 && ['index_not_ready', 'semantic_not_ready'].includes(String(entry.body.code)),
              JSON.stringify(entry),
            );
          assert(Date.now() < until, 'Released TypeLists did not become ready');
          await Bun.sleep(100);
          continue;
        }
        requireStatus(response, 200, 'Read the published catalogue composition');
        assert.deepEqual(response.body.document, document);
        assert(reads);
        assert.deepEqual(Object.keys(reads).sort(), Object.keys(plan.reads).sort());
        assert(!JSON.stringify(response.body).includes(hidden.id));
        let outputSlots = 0;
        for (const list of lists) {
          const result = reads[plan.nodes[list.id]!]!;
          assert.equal(result.status, 200, JSON.stringify(result.body));
          const subjects = result.body.subjects;
          assert(Array.isArray(subjects));
          outputSlots += subjects.length;
          assert.deepEqual(
            subjects.map(({ id, type }) => ({ id, type })),
            anchors.filter(({ type }) => list.types.includes(type)).slice(0, list.limit),
          );
          assert(typeof result.body.next === 'string' && result.body.next.length > 0);
          for (const field of ['total', 'count', 'relation', 'indexed_estimate'])
            assert(!Object.hasOwn(result.body, field));
        }
        return outputSlots;
      }
    }
    const population = new Set<string>();
    return {
      database,
      read,
      async denied() {
        const response = requireStatus(await request('suspended'), 401, 'Read with revoked credentials');
        assert.equal(response.body.code, 'invalid_credentials');
        assert(!Object.hasOwn(response.body, 'reads'));
      },
      async grow(from: number, to: number) {
        assert.equal(population.size, from);
        for (let ordinal = from; ordinal < to; ordinal++) {
          const subject = await fixture.createSubject(
            BOOK_CATALOGUE_TYPES[ordinal % BOOK_CATALOGUE_TYPES.length]!,
            `ZZZ catalogue ${ordinal}`,
          );
          population.add(subject.id);
        }
        assert.equal(population.size, to);
        await indexed([...population]);
      },
      close: () => fixture.close(),
    };
  } catch (error) {
    await owner?.close();
    throw error;
  }
}
