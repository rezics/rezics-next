import { expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { allocateDiscovery, discoveryConsumer } from '../../src/search/generations.ts';
import type { DiscoveryRegistry } from '../../src/search/discovery.ts';

test('discovery allocation registers empty partition checkpoints with Core zero-position semantics', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const prefix = `empty-${crypto.randomUUID().slice(0, 8)}-`;
  const consumer = discoveryConsumer(prefix, 1);
  try {
    await allocateDiscovery(pool, prefix, {
      entries: [{ kind: 'account', owner: 'accounts' }],
    } as unknown as DiscoveryRegistry);
    const rows = (await pool.query('SELECT epoch,position FROM core.consumer_checkpoint WHERE consumer=$1', [consumer]))
      .rows;
    expect(rows).toHaveLength(4096);
    expect(rows.some((row) => row.position === '0')).toBe(true);
    expect(rows.every((row) => (row.epoch === null) === (row.position === '0'))).toBe(true);
  } finally {
    await pool.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [consumer]);
    await pool.query('DELETE FROM search.discovery_population WHERE prefix=$1', [prefix]);
    await pool.query('DELETE FROM search.discovery_generation WHERE prefix=$1', [prefix]);
    await pool.end();
  }
});
