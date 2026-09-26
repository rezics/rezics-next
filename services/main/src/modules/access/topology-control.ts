import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import type { AuthorityControlFamily } from './topology-schema.ts';

/** Shared owner transaction, authority lookups and receipt replay for the
 * topology, protected-change, policy, Agent-control and invitation families. */
export class ControlDenied extends Error {}
export class ControlConflict extends Error {}
export class ControlStale extends Error {}
export class ControlUnavailable extends Error {}
export class ControlInvalid extends Error {}

export const WORK_SCOPE = 'work:create:root';
export const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const generationPattern = /^(0|[1-9][0-9]{0,18})$/;

export interface ControlReceipt { idempotencyKey: string; requestDigest: string }
export interface Mandate { id: string; generation: string; validUntil: Date }
export interface Ceiling { id: string; generation: string; validUntil: Date }

export function requireReceipt(receipt: ControlReceipt): void {
  if (!receipt.idempotencyKey || receipt.idempotencyKey.length > 128
    || receipt.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)) {
    throw new ControlInvalid('a bounded idempotency key is required');
  }
}

/** Owner guards raise 23514 for an invariant and 54000 for an exceeded bound. */
export function normalizeControlError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    const message = error instanceof Error ? error.message : '';
    if (code === '23505') return new ControlConflict('authority identity is already bound');
    if (code === '23503') return new ControlDenied('a referenced authority is unavailable');
    if (code === '54000') return new ControlUnavailable(message || 'authority bound exceeded');
    if (code === '23514') {
      if (/cycle|continuity|already has an outcome|already activated/.test(message)) {
        return new ControlConflict(message);
      }
      return new ControlDenied(message);
    }
    if (['40001', '40P01', '55P03', '57014'].includes(code)) {
      return new ControlUnavailable('authority owner could not complete');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** One bounded owner transaction behind the Access recovery fence. */
export async function controlTransaction<T>(pool: Pool,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (fence.rows[0]?.open !== true) throw new ControlUnavailable('Access recovery is held');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw normalizeControlError(error);
  } finally { client.release(); }
}

export async function lockGate(client: PoolClient, scope: string, write: boolean): Promise<string> {
  const gate = await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
    `SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1
     ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [scope]);
  if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) throw new ControlDenied('scope is closed');
  return gate.rows[0].authority_epoch;
}

export async function bumpEpoch(client: PoolClient, scope: string): Promise<string> {
  const bumped = await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
    SET authority_epoch = authority_epoch + 1 WHERE id = $1 RETURNING authority_epoch`, [scope]);
  return bumped.rows[0]!.authority_epoch;
}

export async function activePrincipal(client: PoolClient,
  principal: VerifiedPrincipal): Promise<{ id: string; epoch: string } | null> {
  const row = await client.query<{ id: string; enforcement_epoch: string }>(`SELECT id,
    enforcement_epoch FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
      AND active FOR SHARE`, [principal.issuer, principal.subject]);
  return row.rows[0] ? { id: row.rows[0].id, epoch: row.rows[0].enforcement_epoch } : null;
}

export async function requirePrincipal(client: PoolClient,
  principal: VerifiedPrincipal): Promise<{ id: string; epoch: string }> {
  const row = await activePrincipal(client, principal);
  if (!row) throw new ControlDenied('principal is not admitted');
  return row;
}

/** One current, unexpired mandate of an active principal for an active Agent. */
export async function mandateFor(client: PoolClient, principalId: string, subject: string,
  action: string, until?: Date): Promise<Mandate | null> {
  const row = await client.query<{ id: string; generation: string; valid_until: Date }>(`
    SELECT r.id, r.generation, r.valid_until FROM access.representation r
    JOIN access.authority_subject s ON s.id = r.subject_id
    WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = $3 AND r.active
      AND r.valid_until > clock_timestamp() AND ($4::timestamptz IS NULL OR r.valid_until >= $4)
      AND s.kind = 'agent' AND s.active
    ORDER BY r.valid_until DESC, r.id LIMIT 1 FOR SHARE OF r, s`,
  [principalId, subject, action, until ?? null]);
  const mandate = row.rows[0];
  return mandate ? { id: mandate.id, generation: mandate.generation,
    validUntil: mandate.valid_until } : null;
}

export async function requireMandate(client: PoolClient, principalId: string, subject: string,
  action: string, until?: Date): Promise<Mandate> {
  const mandate = await mandateFor(client, principalId, subject, action, until);
  if (!mandate) throw new ControlDenied(`representation for ${action} is missing`);
  return mandate;
}

/** A current grant the subject holds, covering `until` when given. */
export async function ceilingFor(client: PoolClient, subject: string, action: string,
  until?: Date, scope = WORK_SCOPE): Promise<Ceiling | null> {
  const row = await client.query<{ id: string; generation: string; valid_until: Date }>(`
    SELECT id, generation, valid_until FROM access.permission_grant
    WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
      AND valid_until > clock_timestamp() AND ($4::timestamptz IS NULL OR valid_until >= $4)
    ORDER BY valid_until DESC, id LIMIT 1 FOR SHARE`, [subject, scope, action, until ?? null]);
  const grant = row.rows[0];
  return grant ? { id: grant.id, generation: grant.generation, validUntil: grant.valid_until } : null;
}

export async function requireCeiling(client: PoolClient, subject: string, action: string,
  until?: Date, scope = WORK_SCOPE): Promise<Ceiling> {
  const ceiling = await ceilingFor(client, subject, action, until, scope);
  if (!ceiling) throw new ControlDenied(`${action} ceiling is missing or shorter`);
  return ceiling;
}

export async function requireAgent(client: PoolClient, subject: string): Promise<string> {
  const row = await client.query<{ generation: string }>(`SELECT generation
    FROM access.authority_subject WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [subject]);
  if (!row.rows[0]) throw new ControlDenied('Agent is not admitted');
  return row.rows[0].generation;
}

/** Exact principal/key/intent replay: the saved result, or a conflict. */
export async function priorReceipt<T extends Record<string, unknown>>(client: PoolClient,
  principalId: string, receipt: ControlReceipt, family: AuthorityControlFamily,
  operation: string, objectId: string): Promise<T | null> {
  const prior = await client.query<{ request_digest: string; family: string; operation: string;
    object_id: string; result: T }>(`SELECT request_digest, family, operation, object_id, result
    FROM access.authority_control_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
  [principalId, receipt.idempotencyKey]);
  const row = prior.rows[0];
  if (!row) return null;
  if (row.request_digest !== receipt.requestDigest || row.family !== family
    || row.operation !== operation || row.object_id !== objectId) {
    throw new ControlConflict('idempotency key binds another intent');
  }
  return row.result;
}

export async function recordReceipt(client: PoolClient, principalId: string,
  receipt: ControlReceipt, family: AuthorityControlFamily, operation: string,
  subject: string | null, objectId: string, epoch: string,
  result: Record<string, unknown>): Promise<void> {
  await client.query(`INSERT INTO access.authority_control_receipt (principal_id,
    idempotency_key, request_digest, family, operation, subject, object_id,
    result_authority_epoch, result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [principalId, receipt.idempotencyKey, receipt.requestDigest, family, operation, subject,
    objectId, epoch, result]);
}

/** Runs one receipted write: replay first, then the effect and its receipt. */
export async function receipted<T extends Record<string, unknown>>(client: PoolClient,
  principalId: string, receipt: ControlReceipt, family: AuthorityControlFamily,
  operation: string, subject: string | null, objectId: string,
  effect: () => Promise<{ epoch: string; result: T }>): Promise<T & { replayed: boolean }> {
  const prior = await priorReceipt<T>(client, principalId, receipt, family, operation, objectId);
  if (prior) return { ...prior, replayed: true };
  const { epoch, result } = await effect();
  await recordReceipt(client, principalId, receipt, family, operation, subject, objectId,
    epoch, result);
  return { ...result, replayed: false };
}
