import type { CommandTransaction } from '../command/command.ts';
import { ZONE_EVENTS } from '../zones/events.ts';
import {
  classifyEvent,
  ZONE_HISTORY_EVENT_TYPES,
  ZONE_HISTORY_RECEIPT_KINDS,
  type ZoneHistoryEventType,
} from './contracts.ts';
import type { HistoryArtifact, HistoryBarrier, HistoryFamilySource, HistoryRegistry } from './registry.ts';
import type { HistoryReceivingContext } from './receiving.ts';
import { observeZoneHistoryConsumerClosure } from './receiving.ts';

const eventTypes = [...ZONE_HISTORY_EVENT_TYPES].sort();
const actualEventTypes = Object.keys(ZONE_EVENTS).sort();
if (JSON.stringify(eventTypes) !== JSON.stringify(actualEventTypes))
  throw new TypeError('Zone event producer inventory changed without History adoption');

for (const type of ZONE_HISTORY_EVENT_TYPES) {
  if (classifyEvent(type).kind !== 'non-personal') throw new TypeError('Zone base event classification changed');
}

/** The current rebuilt producer cut: seven receipt codecs and seven closed ID/revision events.
 * No Zone durable-work producer is registered until its actual native owner exists. */
export const ZONE_HISTORY_FAMILY_SOURCES: readonly HistoryFamilySource[] = Object.freeze([
  ...ZONE_HISTORY_RECEIPT_KINDS.map((producer) => ({
    artifactType: 'command-receipt/v1' as const,
    producer,
    version: 1,
  })),
  ...ZONE_HISTORY_EVENT_TYPES.map((producer) => ({ artifactType: 'outbox-event/v1' as const, producer, version: 1 })),
]);

export type ZoneHistoryConsumerDependencies = Readonly<{ history: HistoryRegistry }>;

async function readiness(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
  receiving: HistoryReceivingContext | undefined,
) {
  const binding = receiving?.discriminant?.kind === 'zone-cleanup' ? receiving.discriminant.binding : undefined;
  const closure = await observeZoneHistoryConsumerClosure(tx, artifact, barrier, binding);
  return closure.state === 'closed' ? { ready: true as const } : { ready: false as const, gap: closure.gap };
}

/** Register every delivered Zone History producer and its exact native consumer disposition.
 * Durable work remains an explicit family gap; neither an empty scan nor an unconditional owner
 * can claim that future Zone work has no consumer. */
export function registerZoneHistoryConsumers({ history }: ZoneHistoryConsumerDependencies): void {
  history.registerCoverage('zones', ['command-receipt/v1', 'outbox-event/v1']);
  history.registerFamilySources('zones', 1, ZONE_HISTORY_FAMILY_SOURCES);

  for (const kind of ZONE_HISTORY_RECEIPT_KINDS) {
    history.registerOwner({
      name: kind,
      artifactType: 'command-receipt/v1',
      version: 1,
      readiness,
    });
  }
  for (const eventType of ZONE_HISTORY_EVENT_TYPES) {
    history.registerOwner({
      name: eventType,
      artifactType: 'outbox-event/v1',
      version: 1,
      readiness,
    });
  }
}

export type ZoneHistoryProducerInventory = Readonly<{
  receipts: typeof ZONE_HISTORY_RECEIPT_KINDS;
  events: readonly ZoneHistoryEventType[];
  durableWork: readonly [];
}>;

export const ZONE_HISTORY_PRODUCER_INVENTORY: ZoneHistoryProducerInventory = Object.freeze({
  receipts: ZONE_HISTORY_RECEIPT_KINDS,
  events: ZONE_HISTORY_EVENT_TYPES,
  durableWork: Object.freeze([] as const),
});
