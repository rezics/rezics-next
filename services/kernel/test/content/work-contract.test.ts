import { expect, test } from 'bun:test';
import { effectWorkflowId } from '../../src/events/effects.ts';
import {
  CONTENT_WORKFLOWS,
  CONTENT_QUEUES,
  MEDIA_WORK_EVENTS,
  contentWorkQueueOptions,
  contentWorkSource,
  contentWorkWorkflowId,
  subjectReactionMergeWorkflowId,
  type ContentWorkInput,
  type AuthorEraseWorkInput,
  type ImportFromUrlWorkInput,
  type SubjectReactionMergeWorkInput,
} from '../../src/content/work-contract.ts';
import type { Envelope } from '../../src/events/log.ts';

test('content media work names and queues match the DBOS application contract', () => {
  expect(CONTENT_WORKFLOWS).toEqual({
    image: 'content.image',
    purge: 'content.purge',
    collect: 'content.collect',
    authorErase: 'content.authorErase',
    importFromUrl: 'content.importFromUrl',
    subjectReactionMerge: 'content.subjectReactionMerge',
  });
  expect(CONTENT_QUEUES).toEqual({
    image: 'effects',
    purge: 'governance',
    collect: 'maintenance',
    authorErase: 'governance',
    importFromUrl: 'import',
    subjectReactionMerge: 'effects',
  });
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
  expect(contentWorkWorkflowId(envelope, 2, 'authorErase', 'operation-a')).toBe(
    effectWorkflowId(envelope, 2, 'content_author_erase_operation-a'),
  );
  expect(contentWorkWorkflowId(envelope, 2, 'authorErase', 'operation-a')).not.toBe(
    contentWorkWorkflowId(envelope, 2, 'authorErase', 'operation-b'),
  );
  expect(contentWorkWorkflowId(envelope, 2, 'importFromUrl', 'media-a')).toBe(
    effectWorkflowId(envelope, 2, 'content_import_from_url_media-a'),
  );
  expect(contentWorkWorkflowId(envelope, 2, 'importFromUrl', 'media-a')).not.toBe(
    contentWorkWorkflowId(envelope, 2, 'importFromUrl', 'media-b'),
  );
  expect(contentWorkWorkflowId(envelope, 2, 'importFromUrl', 'media-a')).toBe(
    contentWorkWorkflowId(envelope, 2, 'importFromUrl', 'media-a'),
  );
  expect(subjectReactionMergeWorkflowId(envelope, 2, 'subject-a')).toBe(
    effectWorkflowId(envelope, 2, 'content_subject_reaction_merge_subject-a'),
  );
  expect(subjectReactionMergeWorkflowId(envelope, 2, 'subject-a')).not.toBe(
    subjectReactionMergeWorkflowId(envelope, 2, 'subject-b'),
  );
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

test('new durable requests carry only IDs and the actual source envelope identity', () => {
  const envelope: Envelope = { epoch: 8, partition: 51, position: 9007199254740994n, events: [] };
  const authorErase: AuthorEraseWorkInput = {
    operationId: 'operation-1',
    source: contentWorkSource(envelope, 3),
  };
  const importFromUrl: ImportFromUrlWorkInput = {
    mediaId: 'media-1',
    source: contentWorkSource(envelope, 4),
  };
  const subjectReactionMerge: SubjectReactionMergeWorkInput = {
    id: 'subject-1',
    survivor: 'subject-0',
    source: contentWorkSource(envelope, 5),
  };

  expect(authorErase).toEqual({
    operationId: 'operation-1',
    source: { epoch: 8, partition: 51, position: '9007199254740994', eventIndex: 3 },
  });
  expect(importFromUrl).toEqual({
    mediaId: 'media-1',
    source: { epoch: 8, partition: 51, position: '9007199254740994', eventIndex: 4 },
  });
  expect(subjectReactionMerge).toEqual({
    id: 'subject-1',
    survivor: 'subject-0',
    source: { epoch: 8, partition: 51, position: '9007199254740994', eventIndex: 5 },
  });
  expect(Object.keys(authorErase)).toEqual(['operationId', 'source']);
  expect(Object.keys(importFromUrl)).toEqual(['mediaId', 'source']);
  expect(Object.keys(subjectReactionMerge)).toEqual(['id', 'survivor', 'source']);
  expect(Object.keys(authorErase.source)).toEqual(['epoch', 'partition', 'position', 'eventIndex']);
  expect(Object.keys(importFromUrl.source)).toEqual(['epoch', 'partition', 'position', 'eventIndex']);
  expect(Object.keys(subjectReactionMerge.source)).toEqual(['epoch', 'partition', 'position', 'eventIndex']);
});

test('image enqueue uses the source partition as immutable queue options, outside the job payload', () => {
  const envelope: Envelope = { epoch: 1, partition: 23, position: 7n, events: [] };
  const options = contentWorkQueueOptions(envelope);
  expect(options).toEqual({ queuePartitionKey: '23' });
  expect(Object.isFrozen(options)).toBe(true);
  expect(Object.keys(options)).toEqual(['queuePartitionKey']);
});
