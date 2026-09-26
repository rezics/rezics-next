import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from './admission.ts';
import { ORG_REALM_SCOPE, validOrgRealmGeneration, validOrgRealmId } from './org-realm-authority.ts';
import { managedTransaction, managedOrganization, managedRecipient, managedRepresentation,
  managedIssuer, recheckManagedIssuer, recheckManagedRepresentation, managedLive,
  MANAGED_ORG_ACTION, ManagedOrgDenied, ManagedOrgConflict, ManagedOrgStale,
  type ManagedRecipient, type ManagedIssuerProof, type ManagedRepresentation } from './managed-org-authority.ts';

export type ManagedOrgChange = { organizationSubject: string; expectedAuthorityEpoch: string } & (
  { operation: 'issue'; recipient: ManagedRecipient; actions: (typeof MANAGED_ORG_ACTION.roster)[];
    delegationCeiling: 0; validFrom: string; validUntil: string }
  | { operation: 'revoke'; grantId: string; expectedGeneration: string }
);
export interface OrgRosterPolicyInput {
  organizationSubject: string; recipient: ManagedRecipient; grantId: string;
  expectedGrantGeneration: string; representationId: string; expectedRepresentationGeneration: string;
  expectedPolicyRevision: string; admissionsOpen: boolean;
}
export interface ManagedGrantResult {
  grantId: string; organizationSubject: string; recipient: ManagedRecipient; recipientSubject: string;
  resource: { kind: 'org-roster'; organizationSubject: string };
  actions: (typeof MANAGED_ORG_ACTION.roster)[]; delegationCeiling: 0;
  validFrom: string; validUntil: string; generation: string; active: boolean;
}
export interface ManagedGrantChangeResult extends ManagedGrantResult {
  operation: 'issue' | 'revoke'; authorityEpoch: string; replayed: boolean;
}
export interface OrgManagementState {
  organizationSubject: string; authorityEpoch: string; policyRevision: string; admissionsOpen: boolean;
}
export interface OrgRosterPolicyResult extends OrgManagementState {
  grantId: string; grantGeneration: string; replayed: boolean;
}
type Grant = { id: string; organization_subject: string; organization_generation: string;
  organization_admission_generation: string; recipient_kind: 'realm' | 'parent'; recipient_id: string;
  recipient_subject: string; recipient_generation: string; recipient_admission_generation: string;
  action: typeof MANAGED_ORG_ACTION.roster; delegation_ceiling: 0;
  valid_from: Date; valid_until: Date; issuer_proof: ManagedIssuerProof; generation: string; active: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const time = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const recipientValid = (value: ManagedRecipient) => ['realm', 'parent'].includes(value.kind) && validOrgRealmId(value.id);

/** Explicit single-hop management; no structural tuple or roster is an authority source. */
export class AccessManagedOrganizations {
  constructor(private readonly pool: Pool) {}

  private validate(organization: string, key?: string): void {
    if (!validOrgRealmId(organization) || key !== undefined && (!key || key.length > 128 || key.includes('\0'))) {
      throw new ManagedOrgDenied('invalid managed organization intent');
    }
  }

  private async grant(client: PoolClient, id: string): Promise<Grant> {
    const result = await client.query<Grant>(`SELECT id, organization_subject, organization_generation,
      organization_admission_generation, recipient_kind, recipient_id, recipient_subject,
      recipient_generation, recipient_admission_generation, action, delegation_ceiling,
      valid_from, valid_until, issuer_proof, generation, active
      FROM access.managed_org_grant WHERE id = $1 FOR SHARE`, [id]);
    if (!result.rows[0]) throw new ManagedOrgDenied('managed grant unavailable');
    return result.rows[0];
  }

  private view(grant: Grant): ManagedGrantResult {
    return { grantId: grant.id, organizationSubject: grant.organization_subject,
      recipient: { kind: grant.recipient_kind, id: grant.recipient_id }, recipientSubject: grant.recipient_subject,
      resource: { kind: 'org-roster', organizationSubject: grant.organization_subject },
      actions: [grant.action], delegationCeiling: grant.delegation_ceiling,
      validFrom: grant.valid_from.toISOString(), validUntil: grant.valid_until.toISOString(),
      generation: grant.generation, active: grant.active };
  }

  private async policy(client: PoolClient, organization: string): Promise<{ revision: string; open: boolean }> {
    const result = await client.query<{ revision: string; open: boolean }>(`SELECT revision, open
      FROM access.membership_policy WHERE kind = 'org' AND owner_subject = $1 FOR SHARE`, [organization]);
    if (!result.rows[0]) throw new ManagedOrgDenied('organization roster policy unavailable');
    return result.rows[0];
  }

  private digest(input: ManagedOrgChange | OrgRosterPolicyInput): string {
    const fields = 'operation' in input
      ? input.operation === 'issue'
        ? ['issue', input.organizationSubject, input.expectedAuthorityEpoch, input.recipient.kind, input.recipient.id,
          input.actions, input.delegationCeiling, input.validFrom, input.validUntil]
        : ['revoke', input.organizationSubject, input.expectedAuthorityEpoch, input.grantId, input.expectedGeneration]
      : ['roster-policy', input.organizationSubject, input.recipient.kind, input.recipient.id, input.grantId,
        input.expectedGrantGeneration, input.representationId, input.expectedRepresentationGeneration,
        input.expectedPolicyRevision, input.admissionsOpen];
    return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  }

  private async replay<T>(client: PoolClient, actor: ManagedRepresentation, key: string,
    digest: string): Promise<T | undefined> {
    const result = await client.query<{ request_digest: string; result: T }>(`SELECT request_digest, result
      FROM access.managed_org_receipt WHERE principal_id = $1 AND idempotency_key = $2`, [actor.principalId, key]);
    if (!result.rows[0]) return undefined;
    if (result.rows[0].request_digest !== digest) throw new ManagedOrgConflict('key binds another managed intent');
    return { ...result.rows[0].result, replayed: true };
  }

  private async receipt(client: PoolClient, actor: ManagedRepresentation, key: string,
    operation: string, digest: string, result: ManagedGrantChangeResult | OrgRosterPolicyResult): Promise<void> {
    await client.query(`INSERT INTO access.managed_org_receipt
      (principal_id, idempotency_key, operation, request_digest, result) VALUES ($1,$2,$3,$4,$5)`,
    [actor.principalId, key, operation, digest, result]);
  }

  private async advance(client: PoolClient): Promise<string> {
    const result = await client.query<{ authority_epoch: string }>(`UPDATE access.scope_gate
      SET authority_epoch = authority_epoch + 1 WHERE id = $1 RETURNING authority_epoch`, [ORG_REALM_SCOPE]);
    return result.rows[0]!.authority_epoch;
  }

  async readOrganization(principal: VerifiedPrincipal, organization: string): Promise<OrgManagementState> {
    this.validate(organization);
    return managedTransaction(this.pool, false, async (client, epoch) => {
      await managedOrganization(client, organization);
      const actor = await managedIssuer(client, principal, organization);
      const policy = await this.policy(client, organization);
      await recheckManagedIssuer(client, actor);
      return { organizationSubject: organization, authorityEpoch: epoch,
        policyRevision: policy.revision, admissionsOpen: policy.open };
    });
  }

  async readGrant(principal: VerifiedPrincipal, id: string, side: 'organization' | 'recipient') {
    if (!uuid.test(id) || !['organization', 'recipient'].includes(side)) throw new ManagedOrgDenied('invalid grant read');
    return managedTransaction(this.pool, false, async (client, epoch) => {
      const grant = await this.grant(client, id);
      const organization = await managedOrganization(client, grant.organization_subject);
      let representation: { id: string; generation: string } | null = null;
      if (side === 'organization') {
        const actor = await managedIssuer(client, principal, organization.subject);
        await recheckManagedIssuer(client, actor);
      } else {
        const recipient = await managedRecipient(client, { kind: grant.recipient_kind, id: grant.recipient_id });
        if (recipient.subject !== grant.recipient_subject) throw new ManagedOrgDenied('recipient changed');
        const actor = await managedRepresentation(client, principal, recipient.subject, MANAGED_ORG_ACTION.roster);
        await recheckManagedRepresentation(client, actor);
        representation = { id: actor.representationId, generation: actor.representationGeneration };
      }
      const policy = await this.policy(client, organization.subject);
      return { ...this.view(grant), authorityEpoch: epoch, policyRevision: policy.revision,
        admissionsOpen: policy.open, representation };
    });
  }

  async change(principal: VerifiedPrincipal, input: ManagedOrgChange, key: string): Promise<ManagedGrantChangeResult> {
    this.validate(input.organizationSubject, key);
    if (!validOrgRealmGeneration(input.expectedAuthorityEpoch)
      || !['issue', 'revoke'].includes(input.operation)
      || input.operation === 'issue' && (!recipientValid(input.recipient)
        || input.actions.length !== 1 || input.actions[0] !== MANAGED_ORG_ACTION.roster
        || input.delegationCeiling !== 0 || !time(input.validFrom) || !time(input.validUntil)
        || Date.parse(input.validUntil) <= Date.parse(input.validFrom)
        || Date.parse(input.validUntil) - Date.parse(input.validFrom) > 30 * 86400_000)
      || input.operation === 'revoke' && (!uuid.test(input.grantId) || !validOrgRealmGeneration(input.expectedGeneration))) {
      throw new ManagedOrgDenied('invalid managed grant change');
    }
    return managedTransaction(this.pool, true, async (client, epoch) => {
      const organization = await managedOrganization(client, input.organizationSubject);
      // Current issuer authority permits receipt recovery and revocation even
      // when the original assignment ceiling has been removed.
      let actor = await managedIssuer(client, principal, input.organizationSubject);
      const digest = this.digest(input);
      const replay = await this.replay<ManagedGrantChangeResult>(client, actor, key, digest);
      if (replay) { await recheckManagedIssuer(client, actor); return replay; }
      if (input.expectedAuthorityEpoch !== epoch) throw new ManagedOrgStale('authority epoch changed');
      let grant: Grant;
      if (input.operation === 'issue') {
        const recipient = await managedRecipient(client, input.recipient);
        if (recipient.subject === organization.subject) throw new ManagedOrgDenied('recipient must be distinct');
        await this.policy(client, organization.subject);
        actor = await managedIssuer(client, principal, organization.subject, input.validUntil);
        await recheckManagedIssuer(client, actor, input.validUntil);
        const valid = await client.query(`SELECT 1 WHERE $1::timestamptz > clock_timestamp()
          AND $1::timestamptz <= clock_timestamp() + interval '30 days'`, [input.validUntil]);
        if (!valid.rows[0]) throw new ManagedOrgDenied('grant lifetime outside issuance ceiling');
        const id = randomUUID();
        await client.query(`INSERT INTO access.managed_org_grant
          (id, organization_subject, organization_generation, organization_admission_generation,
            recipient_kind, recipient_id, recipient_realm, recipient_parent,
            recipient_subject, recipient_generation, recipient_admission_generation,
            action, delegation_ceiling, valid_from, valid_until, issuer_proof)
          VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5 = 'realm' THEN $6::text END,
            CASE WHEN $5 = 'parent' THEN $6::text END,$7,$8,$9,$10,0,$11,$12,$13)`,
        [id, organization.subject, organization.generation, organization.admissionGeneration,
          input.recipient.kind, input.recipient.id, recipient.subject, recipient.generation,
          recipient.admissionGeneration, MANAGED_ORG_ACTION.roster, input.validFrom, input.validUntil, actor]);
        grant = await this.grant(client, id);
      } else {
        grant = await this.grant(client, input.grantId);
        if (grant.organization_subject !== input.organizationSubject) throw new ManagedOrgDenied('grant belongs to another organization');
        if (grant.generation !== input.expectedGeneration) throw new ManagedOrgStale('grant generation changed');
        if (!grant.active) throw new ManagedOrgDenied('grant already revoked');
        await recheckManagedIssuer(client, actor);
        await client.query(`UPDATE access.managed_org_grant SET active = false, generation = generation + 1 WHERE id = $1`, [grant.id]);
        grant = { ...grant, active: false, generation: (BigInt(grant.generation) + 1n).toString() };
      }
      const authorityEpoch = await this.advance(client);
      await client.query(`INSERT INTO access.managed_org_grant_event
        (grant_id, generation, operation, actor_proof, authority_epoch) VALUES ($1,$2,$3,$4,$5)`,
      [grant.id, grant.generation, input.operation, actor, authorityEpoch]);
      const result: ManagedGrantChangeResult = { ...this.view(grant), operation: input.operation, authorityEpoch, replayed: false };
      await this.receipt(client, actor, key, input.operation, digest, result);
      return result;
    });
  }

  async setRosterPolicy(principal: VerifiedPrincipal, input: OrgRosterPolicyInput, key: string): Promise<OrgRosterPolicyResult> {
    this.validate(input.organizationSubject, key);
    if (!recipientValid(input.recipient) || !uuid.test(input.grantId) || !uuid.test(input.representationId)
      || ![input.expectedGrantGeneration, input.expectedRepresentationGeneration, input.expectedPolicyRevision]
        .every(validOrgRealmGeneration) || typeof input.admissionsOpen !== 'boolean') {
      throw new ManagedOrgDenied('invalid organization roster policy intent');
    }
    return managedTransaction(this.pool, true, async (client) => {
      const grant = await this.grant(client, input.grantId);
      if (grant.organization_subject !== input.organizationSubject || grant.recipient_kind !== input.recipient.kind
        || grant.recipient_id !== input.recipient.id || grant.action !== MANAGED_ORG_ACTION.roster
        || grant.delegation_ceiling !== 0) throw new ManagedOrgDenied('grant does not cover this operation/resource/recipient');
      const organization = await managedOrganization(client, input.organizationSubject);
      const recipient = await managedRecipient(client, input.recipient);
      if (recipient.subject !== grant.recipient_subject) throw new ManagedOrgDenied('recipient authority changed');
      const actor = await managedRepresentation(client, principal, recipient.subject, MANAGED_ORG_ACTION.roster,
        { id: input.representationId, generation: input.expectedRepresentationGeneration });
      const digest = this.digest(input);
      const replay = await this.replay<OrgRosterPolicyResult>(client, actor, key, digest);
      if (replay) { await recheckManagedRepresentation(client, actor); return replay; }
      if (grant.generation !== input.expectedGrantGeneration) throw new ManagedOrgStale('grant generation changed');
      if (!grant.active) throw new ManagedOrgDenied('grant revoked');
      if (organization.generation !== grant.organization_generation
        || organization.admissionGeneration !== grant.organization_admission_generation
        || recipient.generation !== grant.recipient_generation
        || recipient.admissionGeneration !== grant.recipient_admission_generation) {
        throw new ManagedOrgDenied('saved organization or recipient admission changed');
      }
      const policy = await this.policy(client, organization.subject);
      if (policy.revision !== input.expectedPolicyRevision) throw new ManagedOrgStale('roster policy changed');
      await recheckManagedIssuer(client, grant.issuer_proof, grant.valid_until.toISOString());
      await recheckManagedRepresentation(client, actor);
      await managedLive(client, grant.valid_from.toISOString(), grant.valid_until.toISOString(), actor);
      const revision = (BigInt(policy.revision) + 1n).toString();
      await client.query(`UPDATE access.membership_policy SET open = $2, revision = $3
        WHERE kind = 'org' AND owner_subject = $1`, [organization.subject, input.admissionsOpen, revision]);
      const authorityEpoch = await this.advance(client);
      await client.query(`INSERT INTO access.org_roster_policy_history
        (organization_subject, policy_revision, admissions_open, grant_id, grant_generation, actor_proof, authority_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [organization.subject, revision, input.admissionsOpen, grant.id, grant.generation, actor, authorityEpoch]);
      const result: OrgRosterPolicyResult = { organizationSubject: organization.subject, authorityEpoch,
        policyRevision: revision, admissionsOpen: input.admissionsOpen, grantId: grant.id,
        grantGeneration: grant.generation, replayed: false };
      await this.receipt(client, actor, key, 'roster-policy', digest, result);
      return result;
    });
  }
}
