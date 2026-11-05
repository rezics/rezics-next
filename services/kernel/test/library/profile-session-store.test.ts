import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as store from '../../src/library/progress-store.ts';
import type { LibraryProfilePin } from '../../src/library/profile.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c57;
const id = (n: number) => `00000000-0000-7000-8000-6c57${n.toString(16).padStart(8, '0')}`;
const time = '2026-10-27T12:00:00.000Z';
const pin: LibraryProfilePin = {
  provenance: 'profile',
  releaseDigest: 'sha256:' + 'c'.repeat(64),
  acceptingType: 'ex:Record',
  profileId: 'fixture.record',
};
const context = (n: number) => ({ transactionId: id(n), time });
function publicView(value: unknown) {
  for (const key of ['pin', 'profilePin', 'libraryProfilePin', 'releaseDigest', 'acceptingType', 'profileId'])
    expect(value).not.toHaveProperty(key);
}
test('profile-pinned sessions preserve generic units private provenance and sparse identities through native DAO reads and CAS', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const session = await store.insertSession(
      c,
      route,
      {
        id: id(10),
        accountId: id(1),
        subjectId: id(2),
        versionSubjectId: null,
        mode: 'completed_units',
        unit: 'track',
        total: null,
      },
      context(80),
      pin,
    );
    expect(session.unit).toBe('track');
    publicView(session);
    expect(await store.readSessionFact(c, route, session.id)).toEqual({ session, pin });
    expect(await store.readSessionFact(c, route + 1, session.id)).toBeNull();
    expect(await store.readSessionFact(c, route, id(999))).toBeNull();
    publicView(await store.readSession(c, route, session.id));
    expect(await store.addUnits(c, route, session.id, ['1', '3', '7', '01', 'opaque:key'], context(81))).toBe(5);
    const changed = await store.updateSession(
      c,
      route,
      session.id,
      1,
      { amount: null, locator: null, position: null, completedUnitCount: 5, state: 'active', completedAt: null },
      context(82),
    );
    expect(changed.revision).toBe(2);
    publicView(changed);
    expect((await store.readSessionFact(c, route, session.id))?.pin).toEqual(pin);
    expect(
      (await store.pageUnits(c, route, session.id, { after: null, limit: 100 })).map((x) => x.unitId).sort(),
    ).toEqual(['01', '1', '3', '7', 'opaque:key']);
    expect(await store.removeUnits(c, route, session.id, ['3', 'missing'])).toBe(1);
    expect(
      (await store.pageUnits(c, route, session.id, { after: null, limit: 100 })).map((x) => x.unitId).sort(),
    ).toEqual(['01', '1', '7', 'opaque:key']);
    const again = await store.insertSession(
      c,
      route,
      {
        id: id(11),
        accountId: id(1),
        subjectId: id(2),
        versionSubjectId: null,
        mode: 'completed_units',
        unit: 'track',
        total: null,
      },
      context(83),
      pin,
    );
    expect(again.id).not.toBe(session.id);
    expect(await store.pageUnits(c, route, again.id, { after: null, limit: 100 })).toEqual([]);
    for (const row of await store.pageSessions(c, route, id(1), id(2), { after: null, limit: 100 })) publicView(row);
    const legacy = await store.insertSession(
      c,
      route,
      {
        id: id(12),
        accountId: id(1),
        subjectId: id(2),
        versionSubjectId: null,
        mode: 'scalar_amount',
        unit: 'minute',
        total: null,
      },
      context(84),
    );
    expect(await store.readSessionFact(c, route, legacy.id)).toEqual({ session: legacy, pin: null });
    const cursor = await store.insertSession(
      c,
      route,
      {
        id: id(13),
        accountId: id(1),
        subjectId: id(2),
        versionSubjectId: null,
        mode: 'cursor_position',
        unit: 'percent',
        total: null,
      },
      context(85),
      pin,
    );
    const moved = await store.updateSession(
      c,
      route,
      cursor.id,
      1,
      {
        amount: null,
        locator: 'chapter:opaque',
        position: '150',
        completedUnitCount: 0,
        state: 'active',
        completedAt: null,
      },
      context(86),
    );
    expect(Number(moved.position)).toBe(150);
    expect((await store.readSessionFact(c, route, cursor.id))?.pin).toEqual(pin);
    await c.query('SAVEPOINT old_unit');
    await expect(
      store.insertSession(
        c,
        route,
        {
          id: id(14),
          accountId: id(1),
          subjectId: id(2),
          versionSubjectId: null,
          mode: 'scalar_amount',
          unit: 'unconfigured',
          total: null,
        },
        context(87),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    await c.query('ROLLBACK TO SAVEPOINT old_unit');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
