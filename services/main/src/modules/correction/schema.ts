// Owner-schema declarations for reviewed corrections. Content migration 130 and the
// correction-proposal-v1/correction-decision-v1 model profiles remain the DDL owners.
import { createHash } from 'node:crypto';
import type { CONTENT_DRAFT_PROTECTION, PROTECTION_RULE } from '../protection/schema.ts';

export const CORRECTION_PROPOSAL_PROFILE = 'https://rezics.com/definition/correction-proposal-v1';
export const CORRECTION_DECISION_PROFILE = 'https://rezics.com/definition/correction-decision-v1';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
/** One current proposal log per target/context; a deterministic identity leaves no absence race. */
export const correctionLogIri = (component: string, slot: string, context: string) =>
  `urn:rezics:correction-log:${sha256(`${component}\0${slot}\0${context}`)}`;
/** Derived from the proposal revision, so a second decision or application cannot be fresh. */
export const correctionDecisionIri = (proposalRevision: string) =>
  `urn:rezics:correction-decision:${sha256(proposalRevision)}`;
export const correctionApplicationIri = (proposalRevision: string) =>
  `urn:rezics:correction-application:${sha256(proposalRevision)}`;

/** `content.correction_proposal`: immutable proposal revision; NULL `base_protection` asserts absence. */
export interface CorrectionProposalRow {
  id: string; proposal_id: string; revision_number: number; predecessor: string | null; variant_id: string;
  profile: typeof CONTENT_DRAFT_PROTECTION; base_head: string; base_protection: string | null;
  rule_revision: typeof PROTECTION_RULE; candidate_revision: string; candidate_digest: string;
  evidence: string[]; reason: string; agent: string | null; operation_id: string; created_at: Date;
}

/** `content.correction_decision`: the one terminal decision of a proposal revision. */
export interface CorrectionDecisionRow {
  id: string; proposal_revision: string; variant_id: string; base_head: string; candidate_revision: string;
  candidate_digest: string; rule_revision: typeof PROTECTION_RULE; outcome: 'approved' | 'rejected';
  independence_proof: string | null; evidence: string[]; reason: string; agent: string | null;
  operation_id: string; created_at: Date;
}

/** `content.correction_application`: one applied effect per proposal revision and per base head. */
export interface CorrectionApplicationRow {
  proposal_revision: string; decision_id: string; decision_outcome: 'approved'; variant_id: string;
  base_head: string; successor_head: string; candidate_digest: string; rule_revision: typeof PROTECTION_RULE;
  protection_head: string | null; operation_id: string; created_at: Date;
}

export const CORRECTION_CONFLICTS = {
  correction_stale_basis: 'stale_review_basis',
  correction_candidate: 'stale_review_basis',
  correction_revision: 'stale_review_basis',
  correction_approval_applied: 'stale_review_basis',
  correction_decision_proposal_revision_key: 'decision_exists',
  correction_application_pkey: 'already_applied',
  correction_application_variant_id_base_head_key: 'already_applied',
} as const;
