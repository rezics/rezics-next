import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import { shareAccount } from '../access/account-share.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { createInitiatorRestorer } from '../access/durable-initiator.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { withConnection } from '../database/pool.ts';
import type { Access } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkContext } from '../work/registry.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { ProblemError } from '../http/problem.ts';
import { executeStatusTarget, executeCollectionAddTarget, executeCollectionRemoveTarget, executeLibraryRemovalTarget,
  type BulkDependencies, type BulkReason, type TargetCommand } from './bulk-contract.ts';
import { BULK_CHANGED_EVENT, BULK_CONFIRMED_EVENT, bulkHash, readCollectionBulkInitiator,
  type CollectionBulkInput } from './collection-bulk-operation.ts';
import { pageCollectionBulkManifest, readCollectionBulk, type CollectionBulkKey } from './collection-bulk-store.ts';
import { workStepDeadline } from './command-support.ts';

type Dependencies = { pool: Pool; access: Access; clock: KernelClock; tokens: KeyRing; readConsent: CurrentConsentReader };
export const COLLECTION_BULK_WORKFLOW = 'library.collectionBulk';

/** Mechanical closeout only, sharing the effect root lock. It cannot issue a personal write. */
async function closePending(deps: Pick<Dependencies, 'pool' | 'clock'>, key: CollectionBulkKey, reason: BulkReason) {
  let live = false;
  const result = await runCommand(deps.pool, { partition: partitionOf(key.route), deadline: workStepDeadline(), clock: deps.clock,
    authorization: { action: 'library:bulk-accounting', resource: { route: key.route, id: key.accountId },
      denied: () => new Error('Bulk accounting fence unavailable'), async authorize(tx) {
        live = false;
        try { await shareAccount(tx, key.accountId); live = true; }
        catch (error) { if (!(error instanceof LifecycleDeniedError)) throw error; }
        return 'execute';
      } } }, async tx => {
      if (!live) return noEffect(0);
      await tx.query(`SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND operation_id=$2 AND account_id=$3 FOR UPDATE`,
        [key.route, key.operationId, key.accountId]);
      const operation = await readCollectionBulk(tx, key);
      if (!operation) return noEffect(0);
      const stopped = (await tx.query<{ reason: BulkReason }>(`SELECT reason FROM library.bulk_target
        WHERE route=$1 AND operation_id=$2 AND state IN ('denied','cancelled') ORDER BY ordinal LIMIT 1`,
        [key.route, key.operationId])).rows[0];
      if (operation.phase === 'completed') reason = stopped?.reason ?? 'cancel_requested';
      // A terminal root with pending targets is an irreversible stop, including cancellation before confirmation.
      await tx.query(`UPDATE library.bulk_operation SET phase='completed' WHERE route=$1 AND operation_id=$2 AND account_id=$3`,
        [key.route, key.operationId, key.accountId]);
      const result = await tx.query(`WITH keys AS MATERIALIZED (
        SELECT ordinal FROM library.bulk_target WHERE route=$1 AND operation_id=$2 AND account_id=$3
          AND state IN ('pending','reconciling') ORDER BY ordinal LIMIT 100)
        UPDATE library.bulk_target AS target SET state=$4,reason=$5 FROM keys
        WHERE target.route=$1 AND target.operation_id=$2 AND target.account_id=$3 AND target.ordinal=keys.ordinal`,
        [key.route, key.operationId, key.accountId, reason === 'authority_lost' ? 'denied' : 'cancelled', reason]);
      return { value: result.rowCount ?? 0, events: [{ type: BULK_CHANGED_EVENT, subject: key.accountId,
        data: { operationId: key.operationId } }] };
    });
  return result.value;
}

/** One bounded page. Workflow inputs contain locators only, never an actor or selection. */
export async function runCollectionBulkPage(deps: Dependencies, input: CollectionBulkInput): Promise<boolean> {
  if (routeOf(input.operationId) !== input.route) throw new TypeError('Invalid bulk operation locator');
  const loaded = await withConnection(deps.pool, async tx => {
    const owner = (await tx.query<{ accountId: string }>(
      `SELECT account_id AS "accountId" FROM library.bulk_operation WHERE route=$1 AND operation_id=$2`,
      [input.route, input.operationId])).rows[0];
    if (!owner) return null;
    const key = { ...input, accountId: owner.accountId };
    const operation = await readCollectionBulk(tx, key);
    const targets = await pageCollectionBulkManifest(tx, { ...key, pendingOnly: true, limit: 100 });
    const denied = (await tx.query(`SELECT ordinal FROM library.bulk_target WHERE route=$1 AND operation_id=$2
      AND state='denied' ORDER BY ordinal LIMIT 1`, [input.route, input.operationId])).rowCount === 1;
    return operation ? { key, operation, targets, denied } : null;
  });
  if (!loaded || loaded.operation.phase === 'preview' || loaded.targets.length === 0) return false;
  const { key, operation, targets } = loaded;
  if (operation.phase === 'completed' || Date.parse(operation.expiresAt) <= deps.clock().getTime()) {
    const removed = await closePending(deps, key, loaded.denied ? 'authority_lost' :
      operation.phase === 'completed' ? 'cancel_requested' : 'execution_expired');
    return removed === 100;
  }
  const runtime: BulkDependencies = { ...deps, readInitiator: readCollectionBulkInitiator,
    initiators: createInitiatorRestorer({ ...deps, readOperation: readCollectionBulkInitiator }),
 };
  for (const row of targets) {
    const target = { ...row.target, operationId: key.operationId, ordinal: row.ordinal };
    const command: TargetCommand = { source: operation.initiator.operation, sourceDigest: operation.sourceDigest,
      target, receipt: row.receipt, chunkIndex: Math.floor(Number(row.ordinal) / 100), deadline: workStepDeadline() };
    const execute = operation.request.action === 'set_status' ? executeStatusTarget :
      operation.request.action === 'add_to_collection' ? executeCollectionAddTarget :
      operation.request.action === 'remove_from_collection' ? executeCollectionRemoveTarget : executeLibraryRemovalTarget;
    const result = await execute(runtime, command);
    if (result.kind === 'stop') {
      if (result.reason === 'evidence_missing') throw new Error('Bulk effect evidence missing');
      await closePending(deps, key, result.reason === 'authority_lost' ? 'authority_lost' : 'execution_expired');
      return true;
    }
    if (result.kind === 'reconciling') throw new ProblemError('dependency_unavailable');
  }
  return targets.length === 100;
}

/** Indexed results cleanup: at most one header and 100 manifest rows per command.
 * A tombstone remains owned by Accounts' installed erasure participant. */
export async function expireCollectionBulkPage(deps: Pick<Dependencies, 'pool' | 'clock'>, route: number): Promise<boolean> {
  const due = await withConnection(deps.pool, async tx => (await tx.query<CollectionBulkKey>(
    `SELECT route,operation_id AS "operationId",account_id AS "accountId" FROM library.bulk_operation
      WHERE route=$1 AND results_expire_at<=$2 ORDER BY results_expire_at,operation_id LIMIT 1`,
    [route, deps.clock().toISOString()])).rows[0]);
  if (!due) return false;
  let live = false;
  const result = await runCommand(deps.pool, { partition: partitionOf(route), clock: deps.clock, deadline: workStepDeadline(),
    authorization: { action: 'library:bulk-retention', resource: { route, id: due.accountId },
      denied: () => new Error('Bulk retention account fence unavailable'), async authorize(tx) {
        live = false;
        try { await shareAccount(tx, due.accountId); live = true; }
        catch (error) { if (!(error instanceof LifecycleDeniedError)) throw error; }
        return 'execute';
      } } }, async (tx, command) => {
      if (!live) return noEffect(false);
      const root = await tx.query(`SELECT operation_id FROM library.bulk_operation WHERE route=$1 AND operation_id=$2
        AND account_id=$3 AND results_expire_at<=$4 FOR UPDATE`,
        [route, due.operationId, due.accountId, authoritativeTimeValue(command.time)]);
      if (!root.rowCount) return noEffect(false);
      await tx.query(`WITH keys AS MATERIALIZED (SELECT ordinal FROM library.bulk_target WHERE route=$1 AND operation_id=$2
          AND account_id=$3 ORDER BY ordinal LIMIT 100)
        DELETE FROM library.bulk_target AS target USING keys WHERE target.route=$1 AND target.operation_id=$2
          AND target.account_id=$3 AND target.ordinal=keys.ordinal`, [route, due.operationId, due.accountId]);
      const deleted = await tx.query(`DELETE FROM library.bulk_operation WHERE route=$1 AND operation_id=$2 AND account_id=$3
        AND NOT EXISTS (SELECT 1 FROM library.bulk_target WHERE route=$1 AND operation_id=$2 ORDER BY ordinal LIMIT 1)`,
        [route, due.operationId, due.accountId]);
      return { value: !deleted.rowCount, events: [{ type: BULK_CHANGED_EVENT, subject: due.accountId,
        data: { operationId: due.operationId } }] };
    });
  return result.value;
}

/** Existing Library WorkModule and Core outbox only; no process or queue is started here. */
export async function registerCollectionBulkWork(context: WorkContext) {
  const { pool, client, clock } = context;
  const dependencies = (): Dependencies => ({ pool, clock, tokens: readMembershipWorkConfig(context.env).referenceKeys,
    ...context.getAuthorization() });
  const page = DBOS.registerStep((input: CollectionBulkInput) => runCollectionBulkPage(dependencies(), input),
    { name: 'library.collectionBulk.page', ...COMMAND_STEP_RETRIES });
  const enqueue = async (input: CollectionBulkInput & { segment: number }) => client.enqueue({
    workflowName: COLLECTION_BULK_WORKFLOW, workflowID: `library.collectionBulk:${input.operationId}:${input.segment}`,
    workflowIDReusePolicy: 'return-existing', queueName: 'workflows' }, input);
  const continuation = DBOS.registerStep(enqueue, { name: 'library.collectionBulk.continue', ...COMMAND_STEP_RETRIES });
  DBOS.registerWorkflow(async (input: CollectionBulkInput & { segment: number }) => {
    for (let n = 0; n < 10; n++) if (!(await page(input))) return;
    await continuation({ ...input, segment: input.segment + 1 });
  }, { name: COLLECTION_BULK_WORKFLOW });
  context.addEffects([{ name: 'library_bulk_confirmation', types: [BULK_CONFIRMED_EVENT], async run(event) {
    const { operationId } = event.data as { operationId: string };
    await enqueue({ route: routeOf(operationId)!, operationId, segment: 0 });
  } }]);
  const expiry = DBOS.registerStep((route: number) => expireCollectionBulkPage({ pool, clock }, route),
    { name: 'library.collectionBulk.expiryPage', ...COMMAND_STEP_RETRIES });
  type Sweep = { root: string; route: number; segment: number };
  const continueSweep = DBOS.registerStep(async (input: Sweep) => client.enqueue({
    workflowName: 'library.collectionBulkExpirySegment', workflowID: `${input.root}:bulk-expiry:${input.segment}`,
    workflowIDReusePolicy: 'return-existing', queueName: 'maintenance' }, input),
    { name: 'library.collectionBulk.expiryContinue', ...COMMAND_STEP_RETRIES });
  const sweep = async (input: Sweep) => {
    let route = input.route;
    for (let n = 0; n < 100 && route < 65536; n++) if (!(await expiry(route))) route++;
    if (route < 65536) await continueSweep({ ...input, route, segment: input.segment + 1 });
  };
  DBOS.registerWorkflow(sweep, { name: 'library.collectionBulkExpirySegment' });
  DBOS.registerWorkflow(() => sweep({ root: DBOS.workflowID!, route: 0, segment: 0 }), { name: 'library.collectionBulkExpirySweep' });
  await client.applySchedules([{ scheduleName: 'library.collectionBulk.expiry.every-10-minutes',
    workflowName: 'library.collectionBulkExpirySweep', schedule: '*/10 * * * *', cronTimezone: 'UTC',
    automaticBackfill: false, queueName: 'maintenance' }]);
}
