import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class CommerceRecoveryConflict extends Error {}

/** Fixed owner inventory. A retained cut must cover gift revocation as well as
 * the effective benefit epoch; Access grant coverage does not include these rows. */
const tables = [
  ['payment_provider', 'id'], ['offering', 'id'], ['offering_revision', 'offering_id, revision'],
  ['plan_group', 'offering_id, group_key'], ['plan', 'offering_id, offering_revision, plan_key'],
  ['price', 'offering_id, offering_revision, plan_key, price_key'],
  ['plan_benefit', 'offering_id, offering_revision, plan_key, benefit_key'],
  ['subscription', 'id'], ['quote', 'id'], ['subscription_change', 'id'],
  ['receipt', 'principal_id, idempotency_key'], ['settlement', 'id'],
  ['provider_callback', 'provider, provider_event_id'], ['reconciliation', 'id'],
  ['settlement_event', 'settlement_id, generation'], ['entitlement', 'id'],
  ['entitlement_event', 'entitlement_id, generation'], ['benefit_epoch', 'beneficiary'],
] as const;

export interface CommerceRecoveryCoverage {
  version: 1;
  tables: Record<typeof tables[number][0], { count: string; digest: string }>;
}

/** One repeatable-read cut, linear scan, 128 retained rows per fetch. */
export async function captureCommerceRecoveryCoverage(pool: Pool): Promise<CommerceRecoveryCoverage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL timezone = 'UTC'");
    const result = {} as CommerceRecoveryCoverage['tables'];
    for (const [table, order] of tables) {
      const hash = createHash('sha256');
      let count = 0;
      await client.query(`DECLARE commerce_cut NO SCROLL CURSOR FOR
        SELECT to_jsonb(t)::text AS row FROM commerce.${table} t ORDER BY ${order}`);
      for (;;) {
        const batch = await client.query<{ row: string }>('FETCH FORWARD 128 FROM commerce_cut');
        for (const item of batch.rows) { hash.update(item.row).update('\n'); count++; }
        if (batch.rows.length < 128) break;
      }
      await client.query('CLOSE commerce_cut');
      result[table] = { count: String(count), digest: hash.digest('hex') };
    }
    await client.query('COMMIT');
    return { version: 1, tables: result };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally { client.release(); }
}

export async function assertCommerceRecoveryCoverage(pool: Pool,
  retained: CommerceRecoveryCoverage): Promise<void> {
  if (retained.version !== 1 || tables.some(([table]) => !retained.tables?.[table])) {
    throw new CommerceRecoveryConflict('Commerce recovery cut is incomplete');
  }
  const actual = await captureCommerceRecoveryCoverage(pool);
  if (JSON.stringify(actual) !== JSON.stringify(retained)) {
    throw new CommerceRecoveryConflict('restored Commerce owner differs from retained cut');
  }
}
