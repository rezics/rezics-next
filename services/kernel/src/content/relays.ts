import type { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { Effect } from '../events/effects.ts';
import { projectBatch, type Envelope } from '../events/log.ts';
import type { Relay } from '../events/relays.ts';
import { WORK_APPLICATION } from '../work/client.ts';
import { createBoardEffect } from './board-projection.ts';
import type { ContentEventData } from './events.ts';
import { createReportEffect } from './report-effect.ts';
import {
  CONTENT_QUEUES,
  CONTENT_WORKFLOWS,
  MEDIA_WORK_EVENTS,
  contentWorkQueueOptions,
  contentWorkSource,
  contentWorkWorkflowId,
  type ContentWorkInput,
} from './work-contract.ts';

/** Pure projection adapters own target positions/revisions; the shared reader owns source checkpoints. */
function projectionRelay(pool: Pool, consumer: string, createEffect: (pool: Pool) => Effect): Relay {
  let effect: Effect | undefined;
  return {
    consumer,
    run: (partition) =>
      projectBatch(pool, {
        consumer,
        partition,
        async apply(envelopes) {
          effect ??= createEffect(pool);
          for (const envelope of envelopes) {
            for (const event of envelope.events) {
              if (effect.types.includes(event.type)) await effect.run(event);
            }
          }
        },
      }),
  };
}

async function enqueueMedia(client: DBOSClient, envelopes: readonly Envelope[]): Promise<void> {
  for (const envelope of envelopes) {
    for (const [eventIndex, event] of envelope.events.entries()) {
      const kind =
        event.type === MEDIA_WORK_EVENTS.image
          ? 'image'
          : MEDIA_WORK_EVENTS.purge.some((type) => type === event.type)
            ? 'purge'
            : undefined;
      if (kind === undefined) continue;
      // projectBatch has validated the closed event schema. Authored bytes and event permission
      // claims never cross this boundary: the worker resolves authoritative media state itself.
      const { mediaId } = event.data as ContentEventData<
        typeof MEDIA_WORK_EVENTS.image | (typeof MEDIA_WORK_EVENTS.purge)[number]
      >;
      const input: ContentWorkInput = { mediaId, source: contentWorkSource(envelope, eventIndex) };
      await client.enqueue(
        {
          applicationName: WORK_APPLICATION,
          workflowName: CONTENT_WORKFLOWS[kind],
          queueName: CONTENT_QUEUES[kind],
          workflowID: contentWorkWorkflowId(envelope, eventIndex, kind, kind === 'purge' ? mediaId : undefined),
          workflowIDReusePolicy: 'return-existing',
          ...(kind === 'image' ? contentWorkQueueOptions(envelope) : {}),
        },
        input,
      );
    }
  }
}

/** Append these consumers to the kernel's one startRelays list. The trusted client uses the bounded dbos pool. */
export function contentRelays(pool: Pool, client: DBOSClient): Relay[] {
  return [
    projectionRelay(pool, 'content_board', createBoardEffect),
    projectionRelay(pool, 'content_reports', createReportEffect),
    {
      consumer: 'content_media',
      run: (partition) =>
        projectBatch(pool, { consumer: 'content_media', partition, apply: (batch) => enqueueMedia(client, batch) }),
    },
  ];
}
