import { sql } from 'drizzle-orm';
import { bigint, integer, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Media owner tables in Main's Content database. The SQL migration
// `services/content/migrations/070_media_owner.sql` remains the DDL and trigger
// owner; these declarations type the media module's queries. Asset revisions and
// media-set publication bodies are `content.revision` rows, typed by Content.
const media = pgSchema('media');
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`);

type MediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/avif' | 'image/gif';

const asset = media.table('asset', {
  id: uuid('id').primaryKey(),
  variantId: text('variant_id').notNull(),
  owner: text('owner').notNull(),
  mediaKind: text('media_kind').$type<'image'>().notNull(),
  objectNamespace: text('object_namespace').notNull(),
  stateHead: uuid('state_head').notNull(),
  operationId: text('operation_id').notNull(),
  createdAt: createdAt(),
});

const assetState = media.table('asset_state', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  predecessor: uuid('predecessor'),
  disclosure: text('disclosure').$type<'private' | 'public'>().notNull(),
  moderation: text('moderation').$type<'none' | 'suppressed'>().notNull(),
  lifecycle: text('lifecycle').$type<'active' | 'deleted' | 'erased'>().notNull(),
  erasureEpoch: bigint('erasure_epoch', { mode: 'bigint' }).notNull(),
  actor: text('actor').notNull(),
  authorityEpoch: text('authority_epoch').notNull(),
  operationId: text('operation_id').notNull(),
  dataEpoch: uuid('data_epoch').notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  createdAt: createdAt(),
});

const upload = media.table('upload', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  principalId: uuid('principal_id').notNull(),
  operationId: text('operation_id').notNull(),
  erasureEpoch: bigint('erasure_epoch', { mode: 'bigint' }).notNull(),
  declaredMediaType: text('declared_media_type').$type<MediaType>().notNull(),
  declaredByteLength: integer('declared_byte_length').notNull(),
  declaredDigest: text('declared_digest'),
  quarantineKey: text('quarantine_key').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: text('status').$type<'reserved' | 'activated' | 'rejected' | 'expired'>().notNull().default('reserved'),
  reason: text('reason').$type<'size-mismatch' | 'digest-mismatch' | 'format-rejected'
    | 'scan-rejected' | 'erasure-fenced' | 'cancelled'>(),
  settleOperationId: text('settle_operation_id'),
  createdAt: createdAt(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});

const representation = media.table('representation', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  kind: text('kind').$type<'original' | 'rendition'>().notNull(),
  uploadId: uuid('upload_id'),
  sourceId: uuid('source_id'),
  transformJobId: uuid('transform_job_id'),
  profile: text('profile'),
  crop: text('crop'),
  byteDigest: text('byte_digest').notNull(),
  byteLength: integer('byte_length').notNull(),
  mediaType: text('media_type').$type<MediaType>().notNull(),
  pixelWidth: integer('pixel_width').notNull(),
  pixelHeight: integer('pixel_height').notNull(),
  availability: text('availability').$type<'available' | 'erased' | 'unavailable'>().notNull().default('available'),
  operationId: text('operation_id').notNull(),
  createdAt: createdAt(),
  clearance: text('clearance').$type<'screening' | 'cleared' | 'held' | 'rejected'>().notNull().default('screening'),
  clearanceReason: text('clearance_reason'),
});

const transformJob = media.table('transform_job', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  sourceId: uuid('source_id').notNull(),
  inputDigest: text('input_digest').notNull(),
  profile: text('profile').notNull(),
  crop: text('crop'),
  authorityEpoch: text('authority_epoch').notNull(),
  erasureEpoch: bigint('erasure_epoch', { mode: 'bigint' }).notNull(),
  operationId: text('operation_id').notNull(),
  status: text('status').$type<'queued' | 'leased' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'),
  attempt: integer('attempt').notNull().default(0),
  leaseToken: uuid('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  reason: text('reason'),
  settleOperationId: text('settle_operation_id'),
  createdAt: createdAt(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});

const use = media.table('use', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  assetVariantId: text('asset_variant_id').notNull(),
  assetRevisionId: uuid('asset_revision_id').notNull(),
  representationId: uuid('representation_id').notNull(),
  target: text('target').notNull(),
  context: text('context').notNull(),
  role: text('role').$type<'avatar' | 'publication-item'>().notNull(),
  crop: text('crop'),
  actor: text('actor').notNull(),
  operationId: text('operation_id').notNull(),
  createdAt: createdAt(),
});

const selectionSlot = media.table('selection_slot', {
  target: text('target').notNull(),
  context: text('context').notNull(),
  role: text('role').$type<'avatar'>().notNull(),
  policy: text('policy').$type<'avatar-selection-v1'>().notNull(),
  head: uuid('head'),
  deliveryHead: uuid('delivery_head'),
});

const selectionRevision = media.table('selection_revision', {
  id: uuid('id').primaryKey(),
  target: text('target').notNull(),
  context: text('context').notNull(),
  role: text('role').$type<'avatar'>().notNull(),
  predecessor: uuid('predecessor'),
  useId: uuid('use_id'),
  actor: text('actor').notNull(),
  authorityEpoch: text('authority_epoch').notNull(),
  operationId: text('operation_id').notNull(),
  dataEpoch: uuid('data_epoch').notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  createdAt: createdAt(),
});

const screenResult = media.table('screen_result', {
  jobId: uuid('job_id').primaryKey(), sourceId: uuid('source_id').notNull(),
  clearance: text('clearance').$type<'cleared' | 'held'>().notNull(), reason: text('reason'),
  evidence: jsonb('evidence').notNull(), operationId: text('operation_id').notNull(), createdAt: createdAt(),
});
const screenReview = media.table('screen_review', {
  jobId: uuid('job_id').primaryKey(), caseId: uuid('case_id'),
  retryAfter: timestamp('retry_after', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});
const clearanceDecision = media.table('clearance_decision', {
  id: uuid('id').primaryKey(), sourceId: uuid('source_id').notNull(), decisionId: uuid('decision_id').notNull(),
  clearance: text('clearance').$type<'cleared' | 'rejected'>().notNull(),
  operationId: text('operation_id').notNull(), createdAt: createdAt(),
});
const suppressedDigest = media.table('suppressed_digest', {
  digest: text('digest').notNull(), createdAt: createdAt(), id: uuid('id').primaryKey().defaultRandom(),
  caseId: uuid('case_id'), decisionId: uuid('decision_id'),
});
const suppressionLift = media.table('suppression_lift', {
  suppressionId: uuid('suppression_id').primaryKey(), caseId: uuid('case_id').notNull(),
  decisionId: uuid('decision_id').notNull(), operationId: text('operation_id').notNull(),
  liftedAt: timestamp('lifted_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
});

/** Every media owner table, for typed queries and the schema conformance test. */
export const mediaTables = { asset, assetState, upload, representation, transformJob, use,
  selectionSlot, selectionRevision, screenResult, screenReview, clearanceDecision, suppressedDigest,
  suppressionLift } as const;
