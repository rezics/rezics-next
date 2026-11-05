import { DBOS } from '@dbos-inc/dbos-sdk';
import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, CommandUnavailableError, noEffect, runCommand } from '../command/command.ts';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import type { CurrentConsentReader } from '../request/auth-consent.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { withConnection } from '../database/pool.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { nativeReceiptKeyCandidates } from '../command/receipt-key.ts';
import {
  executeStatusTarget,
  executeCollectionAddTarget,
  executeCollectionRemoveTarget,
  executeLibraryRemovalTarget,
  reconcileBulkTarget,
  type BulkDependencies,
  type BulkReason,
  type OperationView,
  type TargetEvidence,
  type TargetCommand,
} from './bulk-contract.ts';
import {
  BULK_CHANGED_EVENT,
  BULK_CONFIRMED_EVENT,
  bulkHash,
  collectionBulkView,
  readCollectionBulkInitiator,
  type CollectionBulkInput,
} from './collection-bulk-operation.ts';
import {
  acknowledgeCollectionBulkTarget,
  markCollectionBulkTargetReconciling,
  pageCollectionBulkManifest,
  readCollectionBulk,
  type CollectionBulkKey,
} from './collection-bulk-store.ts';
import { workStepDeadline } from './command-support.ts';

type Dependencies = {
  pool: Pool;
  access: Access;
  clock: KernelClock;
  tokens: KeyRing;
  readConsent: CurrentConsentReader;
};
export const COLLECTION_BULK_WORKFLOW = 'library.collectionBulk';

/** Mechanical closeout only, sharing the effect root lock. It cannot issue a personal write. */
async function closePending(deps: Pick<Dependencies, 'pool' | 'clock'>, key: CollectionBulkKey, reason: BulkReason) {
  let live = false;
  const result = await runCommand(
    deps.pool,
    {
      partition: partitionOf(key.route),
      deadline: workStepDeadline(),
      clock: deps.clock,
      authorization: {
        action: 'library:bulk-accounting',
        resource: { route: key.route, id: key.accountId },
        denied: () => new Error('Bulk accounting fence unavailable'),
        async authorize(tx) {
          live = false;
          try {
            await shareAccount(tx, key.accountId);
            live = true;
          } catch (error) {
            if (!(error instanceof LifecycleDeniedError)) throw error;
          }
          return 'execute';
        },
      },
    },
    async (tx) => {
      if (!live) return noEffect(0);
      await tx.query(
        `SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND operation_id=$2 AND account_id=$3 FOR UPDATE`,
        [key.route, key.operationId, key.accountId],
      );
      const operation = await readCollectionBulk(tx, key);
      if (!operation) return noEffect(0);
      const stopped = (
        await tx.query<{ reason: BulkReason }>(
          `SELECT reason FROM library.bulk_target
        WHERE route=$1 AND operation_id=$2 AND state IN ('denied','cancelled') ORDER BY ordinal LIMIT 1`,
          [key.route, key.operationId],
        )
      ).rows[0];
      if (operation.phase === 'completed') reason = stopped?.reason ?? 'cancel_requested';
      // A terminal root with pending targets is an irreversible stop, including cancellation before confirmation.
      await tx.query(
        `UPDATE library.bulk_operation SET phase='completed' WHERE route=$1 AND operation_id=$2 AND account_id=$3`,
        [key.route, key.operationId, key.accountId],
      );
      const result = await tx.query(
        `WITH keys AS MATERIALIZED (
        SELECT manifest.ordinal FROM library.bulk_target AS manifest
          WHERE manifest.route=$1 AND manifest.operation_id=$2 AND manifest.account_id=$3
          AND manifest.state IN ('pending','reconciling')
          AND (manifest.state='pending' OR CASE
            WHEN manifest.target_kind='occurrence' THEN
              get_byte(uuid_send(manifest.collection_id),10)*256+
                get_byte(uuid_send(manifest.collection_id),11)=manifest.route
            WHEN manifest.target->>'collectionId' IS NULL THEN true
            ELSE get_byte(uuid_send((manifest.target->>'collectionId')::uuid),10)*256+
              get_byte(uuid_send((manifest.target->>'collectionId')::uuid),11)=manifest.route
          END)
          ORDER BY manifest.ordinal LIMIT 100)
        UPDATE library.bulk_target AS target_row SET state=$4,reason=$5 FROM keys
        WHERE target_row.route=$1 AND target_row.operation_id=$2 AND target_row.account_id=$3
          AND target_row.ordinal=keys.ordinal`,
        [key.route, key.operationId, key.accountId, reason === 'authority_lost' ? 'denied' : 'cancelled', reason],
      );
      return {
        value: result.rowCount ?? 0,
        events: [{ type: BULK_CHANGED_EVENT, subject: key.accountId, data: { operationId: key.operationId } }],
      };
    },
  );
  return result.value;
}

/** Source-side checkpoint for a committed remote Collection receipt. */
export async function acknowledgeCollectionBulkOutcome(
  deps: Pick<BulkDependencies, 'pool' | 'clock'>,
  evidence: TargetEvidence,
): Promise<OperationView | null> {
  const route = routeOf(evidence.operationId);
  if (route === null || routeOf(evidence.receipt.principalId) !== route)
    throw new TypeError('Invalid bulk receipt owner');
  const key = { route, accountId: evidence.receipt.principalId, operationId: evidence.operationId };
  let live = false;
  const result = await runCommand<OperationView | null>(
    deps.pool,
    {
      partition: partitionOf(route),
      deadline: workStepDeadline(),
      clock: deps.clock,
      authorization: {
        action: 'library:bulk-accounting',
        resource: { route, id: key.accountId },
        denied: () => new Error('Bulk accounting fence unavailable'),
        async authorize(tx) {
          live = false;
          try {
            await shareAccount(tx, key.accountId);
            live = true;
          } catch (error) {
            if (!(error instanceof LifecycleDeniedError)) throw error;
          }
          return 'execute';
        },
      },
    },
    async (tx) => {
      if (!live) return noEffect(null);
      const operation = await readCollectionBulk(tx, key);
      const ordinal = Number(evidence.ordinal);
      if (!operation || !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 1_000)
        throw new Error('Remote bulk result has no retained operation');
      const row = (
        await tx.query<{
          target: { kind: 'subject' | 'occurrence'; collectionId?: string };
          receipt: TargetEvidence['receipt'];
        }>(
          `SELECT target,receipt FROM library.bulk_target
            WHERE route=$1 AND operation_id=$2 AND account_id=$3 AND ordinal=$4`,
          [route, evidence.operationId, key.accountId, ordinal],
        )
      ).rows[0];
      const collectionId = row?.target.collectionId;
      const collectionRoute = collectionId ? routeOf(collectionId) : null;
      const isRemoteAction =
        (operation.request.action === 'add_to_collection' && row?.target.kind === 'subject') ||
        (operation.request.action === 'remove_from_collection' && row?.target.kind === 'occurrence');
      if (
        !row ||
        !isRemoteAction ||
        collectionRoute === null ||
        collectionRoute === route ||
        evidence.receipt.partition !== partitionOf(collectionRoute) ||
        evidence.receipt.commandKind !== 'library.collectionBulk.target' ||
        !isDeepStrictEqual(row.receipt, evidence.receipt)
      )
        throw new Error('Remote bulk result does not match its persisted target');
      if (evidence.transactionId === null) {
        if (evidence.outcome !== 'denied' || evidence.reason !== 'authority_lost')
          throw new Error('Receipt-less bulk evidence is not an authority refusal');
      } else {
        const found = await tx.query<{ transactionId: string; digest: string; response: TargetEvidence }>(
          `SELECT transaction_id AS "transactionId",encode(request_digest,'hex') AS digest,response
            FROM core.receipt WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
              AND command_kind=$3 AND idempotency_key=ANY($4::text[]) AND payload_state='present' LIMIT 1`,
          [
            evidence.receipt.partition,
            key.accountId,
            evidence.receipt.commandKind,
            nativeReceiptKeyCandidates(tx, evidence.receipt.commandKind, key.accountId, evidence.receipt.key),
          ],
        );
        const receipt = found.rows[0];
        if (
          !receipt ||
          receipt.digest !== evidence.receipt.digest ||
          receipt.transactionId !== evidence.transactionId ||
          !isDeepStrictEqual(receipt.response, evidence)
        )
          throw new Error('Remote bulk result does not match its original native receipt');
      }
      const changed = await acknowledgeCollectionBulkTarget(tx, { ...key, ordinal, evidence });
      const view = (await collectionBulkView(tx, key)).operation;
      return changed
        ? {
            value: view,
            events: [{ type: BULK_CHANGED_EVENT, subject: key.accountId, data: { operationId: key.operationId } }],
          }
        : noEffect(view);
    },
  );
  return result.value;
}

async function markReconciling(
  deps: Pick<BulkDependencies, 'pool' | 'clock'>,
  key: CollectionBulkKey,
  ordinal: number,
  reason: Extract<BulkReason, 'deadline' | 'dependency_unavailable'>,
): Promise<boolean | null> {
  let live = false;
  const result = await runCommand<boolean | null>(
    deps.pool,
    {
      partition: partitionOf(key.route),
      deadline: workStepDeadline(),
      clock: deps.clock,
      authorization: {
        action: 'library:bulk-accounting',
        resource: { route: key.route, id: key.accountId },
        denied: () => new Error('Bulk accounting fence unavailable'),
        async authorize(tx) {
          live = false;
          try {
            await shareAccount(tx, key.accountId);
            live = true;
          } catch (error) {
            if (!(error instanceof LifecycleDeniedError)) throw error;
          }
          return 'execute';
        },
      },
    },
    async (tx) => {
      if (!live) return noEffect(null);
      const changed = await markCollectionBulkTargetReconciling(tx, { ...key, ordinal, reason });
      return changed
        ? {
            value: true,
            events: [{ type: BULK_CHANGED_EVENT, subject: key.accountId, data: { operationId: key.operationId } }],
          }
        : noEffect(false);
    },
  );
  return result.value;
}

/** One bounded page. Workflow inputs contain locators only, never an actor or selection. */
export async function runCollectionBulkPage(deps: Dependencies, input: CollectionBulkInput): Promise<boolean> {
  if (routeOf(input.operationId) !== input.route) throw new TypeError('Invalid bulk operation locator');
  const loaded = await withConnection(deps.pool, async (tx) => {
    const owner = (
      await tx.query<{ accountId: string }>(
        `SELECT account_id AS "accountId" FROM library.bulk_operation WHERE route=$1 AND operation_id=$2`,
        [input.route, input.operationId],
      )
    ).rows[0];
    if (!owner) return null;
    const key = { ...input, accountId: owner.accountId };
    const operation = await readCollectionBulk(tx, key);
    const targets = await pageCollectionBulkManifest(tx, { ...key, pendingOnly: true, limit: 100 });
    const denied =
      (
        await tx.query(
          `SELECT ordinal FROM library.bulk_target WHERE route=$1 AND operation_id=$2
      AND state='denied' ORDER BY ordinal LIMIT 1`,
          [input.route, input.operationId],
        )
      ).rowCount === 1;
    return operation ? { key, operation, targets, denied } : null;
  });
  if (!loaded || loaded.operation.phase === 'preview' || loaded.targets.length === 0) return false;
  const { key, operation, targets } = loaded;
  const runtime: BulkDependencies = {
    ...deps,
    readInitiator: readCollectionBulkInitiator,
    initiators: createInitiatorRestorer({ ...deps, readOperation: readCollectionBulkInitiator }),
  };
  const commandFor = (row: (typeof targets)[number]): TargetCommand => {
    const target = { ...row.target, operationId: key.operationId, ordinal: row.ordinal };
    return {
      source: operation.initiator.operation,
      sourceDigest: operation.sourceDigest,
      target,
      receipt: row.receipt,
      identity: {
        clientId: operation.initiator.actor.clientId,
        requestedBy: operation.initiator.actor.requestedBy,
      },
      chunkIndex: Math.floor(Number(row.ordinal) / 100),
      deadline: workStepDeadline(),
    };
  };
  const isRemote = (command: TargetCommand) => {
    const targetRoute =
      command.target.kind === 'occurrence'
        ? routeOf(command.target.collectionId)
        : command.target.collectionId
          ? routeOf(command.target.collectionId)
          : key.route;
    return targetRoute !== null && targetRoute !== key.route;
  };
  if (operation.phase === 'completed' || Date.parse(operation.expiresAt) <= deps.clock().getTime()) {
    let unresolvedRemote = false;
    for (const row of targets) {
      const command = commandFor(row);
      if (!isRemote(command)) continue;
      const recovered = await reconcileBulkTarget(runtime, command);
      if (recovered?.kind === 'terminal') {
        if (!(await acknowledgeCollectionBulkOutcome(runtime, recovered.evidence))) return false;
      } else if (recovered?.kind === 'reconciling') {
        unresolvedRemote = true;
        const marked = await markReconciling(
          runtime,
          key,
          Number(command.target.ordinal),
          recovered.reason === 'deadline' ? 'deadline' : 'dependency_unavailable',
        );
        if (marked === null) return false;
        throw new CommandUnavailableError(
          recovered.reason === 'deadline' ? 'deadline' : 'overloaded',
          partitionOf(key.route),
        );
      } else if (recovered?.kind === 'stop' && recovered.reason === 'evidence_missing') {
        throw new Error('Bulk effect evidence missing');
      } else if (row.state === 'reconciling') {
        unresolvedRemote = true;
      }
    }
    const removed = await closePending(
      deps,
      key,
      loaded.denied ? 'authority_lost' : operation.phase === 'completed' ? 'cancel_requested' : 'execution_expired',
    );
    if (unresolvedRemote) throw new CommandUnavailableError('overloaded', partitionOf(key.route));
    return removed === 100;
  }
  for (const row of targets) {
    const command = commandFor(row);
    if (isRemote(command)) {
      const marked = await markReconciling(runtime, key, Number(command.target.ordinal), 'dependency_unavailable');
      if (marked === null) return false;
      if (!marked) return true;
    }
    const execute =
      operation.request.action === 'set_status'
        ? executeStatusTarget
        : operation.request.action === 'add_to_collection'
          ? executeCollectionAddTarget
          : operation.request.action === 'remove_from_collection'
            ? executeCollectionRemoveTarget
            : executeLibraryRemovalTarget;
    const result = await execute(runtime, command);
    if (result.kind === 'stop') {
      if (result.reason === 'evidence_missing') throw new Error('Bulk effect evidence missing');
      if (isRemote(command) && row.state === 'reconciling')
        throw new CommandUnavailableError('overloaded', partitionOf(key.route));
      await closePending(deps, key, result.reason === 'authority_lost' ? 'authority_lost' : 'execution_expired');
      return true;
    }
    if (result.kind === 'reconciling') {
      await markReconciling(
        runtime,
        key,
        Number(command.target.ordinal),
        result.reason === 'deadline' ? 'deadline' : 'dependency_unavailable',
      );
      throw new CommandUnavailableError(
        result.reason === 'deadline' ? 'deadline' : 'overloaded',
        partitionOf(key.route),
      );
    }
    if (isRemote(command) && !(await acknowledgeCollectionBulkOutcome(runtime, result.evidence))) return false;
  }
  return targets.length === 100;
}

/** Indexed results cleanup: at most one header and 100 manifest rows per command.
 * A tombstone remains owned by Accounts' installed erasure participant. */
export async function expireCollectionBulkPage(
  deps: Pick<Dependencies, 'pool' | 'clock'>,
  route: number,
): Promise<boolean> {
  const due = await withConnection(
    deps.pool,
    async (tx) =>
      (
        await tx.query<CollectionBulkKey>(
          `SELECT route,operation_id AS "operationId",account_id AS "accountId" FROM library.bulk_operation
      WHERE route=$1 AND results_expire_at<=$2 ORDER BY results_expire_at,operation_id LIMIT 1`,
          [route, deps.clock().toISOString()],
        )
      ).rows[0],
  );
  if (!due) return false;
  let live = false;
  const result = await runCommand(
    deps.pool,
    {
      partition: partitionOf(route),
      clock: deps.clock,
      deadline: workStepDeadline(),
      authorization: {
        action: 'library:bulk-retention',
        resource: { route, id: due.accountId },
        denied: () => new Error('Bulk retention account fence unavailable'),
        async authorize(tx) {
          live = false;
          try {
            await shareAccount(tx, due.accountId);
            live = true;
          } catch (error) {
            if (!(error instanceof LifecycleDeniedError)) throw error;
          }
          return 'execute';
        },
      },
    },
    async (tx, command) => {
      if (!live) return noEffect(false);
      const root = await tx.query(
        `SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND operation_id=$2
        AND account_id=$3 AND results_expire_at<=$4 FOR UPDATE`,
        [route, due.operationId, due.accountId, authoritativeTimeValue(command.time)],
      );
      if (!root.rowCount) return noEffect(false);
      await tx.query(
        `WITH keys AS MATERIALIZED (SELECT ordinal FROM library.bulk_target WHERE route=$1 AND operation_id=$2
          AND account_id=$3 ORDER BY ordinal LIMIT 100)
        DELETE FROM library.bulk_target AS target USING keys WHERE target.route=$1 AND target.operation_id=$2
          AND target.account_id=$3 AND target.ordinal=keys.ordinal`,
        [route, due.operationId, due.accountId],
      );
      const deleted = await tx.query(
        `DELETE FROM library.bulk_operation WHERE route=$1 AND operation_id=$2 AND account_id=$3
        AND NOT EXISTS (SELECT 1 FROM library.bulk_target WHERE route=$1 AND operation_id=$2 ORDER BY ordinal LIMIT 1)`,
        [route, due.operationId, due.accountId],
      );
      return {
        value: !deleted.rowCount,
        events: [{ type: BULK_CHANGED_EVENT, subject: due.accountId, data: { operationId: due.operationId } }],
      };
    },
  );
  return result.value;
}

/** Existing Library WorkModule and Core outbox only; no process or queue is started here. */
export async function registerCollectionBulkWork(context: WorkContext) {
  const { pool, client, clock } = context;
  const dependencies = (): Dependencies => ({
    pool,
    clock,
    tokens: readMembershipWorkConfig(context.env).referenceKeys,
    ...context.getAuthorization(),
  });
  const page = DBOS.registerStep((input: CollectionBulkInput) => runCollectionBulkPage(dependencies(), input), {
    name: 'library.collectionBulk.page',
    ...COMMAND_STEP_RETRIES,
  });
  const enqueue = async (input: CollectionBulkInput & { segment: number }) =>
    client.enqueue(
      {
        workflowName: COLLECTION_BULK_WORKFLOW,
        workflowID: `library.collectionBulk:${input.operationId}:${input.segment}`,
        workflowIDReusePolicy: 'return-existing',
        queueName: 'workflows',
      },
      input,
    );
  const continuation = DBOS.registerStep(enqueue, { name: 'library.collectionBulk.continue', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow(
    async (input: CollectionBulkInput & { segment: number }) => {
      for (let n = 0; n < 10; n++) if (!(await page(input))) return;
      await continuation({ ...input, segment: input.segment + 1 });
    },
    { name: COLLECTION_BULK_WORKFLOW },
  );
  context.addEffects([
    {
      name: 'library_bulk_confirmation',
      types: [BULK_CONFIRMED_EVENT],
      async run(event) {
        const { operationId } = event.data as { operationId: string };
        await enqueue({ route: routeOf(operationId)!, operationId, segment: 0 });
      },
    },
  ]);
  const expiry = DBOS.registerStep((route: number) => expireCollectionBulkPage({ pool, clock }, route), {
    name: 'library.collectionBulk.expiryPage',
    ...COMMAND_STEP_RETRIES,
  });
  type Sweep = { root: string; route: number; segment: number };
  const continueSweep = DBOS.registerStep(
    async (input: Sweep) =>
      client.enqueue(
        {
          workflowName: 'library.collectionBulkExpirySegment',
          workflowID: `${input.root}:bulk-expiry:${input.segment}`,
          workflowIDReusePolicy: 'return-existing',
          queueName: 'maintenance',
        },
        input,
      ),
    { name: 'library.collectionBulk.expiryContinue', ...COMMAND_STEP_RETRIES },
  );
  const sweep = async (input: Sweep) => {
    let route = input.route;
    for (let n = 0; n < 100 && route < 65536; n++) if (!(await expiry(route))) route++;
    if (route < 65536) await continueSweep({ ...input, route, segment: input.segment + 1 });
  };
  DBOS.registerWorkflow(sweep, { name: 'library.collectionBulkExpirySegment' });
  DBOS.registerWorkflow(() => sweep({ root: DBOS.workflowID!, route: 0, segment: 0 }), {
    name: 'library.collectionBulkExpirySweep',
  });
  await client.applySchedules([
    {
      scheduleName: 'library.collectionBulk.expiry.every-10-minutes',
      workflowName: 'library.collectionBulkExpirySweep',
      schedule: '*/10 * * * *',
      cronTimezone: 'UTC',
      automaticBackfill: false,
      queueName: 'maintenance',
    },
  ]);
}
