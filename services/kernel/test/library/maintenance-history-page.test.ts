import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { readMaintenanceHistoryPage } from '../../src/library/maintenance-history-page.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('history maxima consume only the examined child page and retain exact dates', async () => {
  const route = 0x6a10,
    accountId = newId(route),
    sessionId = newId(route),
    subjectId = newId(0x7b20),
    a = '2026-10-27T00:00:00.123456Z',
    b = '2026-10-27T00:00:00.123457Z';
  await db.admin.query(
    "INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,'scalar_amount','page',0,'active',1,$5,$6)",
    [route, sessionId, accountId, subjectId, a, newId(route)],
  );
  for (const [n, at] of [
    [1, a],
    [2, b],
    [3, '2026-10-27T00:00:01.000001Z'],
  ] as const)
    await db.admin.query(
      "INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id) VALUES($1,$2,$3,'{}',$4,$5)",
      [route, sessionId, n, at, newId(route)],
    );
  const first = await readMaintenanceHistoryPage(db.admin, { route, accountId, sessionId, after: 0, limit: 2 });
  expect(first).toEqual({ count: 2, after: 2, lastChangedAt: b, complete: false });
  const next = await readMaintenanceHistoryPage(db.admin, { route, accountId, sessionId, after: 2, limit: 2 });
  expect(next).toEqual({ count: 1, after: 3, lastChangedAt: '2026-10-27T00:00:01.000001Z', complete: true });
  expect(
    await readMaintenanceHistoryPage(db.admin, { route, accountId: newId(route), sessionId, after: 0 }),
  ).toBeNull();
});
