import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AdmissionDenied, AdmissionUnavailable } from './admission.ts';

export const BASELINE_SPACE_QUOTA_POLICY = '00000000-0000-8000-8000-000000000351';

/** Adapter to migration 091's quota owner. All writes share the admission's
 * transaction and use the owner's reservation triggers and immutable events.
 * Cost: one policy and one exact monthly ledger, one reservation, three events
 * over its whole lifetime. No count of historical Spaces or Agents is needed.
 * The existing scope-first lock order serializes registration and settlement;
 * quota's ledger row lock/capacity CHECK is the final overspend backstop.
 * https://www.postgresql.org/docs/18/explicit-locking.html#LOCKING-ROWS */
export async function reserveBaselineSpace(client: PoolClient, principalId: string,
  admissionId: string, digest: string): Promise<void> {
  const policy = (await client.query<{ head_revision: string; base_allowance: string }>(`
    SELECT p.head_revision, r.base_allowance FROM quota.policy p
    JOIN quota.policy_revision r ON r.policy_id = p.id AND r.revision = p.head_revision
    WHERE p.id = $1 AND r.period = 'P1M' AND r.max_reservation >= 1 FOR SHARE OF p`,
  [BASELINE_SPACE_QUOTA_POLICY])).rows[0];
  if (!policy) throw new AdmissionUnavailable('member Space quota policy is unavailable');
  // This private IRI is only a quota beneficiary key, never public attribution.
  const beneficiary = `https://rezics.com/id/${principalId}`;
  await client.query(`INSERT INTO quota.ledger
      (id, policy_id, policy_revision, beneficiary, source, period_start, period_end, capacity)
    VALUES ($1,$2,$3,$4,'base',date_trunc('month', clock_timestamp(), 'UTC'),
      date_trunc('month', clock_timestamp(), 'UTC') + interval '1 month',$5)
    ON CONFLICT (policy_id, beneficiary, period_start) WHERE source = 'base' DO NOTHING`,
  [randomUUID(), BASELINE_SPACE_QUOTA_POLICY, policy.head_revision, beneficiary, policy.base_allowance]);
  const ledger = (await client.query<{ id: string; policy_revision: string; free: string }>(`
    SELECT id, policy_revision, (capacity - reserved - consumed)::text AS free FROM quota.ledger
    WHERE policy_id = $1 AND beneficiary = $2 AND source = 'base'
      AND period_start = date_trunc('month', clock_timestamp(), 'UTC') AND open FOR UPDATE`,
  [BASELINE_SPACE_QUOTA_POLICY, beneficiary])).rows[0];
  if (!ledger || BigInt(ledger.free) < 1n) throw new AdmissionDenied('member Space creation quota is exhausted');
  const id = randomUUID();
  await client.query(`INSERT INTO quota.reservation
      (id, ledger_id, policy_id, policy_revision, operation_id, request_digest,
       admission_id, amount, state, generation, expires_at)
    VALUES ($1,$2,$3,$4,$5::text,$6,$5::uuid,1,'reserved',1,clock_timestamp() + interval '30 seconds')`,
  [id, ledger.id, BASELINE_SPACE_QUOTA_POLICY, ledger.policy_revision, admissionId, digest]);
  await client.query(`INSERT INTO quota.reservation_event
      (reservation_id, generation, action, state, consumed, expires_at)
    SELECT id, generation, 'reserve', state, consumed, expires_at FROM quota.reservation WHERE id = $1`, [id]);
  // An unknown graph outcome must retain capacity even after admission expiry.
  // The existing admission sealer supplies the terminal proof and releases it.
  await client.query(`UPDATE quota.reservation SET state = 'reconciling', generation = 2 WHERE id = $1`, [id]);
  await client.query(`INSERT INTO quota.reservation_event
      (reservation_id, generation, action, state, consumed, expires_at)
    SELECT id, generation, 'defer', state, consumed, expires_at FROM quota.reservation WHERE id = $1`, [id]);
}

/** Called only after the normal admission/receipt/digest/epoch checks. */
export async function settleBaselineSpace(client: PoolClient, admissionId: string,
  outcome: 'succeeded' | 'cancelled'): Promise<void> {
  const changed = (await client.query<{ id: string }>(`UPDATE quota.reservation
    SET state = $3, consumed = $4, generation = generation + 1
    WHERE policy_id = $1 AND operation_id = $2::text AND stage = 0
      AND admission_id = $2::uuid AND state = 'reconciling' RETURNING id`,
  [BASELINE_SPACE_QUOTA_POLICY, admissionId, outcome === 'succeeded' ? 'settled' : 'released',
    outcome === 'succeeded' ? 1 : 0])).rows[0];
  if (!changed) return;
  await client.query(`INSERT INTO quota.reservation_event
      (reservation_id, generation, action, state, consumed, expires_at)
    SELECT id, generation, $2, state, consumed, expires_at FROM quota.reservation WHERE id = $1`,
  [changed.id, outcome === 'succeeded' ? 'settle' : 'release']);
}
