import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createLifecycleInternals, type RecoveryEvidence } from '../../src/access/lifecycle.ts';
import type { Pool } from 'pg';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());
async function fixture(kind = 'actor') {
  const accountId = newId(182);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,$3,'active',$2)`,
    [routeOf(accountId), accountId, kind],
  );
  let witness: RecoveryEvidence | null = null;
  let resolutions = 0;
  let beforeResolve: (() => Promise<void>) | undefined;
  let receiptReads = 0;
  let beforeQuery: ((sql: string | undefined) => Promise<void>) | undefined;
  const commandPool = Object.create(pool) as Pool;
  commandPool.connect = (async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    client.query = (async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string }).text;
      if (sql?.includes('FROM core.receipt')) receiptReads++;
      await beforeQuery?.(sql);
      return query(...(args as Parameters<typeof query>));
    }) as typeof client.query;
    const release = client.release.bind(client);
    client.release = (...args) => {
      client.query = query;
      client.release = release;
      release(...args);
    };
    return client;
  }) as Pool['connect'];
  const lifecycle = createLifecycleInternals({
    pool: commandPool,
    routeKey: new Uint8Array(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async (reference) => {
      resolutions++;
      expect(pool.totalCount - pool.idleCount).toBe(0);
      await beforeResolve?.();
      return reference === 'exact-auth-reference' ? witness : null;
    },
  });
  const fence = await lifecycle.raiseFence({ accountId, key: `${accountId}:fence` });
  witness = {
    ...fence.value,
    authnEpoch: Number(fence.value.minimumAuthnEpoch),
    establishmentId: 'committed-establishment',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  } as RecoveryEvidence;
  return {
    accountId,
    lifecycle,
    get receiptReads() {
      return receiptReads;
    },
    clear: () => lifecycle.clearFence({ accountId, key: `${accountId}:clear`, evidence: 'exact-auth-reference' }),
    get resolutions() {
      return resolutions;
    },
    setWitness(value: RecoveryEvidence | null) {
      witness = value;
    },
    get witness() {
      return witness!;
    },
    onResolve(callback: () => Promise<void>) {
      beforeResolve = callback;
    },
    onQuery(callback: (sql: string | undefined) => Promise<void>) {
      beforeQuery = callback;
    },
  };
}

test('exact cleared receipt replays once, but current authority is checked before private receipt disclosure', async () => {
  for (const change of ['floor', 'suspended', 'deleted', 'operator', 'missing', 'changed', 'expired']) {
    const f = await fixture();
    const first = await f.clear();
    expect(first.replayed).toBe(false);
    expect(await f.clear()).toMatchObject({ replayed: true, transactionId: first.transactionId, value: first.value });
    await expect(
      f.lifecycle.clearFence({
        accountId: f.accountId,
        evidence: 'exact-auth-reference',
        key: `${f.accountId}:missing-clear-receipt`,
      }),
    ).rejects.toThrow();
    if (change === 'floor') await f.lifecycle.raiseFence({ accountId: f.accountId, key: `${f.accountId}:later` });
    else if (change === 'suspended') await suspendAccount(pool, f.accountId);
    else if (change === 'missing') f.setWitness(null);
    else if (change === 'changed') f.setWitness({ ...f.witness, establishmentId: 'substituted' });
    else if (change === 'expired')
      f.setWitness({ ...f.witness, expiresAt: new Date(0).toISOString() } as RecoveryEvidence);
    else
      await pool.query(
        `UPDATE access.account SET state=$2,kind=$3,operator_account_id=$4 WHERE account_id=$1 AND route=$5`,
        [
          f.accountId,
          change === 'deleted' ? change : 'active',
          'actor',
          change === 'operator' ? newId(183) : null,
          routeOf(f.accountId),
        ],
      );
    const reads = f.receiptReads;
    await expect(f.clear()).rejects.toThrow();
    if (change !== 'changed') expect(f.receiptReads).toBe(reads);
    expect(f.resolutions).toBeGreaterThanOrEqual(3);
    expect(
      (
        await pool.query(`SELECT count(*)::int n FROM core.outbox WHERE partition_no=$1 AND position=$2`, [
          first.partition,
          first.position,
        ])
      ).rows[0].n,
    ).toBe(1);
  }
});

test('native retry re-resolves Auth before checkout and denies later floor, state, operator or witness changes', async () => {
  for (const change of ['floor', 'suspended', 'operator', 'missing', 'changed', 'expired']) {
    const f = await fixture();
    let failed = false;
    let changed = false;
    f.onQuery(async (sql) => {
      if (!failed && sql?.includes('SET authn_fenced = false')) {
        failed = true;
        throw Object.assign(new Error('forced serialization contention'), { code: '40001' });
      }
    });
    f.onResolve(async () => {
      if (!failed || changed) return;
      changed = true;
      if (change === 'missing') f.setWitness(null);
      else if (change === 'changed') f.setWitness({ ...f.witness, establishmentId: 'changed-after-contention' });
      else if (change === 'expired') f.setWitness({ ...f.witness, expiresAt: new Date(0).toISOString() });
      else if (change === 'floor')
        await f.lifecycle.raiseFence({ accountId: f.accountId, key: `${f.accountId}:retry-later` });
      else if (change === 'suspended') await suspendAccount(pool, f.accountId);
      else
        await pool.query(`UPDATE access.account SET state=$2,operator_account_id=$3 WHERE route=$4 AND account_id=$1`, [
          f.accountId,
          'active',
          change === 'operator' ? newId(183) : null,
          routeOf(f.accountId),
        ]);
    });
    await expect(f.clear()).rejects.toThrow();
    expect(f.resolutions).toBeGreaterThanOrEqual(3);
    expect((await f.lifecycle.readFenceState(f.accountId))?.fenced).toBe(true);
  }
});

test('an organization cannot use a human recovery witness', async () => {
  const f = await fixture('organization');
  await expect(f.clear()).rejects.toThrow();
});
