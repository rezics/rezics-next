import { bigint, boolean, jsonb, pgSchema, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Access-owned governance tables (migrations 060-061). The SQL migrations stay
// the DDL owner; these declarations type bounded owner queries and are checked
// against the migrated database by tests/governance-schema.test.ts.
const access = pgSchema('access');
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const governanceOwners = ['graph', 'content', 'source', 'media', 'review'] as const;
export const governanceComponents = ['name', 'title', 'body', 'structure', 'media_use', 'synopsis',
  'cover', 'publication', 'record'] as const;
export const evidenceStates = ['available', 'empty', 'unavailable', 'erased', 'unsupported'] as const;
export const authorityKinds = ['platform', 'realm', 'resource_owner'] as const;
export const disclosures = ['private', 'parties', 'public_summary'] as const;
export const decisionKinds = ['organization_publication_rejection', 'content_moderation',
  'rights_disposition', 'realm_sanction_resolution'] as const;
// Membership sanctions are case targets only. Evidence, enforcement and decision
// targets stay on the content owners above.
export const caseKinds = ['content_report', 'rights_complaint', 'realm_sanction_appeal'] as const;
export const caseTargetOwners = [...governanceOwners, 'membership'] as const;
export const caseTargetComponents = [...governanceComponents, 'sanction'] as const;
export const decisionOutcomes = ['reject', 'restrict', 'interim_restrict', 'final_restrict', 'dismiss',
  'restore', 'reverse'] as const;
export const enforcementEffects = ['disclosure', 'publication', 'participation', 'capability', 'search',
  'raw_delivery', 'media_delivery', 'export', 'source_apply'] as const;
export const processSteps = ['appeal', 'uploader_notice', 'counter_notice', 'claimant_notice',
  'restoration_window', 'claimant_action', 'intake', 'message', 'removal_deadline',
  'restoration_not_before', 'restoration_not_after'] as const;
export const GLOBAL_CONTEXT = 'urn:rezics:context:global';

export const governanceRuleHead = access.table('governance_rule_head', {
  ref: text('ref').primaryKey(),
  scopeId: text('scope_id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  digest: text('digest').notNull(),
});

export const governanceRuleRevision = access.table('governance_rule_revision', {
  ref: text('ref').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  scopeId: text('scope_id').notNull(),
  digest: text('digest').notNull(),
  document: jsonb('document').$type<Record<string, unknown>>().notNull(),
  principalId: uuid('principal_id').notNull(),
  actingSubject: text('acting_subject').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  publishedAt: at('published_at').notNull(),
}, table => [primaryKey({ columns: [table.ref, table.revision] })]);

export const governanceCase = access.table('governance_case', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: caseKinds }).notNull(),
  authorityKind: text('authority_kind', { enum: authorityKinds }).notNull(),
  authorityScopeId: text('authority_scope_id').notNull(),
  context: text('context').notNull(),
  targetOwner: text('target_owner', { enum: caseTargetOwners }).notNull(),
  targetResource: text('target_resource').notNull(),
  targetComponent: text('target_component', { enum: caseTargetComponents }).notNull(),
  disclosure: text('disclosure', { enum: disclosures }).notNull(),
  state: text('state', { enum: ['open', 'closed'] }).notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  decisionHead: uuid('decision_head'),
  openedAt: at('opened_at').notNull(),
  closedAt: at('closed_at'),
  urgent: boolean('urgent').notNull(),
  reviewPending: boolean('review_pending').notNull(),
});

export const realmSanctionAppeal = access.table('realm_sanction_appeal', {
  caseId: uuid('case_id').primaryKey(),
  receiptId: uuid('receipt_id').notNull(),
  realm: text('realm').notNull(),
  principalId: uuid('principal_id').notNull(),
  memberSubject: text('member_subject').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  statement: text('statement').notNull(),
  openedAt: at('opened_at').notNull(),
});

/** One reversal's lift. Dismissal has no row. `receiptId` is the unban receipt. */
export const realmSanctionLift = access.table('realm_sanction_lift', {
  decisionId: uuid('decision_id').primaryKey(),
  receiptId: uuid('receipt_id'),
  liftedAt: at('lifted_at').notNull(),
});

export const governanceReport = access.table('governance_report', {
  id: uuid('id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  principalId: uuid('principal_id'),
  actingSubject: text('acting_subject'),
  principalEpoch: bigint('principal_epoch', { mode: 'bigint' }),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  reasonCode: text('reason_code').notNull(),
  statement: text('statement'),
  evidenceCount: smallint('evidence_count').notNull(),
  evidenceDigest: text('evidence_digest').notNull(),
  receivedAt: at('received_at').notNull(),
  contentLanguage: text('content_language'),
  contactEmail: text('contact_email'),
  declarations: jsonb('declarations'),
  publicReceiptHash: text('public_receipt_hash'),
  process: text('process'),
});

export const governanceEvidence = access.table('governance_evidence', {
  reportId: uuid('report_id').notNull(),
  ordinal: smallint('ordinal').notNull(),
  owner: text('owner', { enum: governanceOwners }).notNull(),
  resource: text('resource').notNull(),
  component: text('component', { enum: governanceComponents }).notNull(),
  locator: text('locator'),
  revision: text('revision'),
  representation: text('representation'),
  revisionDigest: text('revision_digest'),
  state: text('state', { enum: evidenceStates }).notNull(),
  provenance: jsonb('provenance').$type<Record<string, unknown>>().notNull(),
  capturedAt: at('captured_at').notNull(),
}, table => [primaryKey({ columns: [table.reportId, table.ordinal] })]);

export const rightsComplaint = access.table('rights_complaint', {
  reportId: uuid('report_id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  caseKind: text('case_kind', { enum: ['rights_complaint'] }).notNull(),
  process: text('process', { enum: ['dmca_512', 'ordinary_dispute'] }).notNull(),
  claimantKind: text('claimant_kind', { enum: ['rights_holder', 'authorized_agent', 'unknown'] }).notNull(),
  claimantName: text('claimant_name').notNull(),
  claimantContact: text('claimant_contact'),
  claimedWork: text('claimed_work').notNull(),
  claimedRight: text('claimed_right', { enum: ['copyright', 'trademark', 'privacy', 'other'] }).notNull(),
  noticeDigest: text('notice_digest').notNull(),
  noticeReceivedAt: at('notice_received_at').notNull(),
});

export const moderationDecision = access.table('moderation_decision', {
  id: uuid('id').primaryKey(),
  kind: text('kind', { enum: decisionKinds }).notNull(),
  outcome: text('outcome', { enum: decisionOutcomes }).notNull(),
  context: text('context').notNull(),
  caseId: uuid('case_id'),
  caseSequence: bigint('case_sequence', { mode: 'bigint' }),
  reversesDecisionId: uuid('reverses_decision_id'),
  admissionId: uuid('admission_id'),
  principalId: uuid('principal_id').notNull(),
  actingSubject: text('acting_subject').notNull(),
  authorityKind: text('authority_kind', { enum: authorityKinds }).notNull(),
  authorityScopeId: text('authority_scope_id').notNull(),
  authorityEpoch: bigint('authority_epoch', { mode: 'bigint' }).notNull(),
  authorityProofDigest: text('authority_proof_digest').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  ruleRef: text('rule_ref'),
  ruleRevision: text('rule_revision'),
  ruleDigest: text('rule_digest'),
  evidenceDigest: text('evidence_digest'),
  rationale: text('rationale'),
  disclosure: text('disclosure', { enum: disclosures }).notNull(),
  decidedAt: at('decided_at').notNull(),
  answersStepId: uuid('answers_step_id'),
  statementOfReasons: jsonb('statement_of_reasons'),
});

export const moderationDecisionTarget = access.table('moderation_decision_target', {
  decisionId: uuid('decision_id').notNull(),
  ordinal: smallint('ordinal').notNull(),
  owner: text('owner', { enum: governanceOwners }).notNull(),
  resource: text('resource').notNull(),
  component: text('component', { enum: governanceComponents }).notNull(),
  locator: text('locator'),
  scopeKind: text('scope_kind', { enum: ['exact_revision', 'component'] }).notNull(),
  revision: text('revision'),
  expectedHead: text('expected_head'),
  effect: text('effect', { enum: enforcementEffects }).notNull(),
  expiresAt: at('expires_at'),
  participantSubject: text('participant_subject'),
}, table => [primaryKey({ columns: [table.decisionId, table.ordinal] })]);

export const governanceProcessStep = access.table('governance_process_step', {
  id: uuid('id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  decisionId: uuid('decision_id'),
  process: text('process', { enum: ['platform_appeal', 'dmca_512', 'ordinary_dispute', 'child_safety',
    'ncii', 'credible_threat', 'platform_rules', 'realm_rules', 'privacy'] }).notNull(),
  step: text('step', { enum: processSteps }).notNull(),
  principalId: uuid('principal_id'),
  partySubject: text('party_subject'),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  statement: text('statement'),
  documentDigest: text('document_digest'),
  occurredAt: at('occurred_at').notNull(),
  dueAt: at('due_at'),
  recordedAt: at('recorded_at').notNull(),
  reportId: uuid('report_id'),
  party: text('party', { enum: ['reporter', 'affected'] }),
  contentLanguage: text('content_language'),
  declarations: jsonb('declarations'),
});

export const governanceRole = access.table('governance_role', {
  name: text('name').primaryKey(), scopeId: text('scope_id').notNull(), permissions: jsonb('permissions').$type<string[]>().notNull(),
});
export const governanceCaseCredential = access.table('governance_case_credential', {
  id: uuid('id').primaryKey(), caseId: uuid('case_id').notNull(), reportId: uuid('report_id').notNull(),
  party: text('party', { enum: ['reporter', 'affected'] }).notNull(), secretHash: text('secret_hash').notNull(),
  createdAt: at('created_at').notNull(),
});
export const governanceCorrespondenceReceipt = access.table('governance_correspondence_receipt', {
  credentialId: uuid('credential_id').notNull(), keyHash: text('key_hash').notNull(),
  requestDigest: text('request_digest').notNull(), stepId: uuid('step_id').notNull(),
}, table => [primaryKey({ columns: [table.credentialId, table.keyHash] })]);
export const governancePreservationHold = access.table('governance_preservation_hold', {
  id: uuid('id').primaryKey(), caseId: uuid('case_id').notNull(), targetResource: text('target_resource').notNull(),
  authorSubject: text('author_subject'), accountIssuer: text('account_issuer'), accountSubject: text('account_subject'),
  reason: text('reason').notNull(), createdAt: at('created_at').notNull(), releasedAt: at('released_at'),
});
export const governanceErasurePostponement = access.table('governance_erasure_postponement', {
  holdId: uuid('hold_id').notNull(), operationId: text('operation_id').notNull(), materialRef: text('material_ref').notNull(),
  reason: text('reason').notNull(), recordedAt: at('recorded_at').notNull(),
}, table => [primaryKey({ columns: [table.holdId, table.operationId, table.materialRef] })]);

export const governanceEnforcement = access.table('governance_enforcement', {
  id: uuid('id').primaryKey(),
  authorityScopeId: text('authority_scope_id').notNull(),
  context: text('context').notNull(),
  owner: text('owner', { enum: governanceOwners }).notNull(),
  resource: text('resource').notNull(),
  component: text('component', { enum: governanceComponents }).notNull(),
  revision: text('revision'),
  effect: text('effect', { enum: enforcementEffects }).notNull(),
  expiresAt: at('expires_at'),
  participantSubject: text('participant_subject'),
  decisionId: uuid('decision_id').notNull(),
  decisionOrdinal: smallint('decision_ordinal').notNull(),
  state: text('state', { enum: ['restricted', 'released'] }).notNull(),
  fenceEpoch: bigint('fence_epoch', { mode: 'bigint' }).notNull(),
  updatedAt: at('updated_at').notNull(),
});

export const safetyCaseClaim = access.table('safety_case_claim', {
  caseId: uuid('case_id').primaryKey(),
  principalId: uuid('principal_id').notNull(),
  actingSubject: text('acting_subject').notNull(),
  claimedAt: at('claimed_at').notNull(),
  caseGeneration: bigint('case_generation', { mode: 'bigint' }).notNull(),
  expiresAt: at('expires_at').notNull(),
});
export const siteModerationPosition = access.table('site_moderation_position', {
  id: boolean('id').primaryKey(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
});
export const safetyDecisionOperation = access.table('safety_decision_operation', {
  decisionId: uuid('decision_id').primaryKey(),
  cancelled: boolean('cancelled').notNull(),
});
export const safetyDecisionEffect = access.table(
  'safety_decision_effect',
  {
    decisionId: uuid('decision_id').notNull(),
    ordinal: smallint('ordinal').notNull(),
    plan: jsonb('plan').notNull(),
    state: text('state').notNull(),
    receipt: text('receipt'),
    continuation: text('continuation'),
    error: text('error'),
  },
  (table) => [primaryKey({ columns: [table.decisionId, table.ordinal] })],
);
export const safetyPartyNotice = access.table('safety_party_notice', {
  id: uuid('id').primaryKey(),
  decisionId: uuid('decision_id').notNull(),
  principalId: uuid('principal_id').notNull(),
  caseId: uuid('case_id').notNull(),
  credential: text('credential').notNull(),
  statementOfReasons: jsonb('statement_of_reasons').notNull(),
  createdAt: at('created_at').notNull(),
});

export const safetyNoticeJob = access.table('safety_notice_job', {
  decisionId: uuid('decision_id').notNull(), ordinal: smallint('ordinal').notNull(),
  target: jsonb('target').notNull(), participant: text('participant'),
  phase: text('phase').notNull(), afterSubject: text('after_subject'), subject: text('subject'),
  afterPrincipal: uuid('after_principal'),
}, table => [primaryKey({ columns: [table.decisionId, table.ordinal] })]);
export const safetyNoticeMailCursor = access.table('safety_notice_mail_cursor', {
  decisionId: uuid('decision_id').primaryKey(), phase: text('phase').notNull(),
  afterParty: uuid('after_party'), afterReportAt: at('after_report_at'), afterReport: uuid('after_report'),
});
export const safetyNoticeMailReceipt = access.table('safety_notice_mail_receipt', {
  deliveryId: uuid('delivery_id').primaryKey(), decisionId: uuid('decision_id').notNull(),
  acceptedAt: at('accepted_at').notNull(),
});
export const governanceCaseEvidence = access.table('governance_case_evidence', {
  caseId: uuid('case_id').notNull(), targetKey: text('target_key').notNull(),
  available: boolean('available').notNull(), automated: boolean('automated').notNull(),
}, table => [primaryKey({ columns: [table.caseId, table.targetKey, table.available] })]);

export const rightsCounterNotice = access.table('rights_counter_notice', {
  stepId: uuid('step_id').primaryKey(), caseId: uuid('case_id').notNull(), reportId: uuid('report_id').notNull(),
  restrictionId: uuid('restriction_id').notNull(), deliveryId: uuid('delivery_id').notNull(),
  claimantCredential: text('claimant_credential').notNull(), receivedAt: at('received_at').notNull(), deliveredAt: at('delivered_at'),
  notBefore: at('not_before').notNull(), notAfter: at('not_after').notNull(), nextAttemptAt: at('next_attempt_at').notNull(),
  phase: text('phase').notNull(), restorationId: uuid('restoration_id'),
});

export const governanceTables = [governanceRuleHead, governanceRuleRevision,
  governanceCase, realmSanctionAppeal, realmSanctionLift, governanceReport, governanceEvidence, rightsComplaint,
  moderationDecision, moderationDecisionTarget, governanceProcessStep, governanceEnforcement,
  governanceRole, governanceCaseCredential, governanceCorrespondenceReceipt, governancePreservationHold,
  governanceErasurePostponement,
  safetyCaseClaim,
  siteModerationPosition,
  safetyDecisionOperation,
  safetyDecisionEffect,
  safetyPartyNotice,
  safetyNoticeJob, safetyNoticeMailCursor, safetyNoticeMailReceipt, governanceCaseEvidence, rightsCounterNotice,
] as const;

export type GovernanceCaseRow = typeof governanceCase.$inferSelect;
export type GovernanceReportRow = typeof governanceReport.$inferSelect;
export type GovernanceEvidenceRow = typeof governanceEvidence.$inferSelect;
export type RightsComplaintRow = typeof rightsComplaint.$inferSelect;
export type ModerationDecisionRow = typeof moderationDecision.$inferSelect;
export type ModerationDecisionTargetRow = typeof moderationDecisionTarget.$inferSelect;
export type GovernanceProcessStepRow = typeof governanceProcessStep.$inferSelect;
export type GovernanceEnforcementRow = typeof governanceEnforcement.$inferSelect;
