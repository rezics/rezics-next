import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  readAccountDiscoveryReductionBinding,
  type AccountDiscoveryReductionBinding,
} from '../../src/access/account-discovery-reduction.ts';
import { accountDiscoverySource, readAccountDiscoveryBindings } from '../../src/access/account-discovery-source.ts';
import { redriveAccountDiscovery } from '../../src/access/account-discovery-work.ts';
import { AccessUnavailableError, CommandUnavailableError } from '../../src/access/unavailable.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { type Pending } from '../../src/history/contract/identity-types.ts';

const pool = createPool(process.env.DATABASE_URL!);
const source = accountDiscoverySource(pool);
const read = (partitions: readonly number[]) =>
  readAccountDiscoveryReductionBinding(pool, partitions, { deadline: Date.now() + 2000 });
const head = (binding: AccountDiscoveryReductionBinding, partition: number) =>
  binding.heads.find((entry) => entry.partition === partition)!;
afterAll(() => pool.end());

async function seed(route: number, handle: string | null = null) {
  const id = newId(route);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,handle,display_name,transaction_id)
     VALUES($1,$2,'actor','active',$3,'Original display',$2)`,
    [route, id, handle],
  );
  return id;
}

test('bounded native binding copies sorted full home coverage, including empty populations', async () => {
  const requested = Array.from({ length: 100 }, (_, index) => 3900 + index).reverse();
  const binding = await read([...requested, requested[0]!]);
  requested.reverse();
  expect(binding.owner).toBe('accounts');
  expect(binding.heads.map(({ partition }) => partition)).toEqual(requested);
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.isFrozen(binding.heads)).toBe(true);
  expect(binding.heads.every(Object.isFrozen)).toBe(true);
  const native = await pool.query<{ epoch: number; revision: string; claimRevision: string }>(
    `SELECT epoch FROM core.partition WHERE partition_no=$1`,
    [requested[0]],
  );
  expect(binding.heads[0]!.epoch).toBe(native.rows[0]!.epoch);
  expect(binding.heads.every(({ revision, claimRevision }) => revision > 0n && claimRevision > 0n)).toBe(true);
  await expect(read([])).rejects.toBeInstanceOf(RangeError);
  await expect(read(Array.from({ length: 101 }, (_, index) => index))).rejects.toBeInstanceOf(RangeError);
  for (const invalid of [-1, 4096, 1.5, NaN]) await expect(read([invalid])).rejects.toBeInstanceOf(RangeError);
  await expect(readAccountDiscoveryReductionBinding(pool, [3900], { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
  await expect(readAccountDiscoveryReductionBinding(pool, [3900], { deadline: Infinity })).rejects.toBeInstanceOf(
    TypeError,
  );
});

test('native Account reduction binding includes excluded and order populations and never reuses restored heads', async () => {
  const route = 62160;
  const partition = partitionOf(route);
  const id = await seed(route);
  try {
    const original = await read([partition]);
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [route, id]);
      } finally {
        await client.query('ROLLBACK');
      }
    });
    expect(await read([partition])).toEqual(original);
    await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [route, id]);
    expect((await source.read(partition, [id])).accounts).toEqual([]);
    const reduced = await read([partition]);
    expect(head(reduced, partition).revision).toBeGreaterThan(head(original, partition).revision);
    // An excluded row still affects NOT/zero-hit/count and future name/id order.
    await pool.query("UPDATE access.account SET display_name='Earlier name' WHERE route=$1 AND account_id=$2", [
      route,
      id,
    ]);
    const renamed = await read([partition]);
    expect(head(renamed, partition).revision).toBeGreaterThan(head(reduced, partition).revision);
    expect(head(renamed, partition).claimRevision).toBe(head(original, partition).claimRevision);
    await pool.query(
      "UPDATE access.account SET authn_fenced=false,display_name='Original display' WHERE route=$1 AND account_id=$2",
      [route, id],
    );
    expect((await source.read(partition, [id])).accounts).toMatchObject([
      { id, handle: null, displayName: 'Original display' },
    ]);
    const restored = await read([partition]);
    expect(head(restored, partition).revision).toBeGreaterThan(head(renamed, partition).revision);
    // Native restoration can serve a fresh query, but cannot equal the original
    // immutable capture. Source must retain that original rather than latest ACK.
    expect(restored).not.toEqual(original);
    expect(await read([partition])).toEqual(restored);
    expect(head(original, partition).revision).toBeLessThan(head(reduced, partition).revision);
  } finally {
    await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [route, id]);
  }
});

test('exact-claim reductions advance their foreign home before delivery and repair never revives the original binding', async () => {
  const route = 62176;
  const partition = partitionOf(route);
  let handle: string;
  let claimRoute: number;
  do {
    handle = `reduction_${newId(route).replaceAll('-', '')}`;
    claimRoute = createHash('sha256').update(handle).digest().readUInt16BE(0);
  } while (partitionOf(claimRoute) === partition);
  const claimPartition = partitionOf(claimRoute);
  const id = await seed(route, handle);
  const insert = () =>
    pool.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
     VALUES($1,$2,$3,'active',$3)`,
      [claimRoute, handle, id],
    );
  try {
    await insert();
    await redriveAccountDiscovery({ pool }, claimPartition);
    expect((await source.read(partition, [id])).accounts[0]!.handle).toBe(handle);
    const original = await read([partition, claimPartition]);
    let previous = original;
    // Pending, former/reserved, release and reactivation are actual claim writers.
    for (const assignment of [
      "state='pending',expires_at=now()+interval '1 day',reserved_until=NULL",
      "state='reserved',expires_at=NULL,reserved_until=now()+interval '1 day',former_until=now()+interval '1 hour'",
    ]) {
      await pool.query(`UPDATE access.handle_claim SET ${assignment} WHERE route=$1 AND normalized_handle=$2`, [
        claimRoute,
        handle,
      ]);
      expect((await source.read(partition, [id])).accounts).toMatchObject([{ id, handle: null }]);
      const changed = await read([partition, claimPartition]);
      expect(head(changed, claimPartition).claimRevision).toBeGreaterThan(head(previous, claimPartition).claimRevision);
      expect(head(changed, partition)).toEqual(head(original, partition));
      previous = changed;
    }
    await pool.query('DELETE FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [claimRoute, handle]);
    const released = await read([partition, claimPartition]);
    expect(head(released, claimPartition).claimRevision).toBeGreaterThan(head(previous, claimPartition).claimRevision);
    await insert();
    const restored = await read([partition, claimPartition]);
    expect(head(restored, claimPartition).claimRevision).toBeGreaterThan(head(released, claimPartition).claimRevision);
    expect(head(restored, partition)).toEqual(head(original, partition));
    expect((await source.read(partition, [id])).accounts[0]!.handle).toBe(handle);
    const stale = (await readAccountDiscoveryBindings(pool, partition, [id])).get(id)!;
    expect(stale.consumedClaimRevision).toBeLessThan(stale.claim!.revision);
    // Current native claim heads invalidate the old capture even before the
    // Account writer catches up; an account-only page cannot cover claim homes.
    expect(restored).not.toEqual(original);
    await redriveAccountDiscovery({ pool }, claimPartition);
    const repaired = await read([partition, claimPartition]);
    const current = (await readAccountDiscoveryBindings(pool, partition, [id])).get(id)!;
    expect(current.consumedClaimRevision).toBeGreaterThanOrEqual(current.claim!.revision);
    expect(head(repaired, partition).revision).toBeGreaterThan(head(original, partition).revision);
    expect(head(repaired, claimPartition)).toEqual(head(restored, claimPartition));
    expect(repaired).not.toEqual(original);
    expect(await read([partition, claimPartition])).toEqual(repaired);
  } finally {
    await pool.query('DELETE FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [claimRoute, handle]);
    await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [route, id]);
  }
});

test('missing, moved, fenced, partial and uninstalled claim homes refuse instead of returning partial evidence', async () => {
  const partition = 3889;
  const other = 3888;
  const native = (
    await pool.query<{
      node: string;
      write_state: string;
      moved_to: string | null;
      epoch: number;
      position: string;
    }>('SELECT node,write_state,moved_to,epoch,position::text FROM core.partition WHERE partition_no=$1', [partition])
  ).rows[0]!;
  const population = (
    await pool.query<{ population: string; revision: string; claim_revision: string }>(
      'SELECT population::text,revision::text,claim_revision::text FROM access.account_discovery_population WHERE partition_no=$1',
      [partition],
    )
  ).rows[0]!;
  const original = await read([partition]);
  try {
    for (const state of ['moved', 'fenced']) {
      await pool.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
        partition,
        state,
        state === 'moved' ? 'elsewhere' : null,
      ]);
      await expect(read([other, partition])).rejects.toMatchObject({
        name: 'CommandUnavailableError',
        reason: state,
        partition,
      });
    }
    await pool.query(
      "UPDATE core.partition SET write_state='active',moved_to=NULL,epoch=epoch+1 WHERE partition_no=$1",
      [partition],
    );
    const movedBack = await read([partition]);
    expect(head(movedBack, partition).epoch).toBe(native.epoch + 1);
    expect(movedBack).not.toEqual(original);
    await pool.query('DELETE FROM core.partition WHERE partition_no=$1', [partition]);
    await expect(read([other, partition])).rejects.toBeInstanceOf(CommandUnavailableError);
  } finally {
    await pool.query(
      `INSERT INTO core.partition(partition_no,node,write_state,moved_to,epoch,position) VALUES($1,$2,$3,$4,$5,$6::bigint)
       ON CONFLICT(partition_no) DO UPDATE SET node=EXCLUDED.node,write_state=EXCLUDED.write_state,
       moved_to=EXCLUDED.moved_to,epoch=EXCLUDED.epoch,position=EXCLUDED.position`,
      [partition, native.node, native.write_state, native.moved_to, native.epoch, native.position],
    );
  }
  try {
    await pool.query('UPDATE access.account_discovery_population SET claim_revision=0 WHERE partition_no=$1', [
      partition,
    ]);
    await expect(read([other, partition])).rejects.toBeInstanceOf(CommandUnavailableError);
    await pool.query('DELETE FROM access.account_discovery_population WHERE partition_no=$1', [partition]);
    await expect(read([other, partition])).rejects.toBeInstanceOf(CommandUnavailableError);
  } finally {
    await pool.query(
      `INSERT INTO access.account_discovery_population(partition_no,population,revision,claim_revision) VALUES($1,$2::bigint,$3::bigint,$4::bigint)
       ON CONFLICT(partition_no) DO UPDATE SET population=EXCLUDED.population,revision=EXCLUDED.revision,claim_revision=EXCLUDED.claim_revision`,
      [partition, population.population, population.revision, population.claim_revision],
    );
  }
});
