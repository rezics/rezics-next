import { bigint, jsonb, pgSchema, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Content-database rights tables (Content migration 080). Complaint decisions,
// restrictions and appeals are Access governance records; offerings are the
// graph profile rights-offering-v1. SQL stays the DDL owner and
// tests/governance-schema.test.ts checks these declarations.
const rights = pgSchema('rights');
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const materialScopes = ['source_provider', 'source_record', 'content_variant', 'media_asset'] as const;
export const expressionKinds = ['fact', 'expression', 'compilation', 'media', 'service', 'unknown'] as const;
export const assessmentFamilies = ['data_rights', 'service_terms'] as const;
export const useKinds = ['acquisition', 'raw_retention', 'wiki_display', 'search', 'media_delivery',
  'quotation', 'export', 'paid_data_product', 'redistribution'] as const;
export const rightsBases = ['original_contribution', 'unprotected_fact', 'public_domain', 'license',
  'permission', 'statutory_exception', 'service_terms', 'unknown'] as const;
// A recorded basis describes one material and use. Access authorization and
// legal clearance are independent decisions, even for a recognized offering.
export const assessmentOutcomes = ['supported', 'conditional', 'not_supported', 'undetermined'] as const;
export const obligationKinds = ['attribution', 'share_alike', 'notice_retention', 'change_indication',
  'non_commercial', 'no_derivatives', 'other'] as const;

export const material = rights.table('material', {
  id: uuid('id').primaryKey(),
  scopeKind: text('scope_kind', { enum: materialScopes }).notNull(),
  provider: text('provider'),
  namespace: text('namespace'),
  sourceRecordId: uuid('source_record_id'),
  contentVariantId: text('content_variant_id'),
  mediaAsset: text('media_asset'),
  component: text('component').notNull(),
  expressionKind: text('expression_kind', { enum: expressionKinds }).notNull(),
  createdAt: at('created_at').notNull(),
});

export const useAssessment = rights.table('use_assessment', {
  id: uuid('id').primaryKey(),
  materialId: uuid('material_id').notNull(),
  family: text('family', { enum: assessmentFamilies }).notNull(),
  useKind: text('use_kind', { enum: useKinds }).notNull(),
  useScope: text('use_scope').notNull(),
  basis: text('basis', { enum: rightsBases }).notNull(),
  outcome: text('outcome', { enum: assessmentOutcomes }).notNull(),
  licenseInstrument: text('license_instrument'),
  exceptionKind: text('exception_kind', { enum: ['fair_use'] }),
  rationale: text('rationale'),
  extent: jsonb('extent').$type<Record<string, unknown>>().notNull(),
  evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
  predecessorId: uuid('predecessor_id'),
  principalId: uuid('principal_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  assessedAt: at('assessed_at').notNull(),
});

export const useAssessmentHead = rights.table('use_assessment_head', {
  materialId: uuid('material_id').notNull(),
  family: text('family', { enum: assessmentFamilies }).notNull(),
  useKind: text('use_kind', { enum: useKinds }).notNull(),
  useScope: text('use_scope').notNull(),
  assessmentId: uuid('assessment_id').notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
}, table => [primaryKey({ columns: [table.materialId, table.family, table.useKind, table.useScope] })]);

export const obligation = rights.table('obligation', {
  assessmentId: uuid('assessment_id').notNull(),
  ordinal: smallint('ordinal').notNull(),
  kind: text('kind', { enum: obligationKinds }).notNull(),
  instrument: text('instrument').notNull(),
  appliesTo: text('applies_to', { enum: ['display', 'export', 'redistribution', 'all'] }).notNull(),
  notice: text('notice'),
}, table => [primaryKey({ columns: [table.assessmentId, table.ordinal] })]);

export const rightsTables = [material, useAssessment, useAssessmentHead, obligation] as const;

export type MaterialRow = typeof material.$inferSelect;
export type UseAssessmentRow = typeof useAssessment.$inferSelect;
export type UseAssessmentHeadRow = typeof useAssessmentHead.$inferSelect;
export type ObligationRow = typeof obligation.$inferSelect;
