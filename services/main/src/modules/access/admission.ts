import { Pool, type PoolClient } from 'pg';

/** Populated only by Account assertion verification, never from a request body. */
export interface VerifiedPrincipal {
  issuer: string;
  subject: string;
}

export interface AdmissionRequest {
  principal: VerifiedPrincipal;
  actingSubject: string;
  scope: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface RegisteredAdmission {
  id: string;
  principalId: string;
  actingSubject: string;
  scope: string;
  action: string;
  authorityEpoch: string;
  expiresAt: string;
  replayed: boolean;
}

export class AdmissionDenied extends Error {}
export class AdmissionUnavailable extends Error {}
export class AdmissionConflict extends Error {}
export class AdmissionExpired extends Error {}

interface GateRow { authority_epoch: string; open: boolean }
interface AdmissionRow {
  id: string;
  principal_id: string;
  acting_subject: string;
  scope_id: string;
  action: string;
  request_digest: string;
  authority_epoch: string;
  expires_at: Date;
  state: string;
  eligible: boolean;
}

async function rollback(client: PoolClient): Promise<void> {
  try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
}

export class AccessAdmissionRegistry {
  constructor(private readonly pool: Pool) {}

  async register(request: AdmissionRequest): Promise<RegisteredAdmission> {
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(request.idempotencyKey)
      || !/^[a-z][a-z0-9.:-]{1,127}$/.test(request.action)
      || !/^[0-9a-f]{64}$/.test(request.requestDigest)) {
      throw new AdmissionDenied('invalid admission request');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const gateResult = await client.query<GateRow>(
        'SELECT authority_epoch, open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [request.scope]);
      const gate = gateResult.rows[0];
      if (!gate) throw new AdmissionUnavailable('scope gate is unavailable');

      const principalResult = await client.query<{ id: string; active: boolean }>(
        `SELECT id, active FROM access.principal
         WHERE account_issuer = $1 AND account_subject = $2 FOR SHARE`,
        [request.principal.issuer, request.principal.subject]);
      const principal = principalResult.rows[0];
      if (principal?.active !== true) throw new AdmissionDenied('principal is not admitted');
      const principalId = principal.id;

      const existingResult = await client.query<AdmissionRow>(
        `SELECT id, principal_id, acting_subject, scope_id, action, request_digest,
                authority_epoch, expires_at, state, (expires_at > now()) AS eligible
         FROM access.admission
         WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3`,
        [principalId, request.action, request.idempotencyKey]);
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.request_digest !== request.requestDigest
          || existing.acting_subject !== request.actingSubject
          || existing.scope_id !== request.scope) {
          throw new AdmissionConflict('idempotency key belongs to a different intent');
        }
        if (existing.state !== 'registered' || !existing.eligible) {
          throw new AdmissionExpired('admission can only be reconciled, not dispatched');
        }
        await client.query('COMMIT');
        return {
          id: existing.id, principalId: existing.principal_id,
          actingSubject: existing.acting_subject, scope: existing.scope_id,
          action: existing.action, authorityEpoch: existing.authority_epoch,
          expiresAt: existing.expires_at.toISOString(), replayed: true,
        };
      }
      if (!gate.open) throw new AdmissionDenied('scope is closed');

      const subject = await client.query<{ active: boolean }>(
        'SELECT active FROM access.authority_subject WHERE id = $1 FOR SHARE', [request.actingSubject]);
      if (subject.rows[0]?.active !== true) throw new AdmissionDenied('acting subject is not active');
      const represented = await client.query(
        `SELECT id FROM access.representation
         WHERE principal_id = $1 AND subject_id = $2 AND action = $3
           AND active AND valid_until > now()
         ORDER BY id LIMIT 1 FOR SHARE`,
        [principalId, request.actingSubject, request.action]);
      if (represented.rowCount !== 1) throw new AdmissionDenied('representation is not admitted');
      const granted = await client.query(
        `SELECT id FROM access.permission_grant
         WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3
           AND active AND valid_until > now()
         ORDER BY id LIMIT 1 FOR SHARE`,
        [request.actingSubject, request.scope, request.action]);
      if (granted.rowCount !== 1) throw new AdmissionDenied('permission is not granted');

      const id = Bun.randomUUIDv7();
      const inserted = await client.query<{ expires_at: Date }>(
        `INSERT INTO access.admission
           (id, principal_id, acting_subject, scope_id, action, idempotency_key,
            request_digest, authority_epoch, expires_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '30 seconds', 'registered')
         RETURNING expires_at`,
        [id, principalId, request.actingSubject, request.scope,
          request.action, request.idempotencyKey, request.requestDigest, gate.authority_epoch]);
      await client.query(
        `INSERT INTO access.admission_receipt
           (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
         VALUES ($1, $2, $3, $4, $5, 'registered')`,
        [id, principalId, request.action, request.idempotencyKey, request.requestDigest]);
      await client.query(
        `INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
         VALUES ($1, 'admission.registered', $2, $3, $4)`,
        [Bun.randomUUIDv7(), id, request.scope, gate.authority_epoch]);
      await client.query('COMMIT');
      return {
        id, principalId, actingSubject: request.actingSubject,
        scope: request.scope, action: request.action, authorityEpoch: gate.authority_epoch,
        expiresAt: inserted.rows[0]!.expires_at.toISOString(), replayed: false,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Ordinary closure fences new admissions; already registered work remains finite. */
  async closeScope(scope: string, expectedEpoch: string): Promise<{ authorityEpoch: string; pending: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const changed = await client.query<{ authority_epoch: string }>(
        `UPDATE access.scope_gate
         SET open = false, authority_epoch = authority_epoch + 1
         WHERE id = $1 AND authority_epoch = $2 AND open
         RETURNING authority_epoch`, [scope, expectedEpoch]);
      if (changed.rowCount !== 1) throw new AdmissionConflict('scope gate changed or was already closed');
      const epoch = changed.rows[0]!.authority_epoch;
      await client.query(
        `INSERT INTO access.outbox (id, kind, scope_id, authority_epoch)
         VALUES ($1, 'scope.closed', $2, $3)`, [Bun.randomUUIDv7(), scope, epoch]);
      const pending = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM access.admission
         WHERE scope_id = $1 AND state = 'registered' AND expires_at > now()`, [scope]);
      await client.query('COMMIT');
      return { authorityEpoch: epoch, pending: Number(pending.rows[0]?.count ?? '0') };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
