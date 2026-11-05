import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as s from '../../src/library/entry-retention-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name migrated native database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c70,
  id = (n: number) => '00000000-0000-7000-8000-6c70' + n.toString(16).padStart(8, '0');
const original = '2026-10-01T01:02:03.000Z',
  deleted = '2026-10-28T00:00:00.000Z';
test('native retained entry DAO preserves complete independent deletions and restores only an empty slot before the strict deadline', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const pin = {
      provenance: 'legacy',
      releaseDigest: 'sha256:' + 'a'.repeat(64),
      acceptingType: null,
      profileId: 'legacy-fixed-v1',
    };
    const seed = async (inc: string, sequence: string | null = '9007199254740995') =>
      c.query(
        `INSERT INTO library.entry(route,account_id,subject_id,requested_subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position,incarnation_id,library_profile_pin,owner_write_seq) VALUES($1,$2,$3,$4,'completed',1,$5,$5,$6,$5,$5,$7,$8,$9,2,9007199254740993,$10,$11,$12)`,
        [route, id(1), id(2), id(3), original, id(80), id(4), id(5), route >> 4, inc, pin, sequence],
      );
    const key = { route, accountId: id(1), subjectId: id(2) };
    const context = (n: number, time = deleted) => ({ transactionId: id(n), time });
    await seed(id(10));
    const a = (
      await c.query('SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
        route,
        id(1),
        id(2),
      ])
    ).rows[0]!;
    expect(await s.retainEntryDeletion(c, { ...key, incarnationId: id(99), revision: 1 }, context(20))).toBeNull();
    const d1 = await s.retainEntryDeletion(c, { ...key, incarnationId: id(10), revision: 1 }, context(21));
    expect(d1).not.toBeNull();
    expect(d1!.deletionId).toBe(id(21));
    expect(d1!.deletedRevision).toBe(2);
    expect(Date.parse(d1!.restoreUntil) - Date.parse(d1!.deletedAt)).toBe(720 * 60 * 60 * 1000);
    const raw = (
      await c.query('SELECT * FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=$3', [
        route,
        id(1),
        id(21),
      ])
    ).rows[0]!;
    for (const column of Object.keys(a)) expect(raw[column]).toEqual(a[column]);
    expect(raw.type_source_position).toBe('9007199254740993');
    expect(raw.owner_write_seq).toBe('9007199254740995');
    expect(d1!.ownerWriteSeq).toBe('9007199254740995');
    expect(
      (await c.query('SELECT subject_id FROM library.entry WHERE route=$1 AND account_id=$2', [route, id(1)])).rows,
    ).toEqual([]);
    await seed(id(11), null);
    const undo1 = { ...key, deletionId: id(21), deletedRevision: 2 };
    expect(await s.restoreRetainedEntryDeletion(c, undo1, context(22))).toBeNull();
    expect(await s.readRetainedEntryDeletion(c, { ...key, deletionId: id(21) })).not.toBeNull();
    const d2 = await s.retainEntryDeletion(c, { ...key, incarnationId: id(11), revision: 1 }, context(23));
    expect(d2!.ownerWriteSeq).toBeNull();
    expect((await s.readRetainedEntryDeletion(c, { ...key, deletionId: id(23) }))!.ownerWriteSeq).toBeNull();
    expect(d2!.deletionId).not.toBe(d1!.deletionId);
    expect(await s.restoreRetainedEntryDeletion(c, undo1, context(24, d1!.restoreUntil))).toBeNull();
    const restored = await s.restoreRetainedEntryDeletion(c, undo1, context(25));
    expect(restored).not.toBeNull();
    const live = (
      await c.query('SELECT * FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3', [
        route,
        id(1),
        id(2),
      ])
    ).rows[0]!;
    for (const column of Object.keys(a).filter((k) => k !== 'revision' && k !== 'transaction_id'))
      expect(live[column]).toEqual(a[column]);
    expect(live.revision).toBe(3);
    expect(live.transaction_id).toBe(id(25));
    expect(live.owner_write_seq).toBe('9007199254740995');
    expect(restored!.ownerWriteSeq).toBe('9007199254740995');
    expect(await s.readRetainedEntryDeletion(c, { ...key, deletionId: id(21) })).toBeNull();
    expect(await s.readRetainedEntryDeletion(c, { ...key, deletionId: id(23) })).not.toBeNull();
    const d3 = await s.retainEntryDeletion(c, { ...key, incarnationId: id(10), revision: 3 }, context(26));
    expect(d3!.deletionId).not.toBe(d1!.deletionId);
    expect(await s.restoreRetainedEntryDeletion(c, undo1, context(27))).toBeNull();
    expect(await s.readRetainedEntryDeletion(c, { ...key, deletionId: id(26) })).not.toBeNull();
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
