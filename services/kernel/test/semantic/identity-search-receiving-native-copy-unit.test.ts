import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import {
  prepareSearchReceivingCaptures,
  searchReceivingCaptureStatements as sql,
} from '../../src/semantic/identity-search-receiving-capture.ts';

const original = '00000000-0000-4000-8000-000000000001';
const native = '00000000-0000-4000-8000-000000000002';
const emptyIdentity = '0'.repeat(64);
type Role = { account_id: string; role: string };
const roles = (width: number): Role[] =>
  Array.from({ length: width }, (_, i) => ({
    account_id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`,
    role: 'owner',
  }));

// A transaction-filtered planner unit double. This is not the original-frame,
// native provenance, unrelated-data growth or configured factory acceptance.
function planner(
  copies: ReadonlyMap<string, readonly Role[]>,
  sources: ReadonlyMap<string, readonly Role[]>,
  nativeTransaction = native,
) {
  let selected = false;
  const reads: { kind: 'copy' | 'source'; transaction: string }[] = [];
  const arms: (readonly unknown[])[] = [];
  const costs: WorkDimensions[] = [];
  const page = (rows: readonly Role[], values: readonly unknown[], offset: number) => {
    const previous =
      values[offset] === undefined
        ? -1
        : rows.findIndex((row) => row.account_id === values[offset] && row.role === values[offset + 1]);
    if (values[offset] !== undefined && previous === -1) throw new Error('Unknown copy continuation');
    return rows.slice(previous + 1, previous + 2);
  };
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
      if (text === sql.copyFirst || text === sql.copyNext) {
        const transaction = values[3] as string;
        reads.push({ kind: 'copy', transaction });
        return { rows: page(copies.get(transaction) ?? [], values, 4) };
      }
      if (text === sql.sourceFirst || text === sql.sourceNext) {
        const transaction = values[1] as string;
        reads.push({ kind: 'source', transaction });
        return { rows: page(sources.get(transaction) ?? [], values, 2) };
      }
      if (text === sql.basis) return { rows: [] };
      if (text === sql.arm) {
        arms.push([...values]);
        return { rows: [{ ordinal: '1' }], rowCount: 1 };
      }
      throw new Error('Unexpected native-copy planner query');
    },
  } as unknown as PoolClient;
  return {
    arms,
    reads,
    costs,
    run(reserve: (cost: WorkDimensions) => void = () => {}) {
      return prepareSearchReceivingCaptures(client, (cost) => {
        reserve(cost);
        costs.push(cost);
      });
    },
  };
}

test('both complete copy origins survive the same physical account/role beyond eight', async () => {
  const copies = roles(17);
  const p = planner(
    new Map([
      [original, copies],
      [native, copies],
    ]),
    new Map([
      [original, [copies[0]!]],
      [native, [copies[0]!]],
    ]),
  );
  await p.run();
  expect(p.arms).toEqual([
    [
      '1',
      original,
      native,
      34,
      2,
      null,
      null,
      null,
      null,
      'e8c644835bd6418ad4b1f22b6e176d8c52be0bd54d3094351c624a9e05628137',
      '596f617a063575cbea53af75ee5eaee3f43a36cca62cc3a25a681fe9dc41fee5',
    ],
  ]);
  expect(p.reads.filter((read) => read.kind === 'copy' && read.transaction === original)).toHaveLength(18);
  expect(p.reads.filter((read) => read.kind === 'copy' && read.transaction === native)).toHaveLength(18);
  // 36 complete copied/carried roles: each 10 rows/points, 9 statements,
  // 3072 deferred bytes + 1024 planner/identity bytes, 5 empty seeks. Base 8/8/8/2048/5,
  // distinct native basis probe 1/1/1/256/1, control/identity bytes 1536. SQL is separate.
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
    nativeRows: 369,
    identityMetadataRows: 0,
    nativePoints: 369,
    witnessKeys: 0,
    statements: 333,
    bytes: 151296,
    emptySeeks: 186,
  });
});

test('a shared original/native transaction traverses and funds its copy prefix once', async () => {
  const p = planner(new Map([[original, roles(10)]]), new Map(), original);
  await p.run();
  expect(p.arms).toEqual([
    [
      '1',
      original,
      original,
      10,
      0,
      null,
      null,
      null,
      null,
      '2302a19dfae8ab29f5cdd15a8ff5886f89407ea89366b88f08cc3cf8036726f1',
      emptyIdentity,
    ],
  ]);
  expect(p.reads.filter((read) => read.kind === 'copy')).toHaveLength(11);
  expect(p.costs.filter((cost) => cost.nativePoints === 10)).toHaveLength(10);
});

test('a native copy reservation refusal keeps original charges and cannot arm the event', async () => {
  const p = planner(
    new Map([
      [original, roles(17)],
      [native, roles(10)],
    ]),
    new Map(),
  );
  let admittedRoles = 0;
  const refusal = Object.assign(new Error('Native copy work refused'), { code: 'identity_epoch_unavailable' });
  await expect(
    p.run((cost) => {
      if (cost.nativePoints === 10 && admittedRoles++ === 17) throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(p.arms).toEqual([]);
  expect(p.costs.filter((cost) => cost.nativePoints === 10)).toHaveLength(17);
  expect(p.reads.at(-1)).toEqual({ kind: 'copy', transaction: native });
});
