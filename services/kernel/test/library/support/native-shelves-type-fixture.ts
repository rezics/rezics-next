import { createAccess } from '../../../src/access/index.ts';
import { accessCheck } from '../../../src/request/access.ts';
import { deadlineFor } from '../../../src/request/deadline.ts';
import { SHELF_TYPE_SYNC_WORKFLOW, shelfTypeSyncWorkflowId } from '../../../src/library/shelf-contract.ts';
import { routeOf } from '../../../src/route/route.ts';
import { activeRelease } from '../../../src/semantic/definitions.ts';
import { updateSubjectIdentity } from '../../../src/semantic/subject.ts';
import { issuer } from '../../access/native-account-bindings-fixture.ts';
import { unavailable, type NativeConformanceWorld } from './native-conformance.ts';

/** Bind producers to the same database, Auth host and executor as the shelf driver. */
export function createNativeShelvesTypeFixture(world: NativeConformanceWorld) {
  const { pool, reader, workClient, accountHost } = world.native;
  const access = createAccess({
    actions: new Map([['subject:create', { anonymous: false }]]),
    clock: () => new Date(world.now()),
    auth: {
      issuer,
      audience: 'https://ordinary.api.test',
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async (location, init) => accountHost.service.handler(new Request(location, init)),
    },
  });
  return {
    async changeSubjectType(subjectId: string, type: string): Promise<{ revision: number }> {
      const route = routeOf(subjectId);
      if (route === null) throw new TypeError('Subject id must carry a valid route');
      const context = { pool, deadline: deadlineFor(30_000) };
      const actor = await access.authenticate(world.native.token('steward'), context);
      const authorize = await accessCheck(access, actor, 'subject:create', { route, id: subjectId }, context);
      const release = await activeRelease(pool);
      if (!release) return unavailable('semantic/definitions.ts:activeRelease');
      const command = await updateSubjectIdentity(pool, {
        subject: subjectId,
        type,
        release,
        authorize,
        deadline: context.deadline,
        clock: () => new Date(world.now()),
      });
      return command.value;
    },
    async redeliver(input: { subjectId: string; order: 'repeat' | 'reverse' }): Promise<void> {
      // Finish original deliveries before asking the SDK to execute their consumers again.
      await world.settle();
      const events = (
        await reader.query<{ partition: number; position: string; eventSeq: number; data: { revision: number } }>(
          `SELECT partition_no AS partition,position::text,event_seq AS "eventSeq",data
           FROM core.outbox WHERE type='com.rezics.subject.revised.v1' AND subject=$1
           ORDER BY partition_no,position,event_seq`,
          [input.subjectId],
        )
      ).rows;
      if (events.length === 0) return unavailable('core.outbox: recorded subject.revised event');
      // Other subject.revised consumers cannot stand in for Library's type consumer.
      // Refuse an absent owner binding before replaying any unrelated effects.
      for (const event of events) {
        const sync = await workClient.getWorkflow(shelfTypeSyncWorkflowId({
          kind: 'revised', subjectId: input.subjectId, revision: event.data.revision,
        }));
        if (sync?.workflowName !== SHELF_TYPE_SYNC_WORKFLOW)
          return unavailable(
            'library/shelf-contract.ts:syncShelfSubjectType(change: ShelfTypeChange, dependencies: ShelfProjectionDependencies); library.shelfTypeSync subject.revised consumer registration',
          );
      }
      if (input.order === 'reverse') events.reverse();
      for (const event of events) {
        const consumers = (
          await reader.query<{ workflowId: string }>(
            `SELECT workflow_id AS "workflowId" FROM core.history_event_consumer
             WHERE partition_no=$1 AND position=$2 AND event_seq=$3 ORDER BY consumer`,
            [event.partition, event.position, event.eventSeq],
          )
        ).rows;
        if (consumers.length === 0) return unavailable('events/effects.ts: registered subject.revised consumer');
        for (const { workflowId } of consumers) {
          const original = await workClient.getWorkflow(workflowId);
          if (!original || original.workflowName !== 'effect' || !original.queueName)
            return unavailable(`events/effects.ts: native redelivery for ${workflowId}`);
          // Step zero reruns effect.run with the SDK's retained original arguments. Forking
          // keeps the original receipts; the event id/data and downstream deduplication keys
          // stay intact. Re-enqueueing the completed original would never enter its consumer.
          const replay = await workClient.forkWorkflow(workflowId, 0, {
            queueName: original.queueName,
            ...(original.queuePartitionKey === undefined ? {} : { queuePartitionKey: original.queuePartitionKey }),
          });
          await workClient.retrieveWorkflow(replay).getResult();
        }
      }
      await world.settle();
    },
  };
}
