import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { insertPersonalLabel } from '../../src/library/label-store.ts';
import { setLabelAssignment } from '../../src/library/label-assignment-store.ts';
import {
  readStoredLabelAssignment,
  unassignStoredLabelAssignment,
  restoreStoredLabelAssignment,
} from '../../src/library/label-assignment-lifecycle-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name migrated native database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c76,
  id = (n: number) => '00000000-0000-7000-8000-6c76' + n.toString(16).padStart(8, '0');
const at = '2026-10-28T00:00:00.000Z',
  later = '2026-10-29T00:00:00.000Z';
test('native assignment lifecycle binds opaque identity and revision restores only within its original window and reacquires the same bounded capacity', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const accountId = id(1),
      subjectId = id(2),
      context = (n: number, time = at) => ({ transactionId: id(n), time });
    for (let n = 0; n < 34; n++)
      await insertPersonalLabel(c, route, { accountId, id: id(100 + n), name: 'Lifecycle ' + n }, context(1000 + n));
    const tuple = { route, accountId, subjectId, labelId: id(100) };
    const set = await setLabelAssignment(c, tuple, context(2000));
    if (set.kind !== 'applied') throw new Error('native baseline assignment failed');
    const a = set.assignment,
      key = { ...tuple, assignmentId: a.id, revision: a.revision };
    expect((await unassignStoredLabelAssignment(c, { ...key, assignmentId: id(90) }, context(2001))).kind).toBe(
      'stale',
    );
    const removed = await unassignStoredLabelAssignment(c, key, context(2002));
    expect(removed.kind).toBe('applied');
    const tomb = await readStoredLabelAssignment(c, tuple);
    expect(tomb).not.toBeNull();
    expect(tomb!.id).toBe(a.id);
    expect(tomb!.revision).toBe(a.revision + 1);
    expect(tomb!.slotNo).toBeNull();
    expect(Date.parse(tomb!.purgeAfter!) - Date.parse(tomb!.deletedAt!)).toBe(720 * 60 * 60 * 1000);
    const restoreKey = { ...tuple, assignmentId: a.id, revision: tomb!.revision };
    expect(
      (await restoreStoredLabelAssignment(c, { ...restoreKey, revision: a.revision }, context(2003, later))).kind,
    ).toBe('stale');
    const restored = await restoreStoredLabelAssignment(c, restoreKey, context(2004, later));
    expect(restored.kind).toBe('applied');
    const active = await readStoredLabelAssignment(c, tuple);
    expect(active!.id).toBe(a.id);
    expect(active!.revision).toBe(a.revision + 2);
    expect(active!.deletedAt).toBeNull();
    expect(active!.createdAt).toBe(a.createdAt);
    expect((await unassignStoredLabelAssignment(c, key, context(2005, later))).kind).toBe('stale');
    expect(
      (await unassignStoredLabelAssignment(c, { ...key, revision: active!.revision }, context(2006, later))).kind,
    ).toBe('applied');
    const deletedAgain = (await readStoredLabelAssignment(c, tuple))!;
    const exact = { ...tuple, assignmentId: a.id, revision: deletedAgain.revision };
    expect((await restoreStoredLabelAssignment(c, exact, context(2007, deletedAgain.purgeAfter!))).kind).toBe(
      'expired',
    );
    for (let n = 1; n <= 32; n++)
      expect((await setLabelAssignment(c, { ...tuple, labelId: id(100 + n) }, context(2100 + n, later))).kind).toBe(
        'applied',
      );
    expect((await restoreStoredLabelAssignment(c, exact, context(2200, later))).kind).toBe('capacity');
    expect(await readStoredLabelAssignment(c, tuple)).toEqual(deletedAgain);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
