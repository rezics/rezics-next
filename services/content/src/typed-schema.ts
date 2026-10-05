import { bigint, boolean, jsonb, pgSchema, text, uuid } from 'drizzle-orm/pg-core';

// Existing Content tables. The SQL migrations remain the DDL owner while the
// typed-query pilot proves compatibility with the current pg transaction.
const content = pgSchema('content');

export const ownerControl = content.table('owner_control', {
  singleton: boolean('singleton').primaryKey(),
  dataEpoch: uuid('data_epoch').notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
});

// Writers append receipts and events without a position; the sequencer
// (migration 791) assigns data_epoch and sequence once, after commit.
export const receipt = content.table('receipt', {
  operationId: text('operation_id').primaryKey(),
  requestDigest: text('request_digest').notNull(),
  action: text('action').notNull(),
  outcome: text('outcome').notNull(),
  variantId: text('variant_id'),
  revisionId: uuid('revision_id'),
  reason: text('reason'),
  dataEpoch: uuid('data_epoch'),
  sequence: bigint('sequence', { mode: 'bigint' }),
  entry: bigint('entry', { mode: 'bigint' }),
});

export const outbox = content.table('outbox', {
  id: uuid('id').primaryKey(),
  dataEpoch: uuid('data_epoch'),
  sequence: bigint('sequence', { mode: 'bigint' }),
  operationId: text('operation_id').notNull(),
  eventType: text('event_type').notNull(),
  recipe: text('recipe').notNull(),
  revisionId: uuid('revision_id'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
});
