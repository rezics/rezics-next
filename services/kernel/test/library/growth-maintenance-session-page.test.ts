import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { readMaintenanceSessions } from '../../src/library/maintenance-session-page.ts';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const route = 0x6a20;
const accountId = id(route, 1, '20000000');
const subjectId = newId(0x7b20);
const at = '1999-12-31T23:59:59.000001Z';
const completedAt = '2026-10-27T01:02:03.654321Z';
const changedAt = '2026-10-27T04:05:06.987654Z';

function id(ownerRoute: number, ordinal: number, prefix = '10000000'): string {
  return `${prefix}-0000-7000-8000-${ownerRoute.toString(16).padStart(4, '0')}${ordinal.toString(16).padStart(8, '0')}`;
}

beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('maintenance session pages retain every owner state and exact timestamps at the tail', async () => {
  await db.admin.query(
    `INSERT INTO library.progress_session
       (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state, revision,
        started_at, completed_at, last_changed_at, transaction_id)
     SELECT $1, ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n * 2), 8, '0'))::uuid,
       $2, $3, 'scalar_amount', 'page', 0,
       CASE n % 3 WHEN 0 THEN 'completed' WHEN 1 THEN 'active' ELSE 'abandoned' END, n + 1,
       $4::timestamptz, CASE WHEN n % 3 = 0 THEN $5::timestamptz END,
       CASE WHEN n % 2 = 0 THEN $6::timestamptz END, $2
     FROM generate_series(1, 105) AS n`,
    [route, accountId, subjectId, at, completedAt, changedAt],
  );
  // Interleaved keys from another owner, and another route in the same partition, must never enter the page.
  for (const otherRoute of [route, route + 1]) {
    await db.admin.query(
      `INSERT INTO library.progress_session
         (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state, revision,
          started_at, transaction_id)
       SELECT $1, ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n * 2 + 1), 8, '0'))::uuid,
         $2, $3, 'scalar_amount', 'page', 0, 'active', 1, $4, $2
       FROM generate_series(0, 106) AS n`,
      [otherRoute, id(otherRoute, 2, '20000000'), subjectId, at],
    );
  }
  await db.admin.query("SET TIME ZONE 'Pacific/Chatham'");
  try {
    const first = await readMaintenanceSessions(db.admin, { route, accountId, after: null });
    expect(first.sessions).toHaveLength(100);
    expect(first.complete).toBe(false);
    expect(first.after).toBe(id(route, 200));
    const tail = await readMaintenanceSessions(db.admin, { route, accountId, after: first.after, limit: 5 });
    expect(tail.complete).toBe(false);
    expect(tail.after).toBe(id(route, 210));
    expect([...first.sessions, ...tail.sessions]).toEqual(
      Array.from({ length: 105 }, (_, index) => {
        const n = index + 1;
        return {
          sessionId: id(route, n * 2),
          subjectId,
          state: n % 3 === 0 ? 'completed' : n % 3 === 1 ? 'active' : 'abandoned',
          revision: n + 1,
          transactionId: accountId,
          startedAt: at,
          completedAt: n % 3 === 0 ? completedAt : null,
          lastChangedAt: n % 2 === 0 ? changedAt : null,
        };
      }),
    );
    expect(await readMaintenanceSessions(db.admin, { route, accountId, after: first.after })).toEqual({
      sessions: tail.sessions,
      after: tail.after,
      complete: true,
    });
    expect(await readMaintenanceSessions(db.admin, { route, accountId, after: tail.after })).toEqual({
      sessions: [],
      after: tail.after,
      complete: true,
    });
    const emptyOwner = newId(route);
    for (const after of [null, id(route, 999)])
      expect(await readMaintenanceSessions(db.admin, { route, accountId: emptyOwner, after })).toEqual({
        sessions: [],
        after,
        complete: true,
      });
  } finally {
    await db.admin.query('RESET TIME ZONE');
  }
});

test('maintenance session inputs reject invalid bounds and route bindings before SQL', async () => {
  const query = spyOn(db.admin, 'query');
  try {
    const input = { route, accountId, after: null };
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
      await expect(readMaintenanceSessions(db.admin, { ...input, limit })).rejects.toBeInstanceOf(RangeError);
    for (const invalidRoute of [-1, 65536, 1.5, NaN, Infinity])
      await expect(readMaintenanceSessions(db.admin, { ...input, route: invalidRoute })).rejects.toBeInstanceOf(
        RangeError,
      );
    for (const invalidId of [
      '',
      'invalid',
      '00000000-0000-0000-0000-000000000000',
      newId(route + 1),
      accountId.toUpperCase(),
    ]) {
      await expect(readMaintenanceSessions(db.admin, { ...input, accountId: invalidId })).rejects.toBeInstanceOf(
        RangeError,
      );
      await expect(readMaintenanceSessions(db.admin, { ...input, after: invalidId })).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
  }
});

test('maintenance session SQL errors propagate without a successful checkpoint', async () => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT 1 / 0').catch(() => {});
    await expect(readMaintenanceSessions(client, { route, accountId, after: null })).rejects.toMatchObject({
      code: '25P02',
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

async function seedSessions(
  ownerRoute: number,
  owner: string,
  from: number,
  to: number,
  prefix = '10000000',
): Promise<void> {
  await db.admin.query(
    `INSERT INTO library.progress_session
       (route, session_id, account_id, subject_id, mode, unit, completed_unit_count, state, revision,
        started_at, transaction_id)
     SELECT $1, ($5 || '-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n * 10000), 8, '0'))::uuid,
       $2, $3, 'scalar_amount', 'page', 0, 'active', 1, $4, $2
     FROM generate_series($6::int, $7::int) AS n`,
    [ownerRoute, owner, subjectId, at, prefix, from, to],
  );
}

function assertOwnerSeek(plans: readonly unknown[]): void {
  const scans: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node['Relation Name']) scans.push(node);
    Object.values(node).forEach(visit);
  }
  visit(plans);
  expect(scans).toHaveLength(1);
  expect(scans[0]).toMatchObject({
    Schema: 'library',
    'Relation Name': 'progress_session',
    'Index Name': 'progress_session_owner_seek',
    'Actual Rows': 100,
    'Actual Loops': 1,
  });
  expect(scans[0]!['Rows Removed by Filter'] ?? 0).toBe(0);
}

test('maintenance session seeks stay bounded across owners and histories', async () => {
  for (const [dimensionIndex, dimension] of (['sessions', 'owners', 'history', 'units'] as const).entries()) {
    // Each dimension has independent fixtures; only the named population grows.
    for (const [positionIndex, position] of (['first', 'deep'] as const).entries()) {
      const ownerRoute = 0x6b20 + dimensionIndex * 4 + positionIndex * 2;
      const owner = id(ownerRoute, 1, '20000000');
      await seedSessions(ownerRoute, owner, 1, dimension === 'sessions' ? 256 : 4096);
      // Other owners sort before and after the target owner; growing owners interleave session keys.
      for (const prefix of ['00000000', 'f0000000'])
        await seedSessions(ownerRoute, id(ownerRoute, 1, prefix), 1, 4096, prefix);
      const cursor = (scale: number) =>
        position === 'first' ? null : id(ownerRoute, (dimension === 'sessions' ? scale - 100 : 3996) * 10000);
      let grown = 256;
      const report = await checkGrowth(db, {
        name: `maintenance sessions ${dimension} ${position}`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        warmups: 1,
        async grow(_database, scale, previous) {
          if (dimension === 'sessions') {
            await seedSessions(ownerRoute, owner, grown + 1, scale);
            grown = scale;
          } else if (dimension === 'owners') {
            for (const otherRoute of [ownerRoute, ownerRoute + 1])
              await db.admin.query(
                `INSERT INTO library.progress_session
                   (route, session_id, account_id, subject_id, mode, unit, completed_unit_count,
                    state, revision, started_at, transaction_id)
                 SELECT $1, ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n * 10000 + k), 8, '0'))::uuid,
                   ('20000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n + 1), 8, '0'))::uuid,
                   $2, 'scalar_amount', 'page', 0, 'active', 1, $3, $2
                 FROM generate_series($4::int + 1, $5::int) AS n, generate_series(1, 4) AS k`,
                [otherRoute, subjectId, at, previous, scale],
              );
          } else if (dimension === 'history') {
            await db.admin.query(
              `INSERT INTO library.progress_change (route, session_id, change_no, intent, recorded_at, transaction_id)
               SELECT $1, session_id, n, '{"amount":"1"}'::jsonb, $3, session_id
               FROM generate_series($4::int * 32 + 1, $5::int * 32) AS n, unnest($2::uuid[]) AS session_id`,
              [ownerRoute, [id(ownerRoute, 10000), id(ownerRoute, 3997 * 10000)], at, previous, scale],
            );
          } else {
            await db.admin.query(
              `INSERT INTO library.progress_unit (route, session_id, unit_id, added_at)
               SELECT $1, session_id, 'unit-' || n::text, $3
               FROM generate_series($4::int * 32 + 1, $5::int * 32) AS n, unnest($2::uuid[]) AS session_id`,
              [ownerRoute, [id(ownerRoute, 10000), id(ownerRoute, 3997 * 10000)], at, previous, scale],
            );
          }
        },
        async warmup(_database, scale) {
          const after = cursor(scale);
          const result = await capture(db, () =>
            readMaintenanceSessions(db.pool, { route: ownerRoute, accountId: owner, after }),
          );
          assertOwnerSeek(result.capture.plans);
        },
        async operation(_database, scale) {
          const after = cursor(scale);
          const page = await readMaintenanceSessions(db.pool, { route: ownerRoute, accountId: owner, after });
          expect(page.sessions.map((session) => session.sessionId)).toEqual(
            Array.from({ length: 100 }, (_, n) =>
              id(
                ownerRoute,
                ((position === 'first' ? 0 : dimension === 'sessions' ? scale - 100 : 3996) + n + 1) * 10000,
              ),
            ),
          );
          expect(page.complete).toBe(false);
          expect(page.after).toBe(page.sessions.at(-1)!.sessionId);
        },
      });
      for (const sample of report.samples) {
        expect(sample.cost.statements).toBe(1);
        expect(sample.cost.rows).toBe(100);
        expect(sample.cost.controlStatements).toBe(0);
        expect(Object.keys(sample.cost.relations)).toEqual(['library.progress_session']);
        expect(sample.cost.relations['library.progress_session']!.sequentialScans).toBe(0);
      }
    }
  }
}, 300_000);
