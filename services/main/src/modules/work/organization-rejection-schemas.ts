import { t } from 'elysia';
import { publicationRejectionWriteResult } from '../../api-responses.ts';
import { ORGANIZATION_MODERATION_PROFILE } from '../access/organization-publication.ts';

const ref = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ format: 'uuid' });
const generation = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });
export const organizationRejectionBody = t.Object({
  profile: t.Literal(ORGANIZATION_MODERATION_PROFILE),
  realm: ref, organizationSubject: ref, participationId: uuid, participationGeneration: generation,
  proposalId: uuid, policyRevision: generation, work: ref, mainVersion: ref,
  expectedWorkHead: ref, selection: ref, contribution: ref, publicationDecision: ref,
  selectedDraft: ref, actingSubject: ref, representationId: uuid, representationGeneration: generation,
}, { additionalProperties: false });
export const organizationRejectionResult = t.Composite([publicationRejectionWriteResult, t.Object({
  profile: t.Literal(ORGANIZATION_MODERATION_PROFILE),
  organizationSubject: ref, participationId: uuid, participationGeneration: generation,
  proposalId: uuid, contribution: ref, publicationDecision: ref, selectedDraft: ref,
  expectedWorkHead: ref, authorityProofDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
})], {});
