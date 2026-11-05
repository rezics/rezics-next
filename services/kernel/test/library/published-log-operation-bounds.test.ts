import { expect, test } from 'bun:test';
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import { COMMAND_STEP_RETRIES } from '../../src/work/retries.ts';
import type { AccessWorkAccounting } from '../../src/access/work.ts';
import type { WorkReceipt } from '../../src/library/collection-source.ts';
import { registerCommandWorkAssociation, type CommandWorkAssociation } from '../../src/command/work-context.ts';
import { withCommandWorkAssociation } from '../../src/command/work.ts';
import {
  PUBLISHED_LOG_RETENTION_PAGE_BOUND,
  PUBLISHED_LOG_RETENTION_SEGMENT_BOUND,
  publishedLogPageReadOperationPlan,
  publishedLogPointReadOperationPlan,
  publishedLogPublishOperationPlan,
  publishedLogRestoreOperationPlan,
  publishedLogRetractOperationPlan,
  publishedLogRetentionPageOperationPlan,
  publishedLogRetentionPurgeOperationPlan,
  publishedLogRetentionSegmentOperationPlan,
} from '../../src/library/published-log-bounds.ts';
import { runLibraryBoundedOperation, runLibraryBoundedStep } from '../../src/library/command-support.ts';
import type { PublishedLogDueKey } from '../../src/library/published-log-retention.ts';

const accountId = '00000000-0000-7000-8000-6c7100000001';
const logId = '00000000-0000-7000-8000-6c7100000002';
const sessionId = '00000000-0000-7000-8000-6c7100000003';
const deletionId = '00000000-0000-4000-8000-6c7100000004';
const cutoff = '2026-11-05T12:00:00.000Z';
const locator: PublishedLogDueKey = {
  route: 0x6c71,
  logId,
  accountId,
  deletionId,
  revision: 7,
  restoreUntil: '2026-11-05T11:00:00.000Z',
};
const cursor = { partition: 0x6c7, after: locator };

function assertComplete(plan: { components: Readonly<Record<string, Bound>>; total: Bound }) {
  expect(plan.total).toEqual(sumBounds(...Object.values(plan.components)));
  expect(plan.total.statements).toBeGreaterThan(0);
  expect(plan.total.bytes).toBeGreaterThan(0);
}

test('Published Log command, read and retention operations compose their full local envelopes', () => {
  const receiptKeyCount = 3;
  const durationMs = 5_000;
  const operations = [
    publishedLogPublishOperationPlan({
      accountId,
      sessionId,
      note: '\0'.repeat(1000),
      requestKey: 'publish',
      receiptKeyCount,
    }),
    publishedLogRetractOperationPlan({ accountId, logId, requestKey: 'retract', revision: 7, receiptKeyCount }),
    publishedLogRestoreOperationPlan({
      accountId,
      logId,
      deletionId,
      revision: 7,
      requestKey: 'restore',
      receiptKeyCount,
    }),
    publishedLogPointReadOperationPlan({ route: locator.route, logId }),
    publishedLogPageReadOperationPlan({ route: locator.route, accountId, limit: 100, hasCursor: true }),
    publishedLogRetentionPurgeOperationPlan(locator, receiptKeyCount, durationMs),
    publishedLogRetentionPageOperationPlan({ cutoff, cursor, receiptKeyCount, durationMs }),
    publishedLogRetentionSegmentOperationPlan({
      root: 'scheduled-root',
      sequence: 4,
      cutoff,
      cursor,
      receiptKeyCount,
      durationMs,
    }),
  ];
  for (const plan of operations) assertComplete(plan);
  for (const plan of operations.slice(0, 7)) expect(plan.total.engineRequests).toBe(0);
  expect(operations[1]!.controls).toMatchObject({ receiptKeyCount, rawRequestKeyBytes: 765 });

  const publicPage = operations[4]!;
  expect(publicPage.controls).toMatchObject({ rawLimit: 101, disclosureMaximum: 100, pageSentinel: 1 });
  expect(publicPage.components.firstAndNextPageStreams).toMatchObject({
    candidateKeys: 101,
    nativeRows: 202,
    emptySeeks: 2,
  });

  const retentionPage = operations[6]!;
  expect(retentionPage.controls).toMatchObject({
    pageBound: PUBLISHED_LOG_RETENTION_PAGE_BOUND,
    dueKeysIncludingNegativeAndEof: 100,
    partitionProbes: 100,
    cutoff,
    cursor: JSON.stringify(cursor),
  });
  const segment = operations[7]!;
  expect(segment.controls).toMatchObject({
    segmentBound: PUBLISHED_LOG_RETENTION_SEGMENT_BOUND,
    continuationPolicy: 'return-existing',
    root: 'scheduled-root',
    sequence: 4,
    cutoff,
  });
  expect(segment.total.engineRequests).toBe(COMMAND_STEP_RETRIES.maxAttempts);
  expect(operations[5]!.controls?.exactDeletionLocator).toBe(
    JSON.stringify({ deletionId, revision: 7, restoreUntil: locator.restoreUntil }),
  );
});

test('a composed operation reserves once and its SQL leaves run on that reservation', async () => {
  const bound = declareBound({
    candidateKeys: 2,
    nativeRows: 1,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 64,
    engineRequests: 0,
  });
  const reservations: Array<{ operation: string; bound: Record<string, number> }> = [];
  let settlements = 0;
  const association = {
    deadline: Date.now() + 5_000,
    access: {} as AccessWorkAccounting,
    reserve(operation: string, work: Parameters<CommandWorkAssociation['reserve']>[1]) {
      reservations.push({ operation, bound: work as unknown as Record<string, number> });
      return { settle: () => settlements++ };
    },
    async run<T>(_operation: string, _work: Parameters<CommandWorkAssociation['run']>[1], dispatch: () => Promise<T>) {
      return dispatch();
    },
    receipt: () => ({}) as WorkReceipt,
    close: () => undefined,
  } as CommandWorkAssociation;
  registerCommandWorkAssociation(association);

  const result = await withCommandWorkAssociation(association, () =>
    runLibraryBoundedOperation('published-log.test', bound, () =>
      runLibraryBoundedStep('published-log.test-leaf', bound, async () => 'done'),
    ),
  );

  expect(result).toBe('done');
  expect(reservations).toHaveLength(1);
  expect(reservations[0]!.operation).toBe('published-log.test');
  expect(reservations[0]!.bound).not.toHaveProperty('engineRequests');
  expect(settlements).toBe(1);
});
