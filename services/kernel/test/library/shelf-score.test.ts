import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { createShelfPageReader } from '../../src/library/shelf-reader-page.ts';
import { shelfScoreBinding, validShelfScoreKey } from '../../src/library/shelf-score.ts';
import { shelfCursorBinding, type ShelfQuery, type ShelfSeek } from '../../src/library/shelf-contract.ts';
import { shelfListQuerySchema } from '../../src/library/shelf-schemas.ts';
import { readPersonalScoreCurrentness, readPersonalScoreQuestion } from '../../src/rating/personal-score.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { decodeListCursor, encodeListCursor } from '../../src/tokens/list-cursor.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { testTokens } from '../support/test-kernel.ts';

let db: GrowthDatabase;
const route = 0x6a10,
  owner = newId(route),
  other = newId(route);
const types = [newId(route), newId(route)];
const ids = Array.from({ length: 7 }, () => newId(0x7b20)).sort();
const scores = [0, 8, 8, 20, null, null, 12];
const reader = createShelfPageReader();
const query: ShelfQuery = { orderBy: 'personalScore', direction: 'asc', limit: 2, state: null, typeId: null };
const install = async (accountId = owner) =>
  (
    await db.admin.query<{ ready: boolean; prepared: number }>('SELECT * FROM library.prepare_shelf_score($1,$2)', [
      route,
      accountId,
    ])
  ).rows[0]!;
async function entry(accountId: string, id: string, index: number) {
  await db.admin.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,
    activity_at,transaction_id,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
    VALUES($1,$2,$3,$4,1,now(),now(),now(),$2,$5,$3,$6,1,0)`,
    [route, accountId, id, index % 2 ? 'completed' : 'planned', types[index % 2], partitionOf(0x7b20)],
  );
}
async function vote(accountId: string, id: string, units: number) {
  await db.admin.query(
    `INSERT INTO rating.vote(route,voter_id,question_id,target_id,units,revision,changed_at,transaction_id)
    VALUES($1,$2,$3,$4,$5,1,now(),$2)`,
    [route, accountId, STANDARD_QUESTION_ID, id, units],
  );
}
async function traverse(q: ShelfQuery) {
  const got: string[] = [];
  let after: ShelfSeek | null = null;
  for (let page = 0; page < 10; page++) {
    const result = await reader.page(db.admin, route, owner, q, after);
    expect(result.entries.length).toBeLessThanOrEqual(q.limit);
    got.push(...result.entries.map((row) => row.subjectId));
    if (!result.more) return got;
    const last = result.entries.at(-1)!;
    after = { subjectId: last.subjectId, key: last.personalScore === null ? '' : String(last.personalScore) };
  }
  throw new Error('Shelf did not terminate');
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  for (const [i, id] of ids.entries()) {
    await entry(owner, id, i);
    if (scores[i] !== null) await vote(owner, id, scores[i]!);
  }
  await entry(other, ids[0]!, 0);
  await vote(other, ids[0]!, 20);
});
afterAll(async () => {
  await db?.close();
});

test('native first, middle and final pages preserve ties, zero and unrated-last with both filter dimensions and directions', async () => {
  await expect(shelfScoreBinding(db.admin, route, owner)).rejects.toMatchObject({ code: 'dependency_unavailable' });
  expect(await install()).toEqual({ ready: true, prepared: 7 });
  for (const direction of ['asc', 'desc'] as const)
    for (const state of [null, 'planned'] as const)
      for (const typeId of [null, types[0]!] as const) {
        const expected = ids
          .filter((_, i) => (state === null || i % 2 === 0) && (typeId === null || i % 2 === 0))
          .sort((a, b) => {
            const x = scores[ids.indexOf(a)]!,
              y = scores[ids.indexOf(b)]!;
            if (x === null && y !== null) return 1;
            if (x !== null && y === null) return -1;
            return (x === null || y === null ? 0 : (x - y) * (direction === 'asc' ? 1 : -1)) || a.localeCompare(b);
          });
        expect(await traverse({ ...query, direction, state, typeId })).toEqual(expected);
      }
  // A caller without Content's currentness binding remains fail-closed.
  await expect(shelfScoreBinding(db.admin, route, owner)).rejects.toMatchObject({
    code: 'dependency_unavailable',
    binding: 'Content native owner-wide score identity fence is not installed',
  });
  const installedBinding = await shelfScoreBinding(db.admin, route, owner, readPersonalScoreCurrentness);
  expect(installedBinding.question.id).toBe(STANDARD_QUESTION_ID);
  expect(installedBinding.binding.scoreIdentity).toContain(STANDARD_QUESTION_ID);
  const question = await readPersonalScoreQuestion(db.admin);
  expect(question).toMatchObject({ id: STANDARD_QUESTION_ID, minimumUnits: 0, maximumUnits: 20, stepUnits: 1 });
  expect(Value.Check(shelfListQuerySchema(), query)).toBe(false); // Internal typeId is not a wire predicate.
  expect(Value.Check(shelfListQuerySchema(), { orderBy: 'personalScore', direction: 'asc', limit: 2 })).toBe(true);
});

test('atomic Content score update, clear, counted-target merge and Entry identity/removal invalidate the native order facts', async () => {
  const revision = async () =>
    (
      await db.admin.query('SELECT revision::text FROM library.shelf_score_head WHERE route=$1 AND account_id=$2', [
        route,
        owner,
      ])
    ).rows[0].revision;
  let before = await revision();
  await db.admin.query(
    'UPDATE rating.vote SET units=4,revision=revision+1 WHERE route=$1 AND voter_id=$2 AND target_id=$3',
    [route, owner, ids[3]],
  );
  expect(await revision()).not.toBe(before);
  expect((await traverse(query)).slice(0, 2)).toEqual([ids[0]!, ids[3]!]);
  before = await revision();
  await db.admin.query(
    'UPDATE rating.vote SET units=NULL,revision=revision+1 WHERE route=$1 AND voter_id=$2 AND target_id=$3',
    [route, owner, ids[0]],
  );
  expect(await revision()).not.toBe(before);
  expect((await traverse(query)).slice(-3)).toEqual([ids[0]!, ids[4]!, ids[5]!]);
  // Content's counted target changes in its own transaction; Library never rewrites a vote.
  await db.admin.query(
    'UPDATE rating.vote SET counted_target=$4,counted_revision=counted_revision+1 WHERE route=$1 AND voter_id=$2 AND target_id=$3',
    [route, owner, ids[3], ids[4]],
  );
  expect((await reader.page(db.admin, route, owner, query, null)).entries[0]).toMatchObject({
    subjectId: ids[4],
    personalScore: 4,
  });
  const changed = newId(0x7b20);
  await db.admin.query('UPDATE library.entry SET subject_id=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
    route,
    owner,
    ids[4],
    changed,
  ]);
  expect(await traverse(query)).not.toContain(ids[4]!);
  expect(
    (
      await db.admin.query('SELECT units FROM library.shelf_score WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
        route,
        owner,
        changed,
      ])
    ).rows[0].units,
  ).toBeNull();
  await db.admin.query('DELETE FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
    route,
    owner,
    ids[1],
  ]);
  expect(await traverse(query)).not.toContain(ids[1]!);
});

test('preparation advances at most 100 entries and cannot publish an empty ready placeholder', async () => {
  const accountId = newId(route);
  for (let i = 0; i < 103; i++) await entry(accountId, newId(0x7b20), i);
  expect(await install(accountId)).toEqual({ ready: false, prepared: 100 });
  expect(await install(accountId)).toEqual({ ready: true, prepared: 3 });
  expect(await install(accountId)).toEqual({ ready: true, prepared: 0 });
  expect(
    (
      await db.admin.query('SELECT count(*)::int AS n FROM library.shelf_score WHERE route=$1 AND account_id=$2', [
        route,
        accountId,
      ])
    ).rows[0].n,
  ).toBe(103);
});

test('a late Content vote deletion cannot resurrect an erased installation head', async () => {
  const accountId = newId(route),
    target = newId(0x7b20);
  await vote(accountId, target, 8);
  await db.admin.query('DELETE FROM library.shelf_score_head WHERE route=$1 AND account_id=$2', [route, accountId]);
  await db.admin.query('DELETE FROM rating.vote WHERE route=$1 AND voter_id=$2', [route, accountId]);
  expect(
    (
      await db.admin.query('SELECT 1 FROM library.shelf_score_head WHERE route=$1 AND account_id=$2', [
        route,
        accountId,
      ])
    ).rows,
  ).toEqual([]);
});

test('opaque cursors reject changed bindings, owner, question, direction, expiry and malformed score keys', async () => {
  const ring = testTokens(),
    now = new Date('2026-11-03T12:00:00Z');
  const base = shelfCursorBinding(owner, query);
  const binding = {
    ...base,
    query: { ...base.query, scoreRevision: '1', questionId: STANDARD_QUESTION_ID, questionRevision: 1 },
  };
  const token = await encodeListCursor(ring, binding, { epoch: 1, after: ['0', ids[0]!] }, now);
  expect((await decodeListCursor(ring, binding, token, now)).ok).toBe(true);
  for (const changed of [{ scoreRevision: '2' }, { questionRevision: 2 }, { direction: 'desc' }, { state: 'planned' }])
    expect((await decodeListCursor(ring, { ...binding, query: { ...binding.query, ...changed } }, token, now)).ok).toBe(
      false,
    );
  expect((await decodeListCursor(ring, { ...binding, viewer: other }, token, now)).ok).toBe(false);
  expect((await decodeListCursor(ring, binding, token, new Date('2027-01-01'))).ok).toBe(false);
  for (const key of ['0', '20', '4096', '']) expect(validShelfScoreKey(key)).toBe(true);
  for (const key of ['-1', '4097', '0.5', '00', 'NaN']) expect(validShelfScoreKey(key)).toBe(false);
});
