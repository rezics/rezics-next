import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
import * as store from '../../src/library/entry-store.ts';
import { decodeLibraryProfilePin } from '../../src/library/profile-pin.ts';
import type { LibraryProfilePin } from '../../src/library/profile.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c56,
  id = (n: number) => `00000000-0000-7000-8000-6c56${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-27T12:00:00.000Z',
  later = '2026-10-28T12:00:00.000Z';
const pin: LibraryProfilePin = {
  provenance: 'profile',
  releaseDigest: 'sha256:' + 'a'.repeat(64),
  acceptingType: 'ex:Game',
  profileId: 'fixture.game',
};
const legacy: LibraryProfilePin = {
  provenance: 'legacy',
  releaseDigest: 'sha256:' + 'b'.repeat(64),
  acceptingType: null,
  profileId: 'legacy-fixed-v1',
};
const privateFree = (value: unknown) => {
  for (const key of ['pin', 'profilePin', 'libraryProfilePin', 'acceptingType', 'releaseDigest'])
    expect(value).not.toHaveProperty(key);
};
async function sqlstate(c: PoolClient, fn: () => Promise<unknown>) {
  await c.query('SAVEPOINT bad_profile_value');
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  await c.query('ROLLBACK TO SAVEPOINT bad_profile_value');
  await c.query('RELEASE SAVEPOINT bad_profile_value');
  expect(caught).toMatchObject({ code: '23514' });
}
test('pinned entries store data state IDs and private provenance without leaking pins through existing entry views', async () => {
  expect(decodeLibraryProfilePin(null)).toBeNull();
  expect(decodeLibraryProfilePin(pin)).toEqual(pin);
  expect(decodeLibraryProfilePin(legacy)).toEqual(legacy);
  for (const value of [
    {},
    [],
    { ...pin, acceptingType: null },
    { ...pin, extra: true },
    { ...legacy, profileId: 'wrong' },
  ])
    expect(() => decodeLibraryProfilePin(value)).toThrow();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const entry = await store.insertEntry(
      c,
      route,
      { accountId: id(1), subjectId: id(2), requestedSubjectId: null, state: 'playing' },
      { transactionId: id(80), time: at },
      pin,
    );
    expect(entry.state).toBe('playing');
    privateFree(entry);
    expect(await store.readEntryFact(c, route, id(1), id(2))).toEqual({ entry, pin });
    privateFree(await store.readEntry(c, route, id(1), id(2)));
    const nextPin: LibraryProfilePin = { ...pin, releaseDigest: 'sha256:' + 'c'.repeat(64) };
    const updated = await store.updateEntryState(
      c,
      route,
      id(1),
      id(2),
      1,
      'finished_custom',
      { transactionId: id(81), time: later },
      nextPin,
    );
    if (updated === null) throw new Error('Expected the matching entry CAS to succeed');
    expect(updated?.revision).toBe(2);
    expect(updated?.createdAt).toBe(at);
    expect(updated?.updatedAt).toBe(later);
    privateFree(updated);
    expect((await store.readEntryFact(c, route, id(1), id(2)))?.pin).toEqual(nextPin);
    expect(
      await store.updateEntryState(
        c,
        route,
        id(1),
        id(2),
        1,
        'stale_value',
        { transactionId: id(82), time: later },
        pin,
      ),
    ).toBeNull();
    expect((await store.readEntryFact(c, route, id(1), id(2)))?.pin).toEqual(nextPin);
    const page = await store.pageEntries(c, route, id(1), { state: 'finished_custom', after: null, limit: 20 });
    expect(page).toEqual([updated]);
    page.forEach(privateFree);
    expect(await store.readEntryFact(c, route, id(3), id(2))).toBeNull();
    const old = await store.insertEntry(
      c,
      route,
      { accountId: id(1), subjectId: id(4), requestedSubjectId: null, state: 'planned' },
      { transactionId: id(83), time: at },
    );
    expect((await store.readEntryFact(c, route, id(1), id(4)))?.pin).toBeNull();
    await c.query(
      `UPDATE library.entry SET library_profile_pin=$1::jsonb WHERE route=$2 AND account_id=$3 AND subject_id=$4`,
      [JSON.stringify(legacy), route, id(1), id(4)],
    );
    const ordinary = await store.updateEntryState(c, route, id(1), id(4), 1, 'completed', {
      transactionId: id(84),
      time: later,
    });
    expect((await store.readEntryFact(c, route, id(1), id(4)))?.pin).toEqual(legacy);
    expect(ordinary?.createdAt).toBe(old.createdAt);
    await c.query(
      `UPDATE library.entry SET state='UNKNOWN_HISTORICAL_RAW' WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
      [route, id(1), id(4)],
    );
    expect((await store.readEntry(c, route, id(1), id(4)))?.state).toBe('UNKNOWN_HISTORICAL_RAW');
    const insertRaw = (state: string, p: string | null) =>
      c.query(
        `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,library_profile_pin) VALUES($1,$2,$3,$4,1,$5,$5,$6,$7::jsonb)`,
        [route, id(1), id(30), state, at, id(85), p],
      );
    await sqlstate(c, () => insertRaw('playing', null));
    await sqlstate(c, () => insertRaw('', JSON.stringify(pin)));
    await c.query(
      `INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,kind,revision,created_at,updated_at,transaction_id,library_profile_pin) VALUES($1,$2,$3,$4,'licensed','record',1,$5,$5,$6,$7::jsonb)`,
      [route, id(40), id(1), id(2), at, id(86), JSON.stringify(pin)],
    );
    const session = (p: string | null, amount: string, count = 0, mode = 'scalar_amount') =>
      c.query(
        `INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,amount,completed_unit_count,state,revision,started_at,transaction_id,library_profile_pin) VALUES($1,$2,$3,$4,$5,'percent',$6::numeric,$7,'active',1,$8,$9,$10::jsonb)`,
        [route, id(50), id(1), id(2), mode, amount, count, at, id(87), p],
      );
    await sqlstate(c, () => session(null, '100.000001'));
    await sqlstate(c, () => session(JSON.stringify(pin), '-1'));
    await sqlstate(c, () => session(JSON.stringify(pin), '0', 20001, 'completed_units'));
    await session(JSON.stringify(pin), '150.000001');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
