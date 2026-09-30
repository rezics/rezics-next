import type { Pool, PoolClient } from 'pg';

declare const fenceBrand: unique symbol;
/** A live target lock, minted only while this owner's transaction is open. */
export interface PreservationFence { readonly resource: string; readonly [fenceBrand]: true }
export type PreservationAccess = Pool | PreservationFence;
const activeFences = new WeakSet<PreservationFence>();

/** Intake and erasure serialize on the same target across owner databases. */
export async function lockPreservationTarget(client: PoolClient, resource: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 931))', [resource]);
}

export async function withPreservationFence<T>(access: PreservationAccess, resource: string, operationId: string,
  write: (fence: PreservationFence) => Promise<T>): Promise<{ held: true } | { held: false; value: T }> {
  if ('resource' in access) {
    if (access.resource !== resource || !activeFences.has(access)) throw new Error('Preservation fence is unavailable');
    return { held: false, value: await write(access) };
  }
  const client = await access.connect();
  const fence = { resource } as PreservationFence;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    await lockPreservationTarget(client, resource);
    if (await postponeHeldMaterial(client, resource, operationId)) {
      await client.query('COMMIT');
      return { held: true };
    }
    activeFences.add(fence);
    const value = await write(fence);
    await client.query('COMMIT');
    return { held: false, value };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { activeFences.delete(fence); client.release(); }
}

/** One indexed hold lookup and one idempotent audit append per held resource. */
export async function postponeHeldMaterial(access: Pool | PoolClient, resource: string, operationId: string): Promise<boolean> {
  const rows = await access.query(`INSERT INTO access.governance_erasure_postponement
    (hold_id, operation_id, material_ref, reason)
    SELECT id, $2, $1, reason FROM access.governance_preservation_hold
    WHERE target_resource = $1 AND released_at IS NULL
    ON CONFLICT DO NOTHING RETURNING hold_id`, [resource, operationId]);
  if (rows.rowCount) return true;
  return (await access.query(`SELECT 1 FROM access.governance_preservation_hold
    WHERE target_resource = $1 AND released_at IS NULL LIMIT 1`, [resource])).rowCount !== 0;
}

/** Credentials can be erased; the held safety record and material remain. */
export async function recordAccountPreservation(access: Pool, issuer: string, subject: string,
  operationId: string): Promise<void> {
  await access.query(`INSERT INTO access.governance_erasure_postponement
    (hold_id, operation_id, material_ref, reason)
    SELECT id, $3, target_resource, reason FROM access.governance_preservation_hold
    WHERE account_issuer = $1 AND account_subject = $2 AND released_at IS NULL
    ON CONFLICT DO NOTHING`, [issuer, subject, operationId]);
}
