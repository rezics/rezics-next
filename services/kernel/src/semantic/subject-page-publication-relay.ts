import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { runCommand, type CommandEvent } from '../command/command.ts';
import { projectBatch } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import type { Access } from '../request/access.ts';
import { partitionOf } from '../route/route.ts';
import type { SourceFenceEventData } from '../content/source-fence-events.ts';
import { fenceKey } from './fences.ts';
import {
  SUBJECT_PAGE_DEPENDENCIES_CHANGED,
  SUBJECT_PAGE_REPAIR_REQUESTED,
  SUBJECT_PAGE_REPAIR_QUEUED,
  SUBJECT_PAGE_WORK_COMMITTED,
} from './events.ts';
import {
  applySubjectPageDependencyDelta,
  applySubjectPageOwnerChange,
  enqueueSubjectPageRepair,
  type OwnerKey,
  type SubjectKey,
  type ComponentKey,
  type EvidenceTime,
} from './subject-page-publication-store.ts';
type Delta = {
  owner: OwnerKey;
  subject: SubjectKey;
  component: ComponentKey;
  sourceVersion: string;
  eventId: string;
  present: boolean;
  time: EvidenceTime;
};
type Delivery = { subject: SubjectKey; owner: OwnerKey; changeId: string; eventId: string; time: EvidenceTime };
const FENCE = 'com.rezics.content.source_fence.taken_down.v1' as const;
/** projectBatch releases the source checkout before any idempotent destination commit. */
export function createSubjectPagePublicationRelay({
  pool,
  clock,
}: {
  pool: Pool;
  access: Access;
  clock: KernelClock;
  routeKey: Uint8Array;
}): Relay {
  return {
    consumer: 'semantic_subject_page_publication',
    run(partition) {
      return projectBatch(pool, {
        partition,
        consumer: 'semantic_subject_page_publication',
        async apply(envelopes) {
          for (const envelope of envelopes)
            for (const event of envelope.events) {
              if (event.type === SUBJECT_PAGE_DEPENDENCIES_CHANGED) {
                const { deltas } = event.data as { deltas: Delta[] };
                for (const delta of deltas)
                  await runCommand(pool, { partition: partitionOf(delta.owner.route), clock }, async (tx) => {
                    const outbox: CommandEvent[] = [];
                    // Retain the admitted envelope identity for replay of this exact membership version.
                    await applySubjectPageDependencyDelta(tx, { ...delta, eventId: event.id, outbox });
                    if (!outbox.length)
                      outbox.push({
                        type: SUBJECT_PAGE_WORK_COMMITTED,
                        data: { partition: partitionOf(delta.owner.route), kind: 'dependency' },
                      });
                    return { value: null, events: outbox };
                  });
              } else if (event.type === SUBJECT_PAGE_REPAIR_REQUESTED) {
                const delivery = event.data as Delivery;
                await runCommand(pool, { partition: partitionOf(delivery.subject.route), clock }, async (tx) => {
                  await enqueueSubjectPageRepair(tx, { subject: delivery.subject, cause: 'owner', delivery });
                  return {
                    value: null,
                    events: [
                      {
                        type: SUBJECT_PAGE_WORK_COMMITTED,
                        data: { partition: partitionOf(delivery.subject.route), kind: 'delivery' },
                      },
                    ],
                  };
                });
              } else if (event.type === FENCE) {
                const data = event.data as SourceFenceEventData<typeof FENCE>;
                const owner: OwnerKey = { kind: 'source-fence', route: data.route, key: fenceKey(data) };
                const known = !!data.takenDownAt && !!data.takedownId;
                await runCommand(pool, { partition: partitionOf(owner.route), clock }, async (tx) => {
                  await applySubjectPageOwnerChange(tx, {
                    owner,
                    changeId: known ? data.takedownId! : event.id,
                    time: known
                      ? { effectiveAt: data.takenDownAt!, evidence: 'known' }
                      : { effectiveAt: null, evidence: 'missing' },
                  });
                  return {
                    value: null,
                    events: [
                      {
                        type: SUBJECT_PAGE_WORK_COMMITTED,
                        data: { partition: partitionOf(owner.route), kind: 'owner' },
                      },
                    ],
                  };
                });
              } else if (
                event.type.startsWith('com.rezics.semantic.subject_page.') &&
                event.type !== SUBJECT_PAGE_REPAIR_QUEUED &&
                event.type !== SUBJECT_PAGE_WORK_COMMITTED
              ) {
                throw new Error(`Unsupported subject page publication event: ${event.type}`);
              }
            }
        },
      });
    },
  };
}
