import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class RepresentationDenied extends Error {}
export class RepresentationConflict extends Error {}
export class RepresentationStale extends Error {}
export class RepresentationUnavailable extends Error {}

const SCOPE = 'work:create:root';
const MANAGE = 'access.representation.manage';
const ASSIGN = 'access.representation.assign.work.create';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epochPattern = /^(0|[1-9][0-9]*)$/;

export interface RepresentationRequestResult {
  requestId: string;
  actingSubject: string;
  validUntil: string;
  expiresAt: string;
  status: 'pending' | 'expired' | 'accepted';
  representationId: string | null;
}
export interface RepresentationResult {
  id: string;
  actingSubject: string;
  requestId: string | null;
  validUntil: string;
  active: boolean;
  generation: string;
  authorityEpoch: string;
}
export interface RepresentationChangeContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedAuthorityEpoch: string;
  idempotencyKey: string;
  requestDigest: string;
}
type RequestRow = { id: string; recipient_principal: string; subject_id: string;
  valid_until: Date; expires_at: Date; representation_id: string | null;
  request_digest: string; idempotency_key: string };

/** Recipient request plus issuer acceptance for an ordinary Agent mandate.
 * No Account subject or principal identifier appears in API results. */
export class AccessRepresentations {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      if (String(error.code) === '23505') {
        return new RepresentationConflict('representation identity is already bound');
      }
      if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        return new RepresentationUnavailable('representation owner could not complete');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async begin(client: PoolClient): Promise<void> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
  }

  private async gate(client: PoolClient, write: boolean): Promise<string> {
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (recovery.rows[0]?.open !== true) {
      throw new RepresentationUnavailable('Access recovery is held');
    }
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
      FROM access.scope_gate WHERE id = $1 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [SCOPE]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new RepresentationDenied('representation scope is closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async principal(client: PoolClient, principal: VerifiedPrincipal,
    create: boolean): Promise<string> {
    if (create) {
      await client.query(`INSERT INTO access.principal
        (id, account_issuer, account_subject) VALUES ($1,$2,$3)
        ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
      [randomUUID(), principal.issuer, principal.subject]);
    }
    const found = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [principal.issuer, principal.subject]);
    if (!found.rows[0]) throw new RepresentationDenied('principal is inactive or unavailable');
    return found.rows[0].id;
  }

  private async manager(client: PoolClient, principal: VerifiedPrincipal,
    issuerSubject: string, validUntil?: Date): Promise<string> {
    const actor = await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4 AND r.active
        AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
      LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, issuerSubject, MANAGE]);
    if (!actor.rows[0]) throw new RepresentationDenied('manager mandate is missing');
    const management = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp() LIMIT 1 FOR SHARE`, [issuerSubject, SCOPE, MANAGE]);
    if (!management.rows[0]) throw new RepresentationDenied('management grant is missing');
    if (validUntil) {
      const ceiling = await client.query(`SELECT id FROM access.permission_grant
        WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
          AND valid_until >= $4 AND valid_until > clock_timestamp()
        ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
      [issuerSubject, SCOPE, ASSIGN, validUntil]);
      if (!ceiling.rows[0]) throw new RepresentationDenied('mandate exceeds assignment ceiling');
    }
    return actor.rows[0].id;
  }

  private requestResult(row: RequestRow): RepresentationRequestResult {
    return { requestId: row.id, actingSubject: row.subject_id,
      validUntil: row.valid_until.toISOString(), expiresAt: row.expires_at.toISOString(),
      status: row.representation_id ? 'accepted'
        : row.expires_at.getTime() <= Date.now() ? 'expired' : 'pending',
      representationId: row.representation_id };
  }

  private async requestRow(client: PoolClient, requestId: string): Promise<RequestRow | null> {
    const row = await client.query<RequestRow>(`SELECT q.*,
      r.id AS representation_id FROM access.representation_request q
      LEFT JOIN access.representation r ON r.request_id = q.id
      WHERE q.id = $1 AND q.action = 'work.create' AND q.resource_subject IS NULL`, [requestId]);
    return row.rows[0] ?? null;
  }

  async request(principal: VerifiedPrincipal, requestId: string, actingSubject: string,
    validUntil: Date, idempotencyKey: string, requestDigest: string):
    Promise<RepresentationRequestResult> {
    if (!idPattern.test(requestId) || !agentPattern.test(actingSubject)
      || Number.isNaN(validUntil.getTime()) || !idempotencyKey
      || idempotencyKey.length > 128 || idempotencyKey.includes('\0')
      || !/^[0-9a-f]{64}$/.test(requestDigest)) {
      throw new RepresentationDenied('invalid representation request');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      await this.gate(client, false);
      const principalId = await this.principal(client, principal, true);
      const prior = await client.query<{ id: string }>(`SELECT id
        FROM access.representation_request
        WHERE recipient_principal = $1 AND idempotency_key = $2`,
      [principalId, idempotencyKey]);
      if (prior.rows[0]) {
        const row = await this.requestRow(client, prior.rows[0].id);
        if (!row || row.id !== requestId || row.request_digest !== requestDigest) {
          throw new RepresentationConflict('request key binds another intent');
        }
        await client.query('COMMIT');
        return this.requestResult(row);
      }
      if (validUntil.getTime() <= Date.now()
        || validUntil.getTime() > Date.now() + 30 * 24 * 60 * 60_000) {
        throw new RepresentationDenied('requested mandate validity is outside profile');
      }
      const subject = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [actingSubject]);
      if (!subject.rows[0]) throw new RepresentationDenied('requested Agent is unavailable');
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await client.query(`INSERT INTO access.representation_request
        (id, recipient_principal, subject_id, action, valid_until,
          idempotency_key, request_digest, expires_at)
        VALUES ($1,$2,$3,'work.create',$4,$5,$6,$7)`,
      [requestId, principalId, actingSubject, validUntil,
        idempotencyKey, requestDigest, expiresAt]);
      await client.query('COMMIT');
      return { requestId, actingSubject, validUntil: validUntil.toISOString(),
        expiresAt: expiresAt.toISOString(), status: 'pending', representationId: null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readRequest(principal: VerifiedPrincipal, issuerSubject: string,
    requestId: string): Promise<RepresentationRequestResult> {
    if (!agentPattern.test(issuerSubject) || !idPattern.test(requestId)) {
      throw new RepresentationDenied('invalid representation request read');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      await this.gate(client, false);
      await this.manager(client, principal, issuerSubject);
      const row = await this.requestRow(client, requestId);
      if (!row || row.subject_id !== issuerSubject) {
        throw new RepresentationDenied('request is unavailable to issuer');
      }
      await client.query('COMMIT');
      return this.requestResult(row);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readRepresentation(principal: VerifiedPrincipal, issuerSubject: string,
    representationId: string): Promise<RepresentationResult> {
    if (!agentPattern.test(issuerSubject) || !idPattern.test(representationId)) {
      throw new RepresentationDenied('invalid representation read');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const authorityEpoch = await this.gate(client, false);
      await this.manager(client, principal, issuerSubject);
      const row = await client.query<{ id: string; subject_id: string; request_id: string | null;
        valid_until: Date; active: boolean; generation: string }>(`SELECT id, subject_id,
          request_id, valid_until, active, generation FROM access.representation
        WHERE id = $1 AND subject_id = $2 AND action = 'work.create'`,
      [representationId, issuerSubject]);
      if (!row.rows[0]) throw new RepresentationDenied('mandate is unavailable to issuer');
      await client.query('COMMIT');
      return { id: row.rows[0].id, actingSubject: row.rows[0].subject_id,
        requestId: row.rows[0].request_id, validUntil: row.rows[0].valid_until.toISOString(),
        active: row.rows[0].active, generation: row.rows[0].generation, authorityEpoch };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private async change(context: RepresentationChangeContext,
    action: 'accept' | 'revoke', representationId: string,
    work: (client: PoolClient, managerId: string) => Promise<void>): Promise<string> {
    if (!agentPattern.test(context.issuerSubject) || !idPattern.test(representationId)
      || !epochPattern.test(context.expectedAuthorityEpoch)
      || !context.idempotencyKey || context.idempotencyKey.length > 128
      || context.idempotencyKey.includes('\0')
      || !/^[0-9a-f]{64}$/.test(context.requestDigest)) {
      throw new RepresentationDenied('invalid representation change');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const authorityEpoch = await this.gate(client, true);
      const managerId = await this.manager(client, context.principal, context.issuerSubject);
      const prior = await client.query<{ request_digest: string; issuer_subject: string;
        action: string; representation_id: string; result_authority_epoch: string }>(`
        SELECT request_digest, issuer_subject, action, representation_id, result_authority_epoch
        FROM access.representation_change_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [managerId, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== context.requestDigest
          || prior.rows[0].issuer_subject !== context.issuerSubject
          || prior.rows[0].action !== action
          || prior.rows[0].representation_id !== representationId) {
          throw new RepresentationConflict('change key binds another intent');
        }
        await client.query('COMMIT');
        return prior.rows[0].result_authority_epoch;
      }
      if (authorityEpoch !== context.expectedAuthorityEpoch) {
        throw new RepresentationStale('representation scope authority epoch changed');
      }
      await work(client, managerId);
      const bumped = await client.query<{ authority_epoch: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch`, [SCOPE]);
      const resultEpoch = bumped.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.representation_change_receipt
        (principal_id, idempotency_key, request_digest, issuer_subject,
          action, representation_id, result_authority_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [managerId, context.idempotencyKey, context.requestDigest,
        context.issuerSubject, action, representationId, resultEpoch]);
      await client.query('COMMIT');
      return resultEpoch;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async accept(context: RepresentationChangeContext, requestId: string,
    representationId: string): Promise<string> {
    if (!idPattern.test(requestId)) throw new RepresentationDenied('invalid request handle');
    return this.change(context, 'accept', representationId, async (client, managerId) => {
      const row = await this.requestRow(client, requestId);
      if (!row || row.subject_id !== context.issuerSubject) {
        throw new RepresentationDenied('request is unavailable to issuer');
      }
      if (row.representation_id) throw new RepresentationConflict('request is already accepted');
      if (row.expires_at.getTime() <= Date.now()
        || row.valid_until.getTime() <= Date.now()) {
        throw new RepresentationStale('representation request expired');
      }
      const recipient = await client.query(`SELECT id FROM access.principal
        WHERE id = $1 AND active FOR SHARE`, [row.recipient_principal]);
      if (!recipient.rows[0]) throw new RepresentationDenied('requesting principal is unavailable');
      await this.manager(client, context.principal, context.issuerSubject, row.valid_until);
      await client.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, valid_until,
          assigned_by_principal, request_id)
        VALUES ($1,$2,$3,'work.create',$4,$5,$6)`,
      [representationId, row.recipient_principal, context.issuerSubject,
        row.valid_until, managerId, requestId]);
    });
  }

  async revoke(context: RepresentationChangeContext, representationId: string,
    expectedObjectGeneration: string): Promise<string> {
    if (!epochPattern.test(expectedObjectGeneration)) {
      throw new RepresentationDenied('invalid mandate generation');
    }
    return this.change(context, 'revoke', representationId, async client => {
      const row = await client.query<{ active: boolean; generation: string }>(`
        SELECT active, generation FROM access.representation
        WHERE id = $1 AND subject_id = $2 AND action = 'work.create' FOR UPDATE`,
      [representationId, context.issuerSubject]);
      if (!row.rows[0]) throw new RepresentationDenied('mandate is unavailable to issuer');
      if (row.rows[0].generation !== expectedObjectGeneration) {
        throw new RepresentationStale('mandate generation changed');
      }
      if (!row.rows[0].active) throw new RepresentationDenied('mandate is already inactive');
      await client.query(`UPDATE access.representation
        SET active = false, generation = generation + 1 WHERE id = $1`, [representationId]);
    });
  }
}
