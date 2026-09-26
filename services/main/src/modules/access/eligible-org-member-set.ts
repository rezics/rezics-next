import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { MembershipConflict, MembershipDenied, MembershipStale,
  MembershipUnavailable } from './memberships.ts';
import { orgRosterScope } from './represented-membership-authority.ts';

const ROOT = 'work:create:root';
const ACTION = 'access.membership.manage.org';
const ASSIGN = 'access.grant.assign.membership.manage.org';
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const epoch = /^(0|[1-9][0-9]*)$/;

export interface EligibleSetGrantContext {
  principal: VerifiedPrincipal;
  issuerSubject: string;
  expectedAuthorityEpoch: string;
  idempotencyKey: string;
  requestDigest: string;
}
export interface EligibleSetGrantRead {
  grantId: string;
  selectorId: string;
  selectorVersion: string;
  recipientSubject: string;
  ownerSubject: string;
  active: boolean;
  generation: string;
  validUntil: string;
}
type GrantRow = { id: string; selector_id: string; selector_version: string;
  recipient_subject: string; issuer_subject: string; active: boolean;
  generation: string; valid_until: Date };

/** Access owns the typed set and its B-issued grant episode. The set never acts. */
export class AccessEligibleOrgMemberSet {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (code === '23505') return new MembershipConflict('eligible set identity conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(code)) {
        return new MembershipUnavailable('eligible set owner could not complete');
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
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
      FROM access.scope_gate WHERE id = $1 FOR UPDATE`, [ROOT]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new MembershipDenied('Access authority gate closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async principal(client: PoolClient, asserted: VerifiedPrincipal): Promise<string> {
    const row = await client.query<{ id: string }>(`SELECT id FROM access.principal
      WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
    [asserted.issuer, asserted.subject]);
    if (!row.rows[0]) throw new MembershipDenied('principal unavailable');
    return row.rows[0].id;
  }

  private async assignment(client: PoolClient, principalId: string, issuer: string,
    validUntil?: Date): Promise<void> {
    const mandate = await client.query(`SELECT r.id FROM access.representation r
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = $3
        AND r.active AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
      LIMIT 1 FOR SHARE OF r, s`, [principalId, issuer, ASSIGN]);
    if (!mandate.rows[0]) throw new MembershipDenied('B assignment mandate missing');
    const ceiling = await client.query(`SELECT id FROM access.permission_grant
      WHERE recipient_subject = $1 AND scope_id = $2 AND action = $3 AND active
        AND valid_until > clock_timestamp()
        AND ($4::timestamptz IS NULL OR valid_until >= $4)
      ORDER BY valid_until DESC LIMIT 1 FOR SHARE`,
    [issuer, ROOT, ASSIGN, validUntil ?? null]);
    if (!ceiling.rows[0]) throw new MembershipDenied('B assignment ceiling missing');
  }

  private validContext(context: EligibleSetGrantContext, grantId: string): boolean {
    return agent.test(context.issuerSubject) && uuid.test(grantId)
      && epoch.test(context.expectedAuthorityEpoch)
      && context.idempotencyKey.length >= 1 && context.idempotencyKey.length <= 128
      && !context.idempotencyKey.includes('\0')
      && /^[0-9a-f]{64}$/.test(context.requestDigest);
  }

  private async mutate(context: EligibleSetGrantContext, grantId: string,
    action: 'grant' | 'revoke', work: (client: PoolClient, principalId: string) => Promise<void>)
      : Promise<string> {
    if (!this.validContext(context, grantId)) throw new MembershipDenied('invalid eligible set change');
    const client = await this.pool.connect();
    try {
      const current = await this.begin(client);
      const principalId = await this.principal(client, context.principal);
      const prior = await client.query<{ request_digest: string; action: string;
        grant_id: string; issuer_subject: string; result_authority_epoch: string }>(`
        SELECT request_digest, action, grant_id, issuer_subject, result_authority_epoch
        FROM access.eligible_org_member_set_grant_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, context.idempotencyKey]);
      if (prior.rows[0]) {
        const saved = prior.rows[0];
        if (saved.request_digest !== context.requestDigest || saved.action !== action
          || saved.grant_id !== grantId || saved.issuer_subject !== context.issuerSubject) {
          throw new MembershipConflict('eligible set key binds another intent');
        }
        await client.query('COMMIT');
        return saved.result_authority_epoch;
      }
      if (current !== context.expectedAuthorityEpoch) {
        throw new MembershipStale('authority epoch changed');
      }
      await work(client, principalId);
      const bump = await client.query<{ authority_epoch: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch`, [ROOT]);
      const result = bump.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.eligible_org_member_set_grant_receipt
        (principal_id, idempotency_key, request_digest, action, grant_id,
          issuer_subject, result_authority_epoch) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [principalId, context.idempotencyKey, context.requestDigest, action,
        grantId, context.issuerSubject, result]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async grant(context: EligibleSetGrantContext, grantId: string, selectorId: string,
    recipientSubject: string, validUntil: Date): Promise<string> {
    if (!uuid.test(selectorId) || !agent.test(recipientSubject)
      || recipientSubject === context.issuerSubject || Number.isNaN(validUntil.getTime())) {
      throw new MembershipDenied('invalid eligible set grant');
    }
    return this.mutate(context, grantId, 'grant', async (client, principalId) => {
      if (validUntil.getTime() <= Date.now()) throw new MembershipDenied('grant validity ended');
      await this.assignment(client, principalId, context.issuerSubject, validUntil);
      const policy = await client.query(`SELECT 1 FROM access.membership_policy
        WHERE kind = 'org' AND owner_subject = $1 FOR SHARE`, [context.issuerSubject]);
      if (!policy.rows[0]) throw new MembershipDenied('B Org roster policy missing');
      const subjects = await client.query<{ id: string; generation: string }>(`
        SELECT id, generation FROM access.authority_subject
        WHERE id = ANY($1::text[]) AND kind = 'agent' AND active FOR SHARE`,
      [[context.issuerSubject, recipientSubject]]);
      if (subjects.rows.length !== 2) throw new MembershipDenied('B or A Agent unavailable');
      const generations = new Map(subjects.rows.map(row => [row.id, row.generation]));
      const existing = await client.query<{ id: string }>(`
        SELECT id FROM access.eligible_org_member_set
        WHERE owner_subject = $1 AND version = 1 FOR SHARE`, [recipientSubject]);
      if (existing.rows[0] && existing.rows[0].id !== selectorId) {
        throw new MembershipConflict('A selector identity already exists');
      }
      if (!existing.rows[0]) await client.query(`INSERT INTO access.eligible_org_member_set
        (id, owner_subject, version, predicate)
        VALUES ($1,$2,1,'current-private-org-members')`, [selectorId, recipientSubject]);
      const scope = orgRosterScope(context.issuerSubject);
      await client.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING',
        [scope]);
      await client.query(`INSERT INTO access.org_roster_scope (owner_subject, scope_id)
        VALUES ($1,$2) ON CONFLICT (owner_subject) DO NOTHING`,
      [context.issuerSubject, scope]);
      const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(`
        SELECT g.open, g.dispatch_open FROM access.org_roster_scope o
        JOIN access.scope_gate g ON g.id = o.scope_id
        WHERE o.owner_subject = $1 AND o.scope_id = $2 FOR UPDATE OF g`,
      [context.issuerSubject, scope]);
      if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
        throw new MembershipDenied('B roster scope closed');
      }
      await client.query(`INSERT INTO access.eligible_org_member_set_grant
        (id, selector_id, recipient_subject, selector_version, issuer_subject,
          scope_id, action, valid_until, assigned_by_principal,
          issuer_generation, recipient_generation)
        VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10)`,
      [grantId, selectorId, recipientSubject, context.issuerSubject, scope, ACTION,
        validUntil, principalId, generations.get(context.issuerSubject),
        generations.get(recipientSubject)]);
    });
  }

  async revoke(context: EligibleSetGrantContext, grantId: string,
    expectedGeneration: string): Promise<string> {
    if (!epoch.test(expectedGeneration)) throw new MembershipDenied('invalid grant generation');
    return this.mutate(context, grantId, 'revoke', async (client, principalId) => {
      await this.assignment(client, principalId, context.issuerSubject);
      const row = await client.query<{ active: boolean; generation: string }>(`
        SELECT active, generation FROM access.eligible_org_member_set_grant
        WHERE id = $1 AND issuer_subject = $2 AND action = $3 FOR UPDATE`,
      [grantId, context.issuerSubject, ACTION]);
      if (!row.rows[0]?.active) throw new MembershipDenied('eligible set grant unavailable');
      if (row.rows[0].generation !== expectedGeneration) {
        throw new MembershipStale('eligible set grant generation changed');
      }
      await client.query(`UPDATE access.eligible_org_member_set_grant
        SET active = false WHERE id = $1`, [grantId]);
    });
  }

  async read(principal: VerifiedPrincipal, issuerSubject: string,
    grantId: string): Promise<EligibleSetGrantRead> {
    if (!agent.test(issuerSubject) || !uuid.test(grantId)) {
      throw new MembershipDenied('invalid eligible set grant read');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const principalId = await this.principal(client, principal);
      await this.assignment(client, principalId, issuerSubject);
      const row = await client.query<GrantRow>(`
        SELECT id, selector_id, selector_version, recipient_subject,
          issuer_subject, active, generation, valid_until
        FROM access.eligible_org_member_set_grant
        WHERE id = $1 AND issuer_subject = $2 FOR SHARE`, [grantId, issuerSubject]);
      if (!row.rows[0]) throw new MembershipDenied('eligible set grant unavailable');
      await client.query('COMMIT');
      const saved = row.rows[0];
      return { grantId: saved.id, selectorId: saved.selector_id,
        selectorVersion: saved.selector_version, recipientSubject: saved.recipient_subject,
        ownerSubject: saved.issuer_subject, active: saved.active,
        generation: saved.generation, validUntil: saved.valid_until.toISOString() };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }
}
