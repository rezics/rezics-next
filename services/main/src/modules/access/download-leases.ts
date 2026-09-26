import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { AdmissionDenied, AdmissionExpired, AdmissionUnavailable } from './admission.ts';
import { inAccessTransaction, requireRecoveryOpen } from './policy-transaction.ts';
import { uuidPattern } from './policy-errors.ts';

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const DOWNLOAD_LEASE_MS = 90_000;
export const DOWNLOAD_PENDING_LIMIT = 256;

export interface DownloadReadLease {
  id: string; principalId: string; actingSubject: string; asset: string; target: string;
  scope: string; expiresAt: string;
}

interface LeaseRow {
  id: string; principal_id: string; acting_subject: string; asset_id: string; target: string;
  scope_id: string; expires_at: Date;
}

function view(row: LeaseRow): DownloadReadLease {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    asset: row.asset_id, target: row.target, scope: row.scope_id,
    expiresAt: row.expires_at.toISOString() };
}

/** Admission and lifecycle for private media byte streams. */
export class AccessDownloadLeases {
  constructor(private readonly pool: Pool) {}

  async admit(principal: VerifiedPrincipal, actingSubject: string, target: string,
    asset: string): Promise<DownloadReadLease> {
    if (!nativeId.test(actingSubject) || !nativeId.test(target)
      || !uuidPattern.test(asset) || !principal.issuer || !principal.subject) {
      throw new AdmissionDenied('invalid media download request');
    }
    const scope = `work:read:${target}`;
    return inAccessTransaction(this.pool, 'read committed', async client => {
      const recovery = await requireRecoveryOpen(client, true);
      const gate = (await client.query<{ authority_epoch: string; open: boolean }>(
        'SELECT authority_epoch, open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope])).rows[0];
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(
        `SELECT id, enforcement_epoch FROM access.principal WHERE account_issuer = $1
          AND account_subject = $2 AND active FOR UPDATE`, [principal.issuer, principal.subject])).rows[0];
      if (!gate?.open || !identity) throw new AdmissionDenied('media download is not admitted');
      await client.query(`WITH stale AS (
        SELECT id FROM access.download_read_lease WHERE scope_id = $1
          AND state = 'admitted' AND expires_at <= clock_timestamp() ORDER BY id LIMIT $2
      ) UPDATE access.download_read_lease l SET state = 'aborted', finished_at = clock_timestamp()
        FROM stale WHERE l.id = stale.id`, [scope, DOWNLOAD_PENDING_LIMIT + 1]);
      await client.query(`WITH stale AS (
        SELECT id FROM access.download_read_lease WHERE principal_id = $1
          AND state = 'admitted' AND expires_at <= clock_timestamp() ORDER BY id LIMIT $2
      ) UPDATE access.download_read_lease l SET state = 'aborted', finished_at = clock_timestamp()
        FROM stale WHERE l.id = stale.id`, [identity.id, DOWNLOAD_PENDING_LIMIT + 1]);
      const pending = await client.query<{ scope: string; principal: string }>(`SELECT
        (SELECT count(*) FROM access.download_read_lease WHERE scope_id = $1
          AND state IN ('admitted', 'delivering'))::text AS scope,
        (SELECT count(*) FROM access.download_read_lease WHERE principal_id = $2
          AND state IN ('admitted', 'delivering'))::text AS principal`, [scope, identity.id]);
      if (Number(pending.rows[0]!.scope) >= DOWNLOAD_PENDING_LIMIT
        || Number(pending.rows[0]!.principal) >= DOWNLOAD_PENDING_LIMIT) {
        throw new AdmissionUnavailable('media download capacity is exhausted');
      }
      const proof = (await client.query<{ subject_generation: string; representation_id: string;
        representation_generation: string; grant_id: string; grant_generation: string;
        expires_at: Date }>(`SELECT s.generation AS subject_generation, r.id AS representation_id,
          r.generation AS representation_generation, g.id AS grant_id,
          g.generation AS grant_generation, LEAST(r.valid_until, g.valid_until) AS expires_at
        FROM access.authority_subject s
        JOIN access.representation r ON r.subject_id = s.id AND r.principal_id = $2
          AND r.action = 'work.read' AND r.active AND r.valid_until > clock_timestamp()
        JOIN access.permission_grant g ON g.recipient_subject = s.id AND g.scope_id = $3
          AND g.action = 'work.read' AND g.active AND g.valid_until > clock_timestamp()
        WHERE s.id = $1 AND s.active
        ORDER BY r.id, g.id LIMIT 1 FOR SHARE OF s, r, g`, [actingSubject, identity.id, scope])).rows[0];
      if (!proof) throw new AdmissionDenied('media download is not admitted');
      const id = randomUUID();
      const inserted = await client.query<LeaseRow>(`WITH deadline AS (
        SELECT LEAST(clock_timestamp() + ($15 * interval '1 millisecond'), $16) AS expires_at
      ) INSERT INTO access.download_read_lease
        (id, principal_id, acting_subject, asset_id, target, scope_id, representation_id, grant_id,
         authority_epoch, principal_epoch, recovery_generation, subject_generation,
         representation_generation, grant_generation, expires_at, state)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,deadline.expires_at,'admitted'
        FROM deadline WHERE deadline.expires_at > clock_timestamp() + interval '1 second'
        RETURNING id, principal_id, acting_subject, asset_id, target, scope_id, expires_at`,
      [id, identity.id, actingSubject, asset, target, scope, proof.representation_id, proof.grant_id,
        gate.authority_epoch, identity.enforcement_epoch, recovery, proof.subject_generation,
        proof.representation_generation, proof.grant_generation, DOWNLOAD_LEASE_MS, proof.expires_at]);
      if (!inserted.rows[0]) throw new AdmissionExpired('media authority expires too soon');
      return view(inserted.rows[0]);
    });
  }

  /** Recheck the saved authority while serializing with the revocation fence. */
  async begin(lease: DownloadReadLease, principal: VerifiedPrincipal): Promise<void> {
    await inAccessTransaction(this.pool, 'read committed', async client => {
      const recovery = await requireRecoveryOpen(client, true);
      const located = (await client.query<{ principal_id: string; scope_id: string }>(
        'SELECT principal_id, scope_id FROM access.download_read_lease WHERE id = $1', [lease.id])).rows[0];
      if (!located) throw new AdmissionDenied('media download lease is unavailable');
      const gate = (await client.query<{ authority_epoch: string; open: boolean }>(
        'SELECT authority_epoch, open FROM access.scope_gate WHERE id = $1 FOR SHARE',
        [located.scope_id])).rows[0];
      const identity = (await client.query<{ enforcement_epoch: string }>(
        `SELECT enforcement_epoch FROM access.principal WHERE id = $1 AND account_issuer = $2
          AND account_subject = $3 AND active FOR SHARE`,
        [located.principal_id, principal.issuer, principal.subject])).rows[0];
      const row = (await client.query<{ state: string; target: string; asset_id: string;
        acting_subject: string; scope_id: string; authority_epoch: string; principal_epoch: string;
        recovery_generation: string; subject_generation: string; representation_id: string;
        representation_generation: string; grant_id: string; grant_generation: string;
        expires_at: Date }>(`SELECT * FROM access.download_read_lease WHERE id = $1 FOR UPDATE`, [lease.id])).rows[0];
      if (!row || row.state !== 'admitted' || !gate?.open || !identity
        || row.target !== lease.target || row.asset_id !== lease.asset || row.acting_subject !== lease.actingSubject
        || row.scope_id !== located.scope_id || row.authority_epoch !== gate.authority_epoch
        || row.principal_epoch !== identity.enforcement_epoch || row.recovery_generation !== recovery) {
        throw new AdmissionDenied('media download is fenced');
      }
      if (row.expires_at.getTime() <= Date.now()) throw new AdmissionExpired('media download lease expired');
      const valid = await client.query(`SELECT 1 FROM access.authority_subject s
        JOIN access.representation r ON r.id = $2 AND r.subject_id = s.id
          AND r.principal_id = $3 AND r.action = 'work.read' AND r.active
          AND r.generation = $4 AND r.valid_until > clock_timestamp()
        JOIN access.permission_grant g ON g.id = $5 AND g.recipient_subject = s.id
          AND g.scope_id = $6 AND g.action = 'work.read' AND g.active
          AND g.generation = $7 AND g.valid_until > clock_timestamp()
        WHERE s.id = $1 AND s.active AND s.generation = $8 FOR SHARE OF s, r, g`,
      [row.acting_subject, row.representation_id, located.principal_id,
        row.representation_generation, row.grant_id, located.scope_id, row.grant_generation,
        row.subject_generation]);
      if (valid.rowCount !== 1) throw new AdmissionDenied('media download proof changed');
      await client.query(`UPDATE access.download_read_lease SET state = 'delivering',
        delivery_started_at = clock_timestamp() WHERE id = $1 AND state = 'admitted'`, [lease.id]);
    });
  }

  async finish(id: string, outcome: 'delivered' | 'aborted'): Promise<void> {
    if (!uuidPattern.test(id) || !['delivered', 'aborted'].includes(outcome)) {
      throw new AdmissionDenied('invalid media download completion');
    }
    const updated = await this.pool.query(`UPDATE access.download_read_lease SET state = $2,
      finished_at = clock_timestamp() WHERE id = $1 AND state IN ('admitted', 'delivering')
        AND ($2 = 'aborted' OR state = 'delivering')
      RETURNING id`, [id, outcome]);
    if (updated.rowCount === 1) return;
    const prior = await this.pool.query<{ state: string }>(
      'SELECT state FROM access.download_read_lease WHERE id = $1', [id]);
    if (prior.rows[0]?.state !== outcome) throw new AdmissionDenied('media download completion conflicts');
  }
}
