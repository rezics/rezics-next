import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { MembershipConflict, MembershipDenied, MembershipStale,
  MembershipUnavailable } from './memberships.ts';

export const REPRESENTED_ORG_ACTION = 'access.membership.manage.org';
const ROOT = 'work:create:root';
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const epoch = /^(0|[1-9][0-9]*)$/;

export function orgRosterScope(ownerSubject: string): string {
  if (!agent.test(ownerSubject)) throw new MembershipDenied('invalid Org roster subject');
  return `access:org-roster:${ownerSubject.slice(-36)}`;
}

export interface RepresentedAuthorityContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  ownerSubject: string;
  expectedAuthorityEpoch: string;
  idempotencyKey: string;
  requestDigest: string;
}
type Request = { id: string; subject_id: string; resource_subject: string;
  recipient_principal: string; valid_until: Date; expires_at: Date;
  representation_id: string | null; request_digest: string };
export interface RepresentedRequestResult {
  requestId: string; actingSubject: string; ownerSubject: string;
  validUntil: string; expiresAt: string;
  status: 'pending' | 'expired' | 'accepted'; representationId: string | null;
}

/** First-class request, acceptance and exact B-to-A grant operations.
 * Every mutation holds the recovery fence and shared authority gate first.
 * No membership, editor or administrator relation is read as representation. */
export class AccessRepresentedMembershipAuthority {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (code === '23505') return new MembershipConflict('represented authority identity conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(code)) {
        return new MembershipUnavailable('represented authority owner could not complete');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async begin(client: PoolClient): Promise<string> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const fence = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (!fence.rows[0]?.open) throw new MembershipUnavailable('Access recovery held');
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open FROM access.scope_gate
      WHERE id = $1 FOR UPDATE`, [ROOT]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new MembershipDenied('Access authority gate closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async principal(client: PoolClient, asserted: VerifiedPrincipal,
    create = false): Promise<{ id: string; enforcement_epoch: string }> {
    if (create) await client.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3)
      ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
    [randomUUID(), asserted.issuer, asserted.subject]);
    const row = await client.query<{ id: string; enforcement_epoch: string }>(`
      SELECT id, enforcement_epoch FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [asserted.issuer, asserted.subject]);
    if (!row.rows[0]) throw new MembershipDenied('principal unavailable');
    return row.rows[0];
  }

  private async assignment(client: PoolClient, principalId: string, issuer: string,
    action: string, validUntil?: Date): Promise<void> {
    const row = await client.query(`SELECT r.id FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = $3
        AND r.active AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
      LIMIT 1 FOR SHARE OF r, s`, [principalId, issuer, action]);
    if (!row.rows[0]) throw new MembershipDenied('issuer assignment mandate missing');
    const grant = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp()
        AND ($4::timestamptz IS NULL OR valid_until >= $4)
      ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
    [issuer, ROOT, action, validUntil ?? null]);
    if (!grant.rows[0]) throw new MembershipDenied('issuer assignment ceiling missing');
  }

  private async requestRow(client: PoolClient, id: string): Promise<Request | null> {
    const row = await client.query<Request>(`SELECT q.id, q.subject_id, q.resource_subject,
      q.recipient_principal, q.valid_until, q.expires_at, q.request_digest,
      r.id AS representation_id FROM access.representation_request q
      LEFT JOIN access.representation r ON r.request_id = q.id WHERE q.id = $1
        AND q.action = $2`, [id, REPRESENTED_ORG_ACTION]);
    return row.rows[0] ?? null;
  }

  private requestResult(row: Request): RepresentedRequestResult {
    return { requestId: row.id, actingSubject: row.subject_id,
      ownerSubject: row.resource_subject, validUntil: row.valid_until.toISOString(),
      expiresAt: row.expires_at.toISOString(), status: row.representation_id ? 'accepted'
        : row.expires_at.getTime() <= Date.now() ? 'expired' : 'pending',
      representationId: row.representation_id };
  }

  async request(principal: VerifiedPrincipal, requestId: string, actingSubject: string,
    ownerSubject: string, validUntil: Date, idempotencyKey: string,
    requestDigest: string): Promise<RepresentedRequestResult> {
    if (!uuid.test(requestId) || !agent.test(actingSubject) || !agent.test(ownerSubject)
      || actingSubject === ownerSubject
      || !idempotencyKey || idempotencyKey.length > 128 || idempotencyKey.includes('\0')
      || !/^[0-9a-f]{64}$/.test(requestDigest) || Number.isNaN(validUntil.getTime())) {
      throw new MembershipDenied('invalid represented request');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const p = await this.principal(client, principal, true);
      const prior = await client.query<{ id: string }>(`SELECT id FROM access.representation_request
        WHERE recipient_principal = $1 AND idempotency_key = $2`, [p.id, idempotencyKey]);
      if (prior.rows[0]) {
        const saved = await this.requestRow(client, prior.rows[0].id);
        if (!saved || saved.id !== requestId || saved.request_digest !== requestDigest) {
          throw new MembershipConflict('request key binds another intent');
        }
        await client.query('COMMIT');
        return this.requestResult(saved);
      }
      if (validUntil.getTime() <= Date.now()
        || validUntil.getTime() > Date.now() + 30 * 24 * 60 * 60_000) {
        throw new MembershipDenied('mandate validity outside profile');
      }
      const subjects = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = ANY($1::text[]) AND kind = 'agent' AND active FOR SHARE`,
      [[actingSubject, ownerSubject]]);
      if (subjects.rows.length !== new Set([actingSubject, ownerSubject]).size) {
        throw new MembershipDenied('Agent unavailable');
      }
      const policy = await client.query(`SELECT 1 FROM access.membership_policy
        WHERE kind = 'org' AND owner_subject = $1 FOR SHARE`, [ownerSubject]);
      if (!policy.rows[0]) throw new MembershipDenied('Org roster policy missing');
      const expiresAt = new Date(Date.now() + 15 * 60_000);
      await client.query(`INSERT INTO access.representation_request
        (id, recipient_principal, subject_id, action, resource_subject,
          valid_until, idempotency_key, request_digest, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [requestId, p.id, actingSubject, REPRESENTED_ORG_ACTION, ownerSubject,
        validUntil, idempotencyKey, requestDigest, expiresAt]);
      await client.query('COMMIT');
      return { requestId, actingSubject, ownerSubject,
        validUntil: validUntil.toISOString(), expiresAt: expiresAt.toISOString(),
        status: 'pending', representationId: null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readRequest(principal: VerifiedPrincipal, issuer: string,
    requestId: string): Promise<RepresentedRequestResult> {
    if (!agent.test(issuer) || !uuid.test(requestId)) throw new MembershipDenied('invalid request read');
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const p = await this.principal(client, principal);
      await this.assignment(client, p.id, issuer, 'access.representation.manage');
      await this.assignment(client, p.id, issuer,
        'access.representation.assign.membership.manage.org');
      const row = await this.requestRow(client, requestId);
      if (!row || row.subject_id !== issuer) throw new MembershipDenied('request unavailable');
      await client.query('COMMIT');
      return this.requestResult(row);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private async mutate(context: RepresentedAuthorityContext,
    action: 'accept' | 'revoke-mandate' | 'grant' | 'revoke-grant', objectId: string,
    work: (client: PoolClient, principalId: string) => Promise<void>): Promise<string> {
    if (!agent.test(context.issuerSubject) || !agent.test(context.ownerSubject)
      || !uuid.test(objectId) || !epoch.test(context.expectedAuthorityEpoch)
      || !context.idempotencyKey || context.idempotencyKey.length > 128
      || context.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(context.requestDigest)) {
      throw new MembershipDenied('invalid represented authority change');
    }
    const client = await this.pool.connect();
    try {
      const current = await this.begin(client);
      const p = await this.principal(client, context.principal);
      const prior = await client.query<{ request_digest: string; action: string; object_id: string;
        issuer_subject: string; resource_subject: string; result_authority_epoch: string }>(`
        SELECT * FROM access.represented_membership_authority_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [p.id, context.idempotencyKey]);
      if (prior.rows[0]) {
        const old = prior.rows[0];
        if (old.request_digest !== context.requestDigest || old.action !== action
          || old.object_id !== objectId || old.issuer_subject !== context.issuerSubject
          || old.resource_subject !== context.ownerSubject) {
          throw new MembershipConflict('authority key binds another intent');
        }
        await client.query('COMMIT');
        return old.result_authority_epoch;
      }
      if (current !== context.expectedAuthorityEpoch) {
        throw new MembershipStale('authority epoch changed');
      }
      await work(client, p.id);
      const bumped = await client.query<{ authority_epoch: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch`, [ROOT]);
      const result = bumped.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.represented_membership_authority_receipt
        (principal_id, idempotency_key, request_digest, action, object_id,
          issuer_subject, resource_subject, result_authority_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [p.id, context.idempotencyKey, context.requestDigest, action, objectId,
        context.issuerSubject, context.ownerSubject, result]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async accept(context: RepresentedAuthorityContext, requestId: string,
    representationId: string): Promise<string> {
    if (!uuid.test(requestId)) throw new MembershipDenied('invalid request handle');
    return this.mutate(context, 'accept', representationId, async (client, operatorId) => {
      await this.assignment(client, operatorId, context.issuerSubject,
        'access.representation.manage');
      await this.assignment(client, operatorId, context.issuerSubject,
        'access.representation.assign.membership.manage.org');
      const request = await this.requestRow(client, requestId);
      if (!request || request.subject_id !== context.issuerSubject
        || request.resource_subject !== context.ownerSubject) {
        throw new MembershipDenied('request does not bind issuer and roster');
      }
      if (request.representation_id) throw new MembershipConflict('request already accepted');
      if (request.expires_at.getTime() <= Date.now()
        || request.valid_until.getTime() <= Date.now()) {
        throw new MembershipStale('request expired');
      }
      await this.assignment(client, operatorId, context.issuerSubject,
        'access.representation.assign.membership.manage.org', request.valid_until);
      const recipient = await client.query<{ id: string; enforcement_epoch: string }>(`
        SELECT id, enforcement_epoch FROM access.principal
        WHERE id = $1 AND active FOR SHARE`, [request.recipient_principal]);
      if (!recipient.rows[0]) throw new MembershipDenied('recipient unavailable');
      const membership = await client.query<{ id: string; generation: string }>(`
        SELECT id, generation FROM access.private_membership
        WHERE principal_id = $1 AND kind = 'org' AND owner_subject = $2
          AND state = 'joined' FOR SHARE`,
      [request.recipient_principal, context.issuerSubject]);
      if (!membership.rows[0]) throw new MembershipDenied('recipient is not admitted to issuer Org');
      const subjects = await client.query<{ id: string; generation: string }>(`
        SELECT id, generation FROM access.authority_subject
        WHERE id = ANY($1::text[]) AND kind = 'agent' AND active FOR SHARE`,
      [[context.issuerSubject, context.ownerSubject]]);
      if (subjects.rows.length !== new Set([context.issuerSubject, context.ownerSubject]).size) {
        throw new MembershipDenied('Agent unavailable');
      }
      const generations = new Map(subjects.rows.map(row => [row.id, row.generation]));
      await client.query(`INSERT INTO access.representation
        (id, principal_id, subject_id, action, resource_subject,
          valid_until, assigned_by_principal, request_id,
          private_membership_id, private_membership_generation,
          represented_principal_epoch, represented_subject_generation,
          represented_resource_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [representationId, request.recipient_principal, context.issuerSubject,
        REPRESENTED_ORG_ACTION, context.ownerSubject, request.valid_until,
        operatorId, requestId, membership.rows[0].id, membership.rows[0].generation,
        recipient.rows[0].enforcement_epoch, generations.get(context.issuerSubject),
        generations.get(context.ownerSubject)]);
    });
  }

  async revokeMandate(context: RepresentedAuthorityContext, representationId: string,
    expectedGeneration: string): Promise<string> {
    if (!epoch.test(expectedGeneration)) throw new MembershipDenied('invalid mandate generation');
    return this.mutate(context, 'revoke-mandate', representationId, async (client, operatorId) => {
      await this.assignment(client, operatorId, context.issuerSubject,
        'access.representation.manage');
      await this.assignment(client, operatorId, context.issuerSubject,
        'access.representation.assign.membership.manage.org');
      const row = await client.query<{ generation: string; active: boolean }>(`
        SELECT generation, active FROM access.representation WHERE id = $1
          AND subject_id = $2 AND resource_subject = $3 AND action = $4 FOR UPDATE`,
      [representationId, context.issuerSubject, context.ownerSubject, REPRESENTED_ORG_ACTION]);
      if (!row.rows[0]?.active) throw new MembershipDenied('mandate unavailable');
      if (row.rows[0].generation !== expectedGeneration) {
        throw new MembershipStale('mandate generation changed');
      }
      await client.query('UPDATE access.representation SET active = false WHERE id = $1',
        [representationId]);
    });
  }

  async grant(context: RepresentedAuthorityContext, grantId: string, recipientSubject: string,
    validUntil: Date): Promise<string> {
    if (!agent.test(recipientSubject) || recipientSubject === context.ownerSubject
      || Number.isNaN(validUntil.getTime())) {
      throw new MembershipDenied('invalid represented grant');
    }
    return this.mutate(context, 'grant', grantId, async (client, operatorId) => {
      if (context.issuerSubject !== context.ownerSubject) {
        throw new MembershipDenied('only B may issue B roster authority');
      }
      if (validUntil.getTime() <= Date.now()) throw new MembershipDenied('grant validity ended');
      await this.assignment(client, operatorId, context.ownerSubject,
        'access.grant.assign.membership.manage.org', validUntil);
      const policy = await client.query(`SELECT 1 FROM access.membership_policy
        WHERE kind = 'org' AND owner_subject = $1 FOR SHARE`, [context.ownerSubject]);
      if (!policy.rows[0]) throw new MembershipDenied('Org roster policy missing');
      const subjects = await client.query<{ id: string; generation: string }>(`
        SELECT id, generation FROM access.authority_subject
        WHERE id = ANY($1::text[]) AND kind = 'agent' AND active FOR SHARE`,
      [[context.ownerSubject, recipientSubject]]);
      if (subjects.rows.length !== 2) throw new MembershipDenied('issuer or recipient Agent unavailable');
      const generations = new Map(subjects.rows.map(row => [row.id, row.generation]));
      const scope = orgRosterScope(context.ownerSubject);
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await client.query(`INSERT INTO access.org_roster_scope (owner_subject, scope_id)
        VALUES ($1,$2) ON CONFLICT (owner_subject) DO NOTHING`,
      [context.ownerSubject, scope]);
      const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(`
        SELECT g.open, g.dispatch_open FROM access.org_roster_scope o
        JOIN access.scope_gate g ON g.id = o.scope_id
        WHERE o.owner_subject = $1 AND o.scope_id = $2 FOR UPDATE OF g`,
      [context.ownerSubject, scope]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
        throw new MembershipDenied('Org roster authority scope closed');
      }
      await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until,
          assigned_by_principal, represented_issuer_generation,
          represented_recipient_generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [grantId, context.ownerSubject, recipientSubject, scope,
        REPRESENTED_ORG_ACTION, validUntil, operatorId,
        generations.get(context.ownerSubject), generations.get(recipientSubject)]);
    });
  }

  async revokeGrant(context: RepresentedAuthorityContext, grantId: string,
    expectedGeneration: string): Promise<string> {
    if (!epoch.test(expectedGeneration)) throw new MembershipDenied('invalid grant generation');
    return this.mutate(context, 'revoke-grant', grantId, async (client, operatorId) => {
      if (context.issuerSubject !== context.ownerSubject) {
        throw new MembershipDenied('only B may revoke B roster authority');
      }
      await this.assignment(client, operatorId, context.ownerSubject,
        'access.grant.assign.membership.manage.org');
      const row = await client.query<{ generation: string; active: boolean }>(`
        SELECT generation, active FROM access.permission_grant WHERE id = $1
          AND issuer_subject = $2 AND scope_id = $3 AND action = $4 FOR UPDATE`,
      [grantId, context.ownerSubject, orgRosterScope(context.ownerSubject),
        REPRESENTED_ORG_ACTION]);
      if (!row.rows[0]?.active) throw new MembershipDenied('grant unavailable');
      if (row.rows[0].generation !== expectedGeneration) {
        throw new MembershipStale('grant generation changed');
      }
      await client.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
        [grantId]);
    });
  }
}
