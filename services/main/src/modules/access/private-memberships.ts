import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { MembershipConflict, MembershipDenied, MembershipStale,
  MembershipUnavailable, type MembershipKind } from './memberships.ts';

const SCOPE = 'work:create:root';
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const epoch = /^(0|[1-9][0-9]*)$/;
const MAX_DEPENDENT_AUTHORITY = 256;
type Principal = { id: string; enforcement_epoch: string };
type Member = { id: string; principal_id: string; kind: MembershipKind;
  owner_subject: string; state: 'joined' | 'left'; generation: string };
type Policy = { revision: string; terms_revision: string; open: boolean };

export interface PrivateMembershipConsentRequest {
  principal: VerifiedPrincipal;
  kind: MembershipKind;
  ownerSubject: string;
  expectedGeneration: string;
  expectedPolicyRevision: string;
  termsRevision: string;
  idempotencyKey: string;
  requestDigest: string;
}
export interface PrivateMembershipConsentResult {
  consentReference: string;
  nextGeneration: string;
  expiresAt: string;
  replayed: boolean;
}
export interface PrivateMembershipChange {
  principal: VerifiedPrincipal;
  kind: MembershipKind;
  ownerSubject: string;
  action: 'join' | 'leave';
  expectedGeneration: string;
  expectedPolicyRevision: string;
  termsRevision?: string;
  consentReference?: string;
  membershipId?: string;
  idempotencyKey: string;
  requestDigest: string;
}
export interface PrivateMembershipResult {
  membershipId: string;
  kind: MembershipKind;
  ownerSubject: string;
  action: 'join' | 'leave';
  state: 'joined' | 'left';
  generation: string;
  policyRevision: string;
  termsRevision: string | null;
  authorityEpoch: string;
  replayed: boolean;
}
export interface PrivateMembershipPage {
  memberships: Omit<PrivateMembershipResult, 'action' | 'authorityEpoch' | 'replayed'>[];
  nextCursor: string | null;
}

/** Access resolves the one-use handle to its private principal inside the owner
 * transaction. A roster manager never receives an Account subject or principal ID. */
export class AccessPrivateMemberships {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = String(error.code);
      if (code === '23505') return new MembershipConflict('private membership key conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(code)) {
        return new MembershipUnavailable('private membership owner timed out');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async begin(client: PoolClient, write: boolean): Promise<string> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (!recovery.rows[0]?.open) throw new MembershipUnavailable('Access recovery held');
    const gate = await client.query<{ authority_epoch: string; open: boolean;
      dispatch_open: boolean }>(`SELECT authority_epoch, open, dispatch_open
        FROM access.scope_gate WHERE id = $1 ${write ? 'FOR UPDATE' : 'FOR SHARE'}`, [SCOPE]);
    if (!gate.rows[0]) throw new MembershipUnavailable('scope gate missing');
    if (!gate.rows[0].open || !gate.rows[0].dispatch_open) {
      throw new MembershipDenied('membership scope closed');
    }
    return gate.rows[0].authority_epoch;
  }

  private async recipient(client: PoolClient, asserted: VerifiedPrincipal,
    create: boolean): Promise<Principal> {
    if (create) {
      await client.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
        VALUES ($1,$2,$3) ON CONFLICT (account_issuer, account_subject) DO NOTHING`,
      [randomUUID(), asserted.issuer, asserted.subject]);
    }
    const row = await client.query<Principal>(`SELECT id, enforcement_epoch
      FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
        AND active FOR SHARE`, [asserted.issuer, asserted.subject]);
    if (!row.rows[0]) throw new MembershipDenied('recipient principal unavailable');
    return row.rows[0];
  }

  private async manager(client: PoolClient, asserted: VerifiedPrincipal,
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
    [asserted.issuer, asserted.subject, ownerSubject, action, SCOPE]);
    if (!row.rows[0]) throw new MembershipDenied('management authority missing');
    return row.rows[0].id;
  }

  async issue(input: PrivateMembershipConsentRequest): Promise<PrivateMembershipConsentResult> {
    if (!agent.test(input.ownerSubject) || !epoch.test(input.expectedGeneration)
      || !epoch.test(input.expectedPolicyRevision) || !input.termsRevision
      || input.termsRevision.length > 128 || !this.validKey(input.idempotencyKey, input.requestDigest)) {
      throw new MembershipDenied('invalid private consent request');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client, true);
      const principal = await this.recipient(client, input.principal, true);
      const prior = await client.query<{ request_digest: string; consent_id: string }>(`
        SELECT request_digest, consent_id FROM access.private_membership_consent_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [principal.id, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest) {
          throw new MembershipConflict('consent key binds another intent');
        }
        const saved = await client.query<{ next_generation: string; expires_at: Date }>(`
          SELECT next_generation, expires_at FROM access.private_membership_consent WHERE id = $1`,
        [prior.rows[0].consent_id]);
        if (!saved.rows[0]) throw new MembershipUnavailable('consent receipt history missing');
        await client.query('COMMIT');
        return { consentReference: prior.rows[0].consent_id,
          nextGeneration: saved.rows[0].next_generation,
          expiresAt: saved.rows[0].expires_at.toISOString(), replayed: true };
      }
      const policy = await client.query<Policy>(`SELECT revision, terms_revision, open
        FROM access.membership_policy WHERE kind = $1 AND owner_subject = $2 FOR SHARE`,
      [input.kind, input.ownerSubject]);
      if (!policy.rows[0]?.open || policy.rows[0].terms_revision !== input.termsRevision) {
        throw new MembershipDenied('admission policy or terms unavailable');
      }
      if (policy.rows[0].revision !== input.expectedPolicyRevision) {
        throw new MembershipStale('admission policy revision changed');
      }
      const state = await client.query<{ generation: string; state: string }>(`
        SELECT generation, state FROM access.private_membership
        WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3 FOR SHARE`,
      [input.kind, input.ownerSubject, principal.id]);
      if ((state.rows[0]?.generation ?? '0') !== input.expectedGeneration) {
        throw new MembershipStale('admission generation changed');
      }
      if (state.rows[0]?.state === 'joined') throw new MembershipDenied('already joined');
      const ban = await client.query(`SELECT 1 FROM access.private_membership_ban
        WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3 AND active FOR SHARE`,
      [input.kind, input.ownerSubject, principal.id]);
      if (ban.rows[0]) throw new MembershipDenied('recipient is banned');
      const id = randomUUID();
      const nextGeneration = (BigInt(input.expectedGeneration) + 1n).toString();
      const expiresAt = new Date(Date.now() + 5 * 60_000);
      await client.query(`INSERT INTO access.private_membership_consent
        (id, principal_id, principal_epoch, kind, owner_subject, policy_revision,
          terms_revision, next_generation, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, principal.id, principal.enforcement_epoch, input.kind, input.ownerSubject,
        input.expectedPolicyRevision, input.termsRevision, nextGeneration, expiresAt]);
      await client.query(`INSERT INTO access.private_membership_consent_receipt
        (principal_id, idempotency_key, request_digest, consent_id) VALUES ($1,$2,$3,$4)`,
      [principal.id, input.idempotencyKey, input.requestDigest, id]);
      await client.query('COMMIT');
      return { consentReference: id, nextGeneration, expiresAt: expiresAt.toISOString(), replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async revoke(asserted: VerifiedPrincipal, consentReference: string): Promise<void> {
    if (!uuid.test(consentReference)) throw new MembershipDenied('invalid consent reference');
    const client = await this.pool.connect();
    try {
      await this.begin(client, true);
      const principal = await this.recipient(client, asserted, false);
      const owned = await client.query(`SELECT id FROM access.private_membership_consent
        WHERE id = $1 AND principal_id = $2 FOR SHARE`, [consentReference, principal.id]);
      if (!owned.rows[0]) throw new MembershipDenied('consent unavailable to recipient');
      await client.query(`INSERT INTO access.private_membership_consent_revocation
        (consent_id, principal_id) VALUES ($1,$2) ON CONFLICT (consent_id) DO NOTHING`,
      [consentReference, principal.id]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async readMine(asserted: VerifiedPrincipal, cursor: string | null,
    limit: number): Promise<PrivateMembershipPage> {
    if (cursor !== null && !uuid.test(cursor) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new MembershipDenied('invalid private membership page');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client, false);
      const principal = await this.recipient(client, asserted, false);
      const rows = await client.query<{ id: string; kind: MembershipKind; owner_subject: string;
        state: 'joined' | 'left'; generation: string; policy_revision: string;
        terms_revision: string | null }>(`SELECT id, kind, owner_subject, state,
          generation, policy_revision, terms_revision FROM access.private_membership
        WHERE principal_id = $1 AND ($2::uuid IS NULL OR id > $2::uuid)
        ORDER BY id LIMIT $3`, [principal.id, cursor, limit + 1]);
      await client.query('COMMIT');
      const page = rows.rows.slice(0, limit);
      return { memberships: page.map(row => ({ membershipId: row.id, kind: row.kind,
        ownerSubject: row.owner_subject, state: row.state, generation: row.generation,
        policyRevision: row.policy_revision, termsRevision: row.terms_revision })),
      nextCursor: rows.rows.length > limit ? page.at(-1)!.id : null };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async change(input: PrivateMembershipChange): Promise<PrivateMembershipResult> {
    if (!agent.test(input.ownerSubject) || !epoch.test(input.expectedGeneration)
      || !epoch.test(input.expectedPolicyRevision)
      || !this.validKey(input.idempotencyKey, input.requestDigest)
      || input.action === 'join' && (!input.termsRevision || input.termsRevision.length > 128
        || !input.consentReference || !uuid.test(input.consentReference))
      || input.action === 'leave' && (!input.membershipId || !uuid.test(input.membershipId))) {
      throw new MembershipDenied('invalid private membership change');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client, true);
      const managerId = await this.manager(client, input.principal, input.kind, input.ownerSubject);
      const prior = await client.query<{ request_digest: string; membership_id: string;
        result_generation: string; result_authority_epoch: string; action: 'join' | 'leave' }>(`
        SELECT request_digest, membership_id, result_generation, result_authority_epoch, action
        FROM access.private_membership_change_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [managerId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest || prior.rows[0].action !== input.action) {
          throw new MembershipConflict('change key binds another intent');
        }
        const saved = await client.query<{ kind: MembershipKind; owner_subject: string;
          state: 'joined' | 'left'; policy_revision: string; terms_revision: string | null }>(`
          SELECT m.kind, m.owner_subject, h.state, h.policy_revision, h.terms_revision
          FROM access.private_membership m JOIN access.private_membership_history h
            ON h.membership_id = m.id AND h.generation = $2 WHERE m.id = $1`,
        [prior.rows[0].membership_id, prior.rows[0].result_generation]);
        if (!saved.rows[0]) throw new MembershipUnavailable('change receipt history missing');
        await client.query('COMMIT');
        return { membershipId: prior.rows[0].membership_id, kind: saved.rows[0].kind,
          ownerSubject: saved.rows[0].owner_subject, action: prior.rows[0].action,
          state: saved.rows[0].state, generation: prior.rows[0].result_generation,
          policyRevision: saved.rows[0].policy_revision,
          termsRevision: saved.rows[0].terms_revision,
          authorityEpoch: prior.rows[0].result_authority_epoch, replayed: true };
      }
      const policy = await client.query<Policy>(`SELECT revision, terms_revision, open
        FROM access.membership_policy WHERE kind = $1 AND owner_subject = $2 FOR SHARE`,
      [input.kind, input.ownerSubject]);
      if (!policy.rows[0]) throw new MembershipDenied('admission policy missing');
      if (policy.rows[0].revision !== input.expectedPolicyRevision) {
        throw new MembershipStale('admission policy revision changed');
      }
      let member: Member | undefined;
      if (input.action === 'join') {
        if (!policy.rows[0].open || policy.rows[0].terms_revision !== input.termsRevision) {
          throw new MembershipDenied('admission policy or terms unavailable');
        }
        const consent = await client.query<{ principal_id: string }>(`
          SELECT c.principal_id FROM access.private_membership_consent c
          JOIN access.principal p ON p.id = c.principal_id AND p.active
            AND p.enforcement_epoch = c.principal_epoch
          WHERE c.id = $1 AND c.kind = $2 AND c.owner_subject = $3
            AND c.policy_revision = $4 AND c.terms_revision = $5
            AND c.expires_at > clock_timestamp()
            AND NOT EXISTS (SELECT 1 FROM access.private_membership_consent_revocation v
              WHERE v.consent_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM access.private_membership_consent_use u
              WHERE u.consent_id = c.id)
          FOR SHARE OF c, p`,
        [input.consentReference, input.kind, input.ownerSubject,
          input.expectedPolicyRevision, input.termsRevision]);
        if (!consent.rows[0]) throw new MembershipDenied('recipient consent unavailable');
        const existing = await client.query<Member>(`SELECT id, principal_id, kind,
          owner_subject, state, generation FROM access.private_membership
          WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3 FOR UPDATE`,
        [input.kind, input.ownerSubject, consent.rows[0].principal_id]);
        member = existing.rows[0];
        const generation = member?.generation ?? '0';
        if (generation !== input.expectedGeneration) throw new MembershipStale('admission generation changed');
        if (member?.state === 'joined') throw new MembershipDenied('already joined');
        const bound = await client.query(`SELECT 1 FROM access.private_membership_consent
          WHERE id = $1 AND next_generation = $2 FOR SHARE`,
        [input.consentReference, (BigInt(generation) + 1n).toString()]);
        if (!bound.rows[0]) throw new MembershipDenied('consent episode mismatch');
        const ban = await client.query(`SELECT 1 FROM access.private_membership_ban
          WHERE kind = $1 AND owner_subject = $2 AND principal_id = $3 AND active FOR SHARE`,
        [input.kind, input.ownerSubject, consent.rows[0].principal_id]);
        if (ban.rows[0]) throw new MembershipDenied('recipient is banned');
        const membershipId = member?.id ?? randomUUID();
        const nextGeneration = (BigInt(generation) + 1n).toString();
        if (member) {
          await client.query(`UPDATE access.private_membership SET state = 'joined',
            generation = $2, policy_revision = $3, terms_revision = $4,
            consent_reference = $5, changed_at = now() WHERE id = $1`,
          [membershipId, nextGeneration, input.expectedPolicyRevision,
            input.termsRevision, input.consentReference]);
        } else {
          await client.query(`INSERT INTO access.private_membership
            (id, kind, owner_subject, principal_id, state, generation, policy_revision,
              terms_revision, consent_reference) VALUES ($1,$2,$3,$4,'joined',$5,$6,$7,$8)`,
          [membershipId, input.kind, input.ownerSubject, consent.rows[0].principal_id,
            nextGeneration, input.expectedPolicyRevision, input.termsRevision,
            input.consentReference]);
        }
        await client.query(`INSERT INTO access.private_membership_consent_use
          (consent_id, membership_id, generation) VALUES ($1,$2,$3)`,
        [input.consentReference, membershipId, nextGeneration]);
        member = { id: membershipId, principal_id: consent.rows[0].principal_id,
          kind: input.kind, owner_subject: input.ownerSubject,
          state: 'joined', generation: nextGeneration };
      } else {
        const found = await client.query<Member>(`SELECT id, principal_id, kind,
          owner_subject, state, generation FROM access.private_membership
          WHERE id = $1 AND kind = $2 AND owner_subject = $3 FOR UPDATE`,
        [input.membershipId, input.kind, input.ownerSubject]);
        member = found.rows[0];
        if (!member) throw new MembershipDenied('membership unavailable');
        if (member.generation !== input.expectedGeneration) {
          throw new MembershipStale('admission generation changed');
        }
        if (member.state !== 'joined') throw new MembershipDenied('already left');
        const grants = await client.query<{ id: string }>(`SELECT id
          FROM access.principal_permission_grant
          WHERE private_membership_id = $1 AND active ORDER BY id LIMIT $2 FOR UPDATE`,
        [member.id, MAX_DEPENDENT_AUTHORITY + 1]);
        if (grants.rows.length > MAX_DEPENDENT_AUTHORITY) {
          throw new MembershipUnavailable('dependent authority cleanup exceeds budget');
        }
        if (grants.rows.length) {
          await client.query(`UPDATE access.principal_permission_grant SET active = false
            WHERE id = ANY($1::uuid[])`, [grants.rows.map(row => row.id)]);
        }
        member = { ...member, state: 'left', generation: (BigInt(member.generation) + 1n).toString() };
        await client.query(`UPDATE access.private_membership SET state = 'left',
          generation = $2, policy_revision = $3, terms_revision = NULL,
          consent_reference = NULL, changed_at = now() WHERE id = $1`,
        [member.id, member.generation, input.expectedPolicyRevision]);
      }
      const bumped = await client.query<{ authority_epoch: string }>(`
        UPDATE access.scope_gate SET authority_epoch = authority_epoch + 1
        WHERE id = $1 RETURNING authority_epoch`, [SCOPE]);
      const authorityEpoch = bumped.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.private_membership_history
        (membership_id, generation, state, policy_revision, terms_revision,
          consent_reference, changed_by_principal) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [member.id, member.generation, member.state, input.expectedPolicyRevision,
        input.action === 'join' ? input.termsRevision : null,
        input.action === 'join' ? input.consentReference : null, managerId]);
      await client.query(`INSERT INTO access.private_membership_change_receipt
        (principal_id, idempotency_key, request_digest, membership_id,
          result_generation, result_authority_epoch, action) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [managerId, input.idempotencyKey, input.requestDigest, member.id,
        member.generation, authorityEpoch, input.action]);
      await client.query('COMMIT');
      return { membershipId: member.id, kind: input.kind, ownerSubject: input.ownerSubject,
        action: input.action, state: member.state, generation: member.generation,
        policyRevision: input.expectedPolicyRevision,
        termsRevision: input.action === 'join' ? input.termsRevision! : null,
        authorityEpoch, replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* retain original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  private validKey(key: string, digest: string): boolean {
    return !!key && key.length <= 128 && !key.includes('\0') && /^[0-9a-f]{64}$/.test(digest);
  }
}
