import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createAccess } from '../../src/access/index.ts';
import { createDiscoveryProducerEntry } from '../../src/composition/discovery.ts';
import { createPool } from '../../src/database/pool.ts';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { currentReadSnapshot } from '../../src/semantic/read.ts';
import { nativeDiscoveryRegistry } from '../../src/search/account-discovery.ts';
import {
  advanceDiscovery,
  allocateDiscovery,
  discoveryConsumer,
  discoveryGenerations,
} from '../../src/search/generations.ts';
import { createDiscoveryIndex, discoveryIndexName, readDiscoveryPhysicalIdentity } from '../../src/search/indices.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';

test('core certification rejects a concurrent native cut and fenced home without holding a snapshot over Search', async () => {
  const pool = createPool(process.env.DATABASE_URL!);
  const writer = createPool(process.env.DATABASE_URL!);
  configureTestReceiptKeys(pool);
  const native = createOpenSearch(process.env.OPENSEARCH_URL!);
  const search: OpenSearch = {
    ...native,
    request(...args) {
      if (currentReadSnapshot(pool)) throw new Error('A native read snapshot crossed external Search I/O');
      return native.request(...args);
    },
  };
  const prefix = `core-cut-${crypto.randomUUID().slice(0, 8)}-`;
  let home: number | undefined;
  let index: string | undefined;
  try {
    await bootstrapRelease(pool, bundledRelease);
    home = (
      await pool.query<{ partition_no: number }>(
        `SELECT p.partition_no FROM core.partition p
         JOIN access.account_discovery_population a USING(partition_no)
         WHERE a.population=0 AND NOT EXISTS (
           SELECT 1 FROM semantic.subject s WHERE s.route>=p.partition_no*16 AND s.route<(p.partition_no+1)*16)
         ORDER BY p.partition_no DESC LIMIT 1`,
      )
    ).rows[0]!.partition_no;
    const routeKey = new Uint8Array(32).fill(73);
    const entry = createDiscoveryProducerEntry({
      pool,
      routeKey,
      access: createAccess({ actions: new Map() }),
      clock: () => new Date(),
    });
    expect((await entry.subjects.count(home)).count).toBe(0);
    expect((await entry.accounts.count(home)).count).toBe(0);
    let moved = false;
    const subjects = {
      ...entry.subjects,
      async countPartitions(partitions: readonly number[]) {
        const census = await entry.subjects.countPartitions!(partitions);
        const selectedHome = home;
        if (selectedHome !== undefined && partitions.includes(selectedHome) && !moved) {
          moved = true;
          const client = await writer.connect();
          await client.query('BEGIN');
          try {
            const cut = (
              await client.query(
                'UPDATE core.partition SET position=position+1 WHERE partition_no=$1 RETURNING epoch,position::text',
                [selectedHome],
              )
            ).rows[0]!;
            const subject = `018f0000-0000-7000-8000-${(selectedHome * 16).toString(16).padStart(4, '0')}00000091`;
            await client.query(
              `INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,subject,data)
               VALUES($1,$2,0,1,$3,$4,'com.rezics.subject.created.v1',$5,jsonb_build_object('id',$5::text))`,
              [selectedHome, cut.position, cut.epoch, crypto.randomUUID(), subject],
            );
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        }
        return census;
      },
    };
    const registry = await nativeDiscoveryRegistry(pool, routeKey, subjects, {
      release: bundledRelease,
      accounts: entry.accounts,
    });
    await allocateDiscovery(pool, prefix, registry);
    const target = (await discoveryGenerations(pool, prefix))[0]!;
    index = discoveryIndexName(prefix, target.generation);
    await createDiscoveryIndex(search, prefix, target.generation, target.incarnation);
    const physical = (await readDiscoveryPhysicalIdentity(search, index))!;
    await pool.query(
      "UPDATE search.discovery_generation SET index_uuid=$2,state='reconciling',capability=$3::jsonb WHERE prefix=$1",
      [
        prefix,
        physical.uuid,
        JSON.stringify({ physicalTarget: index, uuid: physical.uuid, incarnation: target.incarnation, witnesses: {} }),
      ],
    );
    await pool.query(
      'UPDATE search.discovery_population SET complete=true,certified=(partition_no<>$2) WHERE prefix=$1',
      [prefix, home],
    );
    const options = { pool, search, prefix, registry, listing: subjectListingSource(pool) };
    const status = async () =>
      (
        await pool.query<{ owner: string; certified: boolean; position: string | null }>(
          'SELECT owner,certified,reconcile_position::text AS position FROM search.discovery_population WHERE prefix=$1 AND partition_no=$2 ORDER BY owner',
          [prefix, home],
        )
      ).rows;
    await advanceDiscovery(options);
    expect(moved).toBe(true);
    expect(await status()).toEqual(
      ['accounts', 'semantic'].map((owner) => ({ owner, certified: false, position: null })),
    );
    await advanceDiscovery(options);
    const current = await entry.subjects.count(home);
    expect(current.position).toBeGreaterThan(0n);
    expect(await status()).toEqual(
      ['accounts', 'semantic'].map((owner) => ({ owner, certified: true, position: current.position.toString() })),
    );
    await pool.query('UPDATE search.discovery_population SET certified=false WHERE prefix=$1 AND partition_no=$2', [
      prefix,
      home,
    ]);
    await writer.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [home]);
    await expect(advanceDiscovery(options)).rejects.toMatchObject({ reason: 'fenced' });
    expect((await status()).every((row) => !row.certified)).toBe(true);
  } finally {
    try {
      if (home !== undefined)
        await writer.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [home]);
      if (index) await native.request('DELETE', `/${index}`);
    } finally {
      try {
        for (const table of ['discovery_population', 'discovery_generation'])
          await pool.query(`DELETE FROM search.${table} WHERE prefix=$1`, [prefix]);
        await pool.query('DELETE FROM core.consumer_checkpoint WHERE consumer=$1', [discoveryConsumer(prefix, 1)]);
      } finally {
        await Promise.all([writer.end(), pool.end()]);
      }
    }
  }
});
