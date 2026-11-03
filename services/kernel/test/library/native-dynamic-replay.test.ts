import { expect, test } from 'bun:test';
import { effectWorkflowId } from '../../src/events/effects.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import type { NativeConformanceWorld } from './support/native-conformance.ts';
import { replayProjectionEvents, type NativeDynamicReplayWorld } from './support/native-dynamic-replay.ts';

const collectionId = '11111111-1111-4111-8111-111111111111';
const subjectId = '22222222-2222-4222-8222-222222222222';
const memberId = '33333333-3333-4333-8333-333333333333';

function row(input: {
  position: string;
  eventSeq: number;
  eventCount: number;
  id: string;
  type: string;
  data: unknown;
  consumer?: string;
  custodyState?: string;
}) {
  const envelope = { partition: 7, epoch: 4, position: BigInt(input.position), events: [] };
  const consumer = input.consumer ?? null;
  return {
    partition: envelope.partition,
    epoch: envelope.epoch,
    position: input.position,
    eventSeq: input.eventSeq,
    eventCount: input.eventCount,
    id: input.id,
    type: input.type,
    subject: collectionId,
    time: '2026-11-03T04:05:06.123456Z',
    data: input.data,
    payloadState: 'present',
    consumer,
    workflowId: consumer ? effectWorkflowId(envelope, input.eventSeq, consumer) : null,
    custodyState: input.custodyState ?? (consumer ? 'completed' : null),
  };
}

test('Collection replay preserves committed event identity and queues retained effects in the requested order', async () => {
  const rows = [
    row({
      position: '20',
      eventSeq: 0,
      eventCount: 2,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'com.rezics.library.collection.updated.v1',
      data: { collectionId },
      consumer: 'content_feed_activity',
    }),
    row({
      position: '20',
      eventSeq: 1,
      eventCount: 2,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      type: 'com.rezics.library.collection.listing.changed.v1',
      data: { collectionId },
      consumer: 'library_collection_listing',
    }),
    row({
      position: '21',
      eventSeq: 0,
      eventCount: 1,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'com.rezics.library.collection.member.changed.v1',
      data: { collectionId, memberId, subjectId },
      consumer: 'library_member_listing',
    }),
    row({
      position: '21',
      eventSeq: 0,
      eventCount: 1,
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      type: 'com.rezics.library.collection.member.changed.v1',
      data: { collectionId, memberId, subjectId },
      consumer: 'library_native_transfer',
      custodyState: 'transferred',
    }),
  ];
  const calls: { options: Record<string, unknown>; name: string; event: CloudEvent }[] = [];
  let settled = 0;
  const world = {
    native: {
      reader: {
        async query() {
          return { rows };
        },
      },
      workClient: {
        async enqueue(options: Record<string, unknown>, name: string, event: CloudEvent) {
          calls.push({ options, name, event });
          return {};
        },
      },
    },
    async settle() {
      settled++;
    },
  } as unknown as NativeDynamicReplayWorld & NativeConformanceWorld;

  await replayProjectionEvents(world, 'reverse');
  expect(calls.map(({ name, options }) => [name, options.workflowID])).toEqual([
    [
      'library_member_listing',
      effectWorkflowId({ partition: 7, epoch: 4, position: 21n, events: [] }, 0, 'library_member_listing'),
    ],
    [
      'library_collection_listing',
      effectWorkflowId({ partition: 7, epoch: 4, position: 20n, events: [] }, 1, 'library_collection_listing'),
    ],
    [
      'content_feed_activity',
      effectWorkflowId({ partition: 7, epoch: 4, position: 20n, events: [] }, 0, 'content_feed_activity'),
    ],
  ]);
  expect(calls[0]?.event).toMatchObject({
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    source: 'urn:rezics:log:7.4',
    type: 'com.rezics.library.collection.member.changed.v1',
    subject: collectionId,
    time: '2026-11-03T04:05:06.123456Z',
    sequence: '0000000000000000021',
    data: { collectionId, memberId, subjectId },
  });
  expect(
    calls.every(
      ({ options }) => options.workflowName === 'effect' && options.workflowIDReusePolicy === 'return-existing',
    ),
  ).toBe(true);
  expect(settled).toBe(1);

  calls.length = 0;
  await replayProjectionEvents(world, 'forward');
  expect(calls.map(({ name }) => name)).toEqual([
    'content_feed_activity',
    'library_collection_listing',
    'library_member_listing',
  ]);
  expect(settled).toBe(2);
});
