import { DBOS } from '@dbos-inc/dbos-sdk';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { authoritativeTimeValue, noEffect, runCommand, type CommandAuthorization } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { workStepDeadline } from './command-support.ts';
import {
  COLLECTION_ORDER_WORKFLOW,
  collectionOrderEvent,
  lockOrderParent,
  type CollectionOrderLocator,
  type OrderParent,
} from './collection-order.ts';
import { orderRepairKeys, ORDER_WINDOW_SIZE } from './ordinal.ts';

type Repair = {
  repairId: string;
  admittedCount: number;
  minimum: string;
  lower: string;
  upper: string;
  revision: number;
  sourceGeneration: string;
  orderEpoch: number;
  processed: number;
  step: number;
  afterKey: string | null;
  afterMemberId: string | null;
  state: string;
};
type Raw = { memberId: string; ordinalKey: string; active: boolean };

/** One native transaction, driven only by an immutable locator and its captured
 * fences. There is no retained Actor, JWT, authorization decision or previous T.
 * Replayed/out-of-order work cannot write: both the incarnation and step must match.
 */
export async function advanceCollectionOrderRepair(
  context: Pick<WorkContext, 'pool' | 'clock'>,
  locator: CollectionOrderLocator,
) {
  const route = routeOf(locator.collectionId);
  if (route === null || routeOf(locator.repairId) !== route || !Number.isSafeInteger(locator.step) || locator.step < 0)
    throw new TypeError('Invalid order repair locator');
  let repair: Repair | undefined;
  let parent: OrderParent | null = null;
  let terminal = false;
  const authorization: CommandAuthorization = {
    action: 'library:collection-order-maintenance',
    resource: { route, id: locator.collectionId },
    denied: () => new Error('Invalid native Collection order repair'),
    async authorize(tx) {
      parent = await lockOrderParent(tx, route, locator.collectionId);
      repair = (
        await tx.query<Repair>(
          `SELECT repair_id AS "repairId", admitted_count AS "admittedCount", original_minimum AS minimum,
           lower_key AS lower, upper_key AS upper, expected_revision AS revision,
           expected_source_generation::text AS "sourceGeneration", expected_order_epoch AS "orderEpoch",
           processed,step,after_key AS "afterKey",after_member_id AS "afterMemberId",state
         FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3 FOR UPDATE`,
          [route, locator.collectionId, locator.repairId],
        )
      ).rows[0];
      terminal = !parent || parent.state !== 'active' || !parent.curatorAccountId || repair?.state !== 'active';
      if (!terminal && parent?.curatorAccountId) {
        try {
          await shareAccount(tx, parent.curatorAccountId);
        } catch (error) {
          if (!(error instanceof LifecycleDeniedError)) throw error;
          terminal = true;
        }
      }
      return 'execute';
    },
  };
  return runCommand<{ state: 'stale' | 'done' | 'complete' | 'more' }>(
    context.pool,
    {
      partition: partitionOf(route),
      authorization,
      clock: context.clock,
      deadline: workStepDeadline(),
    },
    async (tx, command) => {
      if (!repair || repair.step !== locator.step) return noEffect({ state: 'stale' as const });
      const updated = {
        type: 'com.rezics.library.collection.updated.v1',
        subject: locator.collectionId,
        data: { collectionId: locator.collectionId },
      };
      if (terminal) {
        // One fixed-size native row, also used for the final/cancelled cleanup page.
        await tx.query(
          'DELETE FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3',
          [route, locator.collectionId, locator.repairId],
        );
        return { value: { state: 'done' as const }, events: [updated] };
      }
      if (
        !parent ||
        parent.memberCount !== repair.admittedCount ||
        parent.revision !== repair.revision ||
        parent.sourceGeneration !== repair.sourceGeneration ||
        parent.orderEpoch !== repair.orderEpoch
      )
        throw new Error('Captured Collection order fence changed without terminalization');
      // The initial lower fence and strict examined frontier both refer to ORIGINAL
      // raw order. Every output is below minimum, so it can never be re-enumerated.
      // Deleted rows count against this limit and retain all keys/payload/Undo evidence.
      const rows = (
        await tx.query<Raw>(
          `SELECT member_id AS "memberId",ordinal_key AS "ordinalKey",deletion_id IS NULL AS active
       FROM library.collection_member WHERE route=$1 AND collection_id=$2
         AND ordinal_key >= $3::text COLLATE "C"
         AND (ordinal_key,member_id) > ($4::text COLLATE "C",$5::uuid)
       ORDER BY ordinal_key,member_id LIMIT $6`,
          [
            route,
            locator.collectionId,
            repair.minimum,
            repair.afterKey ?? '',
            repair.afterMemberId ?? '00000000-0000-0000-0000-000000000000',
            ORDER_WINDOW_SIZE,
          ],
        )
      ).rows;
      const active = rows.filter((row) => row.active);
      const keys = orderRepairKeys(repair.lower, repair.upper, repair.admittedCount, repair.processed, active.length);
      const processed = repair.processed + active.length;
      const complete = rows.length < ORDER_WINDOW_SIZE;
      if (complete && processed !== repair.admittedCount) throw new Error('Order repair lost an original occurrence');
      const last = rows.at(-1);
      const next = { ...locator, step: locator.step + 1 };
      const saved = await tx.query(
        `UPDATE library.collection_order_repair SET processed=$4,step=$5,after_key=$6,after_member_id=$7,
         expected_revision=expected_revision+1,expected_source_generation=expected_source_generation+1,
         expected_order_epoch=expected_order_epoch+1,writer_xid=pg_current_xact_id(),state=$8
       WHERE route=$1 AND collection_id=$2 AND repair_id=$3 AND state='active' AND step=$9
         AND expected_revision=$10 AND expected_source_generation=$11 AND expected_order_epoch=$12
       RETURNING repair_id`,
        [
          route,
          locator.collectionId,
          locator.repairId,
          processed,
          next.step,
          last?.ordinalKey ?? repair.afterKey,
          last?.memberId ?? repair.afterMemberId,
          complete ? 'complete' : 'active',
          locator.step,
          repair.revision,
          repair.sourceGeneration,
          repair.orderEpoch,
        ],
      );
      if (saved.rowCount !== 1) throw new Error('Order repair progress CAS failed');
      for (let index = 0; index < active.length; index++) {
        const row = active[index]!;
        const changed = await tx.query(
          `UPDATE library.collection_member SET ordinal_key=$4,transaction_id=$5
         WHERE route=$1 AND collection_id=$2 AND member_id=$3 AND ordinal_key=$6 AND deletion_id IS NULL`,
          [route, locator.collectionId, row.memberId, keys[index], command.transactionId, row.ordinalKey],
        );
        if (changed.rowCount !== 1) throw new Error('Order repair original row CAS failed');
      }
      const head = await tx.query(
        `UPDATE library.collection SET revision=revision+1,source_generation=source_generation+1,
         order_epoch=order_epoch+1,updated_at=$7::timestamptz,transaction_id=$8
       WHERE route=$1 AND collection_id=$2 AND state='active' AND member_count=$3
         AND revision=$4 AND source_generation=$5 AND order_epoch=$6 RETURNING collection_id`,
        [
          route,
          locator.collectionId,
          repair.admittedCount,
          repair.revision,
          repair.sourceGeneration,
          repair.orderEpoch,
          authoritativeTimeValue(command.time),
          command.transactionId,
        ],
      );
      if (head.rowCount !== 1) throw new Error('Order repair parent CAS failed');
      // The committed outbox is the durable continuation intent. A stopped workflow
      // resumes via this exact step ID; it never needs a manager restart or owner scan.
      return {
        value: { state: complete ? ('complete' as const) : ('more' as const) },
        events: [updated, collectionOrderEvent(next)],
      };
    },
  );
}

export function registerCollectionOrderWork(context: WorkContext): void {
  const step = DBOS.registerStep(
    async (locator: CollectionOrderLocator) => {
      await advanceCollectionOrderRepair(context, locator);
    },
    { name: 'library.collectionOrderRepairPage', ...COMMAND_STEP_RETRIES },
  );
  DBOS.registerWorkflow(
    async (locator: CollectionOrderLocator) => {
      await step(locator);
    },
    { name: COLLECTION_ORDER_WORKFLOW },
  );
  context.addEffects([
    {
      name: 'library_collection_order_repair',
      types: ['com.rezics.library.collection.order-repair.advanced.v1'],
      async run(event) {
        const locator = event.data as CollectionOrderLocator;
        await context.client.enqueue(
          {
            workflowName: COLLECTION_ORDER_WORKFLOW,
            queueName: 'maintenance',
            workflowID: `${COLLECTION_ORDER_WORKFLOW}:${locator.repairId}:${locator.step}`,
            workflowIDReusePolicy: 'return-existing',
          },
          locator,
        );
      },
    },
  ]);
}
