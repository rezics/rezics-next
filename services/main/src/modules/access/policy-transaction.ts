// Shared Access transaction steps for the policy, interaction and revocation owners.
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { VerifiedPrincipal } from './admission.ts';
import { normalizePolicyError, PolicyDenied, PolicyUnavailable } from './policy-errors.ts';
import { REVOCATION_AFFECTED_WORK_LIMIT } from './revocation-schema.ts';

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
export async function requireMandate(
  client: PoolClient,
  principalId: string,
  subject: string,
  action: string,
): Promise<{ id: string; generation: string }> {
  const mandate = await client.query<{ id: string; generation: string }>(
    `SELECT r.id, r.generation
    FROM access.representation r JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.principal_id = $1 AND r.subject_id = $2
      AND (r.action = $3 OR $3 = 'access.revoke' AND r.action = 'agent.control') AND r.active
      AND r.valid_until > clock_timestamp() AND s.active
    ORDER BY r.id LIMIT 1 FOR SHARE OF r, s`,
    [principalId, subject, action],
  );
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

/** Reuse the strong-revocation drain after a controller/invitation owner has
 * revoked its source in this transaction. Cost: three indexed source probes,
 * at most 256 work rows, one immutable drain. Never acknowledge a truncated set. */
export async function drainRevokedAuthority(
  client: PoolClient,
  principalId: string,
  issuer: string,
  kind: 'representation' | 'representation_edge' | 'permission_grant',
  id: string,
  generation: string,
  scope: string,
): Promise<string> {
  const admissionColumn =
    kind === 'representation' ? 'represented_representation_id' : 'represented_grant_id';
  const leaseColumn = kind === 'representation' ? 'representation_id' : 'grant_id';
  const work: {
    admission_id: string | null;
    search_read_lease_id: string | null;
    download_read_lease_id: string | null;
  }[] = [];
  if (kind === 'representation_edge') {
    const admissions = (
      await client.query<{ id: string }>(
        `SELECT DISTINCT a.id FROM access.representation_path_step s
      JOIN access.admission_obligation o ON o.path_id = s.path_id JOIN access.admission a ON a.id = o.admission_id
      WHERE s.edge_id = $1 AND a.state <> 'sealed' ORDER BY a.id LIMIT $2`,
        [id, REVOCATION_AFFECTED_WORK_LIMIT + 1],
      )
    ).rows;
    for (const admission of admissions)
      work.push({
        admission_id: admission.id,
        search_read_lease_id: null,
        download_read_lease_id: null,
      });
    if (work.length > REVOCATION_AFFECTED_WORK_LIMIT)
      throw new PolicyUnavailable('strong revocation exceeds its drain budget');
  }
  for (const [table, column, field, state] of [
    ['admission', admissionColumn, 'admission_id', "state <> 'sealed'"],
    [
      'search_read_lease',
      leaseColumn,
      'search_read_lease_id',
      "state IN ('admitted','delivering')",
    ],
    [
      'download_read_lease',
      leaseColumn,
      'download_read_lease_id',
      "state IN ('admitted','delivering')",
    ],
  ] as const) {
    if (kind === 'representation_edge') continue;
    const rows = (
      await client.query<{ id: string }>(
        `SELECT id FROM access.${table}
      WHERE ${column} = $1 AND ${state} ORDER BY id LIMIT $2`,
        [id, REVOCATION_AFFECTED_WORK_LIMIT + 1],
      )
    ).rows;
    for (const row of rows)
      work.push({
        admission_id: null,
        search_read_lease_id: null,
        download_read_lease_id: null,
        [field]: row.id,
      });
    if (work.length > REVOCATION_AFFECTED_WORK_LIMIT)
      throw new PolicyUnavailable('strong revocation exceeds its drain budget');
  }
  const revocationId = randomUUID();
  await client.query(
    `INSERT INTO access.revocation (id,principal_id,issuer_subject,mode,
    target_kind,${kind}_id,target_generation,scope_id,fence_authority_epoch,recovery_generation,
    affected_work,state,completed_at)
    SELECT $1,$2,$3,'strong',$4,$5,$6,$7,g.authority_epoch,f.generation,$8,$9,
      CASE WHEN $9 = 'completed' THEN clock_timestamp() END
    FROM access.scope_gate g CROSS JOIN access.recovery_fence f WHERE g.id = $7 AND f.id`,
    [
      revocationId,
      principalId,
      issuer,
      kind,
      id,
      generation,
      scope,
      work.length,
      work.length ? 'draining' : 'completed',
    ],
  );
  if (work.length)
    await client.query(
      `INSERT INTO access.revocation_affected_work
    (revocation_id,ordinal,admission_id,search_read_lease_id,download_read_lease_id)
    SELECT $1,w.ordinal,w.admission_id,w.search_read_lease_id,w.download_read_lease_id
    FROM jsonb_to_recordset($2::jsonb) AS w(ordinal smallint,admission_id uuid,
      search_read_lease_id uuid,download_read_lease_id uuid)`,
      [revocationId, JSON.stringify(work.map((row, index) => ({ ordinal: index + 1, ...row })))],
    );
  for (const [table, field] of [
    ['search_read_lease', 'search_read_lease_id'],
    ['download_read_lease', 'download_read_lease_id'],
  ] as const)
    await client.query(
      `UPDATE access.${table}
      SET state = 'aborted',finished_at = clock_timestamp() WHERE id = ANY($1::uuid[]) AND state = 'admitted'`,
      [work.flatMap((row) => (row[field] ? [row[field]] : []))],
    );
  return revocationId;
}
