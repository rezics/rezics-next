import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import {
  assembleLibraryIdentityOriginalComponents,
  declareLibraryIdentityStatement,
  LIBRARY_IDENTITY_CHECKOUT_WORK,
  LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS,
} from '../../src/library/identity-original-work.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import {
  readLibraryScopeEffectsPageWithWork,
  type LibraryScopeEffectsPageInput,
} from '../../src/library/identity-scope-effects.ts';
import {
  bindLibraryIdentityPrepaidWork,
  withLibraryIdentityWork,
} from '../../src/library/identity-native-planner-work.ts';
import {
  identitySourceConsumerLibraryWork,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { libraryIdentitySQL } from '../../src/library/identity-native-planner-statements.ts';
import { nextLibraryIdentityNativePlanWithWork } from '../../src/library/identity-native-planner.ts';
import current from '../../src/library/identity-native-planner-current.sql';
import seal from '../../src/library/identity-scope-effects-seal.sql';
import { LIBRARY_IDENTITY_SELECTED_STATEMENTS } from '../../src/library/identity-native-planner-projection.ts';
import savedJob from '../../src/semantic/identity-epoch-store-select-job-4.sql';
import partition from '../../src/partition/read.sql';
import * as installedLibraryWork from '../../src/library/collection-source-work.ts';

// This is a no-IO refusal fixture, never a native database or private Accounts grant fixture.
function forbiddenPool(): { pool: Pool; calls: () => number } {
  let calls = 0;
  const pool = Object.assign(new EventEmitter(), {
    connect: async () => {
      calls++;
      throw new Error('Unexpected checkout');
    },
  }) as unknown as Pool;
  return { pool, calls: () => calls };
}
const id = '00000000-0000-0000-0000-000000000001';
const input = (deadline: number): LibraryScopeEffectsPageInput => ({
  job: { jobId: id, epoch: 1n },
  sourceIdentity: {
    route: 0,
    collectionId: id,
    accountId: id,
    scope: 'curated',
    incarnation: `${id}:0`,
    generation: '1',
    ownerEpoch: 1,
    receivingEpoch: '1',
    effectKey: 'effect',
  },
  scope: 'collection-source',
  after: null,
  limit: 1,
  deadline,
});

test('literal page/current/seal declarations retain all eight axes and repeat/rollback composition', () => {
  const page = declareLibraryIdentityStatement('planner', libraryIdentitySQL.effectPage, [0, id, 'plan', '', '', 1])!;
  expect(page.work).toEqual({
    candidateKeys: 1,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes:
      Buffer.byteLength(libraryIdentitySQL.effectPage) +
      Buffer.byteLength(JSON.stringify([0, id, 'plan', '', '', 1])) +
      512,
    emptySeeks: 1,
  });
  const currentPoint = declareLibraryIdentityStatement(
    'planner',
    current.sql,
    LIBRARY_IDENTITY_SELECTED_STATEMENTS.current.values,
  )!;
  expect(currentPoint.work).toMatchObject({ nativeRows: 7, nativePoints: 7, identityMetadataRows: 1, witnessKeys: 0 });
  const sealPoint = declareLibraryIdentityStatement('planner', seal.sql, [])!;
  expect(sealPoint.work).toMatchObject({ nativeRows: 5, nativePoints: 5, identityMetadataRows: 2 });
  const commit = declareLibraryIdentityStatement('planner', 'COMMIT', [])!;
  const rollback = declareLibraryIdentityStatement('planner', 'ROLLBACK', [])!;
  const total = assembleLibraryIdentityOriginalComponents([
    { component: LIBRARY_IDENTITY_CHECKOUT_WORK, multiplicity: 1 },
    { component: page, multiplicity: 2 },
    { component: currentPoint, multiplicity: 4 }, // repeated, exhausted recheck and final fence
    { component: sealPoint, multiplicity: 4 },
    { component: commit, multiplicity: 1 },
    { component: rollback, multiplicity: 1 }, // failure does not reuse COMMIT's slot
  ]);
  expect(total.work.nativeRows).toBe(52);
  expect(total.work.identityMetadataRows).toBe(12);
  expect(total.work.nativePoints).toBe(51);
  expect(total.work.statements).toBe(12);
  expect(total.engineRequests).toBe(0);
  const ledger = new NativeCollectionWork({ reservationId: 'same-original', remaining: total.work }, Date.now() + 5000);
  for (let repeat = 0; repeat < 2; repeat++) {
    const held = ledger.reserve(page.work);
    held.dispatch();
    held.settle(); // SQL failure/rollback leaves dispatched bounds charged as well.
  }
  expect(ledger.receipt()).toMatchObject({ reservationId: 'same-original', used: { nativeRows: 4, statements: 2 } });
});

test('unknown statements, unadmitted job projections, invalid multiplicities and forged components refuse', () => {
  expect(declareLibraryIdentityStatement('planner', 'SELECT * FROM library.identity_scope_effect', [])).toBeUndefined();
  expect(declareLibraryIdentityStatement('planner', savedJob.sql, [0, id, '1'])).toBeUndefined();
  expect(declareLibraryIdentityStatement('native-collection', 'COMMIT; SELECT 1', [])).toBeUndefined();
  expect(declareLibraryIdentityStatement('native-custody', 'BEGIN; SELECT 1', [])).toBeUndefined();
  expect(() =>
    assembleLibraryIdentityOriginalComponents([{ component: { ...LIBRARY_IDENTITY_CHECKOUT_WORK }, multiplicity: 1 }]),
  ).toThrow('Foreign');
  expect(() =>
    assembleLibraryIdentityOriginalComponents([{ component: LIBRARY_IDENTITY_CHECKOUT_WORK, multiplicity: Infinity }]),
  ).toThrow('Unbounded');
  expect(LIBRARY_IDENTITY_ORIGINAL_MISSING_OPERANDS.map((item) => item.operand)).toEqual([
    'library-invocation-multiplicities',
    'native-command-partition-projection',
    'original-projection-bound',
  ]);
  expect(Object.hasOwn(installedLibraryWork, 'IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION')).toBe(true);
  const declaration = installedLibraryWork.IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION;
  expect(Object.keys(declaration).sort()).toEqual(['engineRequests', 'work']);
  expect(Object.isFrozen(declaration)).toBe(true);
  expect(declaration.engineRequests).toBe(0);
  expect(declaration.work).toMatchObject({
    candidateKeys: 1,
    nativeRows: 785,
    identityMetadataRows: 66,
    nativePoints: 127,
    witnessKeys: 0,
    statements: 34,
    emptySeeks: 70,
  });
});

test('failed COMMIT retains its charge and a separately held ROLLBACK uses the same reservation', async () => {
  const commit = declareLibraryIdentityStatement('native-custody', 'COMMIT', [])!;
  const rollback = declareLibraryIdentityStatement('native-custody', 'ROLLBACK', [])!;
  const total = assembleLibraryIdentityOriginalComponents([
    { component: commit, multiplicity: 1 },
    { component: rollback, multiplicity: 1 },
  ]);
  const ledger = new NativeCollectionWork(
    { reservationId: 'failed-original', remaining: total.work },
    Date.now() + 5000,
  );
  const commitSlot = ledger.reserve(commit.work, true);
  const rollbackSlot = ledger.reserve(rollback.work, true);
  commitSlot.dispatch();
  try {
    await expect(
      commitSlot.query(async () => {
        throw new Error('Deferred COMMIT failure');
      }),
    ).rejects.toThrow('COMMIT failure');
  } finally {
    commitSlot.settle();
  }
  rollbackSlot.dispatch();
  try {
    await rollbackSlot.query(async () => undefined);
  } finally {
    rollbackSlot.settle();
  }
  expect(ledger.receipt()).toEqual({ reservationId: 'failed-original', used: total.work });
  expect(() => ledger.reserve(commit.work)).toThrow();
});

test('prepaid page rejects independently funded and copied ledgers before native IO', async () => {
  const { pool, calls } = forbiddenPool();
  const deadline = Date.now() + 5000;
  const work = new NativeCollectionWork(
    {
      reservationId: 'independent',
      remaining: {
        candidateKeys: 1,
        nativeRows: 100,
        identityMetadataRows: 100,
        nativePoints: 100,
        witnessKeys: 0,
        statements: 100,
        bytes: 100000,
        emptySeeks: 100,
      },
    },
    deadline,
  );
  await expect(readLibraryScopeEffectsPageWithWork(pool, input(deadline), work)).rejects.toThrow(
    'Missing live prepaid Library partition',
  );
  await expect(
    readLibraryScopeEffectsPageWithWork(pool, input(deadline), { ...work } as NativeCollectionWork),
  ).rejects.toThrow('Missing live prepaid Library partition');
  expect(calls()).toBe(0);
});

test('live owner equality rejects foreign Pool, changed deadline, wrong ledger and ended/escaped callbacks', async () => {
  const { pool, calls } = forbiddenPool();
  const foreign = forbiddenPool();
  const deadline = Date.now() + 5000;
  let escaped!: () => Promise<unknown>;
  let escapedDiscovery!: () => Promise<unknown>;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (context) => {
    const work = identitySourceConsumerLibraryWork(pool, context.identityConsumerWork, deadline)!;
    bindLibraryIdentityPrepaidWork(pool, work, deadline);
    expect(declareLibraryIdentityStatement('planner', partition.sql, [0], work)).toBeUndefined();
    expect(await withLibraryIdentityWork(pool, work, async () => work)).toBe(work);
    for (const changed of [deadline - 1, deadline + 1, Date.now() - 1])
      await expect(readLibraryScopeEffectsPageWithWork(pool, input(changed), work)).rejects.toThrow(
        'Missing live prepaid',
      );
    await expect(readLibraryScopeEffectsPageWithWork(foreign.pool, input(deadline), work)).rejects.toThrow(
      'Missing live prepaid',
    );
    await expect(
      readLibraryScopeEffectsPageWithWork(pool, input(deadline), { ...work } as NativeCollectionWork),
    ).rejects.toThrow('Missing live prepaid');
    escapedDiscovery = () => nextLibraryIdentityNativePlanWithWork(pool, input(deadline).job, { deadline }, work);
    // Ending while an awaited descendant is outstanding closes its continuation too.
    let resume!: () => void;
    const pending = withLibraryIdentityWork(
      pool,
      work,
      () =>
        new Promise<void>((resolve) => {
          resume = resolve;
        }),
    );
    escaped = async () => {
      resume();
      return pending;
    };
  });
  await expect(escaped()).rejects.toThrow('Missing live prepaid');
  await expect(escapedDiscovery()).rejects.toThrow('Missing live prepaid');
  expect(calls()).toBe(0);
  expect(foreign.calls()).toBe(0);
});

import {
  assembleLibraryIdentitySelectedBodies,
  LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES,
  LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS,
} from '../../src/library/identity-original-work.ts';
import {
  LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
} from '../../src/library/identity-native-planner-projection.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../../src/command/dispatch-lifetime.ts';
import type { CommandTransaction } from '../../src/command/command.ts';
import {
  pageLibraryIdentityEpochChanges,
  identityEpochLibraryInputsSQL,
} from '../../src/semantic/identity-epoch-store.ts';
import transform from '../../src/semantic/identity-epoch-store-library-transform.sql';
import originals from '../../src/semantic/identity-epoch-store-select-original.sql';
import { nativeCollectionPartitionMetadataSQL } from '../../src/library/collection-source-native.ts';

test('selected Library bodies compose three current paths and one limit1 page, excluding disjoint Core controls', () => {
  const body = assembleLibraryIdentitySelectedBodies();
  expect(body.multiplicities).toEqual({
    discovery: 0,
    plannerSteps: 0,
    effectPages: 1,
    currentVerifications: 1,
    exhaustedPageRechecks: 1,
    finalFences: 0,
  });
  expect(body.multiplicities).toBe(LIBRARY_IDENTITY_SELECTED_MULTIPLICITIES);
  expect(body.coreDispatch).toBe(COMMAND_DISPATCH_ALLOWANCE);
  expect(body.total.work).toMatchObject({
    candidateKeys: 1,
    nativeRows: 785,
    identityMetadataRows: 66,
    nativePoints: 127,
    witnessKeys: 0,
    statements: 34,
    emptySeeks: 70,
  });
  expect(body.total.engineRequests).toBe(0);
  const recomposed = assembleLibraryIdentityOriginalComponents([
    { component: body.page, multiplicity: 1 },
    { component: body.currentVerification, multiplicity: 1 },
    { component: body.exhaustedPageRecheck, multiplicity: 1 },
  ]);
  expect(recomposed.work).toEqual(body.total.work);
  const work = new NativeCollectionWork(
    { reservationId: 'selected-body', remaining: body.total.work },
    Date.now() + 5000,
  );
  for (const part of [body.page, body.currentVerification, body.exhaustedPageRecheck]) {
    const held = work.reserve(part.work);
    held.dispatch();
    held.settle();
  }
  expect(work.receipt().used).toEqual(body.total.work);
  expect(body.missing).toBe(LIBRARY_IDENTITY_SELECTED_MISSING_OPERANDS);
  expect(body.missing).toEqual([]);
  expect(Object.hasOwn(installedLibraryWork, 'IDENTITY_HISTORY_ORIGINAL_LIBRARY_DECLARATION')).toBe(true);
});

test('native selected projections have enforced serialized bind limits and metadata omits unconsumed addresses', () => {
  const plan = LIBRARY_IDENTITY_SELECTED_STATEMENTS.plan;
  const declared = declareLibraryIdentityStatement('planner', plan.sql, plan.values)!;
  expect(declared.work.bytes).toBe(
    Buffer.byteLength(plan.sql) + Buffer.byteLength(JSON.stringify(plan.values)) + LIBRARY_IDENTITY_PLAN_RESULT_BYTES,
  );
  expect(declareLibraryIdentityStatement('planner', plan.sql, [65535, id, 'x'.repeat(65536)])).toBeUndefined();
  expect(declareLibraryIdentityStatement('planner', plan.sql + '; SELECT 1', plan.values)).toBeUndefined();
  expect(nativeCollectionPartitionMetadataSQL).not.toContain('node');
  expect(nativeCollectionPartitionMetadataSQL).not.toContain('moved_to');
  const metadata = declareLibraryIdentityStatement('native-collection', nativeCollectionPartitionMetadataSQL, [0])!;
  expect(metadata.work).toMatchObject({
    candidateKeys: 0,
    nativeRows: 4,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    emptySeeks: 1,
  });
});

// These pure algorithm fixtures exercise the bounded native transform projection, not private grant
// admission or a real snapshot/current owner. The real planner supplies its own same-snapshot client.
const numberedId = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;
function transformClient(
  saved: Record<string, unknown>,
  pages: readonly (readonly { original: string; terminal: string }[])[],
  inputCount = pages.length,
) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  let page = 0;
  const tx = {
    query: async (sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      if (sql === transform.sql) return { rows: [saved] };
      if (sql === identityEpochLibraryInputsSQL)
        return {
          rows: Array.from({ length: inputCount }, (_, n) => ({
            generation: numberedId(1000 + n),
            terminal: numberedId(2000 + n),
            control_partition: 0,
          })),
        };
      if (sql === originals.sql) return { rows: pages[page++] ?? [] };
      throw new Error('Unexpected transform SQL');
    },
  } as unknown as CommandTransaction;
  return { tx, calls };
}

test('Library immutable transform preserves the minimum full-input cutoff, order and bounded original generations', async () => {
  const a = Array.from({ length: 50 }, (_, n) => ({ original: numberedId(2 * (n + 1)), terminal: numberedId(2000) }));
  const b = [1, 3, 5, 101].map((n) => ({ original: numberedId(n), terminal: numberedId(2001) }));
  const fixture = transformClient(
    { kind: 'merge', survivor: numberedId(3000), original: null, terminal: null, remainder_terminal: null },
    [a, b],
  );
  const result = await pageLibraryIdentityEpochChanges(fixture.tx, { jobId: id, epoch: 1n }, null);
  expect(result.changes).toHaveLength(53);
  expect(result.next).toBe(numberedId(100));
  expect(result.changes[0]!.original).toBe(numberedId(1));
  expect(result.changes.every((item) => item.terminal === numberedId(3000))).toBe(true);
  expect(result.changes.some((item) => item.original === numberedId(101))).toBe(false);
  expect(fixture.calls.map((call) => call.sql)).toEqual([
    transform.sql,
    identityEpochLibraryInputsSQL,
    originals.sql,
    originals.sql,
  ]);
  expect(fixture.calls.slice(2).map((call) => call.values[2])).toEqual([50, 50]);
  expect(transform.sql).not.toMatch(/SELECT\s+(?:j\.)?intent\b/i);
});

test('Library transform refuses malformed native operands and a third input before any original seek', async () => {
  for (const saved of [
    { kind: 'other', survivor: id, original: null, terminal: null, remainder_terminal: null },
    { kind: 'repoint', survivor: null, original: id, terminal: 'unbounded foreign value', remainder_terminal: null },
    { kind: 'unmerge', survivor: null, original: id, terminal: null, remainder_terminal: id },
  ]) {
    const fixture = transformClient(saved, [[]]);
    await expect(pageLibraryIdentityEpochChanges(fixture.tx, { jobId: id, epoch: 1n }, null)).rejects.toThrow();
    expect(fixture.calls).toHaveLength(1);
  }
  const fixture = transformClient(
    { kind: 'unmerge', survivor: null, original: id, terminal: null, remainder_terminal: null },
    [],
    3,
  );
  await expect(pageLibraryIdentityEpochChanges(fixture.tx, { jobId: id, epoch: 1n }, null)).rejects.toThrow();
  expect(fixture.calls).toHaveLength(2);
});

test('fixed-width Library transform preserves unmerge/repoint remainder semantics and genuine empty pages', async () => {
  const original = numberedId(10),
    remainder = numberedId(20),
    destination = numberedId(30);
  for (const kind of ['unmerge', 'repoint'] as const) {
    const fixture = transformClient(
      {
        kind,
        survivor: null,
        original,
        terminal: kind === 'repoint' ? destination : null,
        remainder_terminal: remainder,
      },
      [
        [
          { original: numberedId(1), terminal: original },
          { original, terminal: original },
        ],
      ],
    );
    const result = await pageLibraryIdentityEpochChanges(fixture.tx, { jobId: id, epoch: 1n }, null);
    expect(result.next).toBeNull();
    expect(result.changes.map((item) => item.terminal)).toEqual([
      remainder,
      kind === 'unmerge' ? original : destination,
    ]);
    expect(fixture.calls[2]!.values[2]).toBe(100);
  }
  const empty = transformClient(
    { kind: 'unmerge', survivor: null, original, terminal: null, remainder_terminal: null },
    [[]],
  );
  expect(await pageLibraryIdentityEpochChanges(empty.tx, { jobId: id, epoch: 1n }, null)).toEqual({
    changes: [],
    next: null,
  });
  const priced = declareLibraryIdentityStatement('planner', transform.sql, [0, id, '1'])!;
  expect(priced.work).toMatchObject({
    candidateKeys: 0,
    nativeRows: 3,
    identityMetadataRows: 2,
    nativePoints: 3,
    witnessKeys: 0,
    statements: 1,
    emptySeeks: 3,
  });
  expect(priced.work.bytes).toBe(
    Buffer.byteLength(transform.sql) + Buffer.byteLength(JSON.stringify([0, id, '1'])) + 256,
  );
});
