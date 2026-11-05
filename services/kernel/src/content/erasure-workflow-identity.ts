import type { PoolClient } from 'pg';
import { Value } from 'typebox/value';
import type { Envelope } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import bind from './bind-erasure-workflow.sql';
import { OPERATION_EVENTS } from '../events/contracts/content-operation.ts';
import { contentWorkSource, contentWorkWorkflowId } from './work-contract.ts';

/**
 * Internal trusted projection primitive; returns the deterministic native workflow ID.
 * The caller owns this transaction client (Pick<PoolClient, 'query'>, the existing
 * command/storage client shape) and has independently anchored its partition.
 * It must possess the validated actual requested-event Envelope, not caller JSON
 * or an asserted workflow ID/actor. This helper is no authorization or API proof.
 *
 * Use the native projection transaction/checkpoint pattern: bind before the
 * durable relay orchestration enqueues native work. The caller owns commit,
 * rollback and checkpointing; no checkout, enqueue or DBOS step occurs here.
 * This stores identity only. DBOS owns job/progress/status/retry and the workflow
 * must still bind its final native author-erasure outcome. HTTP remains pending
 * before binding. One exact (route, operation_id) update costs O(log(Ut)), with
 * constant rows/statements; only the supplied event in a <=1000-event source is read.
 */
export async function bindAuthorErasureWorkflow(
  client: Pick<PoolClient, 'query'>,
  operationId: string,
  envelope: Envelope,
  eventIndex: number,
): Promise<string> {
  const route = routeOf(operationId);
  if (
    route === null ||
    !envelope ||
    !Number.isInteger(envelope.epoch) ||
    envelope.epoch < 1 ||
    envelope.epoch > 2147483647 ||
    envelope.partition !== partitionOf(route) ||
    typeof envelope.position !== 'bigint' ||
    envelope.position < 1n ||
    envelope.position > 9223372036854775807n ||
    !Array.isArray(envelope.events) ||
    envelope.events.length > 1000 ||
    !Number.isInteger(eventIndex) ||
    eventIndex < 0 ||
    eventIndex >= envelope.events.length
  )
    throw new RangeError('Invalid native author-erasure source identity or event index');

  const event = envelope.events[eventIndex];
  const type = 'com.rezics.content.author-erasure.requested.v1';
  if (!event || event.type !== type || !Value.Check(OPERATION_EVENTS[type], event.data))
    throw new RangeError('Expected the actual author-erasure requested event');
  if (event.data.operationId !== operationId) throw new RangeError('Requested event does not identify this operation');

  const workflowId = contentWorkWorkflowId(envelope, eventIndex, 'authorErase', operationId);
  const source = contentWorkSource(envelope, eventIndex);
  const parameters: (typeof bind)['~reylo']['input'] = {
    route,
    operation_id: operationId,
    thread_id: event.data.threadId,
    author_account_id: event.data.authorId,
    native_workflow_id: workflowId,
    source_epoch: source.epoch,
    source_partition: source.partition,
    source_position: envelope.position,
    source_event_index: source.eventIndex,
  };
  // Execute Reylo's compiled typed statement without its periodic catalogue
  // freshness query, preserving exactly one statement even on a fresh connection.
  const { rows } = await client.query<(typeof bind)['~reylo']['element']>(
    bind.sql,
    bind.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  if (rows.length !== 1) throw new Error('Operation is missing, has a different scope or is already bound elsewhere');
  return workflowId;
}
