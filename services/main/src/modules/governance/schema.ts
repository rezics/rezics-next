import { bigint, jsonb, pgSchema, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Access-owned governance tables (migrations 060-061). The SQL migrations stay
// the DDL owner; these declarations type bounded owner queries and are checked
// against the migrated database by tests/governance-schema.test.ts.
const access = pgSchema('access');
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const governanceOwners = ['graph', 'content', 'source', 'media'] as const;
export const governanceComponents = ['name', 'title', 'body', 'structure', 'media_use', 'synopsis',
  'cover', 'publication', 'record'] as const;
export const evidenceStates = ['available', 'empty', 'unavailable', 'erased', 'unsupported'] as const;
export const authorityKinds = ['platform', 'realm', 'resource_owner'] as const;
export const disclosures = ['private', 'parties', 'public_summary'] as const;
export const decisionKinds = ['organization_publication_rejection', 'content_moderation',
  'rights_disposition'] as const;
export const decisionOutcomes = ['reject', 'restrict', 'interim_restrict', 'final_restrict', 'dismiss',
  'restore', 'reverse'] as const;
export const enforcementEffects = ['disclosure', 'publication', 'participation', 'capability', 'search',
  'raw_delivery', 'media_delivery', 'export', 'source_apply'] as const;
export const processSteps = ['appeal', 'uploader_notice', 'counter_notice', 'claimant_notice',
  'restoration_window', 'claimant_action'] as const;
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
  kind: text('kind', { enum: ['content_report', 'rights_complaint'] }).notNull(),
  authorityKind: text('authority_kind', { enum: authorityKinds }).notNull(),
  authorityScopeId: text('authority_scope_id').notNull(),
  context: text('context').notNull(),
  targetOwner: text('target_owner', { enum: governanceOwners }).notNull(),
  targetResource: text('target_resource').notNull(),
  targetComponent: text('target_component', { enum: governanceComponents }).notNull(),
  disclosure: text('disclosure', { enum: disclosures }).notNull(),
  state: text('state', { enum: ['open', 'closed'] }).notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  decisionHead: uuid('decision_head'),
  openedAt: at('opened_at').notNull(),
  closedAt: at('closed_at'),
});

export const governanceReport = access.table('governance_report', {
  id: uuid('id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  principalId: uuid('principal_id').notNull(),
  actingSubject: text('acting_subject').notNull(),
  principalEpoch: bigint('principal_epoch', { mode: 'bigint' }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  reasonCode: text('reason_code').notNull(),
  statement: text('statement'),
  evidenceCount: smallint('evidence_count').notNull(),
  evidenceDigest: text('evidence_digest').notNull(),
  receivedAt: at('received_at').notNull(),
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
}, table => [primaryKey({ columns: [table.decisionId, table.ordinal] })]);

export const governanceProcessStep = access.table('governance_process_step', {
  id: uuid('id').primaryKey(),
  caseId: uuid('case_id').notNull(),
  decisionId: uuid('decision_id').notNull(),
  process: text('process', { enum: ['platform_appeal', 'dmca_512', 'ordinary_dispute'] }).notNull(),
  step: text('step', { enum: processSteps }).notNull(),
  principalId: uuid('principal_id').notNull(),
  partySubject: text('party_subject'),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  statement: text('statement'),
  documentDigest: text('document_digest'),
  occurredAt: at('occurred_at').notNull(),
  dueAt: at('due_at'),
  recordedAt: at('recorded_at').notNull(),
});

export const governanceEnforcement = access.table('governance_enforcement', {
  id: uuid('id').primaryKey(),
  authorityScopeId: text('authority_scope_id').notNull(),
  context: text('context').notNull(),
  owner: text('owner', { enum: governanceOwners }).notNull(),
  resource: text('resource').notNull(),
  component: text('component', { enum: governanceComponents }).notNull(),
  revision: text('revision'),
  effect: text('effect', { enum: enforcementEffects }).notNull(),
  decisionId: uuid('decision_id').notNull(),
  decisionOrdinal: smallint('decision_ordinal').notNull(),
  state: text('state', { enum: ['restricted', 'released'] }).notNull(),
  fenceEpoch: bigint('fence_epoch', { mode: 'bigint' }).notNull(),
  updatedAt: at('updated_at').notNull(),
});

export const governanceTables = [governanceRuleHead, governanceRuleRevision,
  governanceCase, governanceReport, governanceEvidence, rightsComplaint,
  moderationDecision, moderationDecisionTarget, governanceProcessStep, governanceEnforcement] as const;

export type GovernanceCaseRow = typeof governanceCase.$inferSelect;
export type GovernanceReportRow = typeof governanceReport.$inferSelect;
export type GovernanceEvidenceRow = typeof governanceEvidence.$inferSelect;
export type RightsComplaintRow = typeof rightsComplaint.$inferSelect;
export type ModerationDecisionRow = typeof moderationDecision.$inferSelect;
export type ModerationDecisionTargetRow = typeof moderationDecisionTarget.$inferSelect;
export type GovernanceProcessStepRow = typeof governanceProcessStep.$inferSelect;
export type GovernanceEnforcementRow = typeof governanceEnforcement.$inferSelect;
