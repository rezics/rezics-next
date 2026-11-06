import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf } from '../route/route.ts';
import nativeHead from './space-discovery-native-head.sql';
import {
  publishSpaceDiscoveryTupleWitness,
  registerSpaceDiscoveryTupleProducer,
  type SpaceDiscoveryTupleWitnessInput,
} from './space-discovery-source-fences.ts';

// This capability describes the native authored Space/Realm revision schema.
// Neither revision type accepts imported provenance, including its optional icon.
const capability = {
  generation: 'community-native-authored-heads-v1',
  cut: 'community.space_revision+community.realm_revision:authored-v1',
  complete: true as const,
};

/** Publish one retained owner, independently of public eligibility. An empty
 * tuple set is proven by the exact native revision types, never by a result page.
 * Imported relationship producers keep their explicit tuple contract and are
 * never replaced by this authored-head capability.
 */
export async function publishNativeSpaceDiscoveryWitness(pool: Pool): Promise<boolean> {
  const registered = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<{ generation: string; cut: string }>(
          'SELECT generation,cut FROM community.space_discovery_tuple_producer WHERE singleton=true',
        )
      ).rows[0],
  );
  if (registered && (registered.generation !== capability.generation || registered.cut !== capability.cut))
    return false;
  await registerSpaceDiscoveryTupleProducer(pool, capability);
  const locator = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<{ route: number; space_id: string }>(
          `SELECT route,space_id FROM community.space_discovery_tuple_witness
       WHERE state <> 'ready' ORDER BY route,space_id LIMIT 1`,
        )
      ).rows[0],
  );
  if (!locator) return false;
  const partition = partitionOf(locator.route);
  const input = await withConnection(pool, async (client): Promise<SpaceDiscoveryTupleWitnessInput | null> => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const anchor = await readPartition(client, partition);
      if (!anchor || anchor.writeState !== 'active') throw new Error('Native Space tuple owner is unavailable');
      const row = await nativeHead.run(client, { route: locator.route, space_id: locator.space_id });
      await client.query('COMMIT');
      if (!row) return null;
      return {
        spaceId: locator.space_id,
        spaceRevision: row.space_revision,
        realmId: row.realm_id,
        realmRevision: row.realm_revision,
        producerGeneration: capability.generation,
        producerEpoch: String(anchor.epoch),
        sourcePosition: anchor.position.toString(),
        native: { epoch: anchor.epoch, position: anchor.position.toString() },
        tuples: [],
        origin: {
          partition,
          epoch: anchor.epoch,
          position: anchor.position.toString(),
          eventId: Bun.randomUUIDv7(),
          type: 'com.rezics.community.native-heads.observed.v1',
          resourceId: locator.space_id,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (!input) return false;
  await publishSpaceDiscoveryTupleWitness(pool, input);
  return true;
}
