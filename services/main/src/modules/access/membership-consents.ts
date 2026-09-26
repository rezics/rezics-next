import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { MembershipConflict, MembershipDenied, MembershipStale,
  MembershipUnavailable, type MembershipKind } from './memberships.ts';

const SCOPE = 'work:create:root';
const agent = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const epoch = /^(0|[1-9][0-9]*)$/;

export interface MembershipConsentRequest {
  principal: VerifiedPrincipal;
  kind: MembershipKind;
  ownerSubject: string;
  memberSubject: string;
  expectedGeneration: string;
  expectedPolicyRevision: string;
  termsRevision: string;
  idempotencyKey: string;
  requestDigest: string;
}
export interface MembershipConsentResult {
  consentReference: string;
  nextGeneration: string;
  expiresAt: string;
  replayed: boolean;
}
type PrincipalRow = { id: string; enforcement_epoch: string };
type ConsentRow = { id: string; next_generation: string; expires_at: Date };

/** Recipient consent and revocation use the same Access gate as manager join. */
export class AccessMembershipConsents {
  constructor(private readonly pool: Pool) {}

  private normalize(error: unknown): Error {
    if (error && typeof error === 'object' && 'code' in error) {
      if (String(error.code) === '23505') return new MembershipConflict('consent key conflicts');
      if (['40001', '40P01', '55P03', '57014'].includes(String(error.code))) {
        return new MembershipUnavailable('consent owner timed out or conflicted');
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async begin(client: PoolClient): Promise<void> {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const recovery = await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE');
    if (!recovery.rows[0]?.open) throw new MembershipUnavailable('Access recovery held');
    const gate = await client.query<{ open: boolean; dispatch_open: boolean }>(
      'SELECT open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [SCOPE]);
    if (!gate.rows[0]?.open || !gate.rows[0].dispatch_open) {
      throw new MembershipDenied('consent scope closed');
    }
  }

  private async principal(client: PoolClient, asserted: VerifiedPrincipal): Promise<PrincipalRow> {
    const result = await client.query<PrincipalRow>(`SELECT id, enforcement_epoch
      FROM access.principal WHERE account_issuer = $1 AND account_subject = $2
        AND active FOR SHARE`, [asserted.issuer, asserted.subject]);
    if (!result.rows[0]) throw new MembershipDenied('recipient principal unavailable');
    return result.rows[0];
  }

  async issue(input: MembershipConsentRequest): Promise<MembershipConsentResult> {
    if (!agent.test(input.ownerSubject) || !agent.test(input.memberSubject)
      || !epoch.test(input.expectedGeneration) || !epoch.test(input.expectedPolicyRevision)
      || !input.termsRevision || input.termsRevision.length > 128
      || !input.idempotencyKey || input.idempotencyKey.length > 128
      || input.idempotencyKey.includes('\0') || !/^[0-9a-f]{64}$/.test(input.requestDigest)) {
      throw new MembershipDenied('invalid consent request');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const principal = await this.principal(client, input.principal);
      const prior = await client.query<{ request_digest: string; consent_id: string }>(`
        SELECT request_digest, consent_id FROM access.membership_consent_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`,
      [principal.id, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_digest !== input.requestDigest) {
          throw new MembershipConflict('consent key binds another intent');
        }
        const saved = await client.query<ConsentRow>(`SELECT id, next_generation, expires_at
          FROM access.membership_consent WHERE id = $1`, [prior.rows[0].consent_id]);
        if (!saved.rows[0]) throw new MembershipUnavailable('consent receipt history missing');
        await client.query('COMMIT');
        return { consentReference: saved.rows[0].id,
          nextGeneration: saved.rows[0].next_generation,
          expiresAt: saved.rows[0].expires_at.toISOString(), replayed: true };
      }
      const policy = await client.query<{ revision: string; terms_revision: string; open: boolean }>(`
        SELECT revision, terms_revision, open FROM access.membership_policy
        WHERE kind = $1 AND owner_subject = $2 FOR SHARE`, [input.kind, input.ownerSubject]);
      if (!policy.rows[0]?.open || policy.rows[0].terms_revision !== input.termsRevision) {
        throw new MembershipDenied('admission policy or terms unavailable');
      }
      if (policy.rows[0].revision !== input.expectedPolicyRevision) {
        throw new MembershipStale('admission policy revision changed');
      }
      const state = await client.query<{ generation: string; state: string }>(`
        SELECT generation, state FROM access.membership
        WHERE kind = $1 AND owner_subject = $2 AND member_subject = $3 FOR SHARE`,
      [input.kind, input.ownerSubject, input.memberSubject]);
      if ((state.rows[0]?.generation ?? '0') !== input.expectedGeneration) {
        throw new MembershipStale('admission generation changed');
      }
      if (state.rows[0]?.state === 'joined') throw new MembershipDenied('already joined');
      const ban = await client.query(`SELECT 1 FROM access.membership_ban
        WHERE kind = $1 AND owner_subject = $2 AND member_subject = $3 AND active FOR SHARE`,
      [input.kind, input.ownerSubject, input.memberSubject]);
      if (ban.rows[0]) throw new MembershipDenied('member is banned');
      const mandate = await client.query<{ member_generation: string;
        representation_id: string; representation_generation: string;
        grant_id: string; grant_generation: string; expires_at: Date }>(`
        SELECT s.generation AS member_generation, r.id AS representation_id,
          r.generation AS representation_generation, g.id AS grant_id,
          g.generation AS grant_generation,
          LEAST(clock_timestamp() + interval '5 minutes', r.valid_until, g.valid_until) AS expires_at
        FROM access.authority_subject s
        JOIN LATERAL (SELECT id, generation, valid_until
          FROM access.representation
          WHERE subject_id = s.id AND principal_id = $1
            AND action = 'access.membership.consent'
            AND active AND valid_until > clock_timestamp()
          LIMIT 1 FOR SHARE) r ON true
        JOIN LATERAL (SELECT id, generation, valid_until
          FROM access.permission_grant
          WHERE recipient_subject = s.id AND scope_id = $2
            AND action = 'access.membership.consent' AND membership_id IS NULL
            AND active AND valid_until > clock_timestamp()
          LIMIT 1 FOR SHARE) g ON true
        WHERE s.id = $3 AND s.kind = 'agent' AND s.active
        FOR SHARE OF s`,
      [principal.id, SCOPE, input.memberSubject]);
      if (!mandate.rows[0]) throw new MembershipDenied('recipient mandate missing');
      const consentReference = randomUUID();
      const nextGeneration = (BigInt(input.expectedGeneration) + 1n).toString();
      await client.query(`INSERT INTO access.membership_consent
        (id, principal_id, principal_epoch, kind, owner_subject, member_subject,
          member_generation, policy_revision, terms_revision, next_generation,
          representation_id, representation_generation, grant_id, grant_generation, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [consentReference, principal.id, principal.enforcement_epoch, input.kind,
        input.ownerSubject, input.memberSubject, mandate.rows[0].member_generation,
        input.expectedPolicyRevision, input.termsRevision, nextGeneration,
        mandate.rows[0].representation_id, mandate.rows[0].representation_generation,
        mandate.rows[0].grant_id, mandate.rows[0].grant_generation,
        mandate.rows[0].expires_at]);
      await client.query(`INSERT INTO access.membership_consent_receipt
        (principal_id, idempotency_key, request_digest, consent_id) VALUES ($1,$2,$3,$4)`,
      [principal.id, input.idempotencyKey, input.requestDigest, consentReference]);
      await client.query('COMMIT');
      return { consentReference, nextGeneration,
        expiresAt: mandate.rows[0].expires_at.toISOString(), replayed: false };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }

  async revoke(asserted: VerifiedPrincipal, consentReference: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(consentReference)) {
      throw new MembershipDenied('invalid consent reference');
    }
    const client = await this.pool.connect();
    try {
      await this.begin(client);
      const principal = await this.principal(client, asserted);
      const result = await client.query(`SELECT id FROM access.membership_consent
        WHERE id = $1 AND principal_id = $2 FOR SHARE`, [consentReference, principal.id]);
      if (!result.rows[0]) throw new MembershipDenied('consent unavailable to recipient');
      await client.query(`INSERT INTO access.membership_consent_revocation (consent_id, principal_id)
        VALUES ($1,$2) ON CONFLICT (consent_id) DO NOTHING`, [consentReference, principal.id]);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
      throw this.normalize(error);
    } finally { client.release(); }
  }
}
