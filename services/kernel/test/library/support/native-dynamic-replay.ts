import { ERASURE_LOCATOR_EFFECTS } from '../../../src/access/erasure.ts';
import { lookupEventType } from '../../../src/events/catalogue.ts';
import { EFFECTS_QUEUE, effectWorkflowId } from '../../../src/events/effects.ts';
import type { CloudEvent, Envelope } from '../../../src/events/log.ts';
import { LOCATOR_EFFECTS_QUEUE } from '../../../src/work/queues.ts';
import type { NativeConformanceWorld } from './native-conformance.ts';

export type NativeDynamicReplayWorld = Pick<NativeConformanceWorld, 'settle'> & {
  native: Pick<NativeConformanceWorld['native'], 'reader' | 'workClient'>;
};

type ReplayRow = {
  partition: number;
  epoch: number;
  position: string;
  eventSeq: number;
  eventCount: number;
  id: string;
  type: string;
  subject: string | null;
  time: string;
  data: unknown;
  payloadState: string;
  consumer: string | null;
  workflowId: string | null;
  custodyState: string | null;
};

type ReplayConsumer = { name: string; workflowId: string };
type ReplayEvent = { sequence: number; value: CloudEvent; consumers: ReplayConsumer[] };
type ReplayEnvelope = { value: Envelope; eventCount: number; events: Map<number, ReplayEvent> };

const collectionEventPattern = 'com.rezics.library.collection.%';
const effectWorkflow = 'effect';

const committedProjectionEnvelopes = `
WITH selected AS (
  SELECT DISTINCT partition_no,position
  FROM core.outbox
  WHERE type LIKE $1
)
SELECT outbox.partition_no AS partition,outbox.epoch,outbox.position::text AS position,
       outbox.event_seq AS "eventSeq",outbox.event_count AS "eventCount",outbox.id::text AS id,
       outbox.type,outbox.subject,
       to_char(outbox.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time,
       outbox.data,outbox.payload_state AS "payloadState",custody.consumer,
       custody.workflow_id AS "workflowId",custody.state AS "custodyState"
FROM selected
JOIN core.outbox AS outbox
  ON outbox.partition_no=selected.partition_no AND outbox.position=selected.position
LEFT JOIN core.history_event_consumer AS custody
  ON custody.partition_no=outbox.partition_no
 AND custody.position=outbox.position
 AND custody.event_seq=outbox.event_seq
ORDER BY outbox.partition_no,outbox.position,outbox.event_seq,custody.consumer`;

function unavailable(detail: string): never {
  throw new Error(`Native Library dependency_unavailable: ${detail}`);
}

function compareEnvelope(left: Envelope, right: Envelope): number {
  return left.partition - right.partition ||
    (left.position < right.position ? -1 : left.position > right.position ? 1 : left.epoch - right.epoch);
}

function captureEnvelopes(rows: readonly ReplayRow[]): ReplayEnvelope[] {
  const envelopes = new Map<string, ReplayEnvelope>();
  for (const row of rows) {
    if (row.payloadState !== 'present') return unavailable('retained Collection event payload');
    const validator = lookupEventType(row.type);
    if (!validator?.Check(row.data)) return unavailable(`valid retained Collection event ${row.type}`);

    const position = BigInt(row.position);
    const key = `${row.partition}:${row.epoch}:${position}`;
    let group = envelopes.get(key);
    if (!group) {
      group = {
        value: { partition: row.partition, epoch: row.epoch, position, events: [] },
        eventCount: row.eventCount,
        events: new Map(),
      };
      envelopes.set(key, group);
    }
    if (group.eventCount !== row.eventCount || row.eventSeq < 0 || row.eventSeq >= row.eventCount)
      return unavailable('complete native Collection event envelope');

    let event = group.events.get(row.eventSeq);
    if (!event) {
      const value: CloudEvent = {
        specversion: '1.0',
        id: row.id,
        source: `urn:rezics:log:${row.partition}.${row.epoch}`,
        type: row.type,
        ...(row.subject === null ? {} : { subject: row.subject }),
        time: row.time,
        datacontenttype: 'application/json',
        sequence: position.toString().padStart(19, '0'),
        data: row.data,
      };
      event = { sequence: row.eventSeq, value, consumers: [] };
      group.events.set(row.eventSeq, event);
    }

    if (row.consumer === null) {
      if (row.workflowId !== null || row.custodyState !== null)
        return unavailable('consistent native event consumer custody');
      continue;
    }
    if (row.workflowId === null || row.custodyState === null)
      return unavailable('complete native event consumer custody');
    const expectedWorkflowId = effectWorkflowId(group.value, row.eventSeq, row.consumer);
    if (row.workflowId !== expectedWorkflowId) return unavailable('original native effect workflow identity');
    if (row.custodyState === 'transferred' || row.custodyState === 'suppressed') continue;
    if (row.custodyState !== 'open' && row.custodyState !== 'completed')
      return unavailable('recognized native effect custody state');
    event.consumers.push({ name: row.consumer, workflowId: row.workflowId });
  }

  for (const group of envelopes.values()) {
    if (group.events.size !== group.eventCount) return unavailable('complete native Collection event envelope');
    const events = [...group.events.values()].sort((left, right) => left.sequence - right.sequence);
    for (let sequence = 0; sequence < group.eventCount; sequence++)
      if (events[sequence]?.sequence !== sequence) return unavailable('contiguous native Collection event sequence');
    group.value.events = events.map((event) => event.value);
  }
  return [...envelopes.values()].sort((left, right) => compareEnvelope(left.value, right.value));
}

/** Redeliver retained Collection outbox slots through the installed durable effect workflow. */
export async function replayProjectionEvents(
  world: NativeDynamicReplayWorld,
  order: 'forward' | 'reverse',
): Promise<void> {
  const rows = await world.native.reader.query<ReplayRow>(committedProjectionEnvelopes, [collectionEventPattern]);
  const envelopes = captureEnvelopes(rows.rows);
  if (order === 'reverse') envelopes.reverse();

  for (const envelope of envelopes) {
    const events = [...envelope.events.values()].sort((left, right) => left.sequence - right.sequence);
    if (order === 'reverse') events.reverse();
    for (const event of events) {
      if (!event.value.type.startsWith('com.rezics.library.collection.')) continue;
      for (const consumer of event.consumers) {
        await world.native.workClient.enqueue(
          {
            workflowName: effectWorkflow,
            workflowID: consumer.workflowId,
            workflowIDReusePolicy: 'return-existing',
            queueName: ERASURE_LOCATOR_EFFECTS.has(consumer.name) ? LOCATOR_EFFECTS_QUEUE : EFFECTS_QUEUE,
            queuePartitionKey: `${consumer.name}:${envelope.value.partition}`,
          },
          consumer.name,
          event.value,
        );
      }
    }
  }
  await world.settle();
}
