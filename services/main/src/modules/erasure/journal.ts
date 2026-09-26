import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { DESTRUCTION_STATUSES, type DISPOSITION_DESTRUCTION, type DISPOSITION_SUPPRESSION,
  ERASURE_TARGET_OWNERS, type ErasureRow, type ErasureTargetKind, type RETENTION_CUSTODY,
  type RETENTION_OWNERS, type RETENTION_STORES } from './schema.ts';

export class ErasureInvalid extends Error {}
export class ErasureConflict extends Error {}
export class ErasureNotFound extends Error {}
export class ErasureUnavailable extends Error {}
/** A target already belongs to another journaled erasure; exact references never move. */
export class ErasureStale extends Error {
  constructor(message: string, readonly erasureId: string) { super(message); }
}

/** Matches the `relay.erasure_target` ordinal CHECK. */
export const MAX_ERASURE_TARGETS = 256;
/** Inventory and reads are bounded; more active domains per owner is a configuration fault. */
export const MAX_ERASURE_DISPOSITIONS = 64;
/** Source position of the journal in Access terminal proofs; its sequence is the erasure epoch. */
export const ERASURE_JOURNAL_EPOCH = 'urn:rezics:relay:erasure-journal';

export interface ErasureTargetInput { kind: ErasureTargetKind; ref: string }

export interface ErasureDisposition {
  domain: string;
  owner: typeof RETENTION_OWNERS[number];
  store: typeof RETENTION_STORES[number];
  custody: typeof RETENTION_CUSTODY[number];
  suppression: typeof DISPOSITION_SUPPRESSION[number];
  destruction: typeof DISPOSITION_DESTRUCTION[number];
  retainedUntil: string | null;
  reason: string | null;
  evidenceDigest: string | null;
}

export interface ErasureReport {
  erasureId: string;
  erasureEpoch: string;
  operationId: string;
  requestDigest: string;
  kind: ErasureRow['kind'];
  authority: ErasureRow['authority'];
  principalId: string | null;
  admissionId: string | null;
  authorityEpoch: string | null;
  stage: ErasureRow['stage'];
  suppression: ErasureRow['suppression_status'];
  destruction: ErasureRow['destruction_status'];
  blockedReason: string | null;
  requestedAt: string;
  suppressedAt: string | null;
  verifiedAt: string | null;
  targets: { ordinal: number; owner: string; kind: ErasureTargetKind; ref: string }[];
  dispositions: ErasureDisposition[];
}

export interface RetentionDomainSpec {
  label: string;
  owner: typeof RETENTION_OWNERS[number];
  store: typeof RETENTION_STORES[number];
  custody: typeof RETENTION_CUSTODY[number];
  expiresAt?: Date | null;
  holdReason?: string | null;
}

type Queryable = Pool | PoolClient;

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function relayTransaction<T>(pool: Pool,
  work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function iso(value: Date | null): string | null { return value ? value.toISOString() : null; }

/** Three bounded reads: header, at most 256 targets and at most 64 dispositions. */
export async function readErasure(pool: Queryable, erasureId: string): Promise<ErasureReport> {
  const header = (await pool.query<ErasureRow & { erasure_epoch: string; authority_epoch: string | null }>(
    `SELECT id, erasure_epoch::text AS erasure_epoch, operation_id, request_digest, kind, authority,
       principal_id, admission_id, authority_epoch::text AS authority_epoch, stage,
       suppression_status, destruction_status, blocked_reason, requested_at, suppressed_at, verified_at
     FROM relay.erasure WHERE id = $1`, [erasureId])).rows[0];
  if (!header) throw new ErasureNotFound('erasure is unavailable');
  const targets = (await pool.query<{ ordinal: number; owner: string; target_kind: ErasureTargetKind;
    target_ref: string }>(`SELECT ordinal, owner, target_kind, target_ref FROM relay.erasure_target
     WHERE erasure_id = $1 ORDER BY ordinal LIMIT ${MAX_ERASURE_TARGETS}`, [erasureId])).rows;
  const dispositions = (await pool.query<{ label: string; owner: ErasureDisposition['owner'];
    store: ErasureDisposition['store']; custody: ErasureDisposition['custody'];
    suppression: ErasureDisposition['suppression']; destruction: ErasureDisposition['destruction'];
    retained_until: Date | null; reason: string | null; evidence_digest: string | null }>(
    `SELECT d.label, d.owner, d.store, d.custody, x.suppression, x.destruction, x.retained_until,
       x.reason, x.evidence_digest
     FROM relay.erasure_disposition x JOIN relay.retention_domain d ON d.id = x.domain_id
     WHERE x.erasure_id = $1 ORDER BY d.label LIMIT ${MAX_ERASURE_DISPOSITIONS + 1}`, [erasureId])).rows;
  if (dispositions.length > MAX_ERASURE_DISPOSITIONS) {
    throw new ErasureUnavailable('retention inventory exceeds its declared bound');
  }
  return {
    erasureId: header.id, erasureEpoch: header.erasure_epoch, operationId: header.operation_id,
    requestDigest: header.request_digest, kind: header.kind, authority: header.authority,
    principalId: header.principal_id, admissionId: header.admission_id,
    authorityEpoch: header.authority_epoch, stage: header.stage,
    suppression: header.suppression_status, destruction: header.destruction_status,
    blockedReason: header.blocked_reason, requestedAt: header.requested_at.toISOString(),
    suppressedAt: iso(header.suppressed_at), verifiedAt: iso(header.verified_at),
    targets: targets.map(row => ({ ordinal: row.ordinal, owner: row.owner, kind: row.target_kind,
      ref: row.target_ref })),
    dispositions: dispositions.map(row => ({ domain: row.label, owner: row.owner, store: row.store,
      custody: row.custody, suppression: row.suppression, destruction: row.destruction,
      retainedUntil: iso(row.retained_until), reason: row.reason, evidenceDigest: row.evidence_digest })),
  };
}

export async function findErasureByOperation(pool: Queryable, operationId: string): Promise<string | null> {
  return (await pool.query<{ id: string }>('SELECT id FROM relay.erasure WHERE operation_id = $1',
    [operationId])).rows[0]?.id ?? null;
}

export interface ErasureIntent {
  operationId: string;
  requestDigest: string;
  kind: 'resource' | 'revision';
  principalId: string;
  admissionId: string;
  authorityEpoch: string;
  targets: ErasureTargetInput[];
}

/**
 * Journal one admitted erasure. The allocator lock is taken first, so the replay,
 * collision check and insert see every committed erasure. A journaled entry is
 * committed intent: callers complete it and never cancel it.
 */
export async function journalErasure(relay: Pool, intent: ErasureIntent): Promise<{
  erasureId: string; erasureEpoch: string; replayed: boolean }> {
  if (!intent.targets.length || intent.targets.length > MAX_ERASURE_TARGETS
    || new Set(intent.targets.map(target => `${target.kind}\0${target.ref}`)).size !== intent.targets.length
    || intent.targets.some(target => !(target.kind in ERASURE_TARGET_OWNERS) || !target.ref
      || target.ref.length > 512)) {
    throw new ErasureInvalid('erasure targets are invalid');
  }
  return relayTransaction(relay, async client => {
    const epoch = (await client.query<{ epoch: string }>(
      'SELECT relay.next_erasure_epoch()::text AS epoch')).rows[0]!.epoch;
    const prior = (await client.query<{ id: string; request_digest: string; erasure_epoch: string }>(
      `SELECT id, request_digest, erasure_epoch::text AS erasure_epoch FROM relay.erasure
       WHERE operation_id = $1`, [intent.operationId])).rows[0];
    if (prior) {
      if (prior.request_digest !== intent.requestDigest) {
        throw new ErasureConflict('erasure operation binds another request');
      }
      return { erasureId: prior.id, erasureEpoch: prior.erasure_epoch, replayed: true };
    }
    const owners = intent.targets.map(target => ERASURE_TARGET_OWNERS[target.kind]);
    const kinds = intent.targets.map(target => target.kind);
    const refs = intent.targets.map(target => target.ref);
    const taken = (await client.query<{ erasure_id: string }>(
      `SELECT t.erasure_id FROM unnest($1::text[], $2::text[], $3::text[]) AS wanted(owner, kind, ref)
       JOIN relay.erasure_target t ON t.owner = wanted.owner AND t.target_kind = wanted.kind
         AND t.target_ref = wanted.ref
       ORDER BY t.erasure_id LIMIT 1`, [owners, kinds, refs])).rows[0];
    if (taken) throw new ErasureStale('erasure target is already journaled', taken.erasure_id);
    const erasureId = randomUUID();
    await client.query(`INSERT INTO relay.erasure (id, erasure_epoch, operation_id, request_digest,
        kind, authority, principal_id, admission_id, authority_epoch)
      VALUES ($1, $2, $3, $4, $5, 'access_admission', $6, $7, $8)`,
    [erasureId, epoch, intent.operationId, intent.requestDigest, intent.kind, intent.principalId,
      intent.admissionId, intent.authorityEpoch]);
    await client.query(`INSERT INTO relay.erasure_target (erasure_id, ordinal, owner, target_kind, target_ref)
      SELECT $1, ordinal, owner, kind, ref
      FROM unnest($2::text[], $3::text[], $4::text[]) WITH ORDINALITY AS t(owner, kind, ref, ordinal)`,
    [erasureId, owners, kinds, refs]);
    return { erasureId, erasureEpoch: epoch, replayed: false };
  });
}

/** The journal's disclosure fence after every live owner applied its tombstone. */
export async function markErasureSuppressed(relay: Queryable, erasureId: string): Promise<void> {
  await relay.query(`UPDATE relay.erasure SET stage = 'fenced', suppression_status = 'suppressed',
      suppressed_at = clock_timestamp()
    WHERE id = $1 AND stage = 'requested'`, [erasureId]);
}

/** An accepted erasure that an owner cannot apply stays journaled and explicitly blocked. */
export async function markErasureBlocked(relay: Queryable, erasureId: string, reason: string): Promise<void> {
  await relay.query(`UPDATE relay.erasure SET stage = 'blocked', blocked_reason = $2
    WHERE id = $1 AND stage = 'requested'`, [erasureId, reason.slice(0, 500)]);
}

/** Idempotent registration; an existing label must keep its declared meaning. */
export async function ensureRetentionDomain(relay: Pool, spec: RetentionDomainSpec): Promise<string> {
  return relayTransaction(relay, async client => {
    await client.query(`INSERT INTO relay.retention_domain (id, label, owner, store, custody,
        expires_at, hold_reason) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (label) DO NOTHING`,
    [randomUUID(), spec.label, spec.owner, spec.store, spec.custody, spec.expiresAt ?? null,
      spec.holdReason ?? null]);
    const row = (await client.query<{ id: string; owner: string; store: string; custody: string;
      expires_at: Date | null; hold_reason: string | null; state: string }>(
      `SELECT id, owner, store, custody, expires_at, hold_reason, state FROM relay.retention_domain
       WHERE label = $1 FOR UPDATE`, [spec.label])).rows[0]!;
    if (row.owner !== spec.owner || row.store !== spec.store || row.custody !== spec.custody
      || iso(row.expires_at) !== iso(spec.expiresAt ?? null)
      || row.hold_reason !== (spec.holdReason ?? null) || row.state !== 'active') {
      throw new ErasureConflict('retention domain label binds another declaration');
    }
    if (['backup', 'archive', 'retired'].includes(spec.custody)) {
      // A copy taken after suppression can still hold old row versions or WAL:
      // every suppressed erasure of this owner is retained there until expiry.
      await client.query(`INSERT INTO relay.erasure_disposition
          (erasure_id, domain_id, suppression, destruction, retained_until, reason)
        SELECT e.id, $1, 'not_applicable', 'retained', $3, $4 FROM relay.erasure e
        WHERE e.suppression_status = 'suppressed'
          AND ((e.kind = 'account' AND $2 = 'account') OR EXISTS (SELECT 1 FROM relay.erasure_target t
            WHERE t.erasure_id = e.id AND t.owner = $2))
        ON CONFLICT DO NOTHING`, [row.id, spec.owner, row.expires_at, row.hold_reason]);
      await client.query(`UPDATE relay.erasure e SET destruction_status = 'retained'
        WHERE e.destruction_status = 'destroyed' AND EXISTS (SELECT 1 FROM relay.erasure_disposition x
          WHERE x.erasure_id = e.id AND x.domain_id = $1)`, [row.id]);
    }
    return row.id;
  });
}

export interface InventoryFacts {
  /** Owners whose active domains hold copies of the erased data. */
  owners: readonly (typeof RETENTION_OWNERS[number])[];
  /** Why live row bytes are not yet physically destroyed. */
  liveRetentionReason: string;
}

function summarize(values: readonly string[]): typeof DESTRUCTION_STATUSES[number] {
  if (!values.length) return 'pending';
  if (values.includes('blocked')) return 'blocked';
  if (values.includes('pending')) return 'in_progress';
  if (values.includes('retained')) return 'retained';
  return 'destroyed';
}

/**
 * Record the copy inventory once the journal fence is suppressed. Live copies are
 * suppressed but retained until a qualified rewrite; backups are retained until
 * their declared expiry or hold. The header summary derives from the dispositions.
 */
export async function recordErasureInventory(relay: Pool, erasureId: string,
  facts: InventoryFacts): Promise<void> {
  await relayTransaction(relay, async client => {
    const header = (await client.query<{ stage: string; suppression_status: string }>(
      'SELECT stage, suppression_status FROM relay.erasure WHERE id = $1 FOR UPDATE',
      [erasureId])).rows[0];
    if (!header) throw new ErasureNotFound('erasure is unavailable');
    if (header.suppression_status !== 'suppressed') return;
    const domains = (await client.query<{ id: string; custody: string; expires_at: Date | null;
      hold_reason: string | null }>(`SELECT id, custody, expires_at, hold_reason
      FROM relay.retention_domain WHERE state = 'active' AND owner = ANY($1::text[])
      ORDER BY id LIMIT ${MAX_ERASURE_DISPOSITIONS + 1}`, [facts.owners])).rows;
    if (domains.length > MAX_ERASURE_DISPOSITIONS) {
      throw new ErasureUnavailable('retention inventory exceeds its declared bound');
    }
    const live = domains.filter(domain => domain.custody === 'live');
    const derived = domains.filter(domain => domain.custody === 'derived');
    const copies = domains.filter(domain => !live.includes(domain) && !derived.includes(domain));
    await client.query(`INSERT INTO relay.erasure_disposition
        (erasure_id, domain_id, suppression, destruction, reason)
      SELECT $1, unnest($2::uuid[]), 'suppressed', 'retained', $3 ON CONFLICT DO NOTHING`,
    [erasureId, live.map(domain => domain.id), facts.liveRetentionReason]);
    // Derived copies have no qualified purge in this owner; they stay explicit.
    await client.query(`INSERT INTO relay.erasure_disposition
        (erasure_id, domain_id, suppression, destruction, reason)
      SELECT $1, unnest($2::uuid[]), 'pending', 'blocked', 'derived copy needs its owner purge'
      ON CONFLICT DO NOTHING`, [erasureId, derived.map(domain => domain.id)]);
    await client.query(`INSERT INTO relay.erasure_disposition
        (erasure_id, domain_id, suppression, destruction, retained_until, reason)
      SELECT $1, domain, 'not_applicable', 'retained', until, hold
      FROM unnest($2::uuid[], $3::timestamptz[], $4::text[]) AS c(domain, until, hold)
      ON CONFLICT DO NOTHING`, [erasureId, copies.map(domain => domain.id),
      copies.map(domain => domain.expires_at), copies.map(domain => domain.hold_reason)]);
    const values = (await client.query<{ destruction: string }>(
      'SELECT destruction FROM relay.erasure_disposition WHERE erasure_id = $1', [erasureId]))
      .rows.map(row => row.destruction);
    const summary = summarize(values);
    const blocked = summary === 'blocked' ? (await client.query<{ reason: string }>(
      `SELECT reason FROM relay.erasure_disposition WHERE erasure_id = $1 AND destruction = 'blocked'
       ORDER BY domain_id LIMIT 1`, [erasureId])).rows[0]!.reason : null;
    await client.query(`UPDATE relay.erasure SET destruction_status = $2,
        stage = CASE WHEN stage = 'fenced' THEN 'inventory_complete' ELSE stage END,
        blocked_reason = CASE WHEN stage = 'blocked' THEN blocked_reason ELSE $3 END
      WHERE id = $1`, [erasureId, summary, blocked]);
  });
}

/** Expiry or sanitization of one copy location is recorded with its evidence. */
export async function retireRetentionDomain(relay: Pool, label: string,
  outcome: 'expired' | 'destroyed', evidenceDigest: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(evidenceDigest)) throw new ErasureInvalid('retirement evidence is invalid');
  await relayTransaction(relay, async client => {
    const domain = (await client.query<{ id: string }>(`UPDATE relay.retention_domain
      SET state = $2, retired_at = clock_timestamp() WHERE label = $1 AND state = 'active'
      RETURNING id`, [label, outcome])).rows[0];
    if (!domain) throw new ErasureNotFound('active retention domain is unavailable');
    const changed = (await client.query<{ erasure_id: string }>(`UPDATE relay.erasure_disposition
      SET destruction = $2, evidence_digest = $3, updated_at = clock_timestamp()
      WHERE domain_id = $1 AND destruction IN ('pending', 'retained', 'blocked')
      RETURNING erasure_id`, [domain.id, outcome === 'expired' ? 'expired' : 'destroyed',
      evidenceDigest])).rows.map(row => row.erasure_id);
    await client.query(`UPDATE relay.erasure e SET destruction_status = CASE
        WHEN bool_or_blocked THEN 'blocked' WHEN bool_or_pending THEN 'in_progress'
        WHEN bool_or_retained THEN 'retained' ELSE 'destroyed' END
      FROM (SELECT erasure_id,
          bool_or(destruction = 'blocked') AS bool_or_blocked,
          bool_or(destruction = 'pending') AS bool_or_pending,
          bool_or(destruction = 'retained') AS bool_or_retained
        FROM relay.erasure_disposition WHERE erasure_id = ANY($1::uuid[]) GROUP BY erasure_id) s
      WHERE e.id = s.erasure_id AND e.destruction_status <> 'blocked'`, [changed]);
  });
}
