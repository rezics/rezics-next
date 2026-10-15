import { bigint, boolean, jsonb, pgSchema, primaryKey, text, timestamp }
  from 'drizzle-orm/pg-core';

// SQL owner migrations define the constraints. These declarations keep query and
// recovery consumers on the same private progress identity.
const structure = pgSchema('structure');

export const structureProgress = structure.table('progress', {
  agent: text('agent').notNull(),
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
}, table => [primaryKey({ columns: [table.agent,
  table.structure, table.occurrence, table.selectionKey] })]);

export const progressReader = structure.table('progress_reader', {
  agent: text('agent').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
}, table => [primaryKey({ columns: [table.agent] })]);
export const progressScope = structure.table('progress_scope', {
  agent: text('agent').notNull(),
  structure: text('structure').notNull(), orderRevision: text('order_revision'), ready: boolean('ready').notNull(),
  version: bigint('version', { mode: 'bigint' }).notNull(),
  invalidations: bigint('invalidations', { mode: 'bigint' }).notNull(),
  reindexCursor: jsonb('reindex_cursor').$type<{ occurrence?: string; selection?: string }>(),
  reindexInvalidations: bigint('reindex_invalidations', { mode: 'bigint' }),
}, table => [primaryKey({ columns: [table.agent, table.structure] })]);
export const progressAnchorScope = structure.table('progress_anchor_scope', {
  agent: text('agent').notNull(),
  structure: text('structure').notNull(), parent: text('parent').notNull(),
  revision: text('revision'), parentRevision: text('parent_revision'),
  cursor: jsonb('cursor').$type<{ occurrence?: string; selection?: string }>(),
}, table => [primaryKey({ columns: [table.agent, table.structure, table.parent] })]);

export const progressCommand = structure.table('progress_command', {
  principalIssuer: text('principal_issuer').notNull(),
  principalSubject: text('principal_subject').notNull(),
  agent: text('agent').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  structure: text('structure').notNull(),
  occurrence: text('occurrence').notNull(),
  selectionKey: text('selection_key').notNull(),
  resultVersion: bigint('result_version', { mode: 'bigint' }).notNull(),
  resultCompleted: boolean('result_completed').notNull(),
  resultPosition: text('result_position'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.agent,
  table.principalIssuer, table.principalSubject, table.idempotencyKey] })]);
