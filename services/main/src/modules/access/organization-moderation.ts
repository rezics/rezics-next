import type { Pool, PoolClient } from 'pg';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable,
  type GraphTerminalProof, type RegisteredAdmission, type VerifiedPrincipal } from './admission.ts';
import { beginOrgRealm, normalizeOrgRealmError, OrgRealmStale, OrgRealmDenied,
  OrgRealmConflict, OrgRealmUnavailable } from './org-realm-authority.ts';
import { canonicalOrganizationPublication, moderationProofDigest, ORGANIZATION_MODERATION_ACTION,
  organizationPublicationScope, type OrganizationPublicationTarget } from './organization-publication.ts';

export interface OrganizationModerationProof {
  principalId: string;
  principalEpoch: string;
  managerGeneration: string;
  organizationGeneration: string;
  organizationAdmissionGeneration: string;
  grantId: string;
  grantGeneration: string;
  validUntil: string;
  publisher: GraphTerminalProof;
}
export interface OrganizationModerationAdmission extends RegisteredAdmission {
  moderationProofDigest: string;
}
interface AdmissionRow {
  id: string; principal_id: string; acting_subject: string; scope_id: string;
  action: string; idempotency_key: string; request_digest: string;
  authority_epoch: string; registered_at: Date; expires_at: Date;
  state: RegisteredAdmission['state']; eligible: boolean;
}
interface SavedProof { target: OrganizationPublicationTarget;
  authority_proof: OrganizationModerationProof; proof_digest: string }

function result(row: AdmissionRow, digest: string, eligible: boolean, replayed: boolean): OrganizationModerationAdmission {
  return { id: row.id, principalId: row.principal_id, actingSubject: row.acting_subject,
    scope: row.scope_id, action: row.action, idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest, authorityEpoch: row.authority_epoch,
    registeredAt: row.registered_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    state: row.state, dispatchEligible: eligible, replayed, moderationProofDigest: digest };
}

/** One transaction both decides authority and creates a finite dispatchable admission.
 * There is no generic register/claim interval in which a leave can replace the episode. */
export class AccessOrganizationModeration {
  constructor(private readonly pool: Pool) {}

  async admit(principal: VerifiedPrincipal, raw: OrganizationPublicationTarget,
    publisher: GraphTerminalProof, key: string, requestDigest: string): Promise<OrganizationModerationAdmission> {
    const target = canonicalOrganizationPublication(raw);
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key) || !/^[0-9a-f]{64}$/.test(requestDigest)) {
      throw new AdmissionDenied('invalid organization moderation intent');
    }
    const scope = organizationPublicationScope(target.realm);
    const client = await this.pool.connect().catch(() => {
      throw new AdmissionUnavailable('organization moderation owner is unavailable');
    });
    try {
      // Same first lock as G-012 transitions, then the exact Realm action gate.
      await beginOrgRealm(client, true);
      const gate = (await client.query<{ authority_epoch: string; open: boolean; dispatch_open: boolean }>(
        'SELECT authority_epoch, open, dispatch_open FROM access.scope_gate WHERE id = $1 FOR UPDATE', [scope])).rows[0];
      if (!gate?.open || !gate.dispatch_open) throw new AdmissionDenied('Realm action gate is closed');
      const identity = (await client.query<{ id: string; enforcement_epoch: string }>(`
        SELECT id, enforcement_epoch FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
      [principal.issuer, principal.subject])).rows[0];
      if (!identity) throw new AdmissionDenied('moderator principal is inactive');
      const existing = (await client.query<AdmissionRow>(`SELECT *,
        expires_at > clock_timestamp() AS eligible FROM access.admission
        WHERE principal_id = $1 AND action = $2 AND idempotency_key = $3 FOR UPDATE`,
      [identity.id, ORGANIZATION_MODERATION_ACTION, key])).rows[0];
      if (existing && (existing.request_digest !== requestDigest || existing.scope_id !== scope
        || existing.acting_subject !== target.actingSubject)) {
        throw new AdmissionConflict('organization moderation key binds another intent');
      }
      const manager = await this.manager(client, identity.id, target, scope);
      const saved = existing ? (await client.query<SavedProof>(`
        SELECT target, authority_proof, proof_digest FROM access.organization_publication_moderation
        WHERE admission_id = $1`, [existing.id])).rows[0] : undefined;
      if (existing && (!saved || moderationProofDigest(saved.target) !== moderationProofDigest(target)
        || moderationProofDigest(saved.authority_proof) !== saved.proof_digest)) {
        throw new AdmissionUnavailable('moderation proof is missing or differs');
      }
      // A currently authorized exact retry may read an old receipt after leave.
      // Dispatch still requires the original episode and saved manager branch.
      const episode = await this.episode(client, target);
      const savedGrant = existing && saved ? (await client.query(`SELECT id
        FROM access.permission_grant WHERE id = $1 AND generation = $2
          AND recipient_subject = $3 AND scope_id = $4 AND action = $5
          AND active AND membership_id IS NULL AND valid_until >= $6
          AND valid_until > clock_timestamp() FOR SHARE`, [saved.authority_proof.grantId,
        saved.authority_proof.grantGeneration, target.actingSubject, scope,
        ORGANIZATION_MODERATION_ACTION, existing.expires_at])).rows[0] : undefined;
      const selected = !existing || !!saved && saved.authority_proof.principalEpoch === identity.enforcement_epoch
        && saved.authority_proof.managerGeneration === manager.subject_generation
        && !!savedGrant
        && saved.authority_proof.organizationGeneration === episode?.generation
        && saved.authority_proof.organizationAdmissionGeneration === episode?.admission_generation;
      if (existing && saved) {
        const eligible = existing.state === 'claimed' && existing.eligible && !!episode && selected
          && existing.authority_epoch === gate.authority_epoch
          && manager.representation_until.getTime() >= existing.expires_at.getTime()
          && await this.live(client, existing.expires_at);
        await client.query('COMMIT');
        return result(existing, saved.proof_digest, eligible, true);
      }
      if (!episode) throw new OrgRealmStale('joined organization episode or Realm policy changed');
      await assertOrganizationPublisher(client, target, publisher);
      const proof: OrganizationModerationProof = { principalId: identity.id,
        principalEpoch: identity.enforcement_epoch, managerGeneration: manager.subject_generation,
        organizationGeneration: episode.generation,
        organizationAdmissionGeneration: episode.admission_generation,
        grantId: manager.grant_id, grantGeneration: manager.grant_generation,
        validUntil: manager.valid_until.toISOString(), publisher };
      // All authority rows are held. Re-evaluate the real clock after every lock wait.
      const inserted = (await client.query<AdmissionRow>(`INSERT INTO access.admission
        (id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
          authority_epoch, registered_at, expires_at, state, claimed_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp(),
          LEAST(clock_timestamp() + interval '30 seconds', $9::timestamptz), 'claimed', clock_timestamp()
        WHERE $9::timestamptz > clock_timestamp()
        RETURNING *, true AS eligible`, [Bun.randomUUIDv7(), identity.id, target.actingSubject,
        scope, ORGANIZATION_MODERATION_ACTION, key, requestDigest, gate.authority_epoch,
        manager.valid_until])).rows[0];
      if (!inserted) throw new AdmissionDenied('manager authority expired during admission');
      const proofDigest = moderationProofDigest(proof);
      await client.query(`INSERT INTO access.organization_publication_moderation
        (admission_id, realm, organization_subject, participation_id, participation_generation,
          proposal_id, publisher_admission_id, target, authority_proof, proof_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [inserted.id, target.realm,
        target.organizationSubject, target.participationId, target.participationGeneration,
        target.proposalId, publisher.admissionId, target, proof, proofDigest]);
      await client.query(`INSERT INTO access.admission_receipt
        (admission_id, principal_id, action, idempotency_key, request_digest, outcome)
        VALUES ($1,$2,$3,$4,$5,'registered')`,
      [inserted.id, identity.id, ORGANIZATION_MODERATION_ACTION, key, requestDigest]);
      await client.query(`INSERT INTO access.outbox (id, kind, admission_id, scope_id, authority_epoch)
        VALUES ($1,'admission.registered',$3,$4,$5),($2,'admission.claimed',$3,$4,$5)`,
      [Bun.randomUUIDv7(), Bun.randomUUIDv7(), inserted.id, scope, gate.authority_epoch]);
      if (!await this.live(client, inserted.expires_at)) {
        throw new AdmissionDenied('manager authority expired before commit');
      }
      await client.query('COMMIT');
      return result(inserted, proofDigest, true, false);
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the cause */ }
      const normalized = normalizeOrgRealmError(error);
      if (normalized instanceof AdmissionDenied || normalized instanceof AdmissionConflict
        || normalized instanceof AdmissionUnavailable || normalized instanceof OrgRealmStale
        || normalized instanceof OrgRealmDenied || normalized instanceof OrgRealmConflict
        || normalized instanceof OrgRealmUnavailable) throw normalized;
      throw new AdmissionUnavailable('organization moderation owner is unavailable');
    } finally { client.release(); }
  }

  private async live(client: PoolClient, until: Date): Promise<boolean> {
    return (await client.query<{ live: boolean }>(
      'SELECT $1::timestamptz > clock_timestamp() AS live', [until])).rows[0]?.live === true;
  }

  private async manager(client: PoolClient, principalId: string,
    target: OrganizationPublicationTarget, scope: string) {
    const policy = (await client.query<{ manager_subject: string; revision: string }>(`
      SELECT manager_subject, revision FROM access.org_realm_policy WHERE realm = $1 FOR SHARE`,
    [target.realm])).rows[0];
    if (!policy || policy.manager_subject !== target.actingSubject
      || target.actingSubject === target.organizationSubject) {
      throw new AdmissionDenied('registered Realm manager required');
    }
    const manager = (await client.query<{ subject_generation: string; grant_id: string;
      grant_generation: string; valid_until: Date; representation_until: Date }>(`SELECT s.generation AS subject_generation,
      g.id AS grant_id, g.generation AS grant_generation, r.valid_until AS representation_until,
      LEAST(r.valid_until,g.valid_until) AS valid_until
      FROM access.authority_subject s
      JOIN access.representation r ON r.id = $2 AND r.principal_id = $3
        AND r.subject_id = s.id AND r.generation = $4 AND r.action = $5
        AND r.active AND r.valid_until > clock_timestamp()
      JOIN LATERAL (SELECT id, generation, valid_until FROM access.permission_grant
        WHERE recipient_subject = s.id AND scope_id = $6 AND action = $5
          AND active AND membership_id IS NULL AND valid_until > statement_timestamp()
          AND valid_until > clock_timestamp() ORDER BY valid_until, id LIMIT 1 FOR SHARE) g ON true
      WHERE s.id = $1 AND s.kind = 'agent' AND s.active FOR SHARE OF s, r`,
    [target.actingSubject, target.representationId, principalId, target.representationGeneration,
      ORGANIZATION_MODERATION_ACTION, scope])).rows[0];
    if (!manager) throw new AdmissionDenied('exact manager representation and Realm permission required');
    return manager;
  }

  private async episode(client: PoolClient, target: OrganizationPublicationTarget) {
    const episode = (await client.query<{ generation: string; admission_generation: string }>(`
      SELECT s.generation, o.generation AS admission_generation
      FROM access.org_realm_participation p
      JOIN access.org_realm_policy policy ON policy.realm = p.realm AND policy.revision = $6
      JOIN access.org_participation_subject o ON o.subject = p.organization_subject AND o.active
      JOIN access.authority_subject s ON s.id = o.subject AND s.active AND s.kind = 'agent'
      JOIN access.org_realm_proposal proposal ON proposal.id = p.proposal_id
        AND proposal.realm = p.realm AND proposal.organization_subject = p.organization_subject
        AND proposal.next_generation = p.generation AND proposal.organization_generation = s.generation
        AND proposal.organization_admission_generation = o.generation
      JOIN access.org_realm_history h ON h.participation_id = p.id AND h.generation = p.generation
        AND h.action = 'join' AND h.state = 'joined' AND NOT h.ban_active
        AND h.proposal_id = p.proposal_id
      JOIN access.org_realm_proposal_use u ON u.proposal_id = p.proposal_id
        AND u.participation_id = p.id AND u.generation = p.generation
      WHERE p.id = $1 AND p.realm = $2 AND p.organization_subject = $3
        AND p.generation = $4 AND p.state = 'joined' AND p.proposal_id = $5
        AND p.policy_revision = policy.revision AND p.terms_revision = policy.terms_revision
      FOR SHARE OF p, policy, o, s`, [target.participationId, target.realm, target.organizationSubject,
      target.participationGeneration, target.proposalId, target.policyRevision])).rows[0];
    const ban = (await client.query<{ active: boolean }>(`SELECT active FROM access.org_realm_ban
      WHERE realm = $1 AND organization_subject = $2 FOR SHARE`,
    [target.realm, target.organizationSubject])).rows[0];
    return ban?.active ? undefined : episode;
  }
}

/** The organization is the admitted native publisher, not descriptive author text. */
export async function assertOrganizationPublisher(client: PoolClient,
  target: OrganizationPublicationTarget, publisher: GraphTerminalProof): Promise<void> {
  const row = (await client.query(`SELECT id FROM access.admission
    WHERE id = $1 AND action = 'contribution.publish' AND state = 'sealed'
      AND acting_subject = $2 AND scope_id = $3 AND request_digest = $4 AND authority_epoch = $5
      AND graph_receipt = $6 AND graph_outcome = 'succeeded' AND graph_data_epoch = $7 AND graph_sequence = $8
    FOR SHARE`, [publisher.admissionId, target.organizationSubject,
    `contribution:publish:${target.contribution}`, publisher.requestDigest, publisher.authorityEpoch,
    publisher.receipt, publisher.dataEpoch, publisher.sequence])).rows[0];
  if (!row || publisher.outcome !== 'succeeded'
    || publisher.scope !== `contribution:publish:${target.contribution}`) {
    throw new AdmissionDenied('organization publisher admission is unavailable');
  }
}

/** Recovery verifies immutable saved decisions; current leave/revocation cannot rewrite history. */
export async function assertRetainedOrganizationModeration(client: PoolClient, admissionId: string,
  target: OrganizationPublicationTarget, proofDigest: string): Promise<void> {
  const saved = (await client.query<SavedProof>(`SELECT target, authority_proof, proof_digest
    FROM access.organization_publication_moderation WHERE admission_id = $1`, [admissionId])).rows[0];
  if (!saved || saved.proof_digest !== proofDigest
    || moderationProofDigest(saved.authority_proof) !== proofDigest
    || moderationProofDigest(saved.target) !== moderationProofDigest(canonicalOrganizationPublication(target))) {
    throw new AdmissionUnavailable('retained organization moderation proof differs');
  }
  await assertOrganizationPublisher(client, target, saved.authority_proof.publisher);
}
