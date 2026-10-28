import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { newId, partitionOf } from '../../src/route/route.ts';
import { pageDueEntryDeletions, purgeDueEntryDeletion } from '../../src/library/entry-due-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name migrated native database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
test('native due entry storage pages original deadline keys before filters and purges only the exact expired deletion without touching a later episode or live replacement', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const route = 0x6c71,
      accountId = newId(route),
      subjectId = newId(route),
      incarnationId = newId(route);
    const d1 = newId(route),
      d2 = newId(route),
      d3 = newId(route);
    const due = '2026-10-28T00:00:00.000001Z',
      early = '2026-10-28T00:00:00.000000Z',
      future = '2026-11-27T00:00:00.000001Z';
    const seed = async (deletionId: string, restoreUntil: string) =>
      c.query(
        `INSERT INTO library.entry_deleted(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,incarnation_id,deletion_id,deleted_revision,deleted_at,restore_until) VALUES($1,$2,$3,'planned',1,'2026-01-01','2026-01-02',$4,$5,$6,2,$7::timestamptz-interval '720 hours',$7::timestamptz)`,
        [route, accountId, subjectId, newId(route), incarnationId, deletionId, restoreUntil],
      );
    await seed(d1, due);
    await seed(d2, due);
    await seed(d3, future);
    await c.query(
      `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,incarnation_id) VALUES($1,$2,$3,'planned',1,'2026-01-01','2026-01-02',$4,$5)`,
      [route, accountId, subjectId, newId(route), newId(route)],
    );
    const live = await c.query(
      'SELECT to_jsonb(e) AS row FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3',
      [route, accountId, subjectId],
    );
    const base = { partition: partitionOf(route), cutoff: due, limit: 1 };
    const earlyPage = await pageDueEntryDeletions(c, { ...base, cutoff: early });
    expect(earlyPage.some((k) => k.accountId === accountId)).toBe(false);
    // The migrated native test database may contain unrelated earlier rows: seek our exact route/account tie.
    const after = { restoreUntil: due, route, accountId, deletionId: '00000000-0000-0000-0000-000000000000' };
    const first = await pageDueEntryDeletions(c, { ...base, after });
    expect(first).toHaveLength(1);
    expect(first[0]!.accountId).toBe(accountId);
    expect([d1, d2].sort()[0]).toBe(first[0]!.deletionId);
    expect(Date.parse(first[0]!.restoreUntil)).toBe(Date.parse(due));
    const second = await pageDueEntryDeletions(c, { ...base, after: first[0]! });
    expect(second).toHaveLength(1);
    expect(second[0]!.deletionId).toBe([d1, d2].sort()[1]!);
    const key = first[0]!;
    expect(await purgeDueEntryDeletion(c, key, { time: early })).toBe(false);
    expect(await purgeDueEntryDeletion(c, { ...key, restoreUntil: early }, { time: due })).toBe(false);
    expect(await purgeDueEntryDeletion(c, key, { time: due })).toBe(true);
    expect(await purgeDueEntryDeletion(c, key, { time: future })).toBe(false);
    expect(
      await purgeDueEntryDeletion(c, { restoreUntil: future, route, accountId, deletionId: d3 }, { time: due }),
    ).toBe(false);
    const remaining = (
      await c.query(
        'SELECT deletion_id FROM library.entry_deleted WHERE route=$1 AND account_id=$2 ORDER BY deletion_id',
        [route, accountId],
      )
    ).rows.map((r) => r.deletion_id);
    expect(remaining).toEqual([second[0]!.deletionId, d3].sort());
    expect(
      (
        await c.query(
          'SELECT to_jsonb(e) AS row FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, accountId, subjectId],
        )
      ).rows,
    ).toEqual(live.rows);
    await expect(pageDueEntryDeletions(c, { ...base, limit: 101 })).rejects.toBeInstanceOf(RangeError);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
