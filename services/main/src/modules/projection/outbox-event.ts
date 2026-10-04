import { ownerCommandEvent } from '../context/outbox-event.ts';
import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';

export const outboxEventHandlers = [
  ownerCommandEvent('projection.create', 'ProjectionCreatedEvent', 'com.rezics.projection.created.v1',
    'committed', 'ProjectionRevision'),
  ownerCommandEvent('projection.create', 'ProjectionCreateStaleEvent', 'com.rezics.projection.create-stale.v1',
    'stale', 'ProjectionRevision'),
  ownerCommandEvent('projection.create', 'ProjectionCreateCancelledEvent', 'com.rezics.projection.create-cancelled.v1',
    'cancelled', 'ProjectionRevision'),
] satisfies OwnerOutboxEventHandler[];
