import { bigint, boolean, integer, pgSchema, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Access-owned notification tables (migrations 062-063, 440-441, 495, 883-884). The delivery row is
// the bounded delivery work item; the producer event log only captures owner
// changes. SQL stays
// the DDL owner and tests/governance-schema.test.ts checks these declarations.
const access = pgSchema('access');
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const optionalPurposes = ['social', 'subscription'] as const;
export const mandatoryPurposes = ['security', 'account', 'governance'] as const;
export const notificationPurposes = [...mandatoryPurposes, ...optionalPurposes] as const;
export const preferenceChannels = ['inbox', 'email', 'push'] as const;
export const deliveryChannels = ['email', 'push'] as const;
export const deliveryStates = ['pending', 'sending', 'uncertain', 'delivered', 'failed', 'cancelled'] as const;
export const terminalDeliveryStates = ['delivered', 'failed', 'cancelled'] as const;
export const cancelReasons = ['unsubscribed', 'ineligible', 'undisclosed', 'endpoint_invalid',
  'recipient_erased', 'subject_erased', 'expired'] as const;
export const attemptOutcomes = ['accepted', 'rejected_permanent', 'rejected_transient', 'uncertain'] as const;

export const notificationPreference = access.table('notification_preference', {
  principalId: uuid('principal_id').notNull(),
  purpose: text('purpose', { enum: [...optionalPurposes, 'governance'] }).notNull(),
  topic: text('topic').notNull(),
  channel: text('channel', { enum: preferenceChannels }).notNull(),
  state: text('state', { enum: ['enabled', 'disabled'] }).notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  updatedAt: at('updated_at').notNull(),
}, table => [primaryKey({ columns: [table.principalId, table.purpose, table.topic, table.channel] })]);

export const notificationPreferenceChange = access.table('notification_preference_change', {
  principalId: uuid('principal_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestDigest: text('request_digest').notNull(),
  purpose: text('purpose', { enum: [...optionalPurposes, 'governance'] }).notNull(),
  topic: text('topic').notNull(),
  channel: text('channel', { enum: preferenceChannels }).notNull(),
  state: text('state', { enum: ['enabled', 'disabled'] }).notNull(),
  revision: bigint('revision', { mode: 'bigint' }).notNull(),
  via: text('via', { enum: ['settings', 'signed_link', 'provider_suppression'] }).notNull(),
  createdAt: at('created_at').notNull(),
}, table => [primaryKey({ columns: [table.principalId, table.idempotencyKey] })]);

export const notificationEndpoint = access.table('notification_endpoint', {
  id: uuid('id').primaryKey(),
  principalId: uuid('principal_id').notNull(),
  channel: text('channel', { enum: deliveryChannels }).notNull(),
  deviceId: text('device_id'),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  state: text('state', { enum: ['active', 'retired', 'invalid'] }).notNull(),
  address: text('address'),
  addressDigest: text('address_digest').notNull(),
  lockScreenDisclosure: boolean('lock_screen_disclosure').notNull(),
  createdAt: at('created_at').notNull(),
  retiredAt: at('retired_at'),
});

export const notificationStream = access.table('notification_stream', {
  principalId: uuid('principal_id').notNull(),
  stream: text('stream', { enum: ['inbox'] }).notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  headSequence: bigint('head_sequence', { mode: 'bigint' }).notNull(),
  resetAt: at('reset_at'),
}, table => [primaryKey({ columns: [table.principalId, table.stream] })]);

export const notificationItem = access.table('notification_item', {
  id: uuid('id').primaryKey(),
  principalId: uuid('principal_id').notNull(),
  stream: text('stream', { enum: ['inbox'] }).notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  sequence: bigint('sequence', { mode: 'bigint' }).notNull(),
  purpose: text('purpose', { enum: notificationPurposes }).notNull(),
  topic: text('topic').notNull(),
  sourceOwner: text('source_owner', { enum: ['graph', 'content', 'access', 'account'] }).notNull(),
  sourceEvent: text('source_event').notNull(),
  subjectOwner: text('subject_owner', { enum: ['graph', 'content', 'source', 'media', 'access'] }).notNull(),
  subjectRef: text('subject_ref').notNull(),
  subjectRevision: text('subject_revision'),
  disclosureBasis: text('disclosure_basis').notNull(),
  state: text('state', { enum: ['active', 'withdrawn', 'erased'] }).notNull(),
  createdAt: at('created_at').notNull(),
  stateChangedAt: at('state_changed_at'),
});

export const notificationReadWatermark = access.table('notification_read_watermark', {
  principalId: uuid('principal_id').notNull(),
  stream: text('stream', { enum: ['inbox'] }).notNull(),
  generation: bigint('generation', { mode: 'bigint' }).notNull(),
  readThrough: bigint('read_through', { mode: 'bigint' }).notNull(),
  updatedAt: at('updated_at').notNull(),
}, table => [primaryKey({ columns: [table.principalId, table.stream, table.generation] })]);

export const notificationItemRead = access.table('notification_item_read', {
  principalId: uuid('principal_id').notNull(),
  itemId: uuid('item_id').notNull(),
  readAt: at('read_at').notNull(),
}, table => [primaryKey({ columns: [table.principalId, table.itemId] })]);

export const notificationItemTriage = access.table(
  'notification_item_triage',
  {
    principalId: uuid('principal_id').notNull(),
    itemId: uuid('item_id').notNull(),
    saved: boolean('saved').notNull(),
    done: boolean('done').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.itemId] })],
);
export const watch = access.table(
  'watch',
  {
    principalId: uuid('principal_id').notNull(),
    proposal: uuid('proposal'),
    target: text('target').notNull(),
    kind: text('kind', { enum: ['thread','proposal','release','collection'] }).notNull(),
    reason: text('reason', { enum: ['author', 'reviewer', 'steward', 'manual'] }).notNull(),
    level: text('level', { enum: ['participating', 'all', 'ignore'] }).notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.principalId, table.target] })],
);
export const proposalSubscription = watch;
export const notificationProposalContext = access.table('notification_proposal_context', {
  itemId: uuid('item_id').primaryKey(),
  proposal: uuid('proposal').notNull(),
  revision: integer('revision').notNull(),
  reason: text('reason', { enum: ['author', 'reviewer', 'steward', 'manual'] }).notNull(),
});

export const notificationKinds = ['reply', 'submission_decision', 'moderation_outcome',
  'realm_role_change', 'follow', 'claim_correction', 'review', 'review_helpful', 'realm_invitation',
  'chapter', 'post_vote'] as const;
export const notificationDisplayContext = access.table('notification_display_context', {
  itemId: uuid('item_id').primaryKey(),
  kind: text('kind', { enum: notificationKinds }).notNull(),
  actorAgent: text('actor_agent'),
  realm: text('realm'),
  groupKey: text('group_key'),
});

export const notificationDelivery = access.table('notification_delivery', {
  id: uuid('id').primaryKey(),
  itemId: uuid('item_id').notNull(),
  principalId: uuid('principal_id').notNull(),
  endpointId: uuid('endpoint_id').notNull(),
  channel: text('channel', { enum: deliveryChannels }).notNull(),
  endpointGeneration: bigint('endpoint_generation', { mode: 'bigint' }).notNull(),
  state: text('state', { enum: deliveryStates }).notNull(),
  cancelReason: text('cancel_reason', { enum: cancelReasons }),
  attemptCount: smallint('attempt_count').notNull(),
  nextAttemptAt: at('next_attempt_at'),
  leaseToken: uuid('lease_token'),
  leaseUntil: at('lease_until'),
  expiresAt: at('expires_at').notNull(),
  providerMessageId: text('provider_message_id'),
  diagnostic: text('diagnostic'),
  createdAt: at('created_at').notNull(),
  terminalAt: at('terminal_at'),
});

export const notificationAttempt = access.table('notification_attempt', {
  deliveryId: uuid('delivery_id').notNull(),
  attempt: smallint('attempt').notNull(),
  leaseToken: uuid('lease_token').notNull(),
  addressDigest: text('address_digest').notNull(),
  disclosureDigest: text('disclosure_digest').notNull(),
  startedAt: at('started_at').notNull(),
  outcome: text('outcome', { enum: attemptOutcomes }),
  providerStatus: text('provider_status'),
  providerMessageId: text('provider_message_id'),
  diagnostic: text('diagnostic'),
  finishedAt: at('finished_at'),
}, table => [primaryKey({ columns: [table.deliveryId, table.attempt] })]);

export const notificationProviderEvent = access.table('notification_provider_event', {
  provider: text('provider').notNull(),
  providerEventId: text('provider_event_id').notNull(),
  deliveryId: uuid('delivery_id'),
  source: text('source', { enum: ['callback', 'reconciliation'] }).notNull(),
  kind: text('kind', { enum: ['delivered', 'bounced', 'complained', 'failed', 'suppressed', 'not_found'] })
    .notNull(),
  payloadDigest: text('payload_digest').notNull(),
  receivedAt: at('received_at').notNull(),
}, table => [primaryKey({ columns: [table.provider, table.providerEventId] })]);

export const notificationProducerHead = access.table('notification_producer_head', {
  id: boolean('id').primaryKey(),
  position: bigint('position', { mode: 'bigint' }).notNull(),
});
export const notificationProducerEvent = access.table('notification_producer_event', {
  position: bigint('position', { mode: 'bigint' }).primaryKey(),
  kind: text('kind', { enum: ['submission_decision', 'moderation_outcome',
    'realm_role_change', 'realm_membership_change', 'review_created',
    'review_helpful_milestone', 'realm_invitation'] }).notNull(),
  eventId: uuid('event_id').notNull(),
  createdAt: at('created_at').notNull(),
});
export const notificationProducerCursor = access.table('notification_producer_cursor', {
  consumer: text('consumer').primaryKey(),
  position: bigint('position', { mode: 'bigint' }).notNull(),
  updatedAt: at('updated_at').notNull(),
});
export const notificationRealmPending = access.table('notification_realm_pending', {
  transactionId: bigint('transaction_id', { mode: 'bigint' }).notNull(),
  realm: text('realm').notNull(),
  member: text('member').notNull(),
}, table => [primaryKey({ columns: [table.transactionId, table.realm, table.member] })]);
export const notificationRealmEffect = access.table('notification_realm_effect', {
  receiptId: uuid('receipt_id').notNull(),
  member: text('member').notNull(),
}, table => [primaryKey({ columns: [table.receiptId, table.member] })]);

export const notificationTables = [notificationPreference, notificationPreferenceChange,
  notificationEndpoint, notificationStream, notificationItem, notificationReadWatermark,
  notificationItemRead, notificationDisplayContext, notificationDelivery,
  notificationAttempt, notificationProviderEvent, notificationProducerHead,
  notificationProducerEvent, notificationProducerCursor, notificationRealmPending,
  notificationRealmEffect] as const;

export type NotificationPreferenceRow = typeof notificationPreference.$inferSelect;
export type NotificationEndpointRow = typeof notificationEndpoint.$inferSelect;
export type NotificationStreamRow = typeof notificationStream.$inferSelect;
export type NotificationItemRow = typeof notificationItem.$inferSelect;
export type NotificationReadWatermarkRow = typeof notificationReadWatermark.$inferSelect;
export type NotificationItemReadRow = typeof notificationItemRead.$inferSelect;
export type NotificationDisplayContextRow = typeof notificationDisplayContext.$inferSelect;
export type NotificationDeliveryRow = typeof notificationDelivery.$inferSelect;
export type NotificationAttemptRow = typeof notificationAttempt.$inferSelect;
export type NotificationProviderEventRow = typeof notificationProviderEvent.$inferSelect;
