import { expect, test } from 'bun:test';
import { effectWorkflowId } from '../../src/events/effects.ts';
import {
  CONTENT_WORKFLOWS,
  CONTENT_QUEUES,
  MEDIA_WORK_EVENTS,
  contentWorkWorkflowId,
  type ContentWorkInput,
} from '../../src/content/work-contract.ts';
import type { Envelope } from '../../src/events/log.ts';

test('content media work names and queues match the DBOS application contract', () => {
  expect(CONTENT_WORKFLOWS).toEqual({ image: 'content.image', purge: 'content.purge', collect: 'content.collect' });
  expect(CONTENT_QUEUES).toEqual({ image: 'effects', purge: 'governance', collect: 'maintenance' });
  expect(MEDIA_WORK_EVENTS).toEqual({
    image: 'com.rezics.content.media.uploaded.v1',
    purge: ['com.rezics.content.media.erased.v1', 'com.rezics.content.media.rejected.v1'],
  });
});

test('work identity uses source position and event index, separating work kinds and purge media', () => {
  const envelope: Envelope = {
    epoch: 4,
    partition: 29,
    position: 9007199254740994n,
    events: [],
  };
  expect(contentWorkWorkflowId(envelope, 2, 'image')).toBe(effectWorkflowId(envelope, 2, 'content_image'));
  expect(contentWorkWorkflowId(envelope, 2, 'image')).toBe(contentWorkWorkflowId(envelope, 2, 'image'));
  expect(contentWorkWorkflowId(envelope, 2, 'image')).not.toBe(contentWorkWorkflowId(envelope, 2, 'purge', 'media-a'));
  expect(contentWorkWorkflowId(envelope, 2, 'purge', 'media-a')).not.toBe(
    contentWorkWorkflowId(envelope, 2, 'purge', 'media-b'),
  );
  expect(contentWorkWorkflowId(envelope, 3, 'image')).not.toBe(contentWorkWorkflowId(envelope, 2, 'image'));
});

test('workflow inputs carry only media ID and source envelope identity', () => {
  const input: ContentWorkInput = {
    mediaId: 'media-123',
    source: { epoch: 4, partition: 29, position: '17', eventIndex: 1 },
  };
  expect(input).toEqual({ mediaId: 'media-123', source: { epoch: 4, partition: 29, position: '17', eventIndex: 1 } });
  expect(Object.keys(input)).toEqual(['mediaId', 'source']);
  expect(Object.keys(input.source)).toEqual(['epoch', 'partition', 'position', 'eventIndex']);
});
