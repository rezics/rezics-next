import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent, Envelope } from '../events/log.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { WORK_APPLICATION, type WorkClient } from '../work/client.ts';
import { createBoardEffect } from './board-projection.ts';
import { bindAuthorErasureWorkflow } from './erasure-workflow-identity.ts';
import { CONTENT_EVENTS } from './events.ts';
import { SEMANTIC_EVENTS, SUBJECT_MERGED } from '../semantic/events.ts';
import { createModerationDecisionEffect } from './moderation-decisions.ts';
import { createReportOutcomeEffect } from './report-outcomes.ts';
import { createReportEffect } from './report-effect.ts';
import { createMentionNoticeEffect } from './mention-notices.ts';
import { createReplyNoticeEffect } from './reply-notices.ts';
import readOutboxEvent from './read-outbox-event-index.sql';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  MEDIA_WORK_EVENTS,
  contentWorkQueueOptions,
  contentWorkSource,
  contentWorkWorkflowId,
  subjectReactionMergeWorkflowId,
} from './work-contract.ts';

const authorRequested = 'com.rezics.content.author-erasure.requested.v1';
const importRequested = 'com.rezics.content.media.import-requested.v1';
type EnqueueKind = 'image' | 'purge' | 'authorErase' | 'importFromUrl';
type Source = { partition: number; epoch: number; position: bigint };

function sourceIdentity(event: CloudEvent, objectId: string): Source {
  const source = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const partition = Number(source?.[1]);
  const epoch = Number(source?.[2]);
  const route = routeOf(objectId);
  if (
    !source ||
    route === null ||
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    partition !== partitionOf(route) ||
    !Number.isInteger(epoch) ||
    epoch > 2147483647 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id) ||
    !/^[0-9]{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n ||
    BigInt(event.sequence) > 9223372036854775807n ||
    event.specversion !== '1.0' ||
    event.datacontenttype !== 'application/json'
  )
    throw new TypeError('Invalid native content work source identity');
  return { partition, epoch, position: BigInt(event.sequence) };
}

/** CloudEvent.sequence is a position, not an event index. Recover the real index
 * by identity within that one bounded native envelope (the outbox PK prefix).
 * The shared effects relay alone validates envelopes and owns checkpoints. */
async function eventIndex(client: Pick<PoolClient, 'query'>, source: Source, event: CloudEvent): Promise<number> {
  const rows = await readOutboxEvent.run(client, {
    partition_no: source.partition,
    position: source.position,
    epoch: source.epoch,
    id: event.id,
    type: event.type,
    subject: event.subject ?? null,
    data: event.data,
  });
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !Number.isInteger(row.event_seq) ||
    row.event_seq < 0 ||
    row.event_seq >= row.event_count ||
    row.event_count > 1000
  )
    throw new TypeError('Content work event has no unique native source index');
  return row.event_seq;
}

async function bindErasure(pool: Pool, source: Source, event: CloudEvent, operationId: string) {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const anchor = await readPartition(client, source.partition);
      if (
        !anchor ||
        anchor.writeState === 'moved' ||
        source.epoch > anchor.epoch ||
        (source.epoch === anchor.epoch && source.position > anchor.position)
      )
        throw new Error('Author-erasure source partition is unavailable');
      const index = await eventIndex(client, source, event);
      // Only the actual indexed requested event is needed by the binder. No event
      // ordering is inferred, and no unrelated authored payload is loaded.
      const events: CloudEvent[] = [];
      events[index] = event;
      const envelope: Envelope = { ...source, events };
      const workflowID = await bindAuthorErasureWorkflow(client, operationId, envelope, index);
      await client.query('COMMIT');
      return { index, workflowID };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function enqueueEffect(pool: Pool, client: WorkClient, name: string, types: string[], kind: EnqueueKind): Effect {
  return {
    name,
    types,
    async run(event) {
      if (!types.includes(event.type) || !Object.hasOwn(CONTENT_EVENTS, event.type))
        throw new TypeError('Unsupported content work event');
      const schema = CONTENT_EVENTS[event.type as keyof typeof CONTENT_EVENTS];
      if (!Value.Check(schema, event.data)) throw new TypeError('Invalid content work event data');
      const data = event.data as { mediaId?: string; operationId?: string };
      const objectId = (kind === 'authorErase' ? data.operationId : data.mediaId)!;
      const source = sourceIdentity(event, objectId);
      // Release the source connection/transaction before native durable enqueue.
      // Binding may commit before enqueue fails; replay binds the same identity.
      const { index, workflowID } =
        kind === 'authorErase'
          ? await bindErasure(pool, source, event, objectId)
          : await withConnection(pool, async (connection) => {
              const index = await eventIndex(connection, source, event);
              return {
                index,
                workflowID: contentWorkWorkflowId(source, index, kind, kind === 'image' ? undefined : objectId),
              };
            });
      await client.enqueue(
        {
          applicationName: WORK_APPLICATION,
          workflowName: CONTENT_WORKFLOWS[kind],
          queueName: CONTENT_QUEUES[kind],
          workflowID,
          workflowIDReusePolicy: 'return-existing',
          ...(CONTENT_QUEUES[kind] === 'effects' || CONTENT_QUEUES[kind] === 'import'
            ? contentWorkQueueOptions(source)
            : {}),
        },
        {
          ...(kind === 'authorErase' ? { operationId: objectId } : { mediaId: objectId }),
          source: contentWorkSource(source, index),
        },
      );
    },
  };
}

function enqueueSubjectReactionMergeEffect(pool: Pool, client: WorkClient): Effect {
  return {
    name: 'content_subject_reaction_merge',
    types: [SUBJECT_MERGED],
    async run(event) {
      if (event.type !== SUBJECT_MERGED || !Value.Check(SEMANTIC_EVENTS[SUBJECT_MERGED], event.data))
        throw new TypeError('Invalid subject merge work event');
      const data = event.data as { id: string; survivor: string };
      if (event.subject !== data.id) throw new TypeError('Subject merge event identity does not match its subject');
      const source = sourceIdentity(event, data.id);
      const { index, workflowID } = await withConnection(pool, async (connection) => {
        const index = await eventIndex(connection, source, event);
        return {
          index,
          workflowID: subjectReactionMergeWorkflowId({ ...source, position: source.position }, index, data.id),
        };
      });
      await client.enqueue(
        {
          applicationName: WORK_APPLICATION,
          workflowName: CONTENT_WORKFLOWS.subjectReactionMerge,
          queueName: CONTENT_QUEUES.subjectReactionMerge,
          workflowID,
          workflowIDReusePolicy: 'return-existing',
          queuePartitionKey: String(source.partition),
        },
        { id: data.id, survivor: data.survivor, source: contentWorkSource(source, index) },
      );
    },
  };
}

/** Add once through WorkContext.addEffects before the sole worker is launched.
 * This static list owns no runner, workflow registration or checkpoint. */
export function contentEffects(pool: Pool, client: WorkClient): Effect[] {
  return [
    createBoardEffect(pool),
    createReportEffect(pool),
    createReportOutcomeEffect(pool),
    createModerationDecisionEffect(pool),
    enqueueEffect(pool, client, 'content_media_image', [MEDIA_WORK_EVENTS.image], 'image'),
    enqueueEffect(pool, client, 'content_media_purge', [...MEDIA_WORK_EVENTS.purge], 'purge'),
    enqueueEffect(pool, client, 'content_author_erasure', [authorRequested], 'authorErase'),
    enqueueEffect(pool, client, 'content_url_import', [importRequested], 'importFromUrl'),
    enqueueSubjectReactionMergeEffect(pool, client),
  ];
}

/** The production registration shares one worker Access instance across content notices. */
export function contentNoticeEffects(pool: Pool, access: Access): Effect[] {
  return [createMentionNoticeEffect(pool, access), createReplyNoticeEffect(pool, access)];
}
