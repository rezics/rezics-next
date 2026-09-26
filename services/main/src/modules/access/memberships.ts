import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';

export class MembershipDenied extends Error {}
export class MembershipConflict extends Error {}
export class MembershipStale extends Error {}
export class MembershipUnavailable extends Error {}

const SCOPE = 'work:create:root';
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epoch = /^(0|[1-9][0-9]*)$/;
const MAX_DEPENDENT_AUTHORITY = 256;
export type MembershipKind = 'org' | 'realm';
export type MembershipAction = 'join' | 'leave';
export interface MembershipDependency { membershipId: string; generation: string }

export function validMembershipDependency(value: MembershipDependency | undefined): boolean {
  return !value || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.membershipId)
    && /^[1-9][0-9]*$/.test(value.generation);
}

export async function currentMembershipDependency(client: PoolClient,
  value: MembershipDependency, memberSubject?: string): Promise<boolean> {
  const row = await client.query(`SELECT id FROM access.membership
    WHERE id = $1 AND ($2::text IS NULL OR member_subject = $2) AND state = 'joined'
      AND generation = $3 FOR SHARE`,
  [value.membershipId, memberSubject ?? null, value.generation]);
  return row.rowCount === 1;
}

export interface MembershipChange {
  principal: VerifiedPrincipal;
  kind: MembershipKind;
  ownerSubject: string;
  memberSubject: string;
  action: MembershipAction;
  expectedGeneration: string;
  expectedPolicyRevision: string;
  termsRevision?: string;
  consentReference?: string;
  idempotencyKey: string;
  requestDigest: string;
}

export interface MembershipResult {
  membershipId: string;
  kind: MembershipKind;
  ownerSubject: string;
  memberSubject: string;
  action: MembershipAction;
  state: 'joined' | 'left';
  generation: string;
  policyRevision: string;
  termsRevision: string | null;
  consentReference: string | null;
  authorityEpoch: string;
  replayed: boolean;
}

type Policy = { revision: string; terms_revision: string; open: boolean };
type Member = { id: string; state: 'joined' | 'left'; generation: string };

/** One owner transaction serializes a membership episode with dependent grants.
 * Org roster and Realm participation use distinct management actions/policies. */
export class AccessMemberships {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (code === '23505') return new MembershipConflict('membership key conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(code)) {
        return new MembershipUnavailable('membership owner timed out or conflicted');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async gate(client: PoolClient): Promise<string> {
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (!recovery.rows[0]?.open) throw new MembershipUnavailable('Access recovery held');
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
        FROM access.scope_gate WHERE id = $1 FOR UPDATE`, [SCOPE]);
    if (!gate.rows[0]) throw new MembershipUnavailable('scope gate missing');
    if (!gate.rows[0].open || !gate.rows[0].dispatch_open) {
      throw new MembershipDenied('scope closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async manager(client: PoolClient, principal: VerifiedPrincipal,
    kind: MembershipKind, ownerSubject: string): Promise<string> {
    const action = kind === 'org' ? 'access.membership.manage.org'
      : 'access.membership.manage.realm';
    const row = await client.query<{ id: string }>(`SELECT p.id FROM access.principal p
      JOIN access.representation r ON r.principal_id = p.id
      JOIN access.authority_subject s ON s.id = r.subject_id
      WHERE p.account_issuer = $1 AND p.account_subject = $2 AND p.active
        AND r.subject_id = $3 AND r.action = $4 AND r.active
        AND r.valid_until > clock_timestamp() AND s.kind = 'agent' AND s.active
        AND EXISTS (SELECT 1 FROM access.permission_grant g
          WHERE g.recipient_subject = $3 AND g.scope_id = $5 AND g.action = $4
            AND g.active AND g.valid_until > clock_timestamp())
      ORDER BY p.id LIMIT 1 FOR SHARE OF p, r, s`,
    [principal.issuer, principal.subject, ownerSubject, action, SCOPE]);
    if (!row.rows[0]) throw new MembershipDenied('management authority missing');
    return row.rows[0].id;
  }

  async change(input: MembershipChange): Promise<MembershipResult> {
    if (!agent.test(input.ownerSubject) || !agent.test(input.memberSubject)
      || !epoch.test(input.expectedGeneration) || !epoch.test(input.expectedPolicyRevision)
      || !input.idempotencyKey || input.idempotencyKey.length > 128
      || input.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(input.requestDigest)
      || input.action === 'join' && (!input.termsRevision || !input.consentReference
        || input.termsRevision.length > 128 || input.consentReference.length > 128)) {
      throw new MembershipDenied('invalid membership request');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      const currentEpoch = await this.gate(client);
      const principalId = await this.manager(client, input.principal, input.kind, input.ownerSubject);
      const prior = await client.query<{ request_digest: string; membership_id: string;
        result_generation: string; result_authority_epoch: string; action: MembershipAction }>(`
        SELECT request_digest, membership_id, result_generation, result_authority_epoch, action
        FROM access.membership_change_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [principalId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest
          || prior.rows[0].action !== input.action) {
          throw new MembershipConflict('key binds another intent');
        }
        const saved = await client.query<{ kind: MembershipKind; owner_subject: string;
          member_subject: string; state: 'joined' | 'left'; policy_revision: string;
          terms_revision: string | null; consent_reference: string | null }>(`
          SELECT m.kind, m.owner_subject, m.member_subject, h.state,
            h.policy_revision, h.terms_revision, h.consent_reference
          FROM access.membership m JOIN access.membership_history h
            ON h.membership_id = m.id AND h.generation = $2
          WHERE m.id = $1`, [prior.rows[0].membership_id, prior.rows[0].result_generation]);
        if (!saved.rows[0]) throw new MembershipUnavailable('receipt history missing');
        await client.query('COMMIT');
        return { membershipId: prior.rows[0].membership_id,
          kind: saved.rows[0].kind, ownerSubject: saved.rows[0].owner_subject,
          memberSubject: saved.rows[0].member_subject, action: prior.rows[0].action,
          state: saved.rows[0].state, generation: prior.rows[0].result_generation,
          policyRevision: saved.rows[0].policy_revision,
          termsRevision: saved.rows[0].terms_revision,
          consentReference: saved.rows[0].consent_reference,
          authorityEpoch: prior.rows[0].result_authority_epoch, replayed: true };
      }
      const policy = await client.query<Policy>(`SELECT revision, terms_revision, open
        FROM access.membership_policy WHERE kind = $1 AND owner_subject = $2 FOR SHARE`,
      [input.kind, input.ownerSubject]);
      if (!policy.rows[0]) throw new MembershipDenied('admission policy missing');
      if (policy.rows[0].revision !== input.expectedPolicyRevision) {
        throw new MembershipStale('policy revision changed');
      }
      if (input.action === 'join' && (!policy.rows[0].open
        || policy.rows[0].terms_revision !== input.termsRevision)) {
        throw new MembershipDenied('admission terms or policy closed');
      }
      const member = await client.query(`SELECT id FROM access.authority_subject
        WHERE id = $1 AND kind = 'agent' AND active FOR SHARE`, [input.memberSubject]);
      if (!member.rows[0]) throw new MembershipDenied('member Agent unavailable');
      const existing = await client.query<Member>(`SELECT id, state, generation
        FROM access.membership WHERE kind = $1 AND owner_subject = $2
          AND member_subject = $3 FOR UPDATE`,
      [input.kind, input.ownerSubject, input.memberSubject]);
      const priorGeneration = existing.rows[0]?.generation ?? '0';
      if (priorGeneration !== input.expectedGeneration) {
        throw new MembershipStale('admission generation changed');
      }
      if (input.action === 'join' && existing.rows[0]?.state === 'joined'
        || input.action === 'leave' && existing.rows[0]?.state !== 'joined') {
        throw new MembershipDenied('invalid membership transition');
      }
      if (input.action === 'join') {
        const ban = await client.query(`SELECT 1 FROM access.membership_ban
          WHERE kind = $1 AND owner_subject = $2 AND member_subject = $3 AND active
          FOR SHARE`, [input.kind, input.ownerSubject, input.memberSubject]);
        if (ban.rows[0]) throw new MembershipDenied('member is banned');
      }
      const membershipId = existing.rows[0]?.id ?? randomUUID();
      const generation = (BigInt(priorGeneration) + 1n).toString();
      if (existing.rows[0]) {
        await client.query(`UPDATE access.membership SET state = $2,
          generation = $3, policy_revision = $4, terms_revision = $5,
          consent_reference = $6, changed_at = now() WHERE id = $1`,
        [membershipId, input.action === 'join' ? 'joined' : 'left', generation,
          input.expectedPolicyRevision, input.action === 'join' ? input.termsRevision : null,
          input.action === 'join' ? input.consentReference : null]);
      } else {
        await client.query(`INSERT INTO access.membership
          (id, kind, owner_subject, member_subject, state, generation,
            policy_revision, terms_revision, consent_reference)
          VALUES ($1,$2,$3,$4,'joined',$5,$6,$7,$8)`,
        [membershipId, input.kind, input.ownerSubject, input.memberSubject,
          generation, input.expectedPolicyRevision, input.termsRevision,
          input.consentReference]);
      }
      if (input.action === 'leave') {
        const dependentTables = ['permission_grant', 'group_permission_grant', 'role_binding'] as const;
        let remaining = MAX_DEPENDENT_AUTHORITY;
        const selected: { table: typeof dependentTables[number]; ids: string[] }[] = [];
        for (const table of dependentTables) {
          const rows = await client.query<{ id: string }>(`SELECT id
            FROM access.${table} WHERE membership_id = $1 AND active
            ORDER BY id LIMIT $2 FOR UPDATE`, [membershipId, remaining + 1]);
          if (rows.rows.length > remaining) {
            throw new MembershipUnavailable('dependent authority cleanup exceeds budget');
          }
          selected.push({ table, ids: rows.rows.map(row => row.id) });
          remaining -= rows.rows.length;
        }
        for (const { table, ids } of selected) {
          if (ids.length) await client.query(`UPDATE access.${table} SET active = false
            WHERE id = ANY($1::uuid[])`, [ids]);
        }
      }
      const bumped = await client.query<{ authority_epoch: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch`, [SCOPE]);
      const authorityEpoch = bumped.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.membership_history
        (membership_id, generation, state, policy_revision, terms_revision,
          consent_reference, changed_by_principal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [membershipId, generation, input.action === 'join' ? 'joined' : 'left',
        input.expectedPolicyRevision, input.action === 'join' ? input.termsRevision : null,
        input.action === 'join' ? input.consentReference : null, principalId]);
      await client.query(`INSERT INTO access.membership_change_receipt
        (principal_id, idempotency_key, request_digest, membership_id,
          result_generation, result_authority_epoch, action)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [principalId, input.idempotencyKey, input.requestDigest,
        membershipId, generation, authorityEpoch, input.action]);
      await client.query('COMMIT');
      return { membershipId, kind: input.kind, ownerSubject: input.ownerSubject,
        memberSubject: input.memberSubject, action: input.action,
        state: input.action === 'join' ? 'joined' : 'left', generation,
        policyRevision: input.expectedPolicyRevision,
        termsRevision: input.action === 'join' ? input.termsRevision! : null,
        consentReference: input.action === 'join' ? input.consentReference! : null,
        authorityEpoch, replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }
}
