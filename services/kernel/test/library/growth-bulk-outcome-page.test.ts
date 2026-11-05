import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { pageBulkOutcomes } from '../../src/library/bulk-outcome-page.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x6a20;
const accountId = newId(route);
const operationId = newId(route);
const otherAccount = newId(route);
const remoteAccount = newId(route + 16);
const input = { route, accountId, operationId, after: null, limit: 20, state: null } as const;
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function grow(database: GrowthDatabase, scale: number, previous: number): Promise<void> {
  if (previous === 0)
    await database.admin.query('DELETE FROM library.bulk_target WHERE account_id = ANY($1::uuid[])', [
      [accountId, otherAccount, remoteAccount],
    ]);
  // The measured operation grows, with three nonmatches per exact-state match. Other operations and owners
  // grow on this route and another partition. No planner settings or fixed public prefix mask a long scan.
  await database.admin.query(
    `INSERT INTO library.bulk_target
       (route, operation_id, ordinal, account_id, subject_id, target_kind, target, source_digest,
        receipt, created_transaction_id, state, chunk_index)
     SELECT $1, $2, n, $3, id, 'subject', '{}', repeat('a',64), '{}', $2,
            CASE WHEN n % 4 = 0 THEN 'applied' ELSE 'pending' END, 0
     FROM (SELECT n, ('10000000-0000-7000-8000-6a20' || lpad(to_hex(n),8,'0'))::uuid AS id
           FROM generate_series($4::int + 1, $5::int) AS n) AS targets`,
    [route, operationId, accountId, previous, scale],
  );
  await database.admin.query(
    `INSERT INTO library.bulk_target
       (route, operation_id, ordinal, account_id, subject_id, target_kind, target, source_digest,
        receipt, created_transaction_id, state, chunk_index)
     SELECT r, id, 0, owner, id, 'subject', '{}', repeat('b',64), '{}', id, 'applied', 0
     FROM (SELECT r, owner,
             ('20000000-0000-7000-8000-' || lpad(to_hex(r),4,'0') ||
              lpad(to_hex(n * 4 + k),8,'0'))::uuid AS id
           FROM generate_series($4::int + 1, $5::int) AS n
           CROSS JOIN (VALUES ($1::int, $2::uuid, 0), ($1::int, $3::uuid, 1),
                              ($6::int, $7::uuid, 2)) AS owners(r, owner, k)) AS targets`,
    [route, accountId, otherAccount, previous, scale, route + 16, remoteAccount],
  );
}

test('outcome pages have bounded rows and statements as operation targets grow', async () => {
  const client = await db.pool.connect();
  try {
    for (const state of [null, 'applied'] as const) {
      for (const deep of [false, true]) {
        const report = await checkGrowth(db, {
          name: `Bulk outcomes ${state ?? 'all'} ${deep ? 'deep' : 'first'} page`,
          scales: [256, 1024, 4096],
          warmups: 1,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          grow,
          async operation(_database, scale) {
            const after = deep ? scale / 2 : 0;
            const page = await pageBulkOutcomes(client, { ...input, state, after: deep ? String(after) : null });
            const step = state === null ? 1 : 4;
            expect(page.outcomes.map((row) => row.ordinal)).toEqual(
              Array.from({ length: 20 }, (_, i) => String(after + (i + 1) * step)),
            );
            expect(page.nextAfter).toBe(page.outcomes.at(-1)!.ordinal);
            if (state !== null) expect(page.outcomes.every((row) => row.state === state)).toBe(true);
          },
        });
        for (const sample of report.samples) {
          expect(sample.cost.statements).toBe(1);
          expect(sample.cost.relations['library.bulk_target']!.rows).toBeLessThanOrEqual(21);
          expect(sample.cost.relations['library.bulk_target']!.sequentialScans).toBe(0);
        }
      }
    }
  } finally {
    client.release();
  }
}, 300_000);

test('outcome paging rejects invalid inputs before SQL and refuses numeric ordinals', async () => {
  let statements = 0;
  const client = {
    query: async () => {
      statements++;
      return { rows: [{ ordinal: 9007199254740992 }] };
    },
  } as unknown as Pick<PoolClient, 'query'>;
  const invalid = [
    { route: -1 },
    { route: 65536 },
    { route: 1.5 },
    { accountId: newId(route + 1) },
    { operationId: newId(route + 1) },
    { accountId: 'invalid' },
    { operationId: 'invalid' },
    { limit: 0 },
    { limit: 21 },
    { limit: 1.5 },
    { state: 'unknown' },
    ...['-1', '+1', '01', '1.0', '1e3', '', ' 1', '1\n'].map((after) => ({ after })),
    { after: 1 },
  ];
  for (const patch of invalid)
    await expect(
      pageBulkOutcomes(client, {
        ...input,
        ...patch,
      } as Parameters<typeof pageBulkOutcomes>[1]),
    ).rejects.toThrow();
  expect(statements).toBe(0);
  await expect(pageBulkOutcomes(client, input)).rejects.toThrow('ordinal');
  expect(statements).toBe(1);
});

test('outcome state and nullable occurrence fields come from the caller snapshot', async () => {
  const op = newId(route),
    subjectId = newId(route),
    collectionId = newId(route + 16);
  const memberId = newId(route + 16),
    resultingMemberId = newId(route + 16);
  await db.admin.query(
    `INSERT INTO library.bulk_target
       (route, operation_id, ordinal, account_id, subject_id, target_kind, collection_id, member_id,
        target, source_digest, receipt, created_transaction_id, state, reason, resulting_member_id, chunk_index)
     VALUES ($1,$2,0,$3,$4,'occurrence',$5,$6,'{}',repeat('a',64),'{}',$2,'pending','deadline',$7,0)`,
    [route, op, accountId, subjectId, collectionId, memberId, resultingMemberId],
  );
  const client = await db.pool.connect();
  const query = { ...input, operationId: op, limit: 1 };
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const before = await pageBulkOutcomes(client, query);
    expect(before).toEqual({
      outcomes: [
        {
          ordinal: '0',
          subjectId,
          memberId,
          state: 'pending',
          reason: 'deadline',
          resultingMemberId,
          deletion: null,
          memberDeletion: null,
        },
      ],
      nextAfter: null,
    });
    await db.admin.query("UPDATE library.bulk_target SET state = 'applied' WHERE route = $1 AND operation_id = $2", [
      route,
      op,
    ]);
    expect(await pageBulkOutcomes(client, { ...query, state: 'pending' })).toEqual(before);
    await client.query('COMMIT');
    expect((await pageBulkOutcomes(client, { ...query, state: 'pending' })).outcomes).toEqual([]);
    expect((await pageBulkOutcomes(client, { ...query, state: 'applied' })).outcomes[0]!.state).toBe('applied');
    expect((await pageBulkOutcomes(client, { ...query, after: '0' })).outcomes).toEqual([]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
