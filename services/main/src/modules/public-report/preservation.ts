import type { Pool, PoolClient } from 'pg';
import { GovernanceConflict } from '../governance/store.ts';
import { accessClient, controlTransaction, withAccessClient } from '../access/topology-control.ts';

declare const fenceBrand: unique symbol;
/** A live target lock, minted only while its transaction is open. */
export interface PreservationFence { readonly resource: string; readonly [fenceBrand]: true }
export type PreservationAccess = Pool | PoolClient | PreservationFence;
const activeFences = new WeakSet<PreservationFence>();

/** Intake and erasure serialize on the same target across owner databases. */
export async function lockPreservationTarget(client: PoolClient, resource: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 931))', [resource]);
}

/** Recovery is already shared by intake. Match the Person owner's order:
 * author advisory, sorted principals, authority, provision, intent, then material.
 * Principal write locks fence sibling Persons and reciprocal authenticated reports. */
export async function lockPreservationNeighborhood(client: PoolClient, author: string | null,
  resource: string, reporter: string | null): Promise<string | null> {
  if (!author) { await lockPreservationTarget(client, resource); return null; }
  await lockPreservationTarget(client, author);
  const owner = (await client.query<{ principal_id: string; provision_id: string | null;
    representation_id: string | null }>(`SELECT p.principal_id, p.id AS provision_id,
      NULL::uuid AS representation_id FROM access.agent_provision p WHERE p.agent_id = $1
    UNION ALL SELECT r.principal_id, NULL::uuid, r.id FROM access.representation r
      WHERE r.subject_id = $1 AND NOT EXISTS (
        SELECT 1 FROM access.agent_provision WHERE agent_id = $1)
    ORDER BY representation_id LIMIT 1`, [author])).rows[0];
  await client.query(`SELECT id FROM access.principal WHERE id = ANY($1::uuid[])
    ORDER BY id FOR UPDATE`, [[...new Set([owner?.principal_id, reporter].filter((id): id is string => !!id))]]);
  await client.query('SELECT id FROM access.authority_subject WHERE id = $1 FOR SHARE', [author]);
  if (owner) {
    const retained = owner.provision_id
      ? await client.query(`SELECT id FROM access.agent_provision
          WHERE id = $1 AND agent_id = $2 AND principal_id = $3 FOR UPDATE`,
        [owner.provision_id, author, owner.principal_id])
      : await client.query(`SELECT id FROM access.representation
          WHERE id = $1 AND subject_id = $2 AND principal_id = $3 FOR SHARE`,
        [owner.representation_id, author, owner.principal_id]);
    if (!retained.rowCount) throw new GovernanceConflict('Report author ownership changed');
    await client.query(`SELECT id FROM access.outbox WHERE principal_id = $1
      AND kind = 'account.deletion_fenced' AND authority_epoch = (
        SELECT enforcement_epoch FROM access.principal WHERE id = $1) FOR SHARE`, [owner.principal_id]);
  }
  if (resource !== author) await lockPreservationTarget(client, resource);
  return owner?.principal_id ?? null;
}

export async function withPreservationFence<T>(access: PreservationAccess, resource: string, operationId: string,
  write: (fence: PreservationFence) => Promise<T>): Promise<{ held: true } | { held: false; value: T }> {
  if ('resource' in access) {
    if (access.resource !== resource || !activeFences.has(access)) throw new Error('Preservation fence is unavailable');
    return { held: false, value: await write(access) };
  }
  // The caller keeps this client's transaction and target lock through release.
  if ('release' in access) return writeWithPreservationFence(access, resource, operationId, write);
  const borrowed = accessClient(access);
  if (borrowed) return controlTransaction(access,
    client => writeWithPreservationFence(client, resource, operationId, write), false, borrowed);
  return withAccessClient(access, async client => {
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const result = await writeWithPreservationFence(client, resource, operationId, write);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

async function writeWithPreservationFence<T>(client: PoolClient, resource: string, operationId: string,
  write: (fence: PreservationFence) => Promise<T>): Promise<{ held: true } | { held: false; value: T }> {
  await lockPreservationTarget(client, resource);
  if (await postponeHeldMaterial(client, resource, operationId)) return { held: true };
  const fence = { resource } as PreservationFence;
  activeFences.add(fence);
  try { return { held: false, value: await write(fence) }; }
  finally { activeFences.delete(fence); }
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
