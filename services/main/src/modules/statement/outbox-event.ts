import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { ownerCommandEvent } from '../context/outbox-event.ts';

export const outboxEventHandlers = [
  ownerCommandEvent('statement.record', 'StatementRecordedEvent', 'com.rezics.statement.recorded.v1',
    'committed', 'StatementRevision'),
  ownerCommandEvent('statement.record', 'StatementChangeStaleEvent', 'com.rezics.statement.record-stale.v1',
    'stale', 'StatementRevision'),
  ownerCommandEvent('statement.record', 'StatementChangeCancelledEvent', 'com.rezics.statement.record-cancelled.v1',
    'cancelled', 'StatementRevision'),
  ownerCommandEvent('statement.withdraw', 'StatementWithdrawnEvent', 'com.rezics.statement.withdrawn.v1',
    'committed', 'StatementRevision'),
  ownerCommandEvent('statement.withdraw', 'StatementWithdrawalStaleEvent', 'com.rezics.statement.withdraw-stale.v1',
    'stale', 'StatementRevision'),
  ownerCommandEvent('statement.withdraw', 'StatementWithdrawalCancelledEvent',
    'com.rezics.statement.withdraw-cancelled.v1', 'cancelled', 'StatementRevision'),
  ownerCommandEvent('statement.decide', 'StatementDecisionChangedEvent', 'com.rezics.statement.decision-changed.v1',
    'committed', 'StatementDecision'),
  ownerCommandEvent('statement.decide', 'StatementDecisionStaleEvent', 'com.rezics.statement.decision-stale.v1',
    'stale', 'StatementDecision'),
  ownerCommandEvent('statement.decide', 'StatementDecisionCancelledEvent', 'com.rezics.statement.decision-cancelled.v1',
    'cancelled', 'StatementDecision'),
  // Stopped-writer upgrades retain terminal legacy receipts and outbox batches.
  // These readers do not register an admission family or restore dispatch.
  ownerCommandEvent('statement.migrate', 'StatementMigratedEvent', 'com.rezics.statement.migrated.v1',
    'committed', 'StatementDecision', 'statement-migrate-v1'),
  ownerCommandEvent('statement.migrate', 'StatementMigrationStaleEvent', 'com.rezics.statement.migrate-stale.v1',
    'stale', 'StatementDecision', 'statement-migrate-v1'),
  ownerCommandEvent('statement.migrate', 'StatementMigrationCancelledEvent', 'com.rezics.statement.migrate-cancelled.v1',
    'cancelled', 'StatementDecision', 'statement-migrate-v1'),
  ownerCommandEvent('statement.cutover', 'StatementCutoverEvent', 'com.rezics.statement.cutover.v1',
    'committed', 'StatementCutover', 'statement-cutover-v1'),
  ownerCommandEvent('statement.cutover', 'StatementCutoverStaleEvent', 'com.rezics.statement.cutover-stale.v1',
    'stale', 'StatementCutover', 'statement-cutover-v1'),
  ownerCommandEvent('statement.cutover', 'StatementCutoverCancelledEvent', 'com.rezics.statement.cutover-cancelled.v1',
    'cancelled', 'StatementCutover', 'statement-cutover-v1'),
] satisfies OwnerOutboxEventHandler[];
