import { expect, test } from 'bun:test';
import { withQueryAccounting } from '../../src/database/pool.ts';
import { anchorRoute, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createDiscoveryProjection,
  nativeDiscoveryRegistry,
  withDiscoveryTarget,
} from '../../src/search/account-discovery.ts';
import { allocateDiscovery, discoveryGenerations } from '../../src/search/generations.ts';
import { createDiscoveryIndex, discoveryIndexName, discoveryIndexUuid } from '../../src/search/indices.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import { createCoverageFixture } from './coverage-fixture.ts';

test('ordinary mixed copies serialize one home while a queued physical erasure excludes every home', async () => {
  const f = await createCoverageFixture();
  const prefix = `custody-${crypto.randomUUID().slice(0, 8)}-`;
  const index = discoveryIndexName(prefix, 1);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const erasing = Promise.withResolvers<void>();
  const releaseErasure = Promise.withResolvers<void>();
  const running: Promise<unknown>[] = [];
  let allocated = false;
  let bulk = 0;
  const search: OpenSearch = {
    ...f.search,
    async bulkRaw<T>(...args: Parameters<NonNullable<OpenSearch['bulkRaw']>>) {
      if (++bulk === 1) {
        entered.resolve();
        await release.promise;
      }
      return f.search.bulkRaw!<T>(...args);
    },
  };
  const queued = async (mode: 'ExclusiveLock' | 'ShareLock', home: number | null) => {
    const until = Date.now() + 5000;
    do {
      const { rows } = await f.admin.query(
        `SELECT EXISTS (SELECT FROM pg_locks WHERE locktype='advisory' AND NOT granted AND mode=$2
           AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
           AND CASE WHEN $3::integer IS NULL THEN objsubid=1
             AND (classid::bigint << 32 | objid::bigint)=hashtextextended($1,0)
             ELSE objsubid=2 AND classid=hashtext($1)::oid AND objid=$3::oid END) AS queued`,
        [index, mode, home],
      );
      if (rows[0]!.queued) return;
      await Bun.sleep(10);
    } while (Date.now() < until);
    throw new Error(`Native ${mode} did not queue on ${home ?? index}`);
  };
  try {
    const registry = await nativeDiscoveryRegistry(f.pool, f.routeKey, f.source);
    await allocateDiscovery(f.pool, prefix, registry);
    const [target] = await discoveryGenerations(f.pool, prefix);
    if (!target) throw new Error('Missing discovery generation');
    await createDiscoveryIndex(search, prefix, 1, target.incarnation);
    allocated = true;
    target.uuid = await discoveryIndexUuid(search, index);
    await f.pool.query("UPDATE search.discovery_generation SET index_uuid=$2,state='populating' WHERE prefix=$1", [
      prefix,
      target.uuid,
    ]);
    const projection = createDiscoveryProjection({ pool: f.pool, search, registry, listing: f.listing, target });
    const homes = new Set<number>();
    const newBook = async () => {
      let receipt, home;
      do {
        receipt = crypto.randomUUID();
        home = partitionOf(anchorRoute(f.routeKey, `${f.accountId}\nsubject.create\n${receipt}`));
      } while (homes.has(home));
      homes.add(home);
      const {
        subject: { id },
      } = await f.post('/v1/subjects', { type: 'schema:Book', labels: { en: receipt } }, receipt);
      const route = routeOf(id)!;
      expect(partitionOf(route)).toBe(home);
      return { owner: 'semantic' as const, kind: 'schema:Book' as const, id, route };
    };
    const keys = [await newBook(), await newBook(), await newBook()] as const;
    const [first, second, third] = keys;
    const project = (key: (typeof keys)[number]) => projection.project(partitionOf(key.route), [key]);
    await expect(projection.project(partitionOf(first.route), [first, second])).rejects.toThrow(
      'Foreign discovery key',
    );
    const original = project(first);
    running.push(original);
    await Promise.race([entered.promise, original]);
    expect(
      (await f.admin.query('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS open', [index])).rows[0]!
        .open,
    ).toBe(true);
    expect(
      (await f.admin.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS open', [index])).rows[0]!.open,
    ).toBe(false);
    running.push(project(first));
    await queued('ExclusiveLock', partitionOf(first.route));
    await project(second);
    expect(bulk).toBe(2);
    const snapshot = async () =>
      (await f.admin.query('SELECT source_id::text AS id,settled FROM search.discovery_copy WHERE prefix=$1', [prefix]))
        .rows;
    expect(await snapshot()).toEqual(
      expect.arrayContaining([
        { id: first.id, settled: false },
        { id: second.id, settled: true },
      ]),
    );

    running.push(
      withDiscoveryTarget(
        f.pool,
        search,
        target,
        async () => {
          erasing.resolve();
          await releaseErasure.promise;
        },
        true,
      ),
    );
    await queued('ExclusiveLock', null);
    running.push(project(third));
    await queued('ShareLock', null);
    release.resolve();
    await erasing.promise;
    expect(bulk).toBe(2);
    expect(await snapshot()).toEqual(expect.arrayContaining([{ id: first.id, settled: true }]));
    releaseErasure.resolve();
    await Promise.all(running);
    expect(bulk).toBe(3);
    expect((await snapshot()).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      keys.map(({ id }) => ({ id, settled: true })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    const visible = await search.request<{ hits: { hits: { _source: { id: string } }[] } }>(
      'POST',
      `/${index}/_search`,
      { query: { match_all: {} }, size: 10 },
    );
    expect(visible.body.hits.hits.map((hit) => hit._source.id).sort()).toEqual(keys.map(({ id }) => id).sort());

    await expect(
      withQueryAccounting(
        {
          connection: (dispatch) => dispatch(),
          async query(sql, _operands, dispatch) {
            const result = await dispatch();
            if (sql.includes('pg_advisory_lock_shared('))
              throw new Error('Lost lock response after native acquisition');
            return result;
          },
        },
        () => project(first),
      ),
    ).rejects.toThrow('Lost lock response after native acquisition');
    await project(first);
    expect(bulk).toBe(3);
  } finally {
    release.resolve();
    releaseErasure.resolve();
    await Promise.allSettled(running);
    try {
      if (allocated) await f.search.request('DELETE', `/${index}`);
    } finally {
      await f.close();
    }
  }
}, 120_000);
