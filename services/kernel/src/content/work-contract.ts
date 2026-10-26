import { effectWorkflowId } from '../events/effects.ts';
import type { Envelope } from '../events/log.ts';

/** Native DBOS workflow names owned by the content worker. */
export const CONTENT_WORKFLOWS = {
  image: 'content.image',
  purge: 'content.purge',
  collect: 'content.collect',
  authorErase: 'content.authorErase',
  importFromUrl: 'content.importFromUrl',
  subjectReactionMerge: 'content.subjectReactionMerge',
} as const;

/** DBOS queues are provisioned by the corresponding kernel/content runtime. */
export const CONTENT_QUEUES = {
  image: 'effects',
  purge: 'governance',
  collect: 'maintenance',
  authorErase: 'governance',
  importFromUrl: 'import',
  subjectReactionMerge: 'effects',
} as const;

export const MEDIA_WORK_EVENTS = {
  image: 'com.rezics.content.media.uploaded.v1',
  purge: ['com.rezics.content.media.erased.v1', 'com.rezics.content.media.rejected.v1'],
} as const;

export type ContentWorkKind = keyof typeof CONTENT_WORKFLOWS;

/** The minimal source identity sent to a durable worker; position is decimal to preserve bigint exactly. */
export type ContentWorkSource = {
  epoch: number;
  partition: number;
  position: string;
  eventIndex: number;
};

/** ID-only media work input. The worker must resolve current authoritative state before acting. */
export type ContentWorkInput = {
  mediaId: string;
  source: ContentWorkSource;
};

/** ID-only author erasure request; the workflow resolves its operation state when it runs. */
export type AuthorEraseWorkInput = {
  operationId: string;
  source: ContentWorkSource;
};

/** ID-only URL import request; the workflow resolves the source URL and current state when it runs. */
export type ImportFromUrlWorkInput = {
  mediaId: string;
  source: ContentWorkSource;
};

/** A semantic merge event starts a bounded sweep of the merged subject's reactors. */
export type SubjectReactionMergeWorkInput = {
  id: string;
  survivor: string;
  source: ContentWorkSource;
};

/** Convert a kernel log envelope to the serializable source identity used by DBOS inputs. */
export function contentWorkSource(
  envelope: Pick<Envelope, 'epoch' | 'partition' | 'position'>,
  eventIndex: number,
): ContentWorkSource {
  return {
    epoch: envelope.epoch,
    partition: envelope.partition,
    position: envelope.position.toString(),
    eventIndex,
  };
}

/** Immutable options for enqueueing source-partitioned image work on the effects queue. */
export function contentWorkQueueOptions(
  envelope: Pick<Envelope, 'partition'>,
): Readonly<{ queuePartitionKey: string }> {
  return Object.freeze({ queuePartitionKey: String(envelope.partition) });
}

/**
 * Use the kernel effect identity scheme for event position and sequence. Object-specific work adds its
 * operation or media ID so one source event can enqueue independent work for several objects.
 */
export function contentWorkWorkflowId(
  envelope: Pick<Envelope, 'epoch' | 'partition' | 'position'>,
  eventIndex: number,
  kind: 'image' | 'purge' | 'authorErase' | 'importFromUrl',
  objectId?: string,
): string {
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0)
    throw new RangeError('eventIndex must be a non-negative integer');
  const objectIdRequired = kind === 'purge' || kind === 'authorErase' || kind === 'importFromUrl';
  if (objectIdRequired && (objectId === undefined || objectId.length === 0)) {
    const label = kind === 'authorErase' ? 'operationId' : 'mediaId';
    throw new RangeError(`${kind} work requires a ${label}`);
  }
  if (kind === 'image' && objectId !== undefined)
    throw new RangeError('image work does not accept a mediaId in its identity');
  const effectName =
    kind === 'image'
      ? 'content_image'
      : kind === 'purge'
        ? `content_purge_${objectId}`
        : kind === 'authorErase'
          ? `content_author_erase_${objectId}`
          : `content_import_from_url_${objectId}`;
  return effectWorkflowId(envelope as Envelope, eventIndex, effectName);
}

/** One durable merge job per source event and merged subject. */
export function subjectReactionMergeWorkflowId(
  envelope: Pick<Envelope, 'epoch' | 'partition' | 'position'>,
  eventIndex: number,
  mergedId: string,
): string {
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0)
    throw new RangeError('eventIndex must be a non-negative integer');
  if (mergedId.length === 0) throw new RangeError('A merged subject ID is required');
  return effectWorkflowId(envelope as Envelope, eventIndex, `content_subject_reaction_merge_${mergedId}`);
}
