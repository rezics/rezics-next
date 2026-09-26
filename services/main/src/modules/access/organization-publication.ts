import { createHash } from 'node:crypto';
import { validOrgRealmGeneration, validOrgRealmId } from './org-realm-authority.ts';

export const ORGANIZATION_MODERATION_ACTION = 'publication.reject.organization';
export const ORGANIZATION_MODERATION_PROFILE = 'realm-organization-publication-rejection-v1';

/** Public identities only; the chosen permission and private caller stay in Access. */
export interface OrganizationPublicationTarget {
  realm: string;
  organizationSubject: string;
  participationId: string;
  participationGeneration: string;
  proposalId: string;
  policyRevision: string;
  work: string;
  mainVersion: string;
  expectedWorkHead: string;
  selection: string;
  contribution: string;
  publicationDecision: string;
  selectedDraft: string;
  actingSubject: string;
  representationId: string;
  representationGeneration: string;
}

export function canonicalOrganizationPublication(input: OrganizationPublicationTarget): OrganizationPublicationTarget {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (![input.realm, input.organizationSubject, input.work, input.mainVersion,
    input.expectedWorkHead, input.selection, input.contribution, input.publicationDecision,
    input.selectedDraft, input.actingSubject].every(validOrgRealmId)
    || ![input.participationId, input.proposalId, input.representationId].every(value => uuid.test(value))
    || ![input.participationGeneration, input.policyRevision, input.representationGeneration]
      .every(validOrgRealmGeneration)) throw new Error('invalid organization publication target');
  return { realm: input.realm, organizationSubject: input.organizationSubject,
    participationId: input.participationId, participationGeneration: input.participationGeneration,
    proposalId: input.proposalId, policyRevision: input.policyRevision,
    work: input.work, mainVersion: input.mainVersion, expectedWorkHead: input.expectedWorkHead,
    selection: input.selection, contribution: input.contribution,
    publicationDecision: input.publicationDecision, selectedDraft: input.selectedDraft,
    actingSubject: input.actingSubject, representationId: input.representationId,
    representationGeneration: input.representationGeneration };
}

export const organizationPublicationScope = (realm: string) => `publication:reject:${realm}`;
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]));
  return value;
}
export const moderationProofDigest = (proof: unknown) =>
  createHash('sha256').update(JSON.stringify(ordered(proof))).digest('hex');
