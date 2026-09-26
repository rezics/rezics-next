import { bigint, boolean, integer, pgSchema, primaryKey, smallint, text, timestamp, uuid }
  from 'drizzle-orm/pg-core';

// Typed declarations for services/content/migrations/030_structure_stage.sql.
// The SQL migration stays the DDL owner; its triggers enforce lease fences,
// contiguous checkpoints and monotone settlement for every writer.
const structure = pgSchema('structure');

export const STAGE_KINDS = ['replace', 'import', 'refresh', 'capture', 'restore'] as const;
export const STAGE_STATUSES = ['staging', 'sealed', 'activated', 'cancelled', 'failed'] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const stageJob = structure.table('stage_job', {
  id: uuid('id').primaryKey(),
  principalId: uuid('principal_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  authorityScope: text('authority_scope').notNull(),
  structure: text('structure').notNull(),
  generation: text('generation').notNull(),
  kind: text('kind').$type<StageKind>().notNull(),
  /** Structure revision the stage was built against; activation CAS requires it or a reconciliation. */
  baseHead: text('base_head').notNull(),
  sourceRef: text('source_ref'),
  sourceRevision: text('source_revision'),
  mappingPolicy: text('mapping_policy').$type<'source-key' | 'explicit'>(),
  restoredFrom: text('restored_from'),
  status: text('status').$type<StageStatus>().notNull(),
  leaseHolder: uuid('lease_holder'),
  leaseFence: bigint('lease_fence', { mode: 'bigint' }).notNull(),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  sourceCursor: text('source_cursor'),
  stagedPages: integer('staged_pages').notNull(),
  stagedRecords: bigint('staged_records', { mode: 'number' }).notNull(),
  stagedBytes: bigint('staged_bytes', { mode: 'number' }).notNull(),
  /** Set before the first graph projection batch is sent; a settled job then needs graph proof. */
  graphStarted: boolean('graph_started').notNull(),
  projectionBatches: integer('projection_batches').notNull(),
  rootManifest: text('root_manifest'),
  placementCount: integer('placement_count'),
  coverage: text('coverage').$type<'complete' | 'partial'>(),
  graphReceipt: text('graph_receipt'),
  graphDataEpoch: uuid('graph_data_epoch'),
  graphSequence: bigint('graph_sequence', { mode: 'bigint' }),
  revision: text('revision'),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});

export const stagePage = structure.table('stage_page', {
  jobId: uuid('job_id').notNull().references(() => stageJob.id),
  ordinal: integer('ordinal').notNull(),
  pageDigest: text('page_digest').notNull(),
  tree: text('tree').$type<'record' | 'order'>().notNull(),
  level: smallint('level').notNull(),
  entryCount: integer('entry_count').notNull(),
  byteLength: integer('byte_length').notNull(),
  leaseFence: bigint('lease_fence', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, table => [primaryKey({ columns: [table.jobId, table.ordinal] })]);

export type StageJobRow = typeof stageJob.$inferSelect;
export type StagePageRow = typeof stagePage.$inferSelect;
