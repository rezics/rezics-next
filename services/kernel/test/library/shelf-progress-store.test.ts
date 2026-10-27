import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { insertSession, updateSession } from '../../src/library/progress-store.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('session changes persist monotonic command time', async () => {
  const route = 0x6a10,
    id = newId(route),
    accountId = newId(route);
  await insertSession(
    db.admin,
    route,
    {
      id,
      accountId,
      subjectId: newId(0x7b20),
      versionSubjectId: null,
      mode: 'completed_units',
      unit: 'chapter',
      total: null,
    },
    { transactionId: newId(route), time: '2026-10-27T00:00:01.000001Z' },
  );
  const stamp = async () =>
    String(
      (
        await db.admin.query(
          'SELECT last_changed_at::text AS stamp FROM library.progress_session WHERE route=$1 AND session_id=$2',
          [route, id],
        )
      ).rows[0]!.stamp,
    );
  expect(await stamp()).toContain('00:00:01.000001');
  const changes = {
    amount: null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active' as const,
    completedAt: null,
  };
  await updateSession(db.admin, route, id, 1, changes, {
    transactionId: newId(route),
    time: '2026-10-27T00:00:03.000001Z',
  });
  expect(await stamp()).toContain('00:00:03.000001');
  expect(
    await updateSession(db.admin, route, id, 1, changes, {
      transactionId: newId(route),
      time: '2026-10-27T00:00:09.000001Z',
    }),
  ).toBeNull();
  expect(await stamp()).toContain('00:00:03.000001');
  await updateSession(db.admin, route, id, 2, changes, {
    transactionId: newId(route),
    time: '2026-10-27T00:00:02.000001Z',
  });
  expect(await stamp()).toContain('00:00:03.000001');
});
