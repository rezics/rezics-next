import { effectWorkflowId } from '../events/effects.ts';
import type { Envelope } from '../events/log.ts';

/** Native DBOS workflow names owned by the content worker. */
export const CONTENT_WORKFLOWS = {
  image: 'content.image',
  purge: 'content.purge',
  collect: 'content.collect',
} as const;

/** DBOS queues are provisioned by the corresponding kernel/content runtime. */
export const CONTENT_QUEUES = {
  image: 'effects',
  purge: 'governance',
  collect: 'maintenance',
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

/**
 * Use the kernel effect identity scheme for event position and sequence. Purge adds mediaId because a
 * single erasure event can enqueue independent cleanup for several media objects.
 */
export function contentWorkWorkflowId(
  envelope: Pick<Envelope, 'epoch' | 'partition' | 'position'>,
  eventIndex: number,
  kind: 'image' | 'purge',
  mediaId?: string,
): string {
  if (!Number.isSafeInteger(eventIndex) || eventIndex < 0)
    throw new RangeError('eventIndex must be a non-negative integer');
  if (kind === 'purge' && (mediaId === undefined || mediaId.length === 0)) {
    throw new RangeError('purge work requires a mediaId');
  }
  if (kind === 'image' && mediaId !== undefined)
    throw new RangeError('image work does not accept a mediaId in its identity');
  const effectName = kind === 'image' ? 'content_image' : `content_purge_${mediaId}`;
  return effectWorkflowId(envelope as Envelope, eventIndex, effectName);
}
