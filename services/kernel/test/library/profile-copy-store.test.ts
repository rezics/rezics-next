import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import * as store from '../../src/library/entry-store.ts';
import type { CopyDraft } from '../../src/library/entry-model.ts';
import type { LibraryProfilePin } from '../../src/library/profile.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c67,
  id = (n: number) => `00000000-0000-7000-8000-6c67${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-27T12:00:00.000Z',
  later = '2026-10-28T12:00:00.000Z';
const pin: LibraryProfilePin = {
  provenance: 'profile',
  releaseDigest: 'sha256:' + 'a'.repeat(64),
  acceptingType: 'ex:Game',
  profileId: 'fixture.game',
};
const draft = (n: number, status: string): CopyDraft => ({
  id: id(n),
  accountId: id(1),
  subjectId: id(2),
  status,
  location: 'private box',
  source: 'private gift',
  acquiredOn: '2026-10-01',
  disposedOn: null,
  note: 'private note',
});
const privateFree = (value: unknown) => {
  for (const field of [
    'pin',
    'kind',
    'profilePin',
    'libraryProfilePin',
    'releaseDigest',
    'acceptingType',
    'provenance',
  ])
    expect(value).not.toHaveProperty(field);
};
test('copy fact storage keeps declared kind status and private pins without exposing provenance or conflating same-subject copies', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const accepted = { pin, kind: 'digital-license' };
    const first = await store.insertCopy(
      c,
      route,
      draft(10, 'licensed'),
      { transactionId: id(80), time: at },
      accepted,
    );
    privateFree(first);
    expect(first.status).toBe('licensed');
    expect(await store.readCopyFact(c, route, id(10))).toEqual({ copy: first, pin, kind: 'digital-license' });
    const second = await store.insertCopy(
      c,
      route,
      draft(11, 'installed'),
      { transactionId: id(81), time: at },
      { pin, kind: 'installation' },
    );
    expect(second.id).not.toBe(first.id);
    expect(second.subjectId).toBe(first.subjectId);
    privateFree(second);
    const nextPin: LibraryProfilePin = { ...pin, releaseDigest: 'sha256:' + 'b'.repeat(64) };
    const changes = { ...draft(10, 'available') };
    const updated = await store.updateCopy(
      c,
      route,
      id(10),
      1,
      changes,
      { transactionId: id(82), time: later },
      { pin: nextPin, kind: 'digital-license' },
    );
    expect(updated?.revision).toBe(2);
    expect(updated?.createdAt).toBe(at);
    privateFree(updated);
    expect(await store.readCopyFact(c, route, id(10))).toEqual({
      copy: updated,
      pin: nextPin,
      kind: 'digital-license',
    });
    expect(
      await store.updateCopy(c, route, id(10), 1, changes, { transactionId: id(83), time: later }, accepted),
    ).toBeNull();
    const oldStatus = { ...changes, status: 'lent' };
    const preserved = await store.updateCopy(c, route, id(10), 2, oldStatus, { transactionId: id(84), time: later });
    expect((await store.readCopyFact(c, route, id(10)))?.pin).toEqual(nextPin);
    expect((await store.readCopyFact(c, route, id(10)))?.kind).toBe('digital-license');
    privateFree(preserved);
    const legacy = await store.insertCopy(c, route, draft(12, 'owned'), { transactionId: id(85), time: at });
    expect(await store.readCopyFact(c, route, id(12))).toEqual({ copy: legacy, pin: null, kind: null });
    privateFree(await store.readCopy(c, route, id(10)));
    for (const subject of [null, id(2)]) {
      const page = await store.pageCopies(c, route, id(1), { after: null, limit: 100 }, subject);
      expect(page).toHaveLength(3);
      for (const row of page) privateFree(row);
      expect(page.find((row) => row.id === id(11))?.status).toBe('installed');
    }
    expect(await store.readCopyFact(c, route, id(99))).toBeNull();
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
