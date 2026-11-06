import { expect, test } from 'bun:test';
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import { COMMAND_STEP_RETRIES } from '../../src/work/retries.ts';
import type { AccessWorkAccounting } from '../../src/access/work.ts';
import type { WorkReceipt } from '../../src/library/contract/work-dimensions.ts';
import {
  registerCommandWorkAssociation,
  withCommandWorkAssociation,
  type CommandWorkAssociation,
} from '../../src/command/index.ts';
import {
  PUBLISHED_LOG_RETENTION_PAGE_BOUND,
  PUBLISHED_LOG_RETENTION_SEGMENT_BOUND,
  publishedLogPageReadOperationPlan,
  publishedLogPointReadOperationPlan,
  publishedLogPublishOperationPlan,
  publishedLogRemainingMs,
  publishedLogRestoreOperationPlan,
  publishedLogRetractOperationPlan,
  publishedLogReadPlan,
  publishedLogRetentionPageOperationPlan,
  publishedLogRetentionPurgeOperationPlan,
  publishedLogRetentionSegmentOperationPlan,
} from '../../src/library/published-log-bounds.ts';
import { runLibraryBoundedOperation, runLibraryBoundedStep } from '../../src/library/command-support.ts';
import type { PublishedLogDueKey } from '../../src/library/published-log-retention.ts';
import {
  consumePublishedLogWork,
  publishedLogReachedNestedUnits,
  publishedLogRetrySlots,
  publishedLogStatement,
  publishedLogZeroOperand,
  withPublishedLogNativeWork,
} from '../../src/library/published-log-native.ts';
import read from '../../src/library/published-log-read.sql';

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
  for (const plan of operations.slice(0, 7)) {
    expect(plan.total.engineRequests).toBe(0);
    expect(plan.total.witnessKeys).toBe(0);
  }
  expect(operations[0]!.components.abortedOrSuccessfulAttempts!.statements).toBeGreaterThan(0);
  expect(operations[0]!.total.identityMetadataRows).toBeGreaterThan(0);
  expect(operations[0]!.controls).toMatchObject({
    durationMs,
    commandAttempts: 1 + Math.ceil(durationMs / 25),
    engineRequests: 0,
    witnessKeys: 0,
  });
  expect(operations[1]!.controls).toMatchObject({ receiptKeyCount, rawRequestKeyBytes: 765 });
  expect(operations[3]!.controls).toMatchObject({ originalAndTerminalGates: 2, engineRequests: 0 });
  expect(operations[3]!.total.identityMetadataRows).toBeGreaterThan(0);
  const remaining = publishedLogRemainingMs(Date.now() + 1_250);
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(1_250);
  const remainingPublish = publishedLogPublishOperationPlan({
    accountId,
    sessionId,
    note: null,
    requestKey: 'remaining',
    receiptKeyCount,
    durationMs: remaining,
  });
  expect(remainingPublish.controls).toMatchObject({
    durationMs: remaining,
    commandAttempts: 1 + Math.ceil(remaining / 25),
  });
  expect(remainingPublish.controls!.commandAttempts).toBeLessThan(1 + Math.ceil(durationMs / 25));

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

test('reached nested Source units use actual subject IDs, remaining deadline slots, and a zero empty path', () => {
  const now = 1_700_000_000_000;
  const dateNow = Date.now;
  Date.now = () => now;
  const subjectId = '00000000-0000-7000-8000-6c7100000005';
  const deadline = now + 1_250;
  try {
    const empty = publishedLogReachedNestedUnits({
      kind: 'published-log.point-read',
      accountId,
      deadline,
      subjectIds: [],
      logId,
      route: locator.route,
    });
    expect(empty.nestedSource).toEqual(publishedLogZeroOperand());
    expect(empty.nestedDisclosure).toEqual(publishedLogZeroOperand());
    expect(empty.zeroSqlAxes).toEqual({ witnessKeys: 0, engineRequests: 0 });
    const slots = publishedLogRetrySlots(deadline);
    expect(empty.remainingMs).toBe(1_250);
    expect(empty.remainingMs).toBe(slots.remainingMs);
    expect(empty.retryAttempts).toBe(slots.attempts);
    expect(empty.retryAttempts).toBeLessThan(1 + Math.ceil(5_000 / 25));

    const publish = publishedLogReachedNestedUnits({
      kind: 'published-log.publish',
      accountId,
      deadline,
      subjectIds: [subjectId],
      sessionId,
      note: null,
      requestKey: 'nested',
      receiptKeyCount: 3,
    });
    expect(publish.nestedSource.identityMetadataRows).toBeGreaterThan(0);
    expect(publish.nestedSource.engineRequests).toBe(0);
    expect(publish.nestedSource.witnessKeys).toBe(0);
    expect(publish.abortedAttempts.statements).toBeGreaterThan(0);
    expect(publish.successfulAttempt.statements).toBeGreaterThanOrEqual(publish.abortedAttempts.statements);
    expect(publish.retryAttempts).toBe(slots.attempts);

    const live = publishedLogReachedNestedUnits({
      kind: 'published-log.point-read',
      accountId,
      deadline,
      subjectIds: [subjectId],
      logId,
      route: locator.route,
    });
    expect(live.nestedDisclosure.identityMetadataRows).toBeGreaterThan(publish.nestedSource.identityMetadataRows);
    expect(live.nestedDisclosure.engineRequests).toBe(0);

    const leaf = publishedLogStatement(read.sql, [locator.route, logId]);
    expect(leaf).toMatchObject({ engineRequests: 0, witnessKeys: 0, statements: 1 });
    expect(publishedLogStatement('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', [])).toMatchObject({
      engineRequests: 0,
      witnessKeys: 0,
    });
  } finally {
    Date.now = dateNow;
  }
});

test('native interceptor skips consume while the enclosing operation reservation is open', async () => {
  const bound = declareBound({
    candidateKeys: 1,
    nativeRows: 1,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 32,
    engineRequests: 0,
  });
  const runs: string[] = [];
  const association = {
    deadline: Date.now() + 5_000,
    access: {} as AccessWorkAccounting,
    reserve() {
      return { settle() {} };
    },
    async run<T>(operation: string, _work: Parameters<CommandWorkAssociation['run']>[1], dispatch: () => Promise<T>) {
      runs.push(operation);
      return dispatch();
    },
    receipt: () => ({}) as WorkReceipt,
    close: () => undefined,
  } as CommandWorkAssociation;
  registerCommandWorkAssociation(association);
  const result = await withCommandWorkAssociation(association, () =>
    runLibraryBoundedOperation('published-log.test-native', bound, () =>
      withPublishedLogNativeWork(association.deadline, () =>
        consumePublishedLogWork('statement', bound, async () => 'kept'),
      ),
    ),
  );
  expect(result).toBe('kept');
  expect(runs).toEqual([]);
  const plan = publishedLogReadPlan({ route: locator.route, log_id: logId });
  const executed = await withCommandWorkAssociation(association, () =>
    runLibraryBoundedOperation('published-log.test-execute', bound, () =>
      withPublishedLogNativeWork(association.deadline, () =>
        consumePublishedLogWork(plan.kind, plan.total, async () => null),
      ),
    ),
  );
  expect(executed).toBeNull();
  expect(runs).toEqual([]);
});
