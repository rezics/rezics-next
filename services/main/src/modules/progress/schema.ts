import { bigint, boolean, jsonb, pgSchema, primaryKey, text, timestamp }
  from 'drizzle-orm/pg-core';

// SQL migration 031 owns the constraints. These declarations keep query and
// recovery consumers on the same private progress identity.
const structure = pgSchema('structure');

export const structureProgress = structure.table('progress', {
  principalIssuer: text('principal_issuer').notNull(),
  principalSubject: text('principal_subject').notNull(),
  structure: text('structure').notNull(),
  occurrence: text('occurrence').notNull(),
  selectionKey: text('selection_key').notNull(),
  completed: boolean('completed').notNull(),
  position: text('position'),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  orderRevision: text('order_revision'),
  orderKey: text('order_key'),
  resumeEligible: boolean('resume_eligible'),
}, table => [primaryKey({ columns: [table.principalIssuer, table.principalSubject,
  table.structure, table.occurrence, table.selectionKey] })]);

export const progressReader = structure.table('progress_reader', {
  principalIssuer: text('principal_issuer').notNull(), principalSubject: text('principal_subject').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
}, table => [primaryKey({ columns: [table.principalIssuer, table.principalSubject] })]);
export const progressScope = structure.table('progress_scope', {
  principalIssuer: text('principal_issuer').notNull(), principalSubject: text('principal_subject').notNull(),
  structure: text('structure').notNull(), orderRevision: text('order_revision'), ready: boolean('ready').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  invalidations: bigint('invalidations', { mode: 'bigint' }).notNull(),
  reindexCursor: jsonb('reindex_cursor').$type<{ occurrence?: string; selection?: string }>(),
  reindexInvalidations: bigint('reindex_invalidations', { mode: 'bigint' }),
  anchorRevision: text('anchor_revision'), anchorParent: text('anchor_parent'),
  anchorParentRevision: text('anchor_parent_revision'),
  anchorCursor: jsonb('anchor_cursor').$type<{ occurrence?: string; selection?: string }>(),
}, table => [primaryKey({ columns: [table.principalIssuer, table.principalSubject, table.structure] })]);

export const progressCommand = structure.table('progress_command', {
  principalIssuer: text('principal_issuer').notNull(),
  principalSubject: text('principal_subject').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  structure: text('structure').notNull(),
  occurrence: text('occurrence').notNull(),
  selectionKey: text('selection_key').notNull(),
  resultVersion: bigint('result_version', { mode: 'bigint' }).notNull(),
  resultCompleted: boolean('result_completed').notNull(),
  resultPosition: text('result_position'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.principalIssuer, table.principalSubject,
  table.idempotencyKey] })]);
