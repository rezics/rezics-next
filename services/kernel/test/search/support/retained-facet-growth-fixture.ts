import assert from 'node:assert/strict';
import type { Pool, QueryResult } from 'pg';
import type { FacetDiscoveryRequest } from '../../../src/search/facet-discovery-contract.ts';
import { capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../../support/growth.ts';
import {
  createReleasedDiscoveryFixture,
  discoveryKey,
  discoveryStatement,
  type CreatedSubject,
  type ReleasedDiscoveryFixture,
} from '../../support/released-discovery.ts';

export const property = 'schema:author';
export const request: FacetDiscoveryRequest = {
  filter: { type: { in: ['schema:Book'] } },
  facets: [{ property, size: 20 }],
};
type Seek = { returned: number; values: string[] };

/** Response scheduling only: never substitutes a native query, row, grant or Source result. */
function instrument(pool: Pool, seek: (result: QueryResult) => Promise<void>) {
  const query = pool.query.bind(pool);
  pool.query = ((...args: unknown[]) => {
    const input = args[0];
    const sql = typeof input === 'string' ? input : (input as { text?: string } | undefined)?.text;
    const result = Reflect.apply(query, pool, args);
    if (!sql?.includes('to_jsonb(v) AS item FROM valid LEFT JOIN LATERAL')) return result;
    return Promise.resolve(result).then(async (result: QueryResult) => {
      await seek(result);
      return result;
    });
  }) as Pool['query'];
  // The fixture and harness share ownership of this exact native pool.
  const end = pool.end.bind(pool);
  let closing: Promise<void> | undefined;
  pool.end = () => (closing ??= end());
}

export async function retainedFacetGrowthFixture(count: number) {
  const databases = new Map<string, Promise<GrowthDatabase>>();
  const seeks: Seek[] = [];
  let recording = false;
  let gate: { hit(): void; wait: Promise<void> } | undefined;
  let fixture: ReleasedDiscoveryFixture | undefined;
  async function close() {
    try {
      await fixture?.close();
    } finally {
      for (const database of databases.values()) await (await database).close();
    }
  }
  try {
    fixture = await createReleasedDiscoveryFixture({
      version: 1,
      search: 'native',
      kernelPool(url) {
        let pending = databases.get(url);
        if (!pending) {
          pending = openGrowthDatabase(url).then((database) => {
            instrument(database.pool, async (result) => {
              if (recording) {
                const values = result.rows.flatMap((row: { item: { value: string } | null }) =>
                  row.item === null ? [] : [row.item.value],
                );
                seeks.push({ returned: values.length, values });
              }
              const waiting = gate;
              if (waiting) {
                gate = undefined;
                waiting.hit();
                await waiting.wait;
              }
            });
            return database;
          });
          databases.set(url, pending);
        }
        return pending.then((database) => database.pool);
      },
    });
    const native = fixture.search;
    assert(native && native.workerKind === 'in-process');
    const book = await fixture.createSubject('schema:Book', 'Retained facet growth contributor');
    const targets: CreatedSubject[] = [];
    for (let index = 0; index < count; index++) {
      const target = await fixture.createSubject('schema:Person', `Retained author ${index}`);
      await fixture.adopt(book, discoveryStatement(property, target.id));
      targets.push(target);
    }
    await fixture.grant('editor', ['moderation:hide'], book.id);
    await fixture.catchUp([book, ...targets]);
    const expected = targets.map(({ id }) => id).sort();
    const owner = fixture;
    const preparation: { request: FacetDiscoveryRequest; status: number; code: unknown }[] = [];
    async function ready(body: FacetDiscoveryRequest = request) {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const result = await owner.request('anonymous', 'POST', '/v1/subjects:facets', body);
        preparation.push({ request: body, status: result.status, code: result.body.code });
        if (result.status === 200) return result;
        assert.equal(result.status, 503, JSON.stringify(result.body));
        assert(['index_not_ready', 'semantic_not_ready'].includes(String(result.body.code)));
        assert(Date.now() < deadline, `Native facet preparation unavailable: ${JSON.stringify(result.body)}`);
      }
    }
    async function measured(body: FacetDiscoveryRequest = request) {
      assert(!recording, 'Only one ready-page capture may run at once');
      seeks.length = 0;
      recording = true;
      try {
        const database = await databases.values().next().value!;
        const run = await capture(database, () => owner.request('anonymous', 'POST', '/v1/subjects:facets', body), {
          includeBackends: true,
        });
        const cost = costOf(run.capture);
        // Preserve inclusive native plans, controls and concurrent background work. Auth and engine
        // telemetry have no instrumentation seam here and are explicitly unmeasured, never zero.
        console.info('retained facet native diagnostic', {
          count,
          prefix: native!.indexPrefix,
          workerKind: native!.workerKind,
          database: new URL(database.url).pathname,
          cost,
          capture: run.capture,
          seeks,
          unmeasured: ['isolated Auth pools', 'OpenSearch profiles'],
        });
        return { ...run, cost, seeks: [...seeks] };
      } finally {
        recording = false;
      }
    }
    return {
      fixture: owner,
      native,
      book,
      expected,
      preparation,
      ready,
      measured,
      close,
      barrier() {
        assert(!gate);
        const reached = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        gate = { hit: () => reached.resolve(), wait: released.promise };
        return { reached: reached.promise, release: () => released.resolve() };
      },
      hide: () =>
        owner.request(
          'editor',
          'POST',
          `/v1/subjects/${book.id}:hide`,
          { reason: 'Retained contributor reduction during native page' },
          discoveryKey(),
        ),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
