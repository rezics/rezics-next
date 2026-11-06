import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import type { DiscoveryProjection } from '../../src/search/account-discovery.ts';
import { createDiscoveryIndexer } from '../../src/search/indexer.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the check services');

const pool = createPool(databaseUrl);
afterAll(() => pool.end());

function addressIn(partition: number) {
  for (let n = 0; n < 1_000_000; n++) {
    const address = `p${partition}a${n}`;
    if (partitionOf(createHash('sha256').update(address).digest().readUInt16BE(0)) === partition) return address;
  }
  throw new Error('No address hashes into the relay partition');
}

test('Space invalidation uses the native resolver and only the relay partition', async () => {
  const partition = 401;
  const home = newId(partition * 16);
  const elsewhere = newId(402 * 16);
  const spaces: string[][] = [];
  const projection = {
    metadataProducers: { space: {} },
    async project() {},
    async projectOwner(_kind: string, _partition: number, ids: readonly string[]) {
      spaces.push([...ids]);
    },
  } as unknown as DiscoveryProjection;
  const consumer = `space-part-${crypto.randomUUID()}`;
  const relay = createDiscoveryIndexer(pool, projection, consumer);
  const positions: bigint[] = [];
  try {
    positions.push(
      (
        await runCommand(pool, { partition }, async () => ({
          value: null,
          events: [
            { type: 'com.rezics.community.space.updated.v1', subject: home, data: { spaceId: home, revisionId: home } },
          ],
        }))
      ).position,
    );
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: positions[0] });
    expect(spaces).toEqual([[home]]);
    positions.push(
      (
        await runCommand(pool, { partition }, async () => ({
          value: null,
          events: [
            {
              type: 'com.rezics.community.space.address-activated.v1',
              subject: elsewhere,
              data: { spaceId: elsewhere, address: addressIn(partition) },
            },
          ],
        }))
      ).position,
    );
    expect(await relay.run(partition)).toMatchObject({ status: 'read', envelopes: 1, position: positions[1] });
    expect(spaces).toEqual([[home]]);
  } finally {
    await pool.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [consumer]);
    for (const position of positions)
      await pool.query('DELETE FROM core.outbox WHERE partition_no=$1 AND position=$2', [partition, String(position)]);
  }
}, 60_000);
