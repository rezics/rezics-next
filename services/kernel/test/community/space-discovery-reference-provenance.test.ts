import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { initializeSpaceDiscoveryDependencies } from '../../src/community/space-discovery-dependencies.ts';
import {
  publishSpaceDiscoveryTupleWitness,
  readSpaceDiscoveryTupleWitnesses,
  registerSpaceDiscoveryTupleProducer,
  repairSpaceDiscoveryTupleWitness,
} from '../../src/community/space-discovery-source-fences.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { productionActions } from '../support/production-actions.ts';
import { createContentSystemWithOrdinaryScopes, type ContentSystem } from '../content/support/system.ts';

let system: ContentSystem;
beforeAll(async () => {
  system = await createContentSystemWithOrdinaryScopes(
    { databaseUrl: process.env.DATABASE_URL! },
    [...productionActions().keys()].filter((action) => action !== 'media:complete'),
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
  system.database.pool.options.max = 1;
}, 120_000);
afterAll(async () => {
  await system?.close();
});

async function call(method: string, path: string, body: unknown, head?: string) {
  const response = await system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${system.actors.author.bearer}`,
        'idempotency-key': JSON.stringify(crypto.randomUUID()),
        'content-type': 'application/json',
        ...(head ? { 'if-match': JSON.stringify(head) } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  const value = (await response.json()) as any;
  expect(response.status, JSON.stringify(value)).toBeLessThan(300);
  return value;
}

test.each(['fresh', 'upgraded'] as const)(
  '%s populated Realm revision preserves removal provenance and replays',
  async (installation) => {
    const pool = system.database.pool;
    const { space } = await call('POST', '/v1/spaces', { title: 'Populated Realm witness' });
    const { realm } = await call('POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Populated community',
      visibility: 'protected',
      contextId: GLOBAL_CONTEXT,
    });
    const route = routeOf(space.spaceId)!;
    const home = partitionOf(route);
    while (await initializeSpaceDiscoveryDependencies(pool, home, 1)) {
      /* Finish the captured native installation cut before publishing tuple witnesses. */
    }
    await registerSpaceDiscoveryTupleProducer(pool, {
      generation: 'space-source-test-generation',
      cut: 'space-source-test-cut',
      complete: true,
    });
    const tuple = (externalId: string) => ({
      route: tupleRoute(system.routeKey, 'example', externalId),
      source: 'example',
      external_id: externalId,
      field_group: 'cover' as const,
    });
    const alpha = tuple('populated-realm-alpha');
    const beta = tuple('populated-realm-beta');
    const origin = (position: string) => ({
      partition: home,
      epoch: 1,
      position,
      eventId: Bun.randomUUIDv7(),
      type: 'com.rezics.search.source-tuple.changed.v1',
      resourceId: space.spaceId,
    });
    const count = async (
      table: 'space_discovery_tuple_expected' | 'space_discovery_tuple_reference' | 'space_discovery_tuple_work',
    ) =>
      (
        await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM community.${table} WHERE route=$1 AND space_id=$2`,
          [route, space.spaceId],
        )
      ).rows[0]!.n;
    const witnessProvenance = async () =>
      (
        await pool.query(
          `SELECT producer_epoch::text,source_position::text FROM community.space_discovery_tuple_witness
         WHERE route=$1 AND space_id=$2`,
          [route, space.spaceId],
        )
      ).rows[0];
    const read = async () => (await readSpaceDiscoveryTupleWitnesses(pool, [space.spaceId])).get(space.spaceId);

    // Epoch 3 at position 17 witnesses both tuples. One drained page makes one tuple reference;
    // the other stays pending upsert work owned by that publication.
    const published = await publishSpaceDiscoveryTupleWitness(pool, {
      spaceId: space.spaceId,
      spaceRevision: space.headRevisionId,
      realmId: realm.realmId,
      realmRevision: realm.headRevisionId,
      producerGeneration: 'space-source-test-generation',
      producerEpoch: '3',
      sourcePosition: '17',
      tuples: [alpha, beta],
      origin: origin('17'),
    });
    expect(published.state).toBe('preparing');
    expect(await repairSpaceDiscoveryTupleWitness(pool, home, space.spaceId, 1)).toBe(true);
    expect([await count('space_discovery_tuple_reference'), await count('space_discovery_tuple_work')]).toEqual([1, 1]);
    expect(await witnessProvenance()).toEqual({ producer_epoch: '3', source_position: '17' });

    if (installation === 'upgraded') {
      // Replace the preceding production function while references and pending work are populated.
      // Applying the forward migration must retain their committed provenance through the next edit.
      for (const migration of [
        '20261106082422_space_witness_reference_epoch.sql',
        '20261106100000_space_witness_locked_provenance.sql',
      ]) {
        const sql = readFileSync(new URL(`../../db/community/migrations/${migration}`, import.meta.url), 'utf8');
        await pool.query(sql.split('-- migrate:down')[0]!);
      }
    }

    // The Realm revision must not read the reference table for provenance. Both tuples are removed under the
    // committed witness epoch and position, and the pending upsert is replaced by its own removal.
    const { realm: revised } = await call(
      'PATCH',
      `/v1/realms/${realm.realmId}`,
      { title: 'Populated community, revised' },
      realm.headRevisionId,
    );
    const removals = await pool.query(
      `SELECT action,tuple_route,external_id,producer_epoch::text,source_position::text
     FROM community.space_discovery_tuple_work WHERE route=$1 AND space_id=$2 ORDER BY external_id`,
      [route, space.spaceId],
    );
    expect(removals.rows).toEqual(
      [alpha, beta].map((t) => ({
        action: 'remove',
        tuple_route: t.route,
        external_id: t.external_id,
        producer_epoch: '3',
        source_position: '17',
      })),
    );
    expect(await count('space_discovery_tuple_expected')).toBe(0);
    expect(await witnessProvenance()).toEqual({ producer_epoch: '3', source_position: '17' });
    expect(await read()).toMatchObject({ state: 'unavailable', tuples: [] });

    // Replay applies each removal once: reference rows go away, and tuple home keeps the committed provenance.
    while (await repairSpaceDiscoveryTupleWitness(pool, home, space.spaceId, 1)) {
      /* Resume the removal work in bounded pages. */
    }
    expect([await count('space_discovery_tuple_reference'), await count('space_discovery_tuple_work')]).toEqual([0, 0]);
    const inverse = await pool.query(
      `SELECT external_id,active,source_epoch::text,source_position::text
     FROM community.space_discovery_tuple_inverse WHERE space_route=$1 AND space_id=$2 ORDER BY external_id`,
      [route, space.spaceId],
    );
    expect(inverse.rows).toEqual(
      [alpha, beta].map((t) => ({
        external_id: t.external_id,
        active: false,
        source_epoch: '3',
        source_position: '17',
      })),
    );
    expect(await read()).toMatchObject({ state: 'unavailable', tuples: [] });

    // A prior witness generation must not restore a removed edge. The current inverse stays inactive.
    const generation = (
      await pool.query<{ witness_generation: string }>(
        `SELECT witness_generation::text FROM community.space_discovery_tuple_witness
       WHERE route=$1 AND space_id=$2`,
        [route, space.spaceId],
      )
    ).rows[0]!.witness_generation;
    await pool.query(
      `INSERT INTO community.space_discovery_tuple_work
      (route,space_id,witness_generation,tuple_route,source,external_id,field_group,action,producer_epoch,source_position)
     VALUES($1,$2,$3::bigint-1,$4,$5,$6,$7,'upsert',3,17)`,
      [route, space.spaceId, generation, alpha.route, alpha.source, alpha.external_id, alpha.field_group],
    );
    while (await repairSpaceDiscoveryTupleWitness(pool, home, space.spaceId, 1)) {
      /* Discard the stale upsert without applying it. */
    }
    expect([await count('space_discovery_tuple_reference'), await count('space_discovery_tuple_work')]).toEqual([0, 0]);
    expect(
      (
        await pool.query<{ external_id: string; active: boolean }>(
          `SELECT external_id,active FROM community.space_discovery_tuple_inverse
         WHERE space_route=$1 AND space_id=$2 AND external_id=$3`,
          [route, space.spaceId, alpha.external_id],
        )
      ).rows[0],
    ).toEqual({ external_id: alpha.external_id, active: false });

    const republished = await publishSpaceDiscoveryTupleWitness(pool, {
      spaceId: space.spaceId,
      spaceRevision: space.headRevisionId,
      realmId: realm.realmId,
      realmRevision: revised.headRevisionId,
      producerGeneration: 'space-source-test-generation',
      producerEpoch: '3',
      sourcePosition: '18',
      tuples: [],
      origin: origin('18'),
    });
    expect(republished.state).toBe('ready');
    expect(await read()).toMatchObject({ state: 'ready', complete: true, tuples: [] });
  },
  120_000,
);
