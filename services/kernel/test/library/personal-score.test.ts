import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  personalScoreUnavailableKind,
  readPersonalScoreCurrentness,
  readPersonalScoreQuestion,
} from '../../src/library/personal-score.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const route = 0x6a11;
const owner = newId(route);
const workId = newId(route);

beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('Content identity work and voter standing fence the owner-wide score version without reading votes', async () => {
  expect(personalScoreUnavailableKind('personalScore: POST /v1/libraryShelfScorePreparation until ready=true')).toBe(
    'preparation',
  );
  expect(personalScoreUnavailableKind('Content native owner-wide score identity fence is not installed')).toBe(
    'currentness',
  );
  expect(personalScoreUnavailableKind('Content score identity repair is pending')).toBe('currentness');
  const question = await readPersonalScoreQuestion(db.admin);
  const ownerRef = { route, accountId: owner, question };
  const current = await readPersonalScoreCurrentness(db.admin, ownerRef);
  expect(current).toMatchObject({ status: 'current' });
  if (current.status !== 'current') throw new Error('expected current score identity');
  expect(current.version.length).toBeGreaterThan(0);
  expect(current.version.length).toBeLessThanOrEqual(256);
  expect(current.version).toContain(STANDARD_QUESTION_ID);
  await db.admin.query(
    `INSERT INTO rating.identity_work_frame(route,voter_id,generation,work_id,state,mode)
     VALUES($1,$2,1,$3,'active','repair')`,
    [route, owner, workId],
  );
  expect(await readPersonalScoreCurrentness(db.admin, ownerRef)).toEqual({
    status: 'pending',
    reason: 'Content score identity repair is pending',
  });
  await db.admin.query(
    `UPDATE rating.identity_work_frame SET state='complete',generation=2 WHERE route=$1 AND voter_id=$2`,
    [route, owner],
  );
  const afterRepair = await readPersonalScoreCurrentness(db.admin, ownerRef);
  expect(afterRepair).toMatchObject({ status: 'current' });
  if (afterRepair.status !== 'current') throw new Error('expected current after repair');
  expect(afterRepair.version).not.toBe(current.version);
  await db.admin.query(
    `INSERT INTO rating.voter_state(route,voter_id,state) VALUES($1,$2,'ineligible')`,
    [route, owner],
  );
  expect(await readPersonalScoreCurrentness(db.admin, ownerRef)).toMatchObject({
    status: 'unavailable',
    reason: 'Content voter standing ineligible refuses score currentness',
  });
});
