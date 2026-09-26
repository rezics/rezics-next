import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { ownerCommandEvent } from '../context/outbox-event.ts';

export const outboxEventHandlers = [
  ownerCommandEvent('statement.record', 'StatementRecordedEvent', 'com.rezics.statement.recorded.v1',
    'committed', 'StatementRevision'),
  ownerCommandEvent('statement.record', 'StatementChangeStaleEvent', 'com.rezics.statement.record-stale.v1',
    'stale', 'StatementRevision'),
  ownerCommandEvent('statement.record', 'StatementChangeCancelledEvent', 'com.rezics.statement.record-cancelled.v1',
    'cancelled', 'StatementRevision'),
  ownerCommandEvent('statement.decide', 'StatementDecisionChangedEvent', 'com.rezics.statement.decision-changed.v1',
    'committed', 'StatementDecision'),
  ownerCommandEvent('statement.decide', 'StatementDecisionStaleEvent', 'com.rezics.statement.decision-stale.v1',
    'stale', 'StatementDecision'),
  ownerCommandEvent('statement.decide', 'StatementDecisionCancelledEvent', 'com.rezics.statement.decision-cancelled.v1',
    'cancelled', 'StatementDecision'),
] satisfies OwnerOutboxEventHandler[];
