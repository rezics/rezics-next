import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { beginOrgRealm, normalizeOrgRealmError, orgRealmAuthority,
  recheckOrgRealmAuthority, ORG_REALM_ACTION, ORG_REALM_SCOPE, OrgRealmConflict,
  OrgRealmDenied, OrgRealmStale, type OrgRealmProof,
  validOrgRealmGeneration, validOrgRealmId } from './org-realm-authority.ts';

interface Tuple { realm: string; organizationSubject: string }
interface Basis extends Tuple {
  expectedGeneration: string;
  expectedPolicyRevision: string;
}
export interface OrgRealmProposalInput extends Basis { termsRevision: string }
export type OrgRealmChangeInput = Basis & (
  { action: 'join'; proposalId: string; termsRevision: string }
  | { action: 'leave' }
  | { action: 'suspend' | 'lift-ban'; reasonReference: string }
);
export interface OrgRealmProposalResult extends Tuple {
  proposalId: string;
  nextGeneration: string;
  policyRevision: string;
  termsRevision: string;
  expiresAt: string;
  replayed: boolean;
}
type State = 'joined' | 'left' | 'suspended';
export interface OrgRealmResult extends Tuple {
  participationId: string | null;
  mode: 'independent';
  state: State | 'absent';
  generation: string;
  policyRevision: string;
  termsRevision: string;
  admissionOpen: boolean;
  banned: boolean;
  banGeneration: string;
  proposalId: string | null;
}
export interface OrgRealmChangeResult extends OrgRealmResult {
  action: OrgRealmChangeInput['action']; authorityEpoch: string; replayed: boolean;
}
type Policy = { manager_subject: string; revision: string; terms_revision: string; open: boolean };
type Organization = { generation: string; admission_generation: string; active: boolean };
type Participation = { id: string; state: State; generation: string; proposal_id: string | null };
type Ban = { active: boolean; generation: string };
type Proposal = { realm: string; organization_subject: string; next_generation: string;
  policy_revision: string; terms_revision: string; organization_generation: string;
  organization_admission_generation: string; authority_epoch: string;
  realm_proof: OrgRealmProof; live: boolean };

/** Separate Org/Realm episode. No participation operation creates authority. */
export class AccessOrgRealmParticipation {
  constructor(private readonly pool: Pool) {}

  private validate(input: Basis, key: string): void {
    if (!validOrgRealmId(input.realm) || !validOrgRealmId(input.organizationSubject)
      || !validOrgRealmGeneration(input.expectedGeneration)
      || !validOrgRealmGeneration(input.expectedPolicyRevision)
      || !key || key.length > 128 || key.includes('\0')) {
      throw new OrgRealmDenied('invalid Org/Realm intent');
    }
  }

  private async transaction<T>(body: (client: PoolClient, epoch: string) => Promise<T>, write = true): Promise<T> {
    const client = await this.pool.connect();
    try {
      const epoch = await beginOrgRealm(client, write);
      const result = await body(client, epoch);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve cause */ }
      throw normalizeOrgRealmError(error);
    } finally { client.release(); }
  }

  private async policy(client: PoolClient, input: Tuple): Promise<Policy> {
    const result = await client.query<Policy>(`SELECT manager_subject, revision, terms_revision, open
      FROM access.org_realm_policy WHERE realm = $1 FOR SHARE`, [input.realm]);
    if (!result.rows[0] || result.rows[0].manager_subject === input.organizationSubject) {
      throw new OrgRealmDenied('distinct registered Realm authority required');
    }
    return result.rows[0];
  }

  private async organization(client: PoolClient, input: Tuple, requireActive: boolean): Promise<Organization> {
    const result = await client.query<Organization>(`SELECT s.generation,
      o.generation AS admission_generation, (o.active AND s.active) AS active
      FROM access.org_participation_subject o JOIN access.authority_subject s ON s.id = o.subject
      WHERE o.subject = $1 AND s.kind = 'agent' FOR SHARE OF o, s`, [input.organizationSubject]);
    if (!result.rows[0] || requireActive && !result.rows[0].active) {
      throw new OrgRealmDenied('admitted organization unavailable');
    }
    return result.rows[0];
  }

  private async state(client: PoolClient, input: Tuple): Promise<{ tuple?: Participation; ban?: Ban }> {
    const tuple = await client.query<Participation>(`SELECT id, state, generation, proposal_id
      FROM access.org_realm_participation WHERE realm = $1 AND organization_subject = $2 FOR SHARE`,
    [input.realm, input.organizationSubject]);
    const ban = await client.query<Ban>(`SELECT active, generation FROM access.org_realm_ban
      WHERE realm = $1 AND organization_subject = $2 FOR SHARE`, [input.realm, input.organizationSubject]);
    return { tuple: tuple.rows[0], ban: ban.rows[0] };
  }

  private checkBasis(input: Basis, policy: Policy, tuple?: Participation): void {
    if (policy.revision !== input.expectedPolicyRevision
      || (tuple?.generation ?? '0') !== input.expectedGeneration) {
      throw new OrgRealmStale('Org/Realm policy or tuple changed');
    }
  }

  private digest(operation: string, input: OrgRealmProposalInput | OrgRealmChangeInput): string {
    // Explicit field order; omitted values never borrow caller object ordering.
    return createHash('sha256').update(JSON.stringify([operation, input.realm,
      input.organizationSubject, input.expectedGeneration, input.expectedPolicyRevision,
      'termsRevision' in input ? input.termsRevision : null,
      'proposalId' in input ? input.proposalId : null,
      'reasonReference' in input ? input.reasonReference : null])).digest('hex');
  }

  private async replay<T>(client: PoolClient, principalId: string, key: string,
    operation: string, digest: string): Promise<T | undefined> {
    const result = await client.query<{ request_digest: string; operation: string; result: T }>(`
      SELECT request_digest, operation, result FROM access.org_realm_receipt
      WHERE principal_id = $1 AND idempotency_key = $2`, [principalId, key]);
    if (!result.rows[0]) return undefined;
    if (result.rows[0].operation !== operation || result.rows[0].request_digest !== digest) {
      throw new OrgRealmConflict('Org/Realm key binds another intent');
    }
    return { ...result.rows[0].result, replayed: true };
  }

  private async receipt(client: PoolClient, proof: OrgRealmProof, key: string,
    operation: string, digest: string, result: OrgRealmProposalResult | OrgRealmChangeResult): Promise<void> {
    await client.query(`INSERT INTO access.org_realm_receipt
      (principal_id, idempotency_key, request_digest, operation, result) VALUES ($1,$2,$3,$4,$5)`,
    [proof.principalId, key, digest, operation, result]);
  }

  async propose(principal: VerifiedPrincipal, input: OrgRealmProposalInput,
    key: string): Promise<OrgRealmProposalResult> {
    this.validate(input, key);
    if (!input.termsRevision || input.termsRevision.length > 128) throw new OrgRealmDenied('invalid terms');
    return this.transaction(async (client, epoch) => {
      const policy = await this.policy(client, input);
      const proof = await orgRealmAuthority(client, principal, policy.manager_subject, ORG_REALM_ACTION.admit);
      const digest = this.digest('propose', input);
      // Shared gate permits unrelated invitations. Serialize only this private receipt key;
      // a hash collision can delay a request but cannot authorize or conflate its intent.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['org-realm-receipt', proof.principalId, key])]);
      const replay = await this.replay<OrgRealmProposalResult>(client, proof.principalId, key, 'propose', digest);
      if (replay) return replay;
      await recheckOrgRealmAuthority(client, proof);
      const org = await this.organization(client, input, true);
      const { tuple, ban } = await this.state(client, input);
      this.checkBasis(input, policy, tuple);
      if (!policy.open || policy.terms_revision !== input.termsRevision
        || tuple?.state === 'joined' || ban?.active) throw new OrgRealmDenied('Org/Realm admission closed');
      const proposalId = randomUUID();
      const nextGeneration = (BigInt(input.expectedGeneration) + 1n).toString();
      const inserted = await client.query<{ expires_at: Date }>(`INSERT INTO access.org_realm_proposal
        (id, realm, organization_subject, next_generation, policy_revision, terms_revision,
          organization_generation, organization_admission_generation, principal_id, authority_epoch,
          realm_proof, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
          LEAST(clock_timestamp() + interval '5 minutes', $12::timestamptz)) RETURNING expires_at`,
      [proposalId, input.realm, input.organizationSubject, nextGeneration, policy.revision,
        policy.terms_revision, org.generation, org.admission_generation, proof.principalId, epoch,
        proof, proof.validUntil]);
      const result: OrgRealmProposalResult = { proposalId, realm: input.realm,
        organizationSubject: input.organizationSubject, nextGeneration,
        policyRevision: policy.revision, termsRevision: policy.terms_revision,
        expiresAt: inserted.rows[0]!.expires_at.toISOString(), replayed: false };
      await this.receipt(client, proof, key, 'propose', digest, result);
      return result;
    }, false);
  }

  async change(principal: VerifiedPrincipal, input: OrgRealmChangeInput,
    key: string): Promise<OrgRealmChangeResult> {
    this.validate(input, key);
    if (!['join', 'leave', 'suspend', 'lift-ban'].includes(input.action)
      || input.action === 'join' && (!/^[0-9a-f-]{36}$/.test(input.proposalId)
        || !input.termsRevision || input.termsRevision.length > 128)
      || (input.action === 'suspend' || input.action === 'lift-ban')
        && (!input.reasonReference || input.reasonReference.length > 128)) {
      throw new OrgRealmDenied('invalid Org/Realm change');
    }
    return this.transaction(async (client, epoch) => {
      const policy = await this.policy(client, input);
      const organizationAction = input.action === 'join' || input.action === 'leave';
      const proof = await orgRealmAuthority(client, principal,
        organizationAction ? input.organizationSubject : policy.manager_subject,
        organizationAction ? ORG_REALM_ACTION.participate : ORG_REALM_ACTION.suspend);
      const digest = this.digest(input.action, input);
      const replay = await this.replay<OrgRealmChangeResult>(client, proof.principalId,
        key, input.action, digest);
      if (replay) return replay;
      const org = await this.organization(client, input, input.action === 'join');
      const { tuple, ban } = await this.state(client, input);
      this.checkBasis(input, policy, tuple);
      if (input.action === 'join' && (tuple?.state === 'joined' || ban?.active || !policy.open)
        || input.action === 'leave' && (!tuple || tuple.state === 'left')
        || input.action === 'suspend' && tuple?.state !== 'joined'
        || input.action === 'lift-ban' && (!tuple || !ban?.active)) {
        throw new OrgRealmDenied('Org/Realm transition unavailable');
      }
      const generation = (BigInt(input.expectedGeneration) + 1n).toString();
      if (input.action === 'join') {
        const proposal = await client.query<Proposal>(`SELECT realm, organization_subject,
          next_generation, policy_revision, terms_revision, organization_generation,
          organization_admission_generation, authority_epoch, realm_proof,
          expires_at > clock_timestamp() AS live FROM access.org_realm_proposal WHERE id = $1 FOR SHARE`,
        [input.proposalId]);
        const saved = proposal.rows[0];
        if (!saved || !saved.live || saved.realm !== input.realm
          || saved.organization_subject !== input.organizationSubject
          || saved.realm_proof.principalId === proof.principalId
          || saved.realm_proof.subject === proof.subject) throw new OrgRealmDenied('two-party proposal required');
        if (saved.next_generation !== generation || saved.policy_revision !== policy.revision
          || saved.terms_revision !== input.termsRevision || policy.terms_revision !== input.termsRevision
          || saved.authority_epoch !== epoch || saved.organization_generation !== org.generation
          || saved.organization_admission_generation !== org.admission_generation
          || saved.realm_proof.subject !== policy.manager_subject) {
          throw new OrgRealmStale('Org/Realm proposal basis changed');
        }
        const used = await client.query('SELECT 1 FROM access.org_realm_proposal_use WHERE proposal_id = $1',
          [input.proposalId]);
        if (used.rows[0]) throw new OrgRealmDenied('Org/Realm proposal already consumed');
        await recheckOrgRealmAuthority(client, saved.realm_proof);
        const stillLive = await client.query(`SELECT 1 FROM access.org_realm_proposal
          WHERE id = $1 AND expires_at > clock_timestamp()`, [input.proposalId]);
        if (!stillLive.rows[0]) throw new OrgRealmDenied('proposal expired during authority validation');
      }
      // The other side's locks can wait: validate the accepting mandate again
      // after both branches are locked, before committing any participation effect.
      await recheckOrgRealmAuthority(client, proof);
      const participationId = tuple?.id ?? randomUUID();
      const state: State = input.action === 'join' ? 'joined' : input.action === 'leave'
        ? 'left' : input.action === 'suspend' ? 'suspended' : tuple!.state;
      const proposalId = input.action === 'join' ? input.proposalId : tuple?.proposal_id ?? null;
      let banned = ban?.active ?? false;
      let banGeneration = ban?.generation ?? '0';
      if (input.action === 'suspend' || input.action === 'lift-ban') {
        banned = input.action === 'suspend';
        banGeneration = (BigInt(banGeneration) + 1n).toString();
        const values = [input.realm, input.organizationSubject, banned, banGeneration, input.reasonReference];
        if (ban) {
          await client.query(`UPDATE access.org_realm_ban SET active = $3,
            generation = $4, reason_reference = $5 WHERE realm = $1 AND organization_subject = $2`, values);
        } else {
          await client.query(`INSERT INTO access.org_realm_ban
            (realm, organization_subject, active, generation, reason_reference) VALUES ($1,$2,$3,$4,$5)`, values);
        }
      }
      if (tuple) {
        await client.query(`UPDATE access.org_realm_participation SET generation = $2,
          state = $3, policy_revision = $4, terms_revision = $5, proposal_id = $6 WHERE id = $1`,
        [participationId, generation, state, policy.revision, policy.terms_revision, proposalId]);
      } else {
        await client.query(`INSERT INTO access.org_realm_participation
          (id, realm, organization_subject, generation, state, policy_revision, terms_revision, proposal_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [participationId, input.realm, input.organizationSubject,
          generation, state, policy.revision, policy.terms_revision, proposalId]);
      }
      const changed = await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
        SET authority_epoch = authority_epoch + 1 WHERE id = $1 RETURNING authority_epoch`, [ORG_REALM_SCOPE]);
      const authorityEpoch = changed.rows[0]!.authority_epoch;
      await client.query(`INSERT INTO access.org_realm_history
        (participation_id, generation, action, state, policy_revision, terms_revision,
          proposal_id, ban_active, ban_generation, actor_proof, authority_epoch, reason_reference)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [participationId, generation,
        input.action, state, policy.revision, policy.terms_revision, proposalId, banned,
        banGeneration, proof, authorityEpoch, 'reasonReference' in input ? input.reasonReference : null]);
      if (input.action === 'join') {
        await client.query(`INSERT INTO access.org_realm_proposal_use
          (proposal_id, participation_id, generation) VALUES ($1,$2,$3)`,
        [input.proposalId, participationId, generation]);
      }
      const result: OrgRealmChangeResult = { participationId, realm: input.realm,
        organizationSubject: input.organizationSubject, mode: 'independent', action: input.action,
        state, generation, policyRevision: policy.revision, termsRevision: policy.terms_revision,
        admissionOpen: policy.open, banned, banGeneration, proposalId, authorityEpoch, replayed: false };
      await this.receipt(client, proof, key, input.action, digest, result);
      return result;
    });
  }

  async read(principal: VerifiedPrincipal, input: Tuple & { side: 'organization' | 'realm' }): Promise<OrgRealmResult> {
    if (!validOrgRealmId(input.realm) || !validOrgRealmId(input.organizationSubject)
      || !['organization', 'realm'].includes(input.side)) throw new OrgRealmDenied('invalid Org/Realm selection');
    return this.transaction(async client => {
      const policy = await this.policy(client, input);
      await orgRealmAuthority(client, principal,
        input.side === 'organization' ? input.organizationSubject : policy.manager_subject,
        input.side === 'organization' ? ORG_REALM_ACTION.participate : ORG_REALM_ACTION.admit);
      await this.organization(client, input, false);
      const { tuple, ban } = await this.state(client, input);
      return { participationId: tuple?.id ?? null, realm: input.realm,
        organizationSubject: input.organizationSubject, mode: 'independent',
        state: tuple?.state ?? 'absent', generation: tuple?.generation ?? '0',
        policyRevision: policy.revision, termsRevision: policy.terms_revision, admissionOpen: policy.open,
        banned: ban?.active ?? false, banGeneration: ban?.generation ?? '0', proposalId: tuple?.proposal_id ?? null };
    }, false);
  }
}
