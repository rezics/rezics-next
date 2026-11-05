import { installAccessClock } from './access-clock.ts';
import { systemClock } from '../clock.ts';
import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { authoritativeTimeValue, currentCommand, type CommandTransaction } from '../command/command.ts';
import { derivedId, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkContext } from '../work/registry.ts';
import {
  continuationEntryDigest,
  createCommittedContinuations,
  ContinuationDeniedError,
  type ContinuationEntry,
  type ContinuationSnapshot,
} from './committed-continuations.ts';
import { lifecycleExecutor, type LifecycleReceipt } from './lifecycle-20261025094010-command.ts';
import { createOperatorCommands } from './operator.ts';
import { createAccess } from './permission.ts';
import insertPage from './committed-continuation-page-insert.sql';
import readPage from './committed-continuation-page-read.sql';
import operatorState from './operator-fence-state.sql';
import unfenceSubject from './operator-unfence-subject.sql';
import clearFence from './lifecycle-fence-clear.sql';
import fenceSubject from './operator-fence-subject.sql';
import nativeFence from './lifecycle-fence.sql';
import fenceOrigin from './operator-fence-origin.sql';

const PAGE_SIZE = 100;
const workflowName = 'accounts.operator-fence-page';
const keyOf = (cursor?: string) =>
  createHash('sha256')
    .update(cursor ?? 'first')
    .digest('hex');
function entry(step: string, target: string, key: string): ContinuationEntry {
  const value = { step, target, key };
  return { ...value, digest: continuationEntryDigest(value) };
}
function allow(value: unknown): asserts value {
  if (!value) throw new ContinuationDeniedError();
}

/** The root and every child snapshot commit before effects. Each page and child effect
 * records its one completion on the root in its own transaction. Page receipts and
 * subject receipts are independent: a failed page effect replays its immutable
 * allowlist and native subject keys, without repeating any fence advance. */
export function createOperatorFenceRunner(config: {
  pool: Pool;
  referenceKeys: KeyRing;
  clock?: () => Date;
  pageSize?: number;
  root(reference: string): Promise<ContinuationSnapshot>;
  /** Records the effect's one completion on the root, in the effect's transaction, after the expiry check. */
  record(
    tx: CommandTransaction,
    root: ContinuationSnapshot,
    entry: ContinuationEntry,
    receiptId: string,
    receipt: LifecycleReceipt,
  ): Promise<void>;
}) {
  const pageSize = config.pageSize ?? PAGE_SIZE;
  allow(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= PAGE_SIZE);
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const access = createAccess({ actions, accountEvidence: () => null });
  installAccessClock(access, config.clock ?? systemClock);
  const operators = createOperatorCommands({
    pool: config.pool,
    actions,
    access,
    managementAction: 'account:manage',
    cursorKeys: config.referenceKeys,
  });
  const execute = lifecycleExecutor(config.pool, config.clock);
  async function page(reference: string, cursor?: string, previous?: string) {
    const root = await config.root(reference);
    const pageKey = keyOf(cursor);
    const source = root.allowlist.find((item) => item.step === 'operator-fence-source');
    const lifting = source !== undefined;
    const pageStep = lifting ? 'operator-unfence-page' : 'operator-responsibility-page';
    // Always recheck, including receipt replay. Only the latest suspension's
    // fanout governs, even after another suspension has also been reversed.
    const current = await withConnection(config.pool, (client) =>
      operatorState.run(client, {
        route: root.route,
        account_id: root.accountId,
        state: lifting ? 'active' : 'suspended',
        continuation_id: source?.target ?? root.continuationId,
      }),
    );
    if (!current) return { next: null, pageKey };
    const pageEntry = entry(
      pageStep,
      root.accountId,
      cursor ? `${root.commandKeyPrefix}:page:${pageKey}` : `${root.commandKeyPrefix}:${pageStep}`,
    );
    if (cursor) {
      allow(previous && /^[0-9a-f]{64}$/.test(previous));
      const parent = await withConnection(config.pool, (client) =>
        readPage.run(client, {
          route: root.route,
          continuation_id: root.continuationId,
          page_key: previous,
        }),
      );
      allow(parent && parent.nextCursor === cursor);
      allow((parent.allowlist as ContinuationEntry[]).some((item) => item.digest === pageEntry.digest));
    } else {
      allow(previous === undefined && root.allowlist.some((item) => item.digest === pageEntry.digest));
    }
    const existing = await withConnection(config.pool, (client) =>
      readPage.run(client, {
        route: root.route,
        continuation_id: root.continuationId,
        page_key: pageKey,
      }),
    );
    // The signed observation finishes before checkout. Each subject's current
    // relation and reservation are independently rechecked under its own lock.
    const batch = existing
      ? undefined
      : await operators.responsibilityWorkPage({
          operatorAccountId: root.accountId,
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        });
    const snapshot = await execute(
      {
        route: root.route,
        id: root.accountId,
        kind: lifting ? 'operator.unfence-page' : 'operator.fence-page',
        key: pageEntry.key,
        input: { continuationId: root.continuationId, cursor: cursor ?? null },
      },
      async (tx, transactionId, receipt) => {
        await config.record(tx, root, pageEntry, transactionId, receipt);
        allow(batch);
        const allowlist = batch.operators.map((subject) =>
          entry(
            lifting ? 'unfence' : 'fence',
            `${subject.subjectAccountId}:${subject.reservationId}`,
            `${root.commandKeyPrefix}:${lifting ? 'unfence' : 'fence'}:${subject.reservationId}`,
          ),
        );
        if (batch.next)
          allowlist.push(entry(pageStep, root.accountId, `${root.commandKeyPrefix}:page:${keyOf(batch.next)}`));
        await insertPage.run(tx, {
          route: root.route,
          continuation_id: root.continuationId,
          page_key: pageKey,
          cursor: cursor ?? '',
          next_cursor: batch.next ?? '',
          allowlist,
        });
        return { pageKey, count: batch.operators.length };
      },
    );
    allow(snapshot.value.pageKey === pageKey);
    const saved =
      existing ??
      (await withConnection(config.pool, (client) =>
        readPage.run(client, {
          route: root.route,
          continuation_id: root.continuationId,
          page_key: pageKey,
        }),
      ));
    allow(saved && saved.cursor === (cursor ?? null));
    // All connections used to read and persist the page have been released.
    for (const child of saved.allowlist as ContinuationEntry[]) {
      allow(child.digest === continuationEntryDigest(child));
      if (child.step !== (lifting ? 'unfence' : 'fence')) continue;
      const [subjectAccountId, reservationId] = child.target.split(':');
      allow(subjectAccountId && reservationId);
      if (source) {
        const route = routeOf(subjectAccountId);
        allow(route !== null);
        await execute(
          {
            route,
            id: subjectAccountId,
            kind: 'operator.subject-unfenced',
            key: child.key,
            input: { continuationId: root.continuationId, subjectAccountId, reservationId },
          },
          async (tx, transactionId, receipt) => {
            await config.record(tx, root, child, transactionId, receipt);
            const subject = await unfenceSubject.run(tx, {
              route,
              subject_id: subjectAccountId,
              operator_id: root.accountId,
              reservation_id: reservationId,
              source_id: source.target,
            });
            if (!subject) return { accountId: subjectAccountId, lifted: false };
            const cleared = await clearFence.run(tx, {
              route,
              account_id: subjectAccountId,
              receipt_id: subject.fenceReceiptId!,
              minimum_authn_epoch: subject.minimumAuthnEpoch,
              authn_epoch: subject.minimumAuthnEpoch,
              transaction_id: transactionId,
            });
            allow(Array.isArray(cleared) ? cleared.length > 0 : cleared);
            return { accountId: subjectAccountId, lifted: true };
          },
        );
      } else {
        const route = routeOf(subjectAccountId);
        allow(route !== null);
        await execute(
          {
            route,
            id: subjectAccountId,
            kind: 'operator.subject-fenced',
            key: child.key,
            input: { operatorAccountId: root.accountId, subjectAccountId, reservationId, key: child.key },
          },
          async (tx, transactionId, businessReceipt) => {
            const receiptId = derivedId('134e9749-1120-8a0c-97d0-71287a629cef', `${transactionId}:fence`, route);
            const related = await fenceSubject.run(tx, {
              route,
              subject_id: subjectAccountId,
              operator_id: root.accountId,
              reservation_id: reservationId,
            });
            await config.record(tx, root, child, related ? receiptId : transactionId, businessReceipt);
            if (!related) return { accountId: subjectAccountId, fenced: false, receiptId: null };
            const receipt = await nativeFence.run(tx, {
              at: authoritativeTimeValue(currentCommand(tx).time),
              route,
              account_id: subjectAccountId,
              receipt_id: receiptId,
              tombstone: false,
              kind: 'fence',
              prior_operator_id: '',
              transaction_id: transactionId,
            });
            allow(receipt[0]);
            await fenceOrigin.run(tx, {
              route,
              account_id: subjectAccountId,
              receipt_id: receiptId,
              operator_id: root.accountId,
              reservation_id: reservationId,
              continuation_id: root.continuationId,
            });
            return { accountId: subjectAccountId, fenced: true, receiptId };
          },
        );
      }
    }
    return { next: saved.nextCursor, pageKey };
  }
  return {
    page,
    async continueCommitted(reference: string) {
      let cursor: string | undefined;
      let previous: string | undefined;
      do {
        const result = await page(reference, cursor, previous);
        previous = result.pageKey;
        cursor = result.next ?? undefined;
      } while (cursor);
    },
  };
}

/** The suspension's durable event starts the first page even if its HTTP/Auth
 * process died immediately after commit. Each workflow performs one page step,
 * releases every connection, then enqueues a separate workflow for its child. */
export function registerOperatorFenceWork(context: WorkContext, referenceKeys: KeyRing): void {
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const access = createAccess({ actions, accountEvidence: () => null });
  installAccessClock(access, context.clock);
  const continuations = createCommittedContinuations({
    pool: context.pool,
    referenceKeys,
    access,
    clock: context.clock,
  });
  const effect = DBOS.registerStep(
    (reference: string, cursor?: string, previous?: string) =>
      continuations.continueCommittedPage(reference, cursor, previous),
    { name: 'accounts.operator-fence-page.run', retriesAllowed: true, maxAttempts: 10, intervalSeconds: 1 },
  );
  const enqueue = async (reference: string, root: string, cursor?: string, previous?: string) => {
    await context.client.enqueue(
      {
        workflowName,
        queueName: 'workflows',
        workflowID: `${workflowName}:${root}:${keyOf(cursor)}`,
        workflowIDReusePolicy: 'return-existing',
      },
      reference,
      root,
      cursor,
      previous,
    );
  };
  DBOS.registerWorkflow(
    async (reference: string, root: string, cursor?: string, previous?: string) => {
      const result = await effect(reference, cursor, previous);
      if (result.next) await enqueue(reference, root, result.next, result.pageKey);
    },
    { name: workflowName },
  );
  context.addEffects([
    {
      name: 'operator_fence',
      types: ['com.rezics.access.account.suspended.v1', 'com.rezics.access.account.reinstated.v1'],
      async run(event) {
        const data = event.data as { accountId: string; receiptId: string; continuationOperationKey?: string };
        if (!data.continuationOperationKey) return;
        const root = await continuations.read(data.continuationOperationKey, data.accountId);
        allow(root && root.barrierReceiptId === data.receiptId);
        await enqueue(root.reference, data.receiptId);
      },
    },
  ]);
}
