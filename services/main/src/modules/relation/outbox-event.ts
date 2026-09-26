import { RV } from '../work/activate.ts';
import type { OwnerOutboxEventHandler } from '../outbox/event-handlers.ts';
import { readChangedEvent } from '../semantic/outbox-event.ts';

export const outboxEventHandlers: OwnerOutboxEventHandler[] = [{
  kind: `${RV}RelationChangedEvent`, action: 'relation.change', type: 'com.rezics.relation.changed.v1',
  read: input => readChangedEvent(input, 'relation.change', 'relation-change', ['RelationOccurrenceRevision'],
    'com.rezics.relation.changed.v1'),
}];
