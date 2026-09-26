import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';

// Shared lifecycle of Access migration 110: manager authority, per-feature
// receipts, lease fences and the exact-revision head CAS. Family modules own
// their basis, batch effects and reads; see README.md in this directory.

export class RecommendationDenied extends Error {}
export class RecommendationConflict extends Error {}
export class RecommendationStale extends Error {}
export class RecommendationNotReady extends Error {}
export class RecommendationUnavailable extends Error {}
export class RecommendationMissing extends Error {}
/** The caller must start pagination again; no reason or count is disclosed. */
export class RecommendationRestart extends Error {}

export const MANAGE_SCOPE = 'recommendation:manage';
export const MANAGE_ACTION = 'recommendation.generation.manage';
export const nativeIri = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ManageContext { principal: VerifiedPrincipal; actingSubject: string }
export interface ReceiptKey { idempotencyKey: string; requestDigest: string }
export interface InputPosition { source: 'main-graph'; dataEpoch: string; sequence: string }

export const digest = (value: unknown): string =>
  createHash('sha256').update(canonical(value)).digest('hex');

/** Key-sorted JSON so equal intents have equal digests. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** One bounded Access transaction; interrupted work never returns to the pool half-done. */
export async function inAccess<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client = await pool.connect(); } catch { throw new RecommendationUnavailable('Access owner is unavailable'); }
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw normalize(error);
  } finally { client.release(); }
}

function normalize(error: unknown): unknown {
  if (error instanceof RecommendationDenied || error instanceof RecommendationConflict
    || error instanceof RecommendationStale || error instanceof RecommendationNotReady
    || error instanceof RecommendationMissing || error instanceof RecommendationRestart
    || error instanceof RecommendationUnavailable) return error;
  const code = (error as { code?: string }).code;
  if (code === '23514' || code === '40001' || code === '40P01' || code === '55P03') {
    return new RecommendationStale('generation state changed concurrently');
  }
  return new RecommendationUnavailable('Access owner is unavailable');
}

export async function requireRecoveryOpen(client: PoolClient): Promise<void> {
  const fence = await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
  if (fence.rows[0]?.open !== true) throw new RecommendationUnavailable('Access recovery is held');
}

/** Active principal representing the acting Agent with a current manage grant. */
export async function authorizeManager(client: PoolClient, context: ManageContext): Promise<string> {
  if (!nativeIri.test(context.actingSubject)) throw new RecommendationDenied('invalid acting subject');
  const gate = await client.query<{ open: boolean }>(
    'SELECT open FROM access.scope_gate WHERE id = $1 FOR SHARE', [MANAGE_SCOPE]);
  if (gate.rows[0]?.open !== true) throw new RecommendationDenied('recommendation management is closed');
  const actor = await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
    JOIN access.representation r ON r.principal_id = p.id
    JOIN access.authority_subject s ON s.id = r.subject_id
    JOIN access.permission_grant g ON g.recipient_subject = s.id
    WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
      AND r.subject_id = $3 AND r.action = $4 AND r.active AND r.valid_until > clock_timestamp()
      AND s.active AND g.scope_id = $5 AND g.action = $4 AND g.active
      AND g.valid_until > clock_timestamp()
    LIMIT 1 FOR SHARE OF p, r, s, g`,
  [context.principal.issuer, context.principal.subject, context.actingSubject, MANAGE_ACTION, MANAGE_SCOPE]);
  if (!actor.rows[0]) throw new RecommendationDenied('recommendation management is not granted');
  return actor.rows[0].id;
}

export interface ReceiptRow {
  request_digest: string; action: 'build' | 'activate' | 'cancel'; generation_id: string;
  outcome: 'succeeded' | 'stale_head' | 'rejected'; head_revision: string | null;
}

/** Same key and digest replays the stored outcome; a changed intent conflicts. */
export async function replayReceipt(client: PoolClient, principalId: string, key: ReceiptKey,
  action: ReceiptRow['action']): Promise<ReceiptRow | undefined> {
  const row = (await client.query<ReceiptRow>(`SELECT request_digest, action, generation_id::text,
    outcome, head_revision::text FROM access.derived_generation_receipt
    WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key.idempotencyKey])).rows[0];
  if (row && (row.request_digest !== key.requestDigest || row.action !== action)) {
    throw new RecommendationConflict('idempotency key was used for another intent');
  }
  return row;
}

export async function recordReceipt(client: PoolClient, principalId: string, key: ReceiptKey,
  row: Omit<ReceiptRow, 'request_digest'>): Promise<void> {
  await client.query(`INSERT INTO access.derived_generation_receipt
    (principal_id, idempotency_key, request_digest, action, generation_id, outcome, head_revision)
    VALUES ($1, $2, $3, $4, $5, $6, $7)`, [principalId, key.idempotencyKey, key.requestDigest,
    row.action, row.generation_id, row.outcome, row.head_revision]);
}

/** Take an expired or unclaimed build lease; the new epoch fences every older holder. */
export async function claimLease(client: PoolClient, generation: string, leaseMs: number): Promise<string> {
  const row = (await client.query<{ lease_epoch: string }>(`UPDATE access.derived_generation
    SET lease_epoch = lease_epoch + 1,
      lease_expires_at = clock_timestamp() + make_interval(secs => $2::double precision / 1000)
    WHERE id = $1 AND state = 'building' AND lease_expires_at <= clock_timestamp()
    RETURNING lease_epoch::text`, [generation, leaseMs])).rows[0];
  if (!row) throw new RecommendationStale('build lease is held or the generation is closed');
  return row.lease_epoch;
}

/** Renew the caller's lease and lock the row for this batch; an older epoch is stale (REC04). */
export async function fenceLease(client: PoolClient, generation: string, leaseEpoch: string,
  leaseMs: number): Promise<void> {
  const fenced = await client.query(`UPDATE access.derived_generation
    SET lease_expires_at = clock_timestamp() + make_interval(secs => $3::double precision / 1000)
    WHERE id = $1 AND lease_epoch = $2 AND state = 'building'
      AND lease_expires_at > clock_timestamp()`, [generation, leaseEpoch, leaseMs]);
  if (fenced.rowCount !== 1) throw new RecommendationStale('build lease is no longer held');
}

export async function markFailed(client: PoolClient, generation: string, leaseEpoch: string,
  reason: string): Promise<void> {
  const failed = await client.query(`UPDATE access.derived_generation SET state = 'failed',
    lease_expires_at = NULL, failure_reason = $3, finished_at = clock_timestamp()
    WHERE id = $1 AND lease_epoch = $2 AND state = 'building'`, [generation, leaseEpoch, reason]);
  if (failed.rowCount !== 1) throw new RecommendationStale('build lease is no longer held');
}

export interface Activation { generation: string; headRevision: string; predecessor: string | null;
  outcome: 'succeeded' | 'stale_head' | 'rejected'; replayed: boolean }

/** Exact-revision CAS; the predecessor becomes superseded and older ones leave retention. */
export async function activateHead(client: PoolClient, principalId: string, key: ReceiptKey,
  generation: string, expectedHeadRevision: string | null): Promise<Activation> {
  const replay = await replayReceipt(client, principalId, key, 'activate');
  if (replay) {
    return { generation, headRevision: replay.head_revision ?? '0', predecessor: null,
      outcome: replay.outcome, replayed: true };
  }
  const target = (await client.query<{ family: string; scope_key: string; state: string }>(
    `SELECT family, scope_key, state FROM access.derived_generation WHERE id = $1 FOR SHARE`,
    [generation])).rows[0];
  if (!target) throw new RecommendationMissing('generation is unavailable');
  // The first activation has no head row to lock. Serialize that absence per
  // family/scope so two valid racers yield one success and one stale-head receipt.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`${target.family}:${target.scope_key}`]);
  const head = (await client.query<{ active_generation: string; revision: string }>(`SELECT
    active_generation::text, revision::text FROM access.derived_generation_head
    WHERE family = $1 AND scope_key = $2 FOR UPDATE`, [target.family, target.scope_key])).rows[0];
  const reject = async (outcome: 'stale_head' | 'rejected') => {
    await recordReceipt(client, principalId, key, { action: 'activate', generation_id: generation,
      outcome, head_revision: null });
    return { generation, headRevision: head?.revision ?? '0', predecessor: null, outcome, replayed: false };
  };
  if ((head?.revision ?? null) !== expectedHeadRevision) return reject('stale_head');
  if (target.state !== 'ready') return reject('rejected');
  const revision = head ? String(BigInt(head.revision) + 1n) : '1';
  if (head) {
    await client.query(`UPDATE access.derived_generation_head SET active_generation = $3,
      revision = $4, activated_at = clock_timestamp() WHERE family = $1 AND scope_key = $2`,
    [target.family, target.scope_key, generation, revision]);
    await client.query(`UPDATE access.derived_generation SET state = 'superseded',
      finished_at = clock_timestamp() WHERE id = $1`, [head.active_generation]);
  } else {
    await client.query(`INSERT INTO access.derived_generation_head
      (family, scope_key, active_generation, revision) VALUES ($1, $2, $3, 1)`,
    [target.family, target.scope_key, generation]);
  }
  await client.query(`INSERT INTO access.derived_generation_activation
    (family, scope_key, revision, generation_id, predecessor, lease_epoch, input_positions)
    SELECT g.family, g.scope_key, $2, g.id, $3, g.lease_epoch,
      coalesce((SELECT jsonb_agg(jsonb_build_object('source', i.source, 'dataEpoch', i.data_epoch,
        'sequence', i.checkpoint_sequence::text) ORDER BY i.source)
        FROM access.derived_generation_input i WHERE i.generation_id = g.id), '[]'::jsonb)
    FROM access.derived_generation g WHERE g.id = $1`,
  [generation, revision, head?.active_generation ?? null]);
  // Superseded generations beyond the family's retention count expire; their
  // cursors restart. Row data is purged later in bounded chunks.
  await client.query(`UPDATE access.derived_generation SET state = 'expired'
    WHERE id IN (SELECT g.id FROM access.derived_generation g
      JOIN access.derived_generation_family f ON f.family = g.family
      WHERE g.family = $1 AND g.scope_key = $2 AND g.state = 'superseded'
      ORDER BY g.finished_at DESC, g.id
      OFFSET (SELECT max_retained - 1 FROM access.derived_generation_family WHERE family = $1))`,
  [target.family, target.scope_key]);
  await recordReceipt(client, principalId, key, { action: 'activate', generation_id: generation,
    outcome: 'succeeded', head_revision: revision });
  return { generation, headRevision: revision, predecessor: head?.active_generation ?? null,
    outcome: 'succeeded', replayed: false };
}
