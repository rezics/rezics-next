import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
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
import { lifecycleExecutor } from './lifecycle-20261025094010-command.ts';
import { createOperatorCommands } from './operator.ts';
import { createAccess } from './permission.ts';
import insertPage from './committed-continuation-page-insert.sql';
import readPage from './committed-continuation-page-read.sql';

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

/** The root and every child snapshot commit before effects. Page receipts and
 * subject receipts are independent: a failed page effect replays its immutable
 * allowlist and native subject keys, without repeating any fence advance. */
export function createOperatorFenceRunner(config: {
  pool: Pool;
  referenceKeys: KeyRing;
  clock?: () => Date;
  pageSize?: number;
  root(reference: string): Promise<ContinuationSnapshot>;
}) {
  const pageSize = config.pageSize ?? PAGE_SIZE;
  allow(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= PAGE_SIZE);
  const actions = new Map([['account:manage', { anonymous: false }]]);
  const operators = createOperatorCommands({
    pool: config.pool,
    actions,
    access: createAccess({ actions, accountEvidence: () => null }),
    managementAction: 'account:manage',
    cursorKeys: config.referenceKeys,
  });
  const execute = lifecycleExecutor(config.pool, config.clock);
  async function page(reference: string, cursor?: string, previous?: string) {
    const root = await config.root(reference);
    const pageKey = keyOf(cursor);
    const pageEntry = entry(
      'operator-responsibility-page',
      root.accountId,
      cursor ? `${root.commandKeyPrefix}:page:${pageKey}` : `${root.commandKeyPrefix}:operator-responsibility-page`,
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
    // Page observation finishes before command checkout. Suspension has already
    // closed the operator to new reservations; subject transfers are rechecked
    // under the subject lock when each child executes.
    const batch = existing
      ? undefined
      : await operators.responsibilityPage({
          operatorAccountId: root.accountId,
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        });
    const snapshot = await execute(
      {
        route: root.route,
        id: root.accountId,
        kind: 'operator.fence-page',
        key: pageEntry.key,
        input: { continuationId: root.continuationId, cursor: cursor ?? null },
      },
      async (tx) => {
        allow(batch);
        const allowlist = batch.operators.map((subject) =>
          entry(
            'fence',
            `${subject.subjectAccountId}:${subject.reservationId}`,
            `${root.commandKeyPrefix}:fence:${subject.reservationId}`,
          ),
        );
        if (batch.next)
          allowlist.push(
            entry('operator-responsibility-page', root.accountId, `${root.commandKeyPrefix}:page:${keyOf(batch.next)}`),
          );
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
      if (child.step !== 'fence') continue;
      const [subjectAccountId, reservationId] = child.target.split(':');
      allow(subjectAccountId && reservationId);
      await operators.fenceOperatedSubject({
        operatorAccountId: root.accountId,
        subjectAccountId,
        reservationId,
        key: child.key,
      });
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
  const continuations = createCommittedContinuations({
    pool: context.pool,
    referenceKeys,
    access: createAccess({ actions, accountEvidence: () => null }),
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
      types: ['com.rezics.access.account.suspended.v1'],
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
