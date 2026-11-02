import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import {
  prepareSearchReceivingCaptures,
  searchReceivingCaptureCost,
  searchReceivingCaptureStatements as sql,
} from '../../src/semantic/identity-search-receiving-capture.ts';

const original = '00000000-0000-4000-8000-000000000001';
const native = '00000000-0000-4000-8000-000000000002';
const emptyIdentity = '0'.repeat(64);
type BasisRow = { actor: boolean; delegated: boolean; requested_bytes: number };

// Planner-unit double only. This does not establish native provenance, a complete
// physical formula or fit in the authentic original Source maintenance frame.
function planner(bases: ReadonlyMap<string, BasisRow>, nativeTransaction: string | null = native) {
  let selected = false;
  const reads: string[] = [];
  const arms: (readonly unknown[])[] = [];
  const costs: WorkDimensions[] = [];
  const client = {
    async query(text: string, values: readonly unknown[]) {
      if (text === sql.next) {
        if (selected) return { rows: [] };
        selected = true;
        return {
          rows: [
            {
              ordinal: '1',
              partition_no: 1,
              store: 'identity_epoch_effect_receipt',
              record_key: '1',
              source_transaction_id: original,
              native_transaction_id: nativeTransaction,
            },
          ],
        };
      }
      if (text === sql.copyFirst || text === sql.sourceFirst) return { rows: [] };
      if (text === sql.basis) {
        const transaction = values[1] as string;
        reads.push(transaction);
        const row = bases.get(transaction);
        return { rows: row ? [row] : [] };
      }
      if (text === sql.arm) {
        arms.push([...values]);
        return { rows: [{ ordinal: '1' }], rowCount: 1 };
      }
      throw new Error('Unexpected native-basis planner query');
    },
  } as unknown as PoolClient;
  return {
    reads,
    arms,
    costs,
    run(reserve: (cost: WorkDimensions) => void = () => {}) {
      return prepareSearchReceivingCaptures(client, (cost) => {
        reserve(cost);
        costs.push(cost);
      });
    },
  };
}

test('original and native bases have separate prepaid footprints and immutable arm operands', async () => {
  const p = planner(
    new Map([
      [original, { actor: true, delegated: false, requested_bytes: 0 }],
      [native, { actor: true, delegated: true, requested_bytes: 92 }],
    ]),
  );
  await p.run();
  expect(p.reads).toEqual([original, native]);
  expect(p.arms).toEqual([['1', original, native, 0, 0, 2, 0, 5, 92, emptyIdentity, emptyIdentity]]);
  // These are only the additional deferred/body reservations. SQL queries have
  // their separate observer. Existing base: 8/8/8/2048/5 and 1536 control/identity bytes;
  // native probe: 1/1/1/256/1; actor basis: 20/20/18/6144/10;
  // delegated actor basis: 47/47/42/14684/25. No axis is omitted.
  const total: { -readonly [Axis in keyof WorkDimensions]: number } = {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    emptySeeks: 0,
  };
  for (const cost of p.costs)
    for (const axis of Object.keys(total) as (keyof WorkDimensions)[]) total[axis] += cost[axis];
  expect(total).toEqual({
    candidateKeys: 0,
    nativeRows: 76,
    identityMetadataRows: 0,
    nativePoints: 76,
    witnessKeys: 0,
    statements: 69,
    bytes: 24668,
    emptySeeks: 41,
  });
  expect(searchReceivingCaptureCost(0, 0, { locators: 2, bytes: 0 }, { locators: 5, bytes: 92 })).toEqual({
    candidateKeys: 0,
    nativeRows: 76,
    identityMetadataRows: 0,
    nativePoints: 76,
    witnessKeys: 0,
    statements: 69,
    bytes: 23132,
    emptySeeks: 41,
  });
});

test('a native basis remains funded when the original basis is absent', async () => {
  const p = planner(new Map([[native, { actor: true, delegated: false, requested_bytes: 0 }]]));
  await p.run();
  expect(p.reads).toEqual([original, native]);
  expect(p.arms).toEqual([['1', original, native, 0, 0, null, null, 2, 0, emptyIdentity, emptyIdentity]]);
});

test('a shared original/native transaction has exactly one basis reservation', async () => {
  const p = planner(new Map([[original, { actor: true, delegated: false, requested_bytes: 0 }]]), original);
  await p.run();
  expect(p.reads).toEqual([original]);
  expect(p.arms).toEqual([['1', original, original, 0, 0, 2, 0, null, null, emptyIdentity, emptyIdentity]]);
  expect(p.costs.filter((cost) => cost.nativePoints === 20)).toHaveLength(1);
});

test('an absent native basis retains its actual probe and nullable arm binding', async () => {
  const p = planner(new Map([[original, { actor: true, delegated: false, requested_bytes: 0 }]]));
  await p.run();
  expect(p.reads).toEqual([original, native]);
  expect(p.arms).toEqual([['1', original, native, 0, 0, 2, 0, null, null, emptyIdentity, emptyIdentity]]);
  expect(searchReceivingCaptureCost(0, 0, null, null)).toEqual({
    candidateKeys: 0,
    nativeRows: 9,
    identityMetadataRows: 0,
    nativePoints: 9,
    witnessKeys: 0,
    statements: 9,
    bytes: 2304,
    emptySeeks: 6,
  });
});

test('native requested-by bytes remain charged even when they do not add delegation locators', () => {
  // A 92-byte nonmatching requested-by projects its bytes but no delegated role.
  expect(searchReceivingCaptureCost(0, 0, null, { locators: 2, bytes: 92 })).toEqual({
    candidateKeys: 0,
    nativeRows: 29,
    identityMetadataRows: 0,
    nativePoints: 29,
    witnessKeys: 0,
    statements: 27,
    bytes: 8540,
    emptySeeks: 16,
  });
  expect(searchReceivingCaptureCost(0, 0, null, { locators: 2, bytes: 0 })).toEqual({
    candidateKeys: 0,
    nativeRows: 29,
    identityMetadataRows: 0,
    nativePoints: 29,
    witnessKeys: 0,
    statements: 27,
    bytes: 8448,
    emptySeeks: 16,
  });
});

test('insufficient native-basis funding refuses arming and retains reached reservations', async () => {
  const p = planner(new Map([[native, { actor: true, delegated: true, requested_bytes: 92 }]]));
  const refusal = Object.assign(new Error('Native basis reservation refused'), { code: 'identity_epoch_unavailable' });
  await expect(
    p.run((cost) => {
      if (cost.nativePoints === 47) throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(p.arms).toEqual([]);
  expect(p.reads).toEqual([original, native]);
  expect(p.costs.map((cost) => cost.nativePoints)).toEqual([8, 0, 1]);
});
