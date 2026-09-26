import { bigint, boolean, pgSchema, primaryKey, text, timestamp }
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
}, table => [primaryKey({ columns: [table.principalIssuer, table.principalSubject,
  table.structure, table.occurrence, table.selectionKey] })]);

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
