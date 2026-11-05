import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { insertSession, readSession } from '../../src/library/progress-store.ts';
import { insertPublishedLog, readPublishedLog } from '../../src/library/published-log-store.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('retained published snapshots survive source detachment without accepting source-less publications', async () => {
  const route = 0x6a10,
    accountId = newId(route),
    sessionId = newId(route),
    subjectId = newId(0x7b20),
    id = newId(route),
    time = '2026-10-27T00:00:00.000Z';
  await insertSession(
    db.admin,
    route,
    {
      id: sessionId,
      accountId,
      subjectId,
      versionSubjectId: null,
      mode: 'completed_units',
      unit: 'chapter',
      total: null,
    },
    { transactionId: newId(route), time },
  );
  const draft = {
    id,
    accountId,
    sessionId,
    subjectId,
    sessionState: 'active' as const,
    startedAt: time,
    completedAt: null,
    note: 'Explicitly shared',
    publishedAt: time,
    transactionId: newId(route),
  };
  const before = await insertPublishedLog(db.admin, route, draft);
  await db.admin.query(
    'UPDATE library.published_log SET session_id=NULL WHERE route=$1 AND account_id=$2 AND log_id=$3',
    [route, accountId, id],
  );
  await db.admin.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [route, sessionId]);
  expect(await readSession(db.admin, route, sessionId)).toBeNull();
  expect(await readPublishedLog(db.admin, route, id)).toEqual({ ...before, sessionId: null });
  await expect(
    insertPublishedLog(db.admin, route, { ...draft, id: newId(route), sessionId: null } as unknown as Parameters<
      typeof insertPublishedLog
    >[2]),
  ).rejects.toThrow();
});
