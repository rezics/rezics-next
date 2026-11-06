import { expect, test } from 'bun:test';
import pg from 'pg';
import { runOperationalTransaction, type OperationalTransaction } from '../../src/command/operational.ts';
import {
  openSelectedOperationalPhase,
  composeSelectedRuntime,
  assertSelectedOperationalTransaction,
  type SelectedOperationalPhase,
  type SelectedIdentity,
} from '../../src/work/selected-runtime.ts';
import { associateSelectedEpisode, finishSelectedEpisode } from '../../src/history/adapters/operational-work-selected.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import {
  SELECTED_AXES,
  SELECTED_COST,
  SELECTED_LOCAL_DECLARATION,
  SELECTED_CLEANUP_DECLARATION,
  sumSelectedCost,
} from '../../src/work/selected-runtime-cost.ts';
import { type SelectedEpisode } from '../../src/history/contract/operational-types.ts';

// UNRUN. These tests reject counterfeit authority before database access.
const pool = new pg.Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' });
const owner = newId(0xc100);
const work = {} as WorkClient;
const identity = {} as SelectedIdentity;
const options = {
  mode: 'work-step' as const,
  partition: partitionOf(0xc100),
  kind: 'library.membersPreparation.step',
  accounts: [owner],
  workClient: work,
  selectedRuntime: Object.freeze({}) as SelectedOperationalPhase,
};
const tx = {
  query() {
    throw new Error('counterfeit SQL was dispatched');
  },
} as unknown as OperationalTransaction;

test('Copied phase, structural WorkClient and matching names cannot create a native operational transaction', async () => {
  expect(() => composeSelectedRuntime(pool, work)).toThrow('original shared WorkClient/Pool');
  expect(() => openSelectedOperationalPhase(pool, options)).toThrow('forged-phase');
  await expect(
    runOperationalTransaction(pool, options, async () => {
      throw new Error('body reached');
    }),
  ).rejects.toThrow('forged-phase');
  expect(pool.totalCount).toBe(0);
});
test('History association has no public structural identity or synthetic transaction route', async () => {
  expect(() => assertSelectedOperationalTransaction(tx, identity)).toThrow('forged-association');
  const locator = { route: 0xc100, ownerAccountId: owner, collectionId: newId(0xc100), episodeId: newId(0xc100) };
  await expect(associateSelectedEpisode(tx, identity, locator)).rejects.toThrow('forged-association');
  await expect(
    finishSelectedEpisode(tx, identity, { result: null } as SelectedEpisode, 'apply', async () => ({
      kind: 'complete',
      version: '1',
    })),
  ).rejects.toThrow('forged-association');
});
test('The finite local original reserves disjoint cleanup and rejects unknown or overflowing child prices', () => {
  for (const axis of SELECTED_AXES()) {
    expect(Number.isSafeInteger(SELECTED_LOCAL_DECLARATION()[axis])).toBe(true);
    expect(SELECTED_LOCAL_DECLARATION()[axis]).toBeGreaterThanOrEqual(SELECTED_CLEANUP_DECLARATION()[axis]);
  }
  expect(SELECTED_CLEANUP_DECLARATION().statements).toBe(
    SELECTED_COST().release.statements + 3 * SELECTED_COST().rollback.statements,
  );
  expect(() => sumSelectedCost()({ ...SELECTED_COST().hold, bytes: NaN })).toThrow();
  expect(() =>
    sumSelectedCost()({ ...SELECTED_COST().hold, bytes: Number.MAX_SAFE_INTEGER }, SELECTED_COST().hold),
  ).toThrow('overflow');
  expect(() => sumSelectedCost()({ ...SELECTED_COST().hold, engineRequests: undefined } as never)).toThrow();
});
