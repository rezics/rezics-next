import { afterAll, beforeAll, expect, test } from 'bun:test';
import { newId } from '../../src/route/route.ts';
import { readMaintenanceSessions } from '../../src/library/maintenance-session-page.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
test('maintenance session pages preserve exact stored dates and full owner continuation', async () => {
  const route = 0x6a10,
    accountId = newId(route),
    subjectId = newId(0x7b20),
    ids = Array.from({ length: 3 }, () => newId(route)).sort(),
    at = '2026-10-27T00:00:00.123456Z';
  for (const sessionId of ids)
    await db.admin.query(
      "INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id) VALUES($1,$2,$3,$4,'scalar_amount','page',0,'active',1,$5,$6)",
      [route, sessionId, accountId, subjectId, at, newId(route)],
    );
  let after: string | null = null;
  let done = false;
  const walked: string[] = [];
  for (let n = 0; n < 5 && !done; n++) {
    const page = await readMaintenanceSessions(db.admin, { route, accountId, after, limit: 1 });
    for (const s of page.sessions) {
      expect(s.startedAt).toBe(at);
      expect(s.completedAt).toBeNull();
      walked.push(s.sessionId);
    }
    after = page.after;
    done = page.complete;
  }
  expect(done).toBe(true);
  expect(walked).toEqual(ids);
  expect((await readMaintenanceSessions(db.admin, { route, accountId: newId(route), after: null })).sessions).toEqual(
    [],
  );
});
