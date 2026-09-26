// Shared Access transaction steps for the policy, interaction and revocation owners.
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { normalizePolicyError, PolicyDenied, PolicyUnavailable } from './policy-errors.ts';

export type Isolation = 'read committed' | 'repeatable read';

/** One owner transaction with the common two-second lock and five-second statement limits. */
export async function inAccessTransaction<T>(pool: Pool, isolation: Isolation,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(isolation === 'repeatable read'
      ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw normalizePolicyError(error);
  } finally { client.release(); }
}

/** Writers share-lock the recovery fence; snapshot readers only observe it. */
export async function requireRecoveryOpen(client: PoolClient, lock: boolean): Promise<string> {
  const fence = await client.query<{ open: boolean; generation: string }>(
    `SELECT open, generation FROM access.recovery_fence WHERE id ${lock ? 'FOR SHARE' : ''}`);
  if (fence.rows[0]?.open !== true) throw new PolicyUnavailable('Access recovery is held');
  return fence.rows[0].generation;
}

export interface PrincipalRow { id: string; enforcement_epoch: string; active: boolean }

export async function findPrincipal(client: PoolClient, principal: VerifiedPrincipal,
  lock = false): Promise<PrincipalRow | undefined> {
  return (await client.query<PrincipalRow>(`SELECT id, enforcement_epoch, active
    FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
    ${lock ? 'FOR SHARE' : ''}`, [principal.issuer, principal.subject])).rows[0];
}

export async function requireActivePrincipal(client: PoolClient,
  principal: VerifiedPrincipal): Promise<PrincipalRow> {
  const row = await findPrincipal(client, principal, true);
  if (!row?.active) throw new PolicyDenied('Access principal is unavailable');
  return row;
}

/** The authenticated principal's current mandate to act as `subject` for `action`. */
export async function requireMandate(client: PoolClient, principalId: string, subject: string,
  action: string): Promise<{ id: string; generation: string }> {
  const mandate = await client.query<{ id: string; generation: string }>(`SELECT r.id, r.generation
    FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = $3 AND r.active
      AND r.valid_until > clock_timestamp() AND s.active
    ORDER BY r.id LIMIT 1 FOR SHARE OF r, s`, [principalId, subject, action]);
  if (!mandate.rows[0]) throw new PolicyDenied('representation is missing');
  return mandate.rows[0];
}

/** One current direct Agent grant on an exact scope and action. */
export async function requireGrant(client: PoolClient, recipient: string, scope: string,
  action: string): Promise<{ id: string; generation: string }> {
  const grant = await client.query<{ id: string; generation: string }>(`SELECT id, generation
    FROM access.permission_grant WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
      AND active AND valid_until > clock_timestamp()
    ORDER BY id LIMIT 1 FOR SHARE`, [recipient, scope, action]);
  if (!grant.rows[0]) throw new PolicyDenied('management grant is missing');
  return grant.rows[0];
}

/** Locks the scope row that serializes this scope's authority changes. */
export async function lockOpenScope(client: PoolClient, scope: string): Promise<string> {
  const gate = await client.query<{ authority_epoch: string; open: boolean }>(
    'SELECT authority_epoch, open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope]);
  if (!gate.rows[0]?.open) throw new PolicyDenied('scope is unavailable or closed');
  return gate.rows[0].authority_epoch;
}

export async function advanceScopeEpoch(client: PoolClient, scope: string): Promise<string> {
  return (await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
    SET authority_epoch = authority_epoch + 1 WHERE id = $1 RETURNING authority_epoch`,
  [scope])).rows[0]!.authority_epoch;
}
