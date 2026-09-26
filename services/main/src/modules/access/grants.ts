import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class GrantDenied extends Error {}
export class GrantConflict extends Error {}
export class GrantStale extends Error {}
export class GrantUnavailable extends Error {}

const SCOPE = 'work:create:root';
const ACTION = 'work.create';
const ASSIGN = 'access.grant.assign.work.create';
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export interface GrantContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedAuthorityEpoch: string;
}
export interface GrantReceipt {
  idempotencyKey: string;
  requestDigest: string;
}
export interface GrantMembershipDependency {
  membershipId: string;
  generation: string;
}
export interface AgentGrant {
  id: string;
  issuerSubject: string;
  recipientSubject: string;
  validUntil: string;
  active: boolean;
  generation: string;
}
export interface GrantPage {
  authorityEpoch: string;
  grants: AgentGrant[];
  nextCursor: string | null;
}
type GrantRow = {
  id: string; issuer_subject: string; recipient_subject: string;
  valid_until: Date; active: boolean; generation: string;
};

/** First institutional Agent-to-Agent work.create grant profile. The actual
 * authenticated operator is recorded privately; the issuer Agent owns the
 * durable grant. Role revisions and protected grant families have other gates. */
export class AccessGrants {
  constructor(private readonly pool: Pool) {}

  private async gate(client: PoolClient, write: boolean): Promise<string> {
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (recovery.rows[0]?.open !== true) throw new GrantUnavailable('Access recovery is held');
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
      FROM access.scope_gate WHERE id = $1 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [SCOPE]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new GrantDenied('grant scope is closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async authorize(client: PoolClient, principal: VerifiedPrincipal,
    issuerSubject: string, validUntil?: Date): Promise<string> {
    const actor = await client.query<{ id: string }>(`SELECT p.id
      FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4 AND r.active
        AND r.valid_until > clock_timestamp()
        AND s.kind = 'agent' AND s.active
      LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, issuerSubject, ASSIGN]);
    if (!actor.rows[0]) throw new GrantDenied('issuer representation is missing');
    const ceiling = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp()
        AND ($4::timestamptz IS NULL OR valid_until >= $4)
      ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
    [issuerSubject, SCOPE, ASSIGN, validUntil ?? null]);
    if (!ceiling.rows[0]) throw new GrantDenied('grant assignment ceiling is missing');
    return actor.rows[0].id;
  }

  private toGrant(row: GrantRow): AgentGrant {
    return { id: row.id, issuerSubject: row.issuer_subject,
      recipientSubject: row.recipient_subject, validUntil: row.valid_until.toISOString(),
      active: row.active, generation: row.generation };
  }

  async readPage(principal: VerifiedPrincipal, issuerSubject: string,
    after?: string): Promise<GrantPage> {
    if (!agentPattern.test(issuerSubject) || after && !idPattern.test(after)) {
      throw new GrantDenied('invalid grant read');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const authorityEpoch = await this.gate(client, false);
      await this.authorize(client, principal, issuerSubject);
      const rows = await client.query<GrantRow>(`SELECT id, issuer_subject,
        recipient_subject, valid_until, active, generation
        FROM access.permission_grant WHERE issuer_subject = $1
          AND scope_id = $2 AND action = $3 AND ($4::uuid IS NULL OR id > $4)
        ORDER BY id LIMIT 51`, [issuerSubject, SCOPE, ACTION, after ?? null]);
      await client.query('COMMIT');
      return { authorityEpoch, grants: rows.rows.slice(0, 50).map(row => this.toGrant(row)),
        nextCursor: rows.rows.length > 50 ? rows.rows[49]!.id : null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readOne(principal: VerifiedPrincipal, issuerSubject: string,
    grantId: string): Promise<{ authorityEpoch: string; grant: AgentGrant }> {
    if (!agentPattern.test(issuerSubject) || !idPattern.test(grantId)) {
      throw new GrantDenied('invalid grant read');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const authorityEpoch = await this.gate(client, false);
      await this.authorize(client, principal, issuerSubject);
      const rows = await client.query<GrantRow>(`SELECT id, issuer_subject,
        recipient_subject, valid_until, active, generation
        FROM access.permission_grant WHERE id = $1 AND issuer_subject = $2
          AND scope_id = $3 AND action = $4`, [grantId, issuerSubject, SCOPE, ACTION]);
      if (!rows.rows[0]) throw new GrantDenied('grant is unavailable to issuer');
      await client.query('COMMIT');
      return { authorityEpoch, grant: this.toGrant(rows.rows[0]) };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      if (String(error.code) === '23505') return new GrantConflict('grant identifier conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        return new GrantUnavailable('grant owner could not complete');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async mutate(context: GrantContext, action: 'create' | 'revoke',
    grantId: string, receipt: GrantReceipt,
    work: (client: PoolClient, principalId: string) => Promise<boolean>): Promise<string> {
    if (!agentPattern.test(context.issuerSubject) || !idPattern.test(grantId)
      || !/^(0|[1-9][0-9]*)$/.test(context.expectedAuthorityEpoch)
      || !receipt.idempotencyKey || receipt.idempotencyKey.length > 128
      || receipt.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(receipt.requestDigest)) {
      throw new GrantDenied('invalid grant change');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const currentEpoch = await this.gate(client, true);
      const principalId = await this.authorize(client, context.principal, context.issuerSubject);
      const prior = await client.query<{ request_digest: string; issuer_subject: string;
        action: string; grant_id: string; result_authority_epoch: string }>(`
        SELECT request_digest, issuer_subject, action, grant_id, result_authority_epoch
        FROM access.grant_change_receipt WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, receipt.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== receipt.requestDigest
          || prior.rows[0].issuer_subject !== context.issuerSubject
          || prior.rows[0].action !== action || prior.rows[0].grant_id !== grantId) {
          throw new GrantConflict('grant key binds another intent');
        }
        await client.query('COMMIT');
        return prior.rows[0].result_authority_epoch;
      }
      if (currentEpoch !== context.expectedAuthorityEpoch) {
        throw new GrantStale('grant scope authority epoch changed');
      }
      const changed = await work(client, principalId);
      let resultEpoch = currentEpoch;
      if (changed) {
        const bumped = await client.query<{ authority_epoch: string }>(`
          UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
          WHERE id = $1 RETURNING authority_epoch`, [SCOPE]);
        resultEpoch = bumped.rows[0]!.authority_epoch;
      }
      await client.query(`INSERT INTO access.grant_change_receipt
        (principal_id, idempotency_key, request_digest, issuer_subject,
        action, grant_id, result_authority_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [principalId, receipt.idempotencyKey, receipt.requestDigest,
        context.issuerSubject, action, grantId, resultEpoch]);
      await client.query('COMMIT');
      return resultEpoch;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async create(context: GrantContext, grantId: string, recipientSubject: string,
    validUntil: Date, receipt: GrantReceipt,
    membershipDependency?: GrantMembershipDependency): Promise<string> {
    if (!agentPattern.test(recipientSubject) || Number.isNaN(validUntil.getTime())
      || membershipDependency && (!idPattern.test(membershipDependency.membershipId)
        || !/^[1-9][0-9]*$/.test(membershipDependency.generation))) {
      throw new GrantDenied('invalid grant recipient or validity');
    }
    return this.mutate(context, 'create', grantId, receipt, async (client, principalId) => {
      if (validUntil.getTime() <= Date.now()) throw new GrantDenied('grant validity ended');
      await this.authorize(client, context.principal, context.issuerSubject, validUntil);
      const recipient = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [recipientSubject]);
      if (!recipient.rows[0]) throw new GrantDenied('recipient Agent is unavailable');
      if (membershipDependency) {
        const membership = await client.query(`SELECT id FROM access.membership
          WHERE id = $1 AND member_subject = $2 AND state = 'joined'
            AND generation = $3 FOR SHARE`, [membershipDependency.membershipId,
          recipientSubject, membershipDependency.generation]);
        if (!membership.rows[0]) throw new GrantDenied('membership dependency is stale');
      }
      await client.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until,
          assigned_by_principal, membership_id, membership_generation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [grantId, context.issuerSubject, recipientSubject, SCOPE, ACTION,
        validUntil, principalId, membershipDependency?.membershipId ?? null,
        membershipDependency?.generation ?? null]);
      return true;
    });
  }

  async revoke(context: GrantContext, grantId: string,
    expectedObjectGeneration: string, receipt: GrantReceipt): Promise<string> {
    if (!/^(0|[1-9][0-9]*)$/.test(expectedObjectGeneration)) {
      throw new GrantDenied('invalid grant object generation');
    }
    return this.mutate(context, 'revoke', grantId, receipt, async client => {
      const grant = await client.query<{ active: boolean; generation: string }>(`
        SELECT active, generation FROM access.permission_grant
        WHERE id = $1 AND issuer_subject = $2 AND scope_id = $3 AND action = $4
        FOR UPDATE`, [grantId, context.issuerSubject, SCOPE, ACTION]);
      if (!grant.rows[0]) throw new GrantDenied('grant is unavailable to issuer');
      if (grant.rows[0].generation !== expectedObjectGeneration) {
        throw new GrantStale('grant object generation changed');
      }
      if (!grant.rows[0].active) return false;
      await client.query(`UPDATE access.permission_grant
        SET active = false, generation = generation + 1 WHERE id = $1`, [grantId]);
      return true;
    });
  }
}
