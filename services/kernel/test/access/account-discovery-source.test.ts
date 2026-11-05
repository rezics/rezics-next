import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import {
  accountDiscoverySource,
  readAccountDiscoveryBindings,
  readAccountDiscoveryWitness,
} from '../../src/access/account-discovery-source.ts';
import { consumeAccountDiscoveryClaim, redriveAccountDiscovery } from '../../src/access/account-discovery-work.ts';

const pool = createPool(process.env.DATABASE_URL!);
const source = accountDiscoverySource(pool);
afterAll(() => pool.end());

async function seed(route: number, handle: string | null = null) {
  const id = newId(route);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,handle,display_name,transaction_id)
    VALUES($1,$2,'actor','active',$3,'Discovery display',$2)`,
    [route, id, handle],
  );
  return id;
}

// These focused producer cases use the ordinary native fixture primitives; the
// existing frozen mixed-query suite remains the Search integration proof.
test('current exact claims supply handles while bad claims leave eligible display identities', async () => {
  const route = 62112;
  const partition = partitionOf(route);
  const handle = `discovery_${newId(route).replaceAll('-', '')}`;
  const id = await seed(route, handle);
  const claimRoute = createHash('sha256').update(handle).digest().readUInt16BE(0);
  try {
    expect((await source.read(partition, [id, id])).accounts).toMatchObject([
      { id, handle: null, displayName: 'Discovery display' },
    ]);
    await pool.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
      VALUES($1,$2,$3,'active',$3)`,
      [claimRoute, handle, id],
    );
    expect((await source.read(partition, [id])).accounts[0]?.handle).toBe(handle);
    const binding = (await readAccountDiscoveryBindings(pool, partition, [id])).get(id)!;
    expect(binding.claim?.route).toBe(claimRoute);
    expect(binding.consumedClaimRevision).toBe(0n);
    await pool.query(
      `UPDATE access.handle_claim SET state='reserved',reserved_until=now()+interval '1 day'
      WHERE route=$1 AND normalized_handle=$2`,
      [claimRoute, handle],
    );
    expect((await source.read(partition, [id])).accounts).toMatchObject([{ id, handle: null }]);
  } finally {
    await pool.query('DELETE FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [claimRoute, handle]);
    await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [route, id]);
  }
});

test('native census, bounded lookahead, fences, rollback and restoration agree', async () => {
  const route = 62128;
  const partition = partitionOf(route);
  const baseline = (await source.count(partition)).count;
  const first = await seed(route);
  const second = await seed(route);
  try {
    expect((await source.count(partition)).count).toBe(baseline + 2);
    const page = await source.page(partition, null, 1);
    expect(page.accounts.length).toBe(1);
    expect(page.next).not.toBeNull();
    const following = await source.page(partition, page.next, 100);
    expect(following.accounts.some(({ id }) => id === page.accounts[0]!.id)).toBe(false);
    const revision = (await source.read(partition, [first])).accounts[0]!.revision;
    const witness = (await readAccountDiscoveryWitness(pool, [partition])).get(partition)!;
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      await client.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        route,
        first,
      ]);
      await client.query('ROLLBACK');
    });
    expect((await source.count(partition)).count).toBe(baseline + 2);
    expect((await source.read(partition, [first])).accounts[0]!.revision).toBe(revision);
    expect((await readAccountDiscoveryWitness(pool, [partition])).get(partition)).toEqual(witness);
    await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [route, first]);
    expect((await source.read(partition, [first])).accounts).toEqual([]);
    expect((await source.count(partition)).count).toBe(baseline + 1);
    await pool.query('UPDATE access.account SET authn_fenced=false WHERE route=$1 AND account_id=$2', [route, first]);
    expect((await source.read(partition, [first])).accounts[0]!.revision).toBeGreaterThan(revision);
    expect((await source.count(partition)).count).toBe(baseline + 2);
  } finally {
    await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=ANY($2::uuid[])', [
      route,
      [first, second],
    ]);
  }
});

test('foreign claim redrive advances the Account once and permanently consumes replay', async () => {
  const route = 62144;
  const partition = partitionOf(route);
  const handle = `discovery_${newId(route).replaceAll('-', '')}`;
  const id = await seed(route, handle);
  const claimRoute = createHash('sha256').update(handle).digest().readUInt16BE(0);
  try {
    await pool.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id)
      VALUES($1,$2,$3,'active',$3)`,
      [claimRoute, handle, id],
    );
    const intent = (
      await pool.query<{ revision: string }>(
        'SELECT revision::text FROM access.account_discovery_claim_intent WHERE route=$1 AND account_id=$2',
        [claimRoute, id],
      )
    ).rows[0]!;
    const input = { route: claimRoute, accountId: id, revision: intent.revision };
    const before = (await source.read(partition, [id])).accounts[0]!.revision;
    expect(await consumeAccountDiscoveryClaim({ pool }, input)).toBe(true);
    const after = (await source.read(partition, [id])).accounts[0]!.revision;
    expect(after).toBeGreaterThan(before);
    await consumeAccountDiscoveryClaim({ pool }, input);
    expect((await source.read(partition, [id])).accounts[0]!.revision).toBe(after);
    const binding = (await readAccountDiscoveryBindings(pool, partition, [id])).get(id)!;
    expect(binding.consumedClaimRevision).toBeGreaterThanOrEqual(binding.claim!.revision);
    await redriveAccountDiscovery({ pool }, partitionOf(claimRoute));
    expect(
      (
        await pool.query('SELECT 1 FROM access.account_discovery_claim_intent WHERE route=$1 AND account_id=$2', [
          claimRoute,
          id,
        ])
      ).rowCount,
    ).toBe(0);
    expect(await consumeAccountDiscoveryClaim({ pool }, input)).toBe(false);
    expect((await source.read(partition, [id])).accounts[0]!.revision).toBe(after);
  } finally {
    await pool.query('DELETE FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [claimRoute, handle]);
    await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [route, id]);
  }
});
