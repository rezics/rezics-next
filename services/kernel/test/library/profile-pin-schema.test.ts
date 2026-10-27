import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c50;
const id = (n: number) => `00000000-0000-7000-8000-6c50${n.toString(16).padStart(8, '0')}`;
const at = '2026-10-27T12:00:00.000Z';
const digest = 'sha256:' + 'a'.repeat(64);
const normal = {
  provenance: 'profile',
  releaseDigest: digest,
  acceptingType: 'urn:test:Subject',
  profileId: 'test-profile',
};
const legacy = { provenance: 'legacy', releaseDigest: digest, acceptingType: null, profileId: 'legacy-fixed-v1' };

async function expectCheck(client: PoolClient, body: () => Promise<unknown>) {
  await client.query('SAVEPOINT invalid_pin');
  let caught: unknown;
  try {
    await body();
  } catch (error) {
    caught = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT invalid_pin');
  expect(caught).toMatchObject({ code: '23514' });
}

test('existing personal fact rows accept only the agreed closed profile pins without rewriting user facts', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO library.entry
      (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id)
      VALUES ($1,$2,$3,'planned',7,$4,$4,$5)`,
      [route, id(1), id(2), at, id(90)],
    );
    await client.query(
      `INSERT INTO library.progress_session
      (route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id)
      VALUES ($1,$2,$3,$4,'cursor_position','percent',0,'active',9,$5,$6)`,
      [route, id(3), id(1), id(2), at, id(91)],
    );
    await client.query(
      `INSERT INTO library.copy
      (route,copy_id,account_id,subject_id,status,revision,created_at,updated_at,transaction_id)
      VALUES ($1,$2,$3,$4,'owned',11,$5,$5,$6)`,
      [route, id(4), id(1), id(2), at, id(92)],
    );
    for (const [table, key, value] of [
      ['entry', 'subject_id', id(2)],
      ['progress_session', 'session_id', id(3)],
      ['copy', 'copy_id', id(4)],
    ] as const) {
      const read = () =>
        client.query(`SELECT to_jsonb(fact) AS row FROM library.${table} fact WHERE route=$1 AND ${key}=$2`, [
          route,
          value,
        ]);
      const before = (await read()).rows[0]!.row;
      expect(before.library_profile_pin).toBeNull();
      if (table === 'copy') {
        expect(before.kind).toBeNull();
        await expectCheck(client, () =>
          client.query(`UPDATE library.copy SET library_profile_pin=$1::jsonb WHERE route=$2 AND copy_id=$3`, [
            JSON.stringify(normal),
            route,
            value,
          ]),
        );
        await client.query(`UPDATE library.copy SET kind='legacy-unspecified' WHERE route=$1 AND copy_id=$2`, [
          route,
          value,
        ]);
      }
      for (const pin of [
        normal,
        legacy,
        { ...legacy, acceptingType: 'urn:retained:Historical' },
        { ...normal, acceptingType: 'urn:long:' + 'x'.repeat(5000) },
      ]) {
        await client.query(`UPDATE library.${table} SET library_profile_pin=$1::jsonb WHERE route=$2 AND ${key}=$3`, [
          JSON.stringify(pin),
          route,
          value,
        ]);
        const after = (await read()).rows[0]!.row;
        expect(after.library_profile_pin).toEqual(pin);
        const { library_profile_pin: _pin, kind: _kind, ...actualFact } = after;
        const { library_profile_pin: _oldPin, kind: _oldKind, ...originalFact } = before;
        expect(actualFact).toEqual(originalFact);
      }
      for (const pin of [
        null,
        [],
        {},
        { ...normal, provenance: 'unknown' },
        { ...normal, acceptingType: null },
        { ...normal, acceptingType: '' },
        { ...normal, profileId: '' },
        { ...normal, profileId: 1 },
        { ...normal, releaseDigest: 'sha256:bad' },
        { ...normal, profileRevision: 1 },
        { ...legacy, profileId: 'wrong' },
        { ...legacy, acceptingType: 123 },
        { provenance: 'profile', releaseDigest: digest, profileId: 'test-profile' },
      ])
        await expectCheck(client, () =>
          client.query(`UPDATE library.${table} SET library_profile_pin=$1::jsonb WHERE route=$2 AND ${key}=$3`, [
            JSON.stringify(pin),
            route,
            value,
          ]),
        );
      await client.query(`UPDATE library.${table} SET library_profile_pin=NULL WHERE route=$1 AND ${key}=$2`, [
        route,
        value,
      ]);
      expect((await read()).rows[0]!.row.library_profile_pin).toBeNull();
    }
    const indexes = await client.query<{ tablename: string; indexdef: string }>(
      `SELECT tablename,indexdef FROM pg_indexes WHERE schemaname='library' AND tablename IN ('entry','progress_session','copy')`,
    );
    for (const [table, key] of [
      ['entry', 'subject_id'],
      ['progress_session', 'session_id'],
      ['copy', 'copy_id'],
    ] as const) {
      expect(
        indexes.rows.some(
          (row) =>
            row.tablename === table &&
            row.indexdef.includes(`(route, account_id, ${key})`) &&
            /WHERE \(library_profile_pin IS NULL\)/.test(row.indexdef),
        ),
      ).toBe(true);
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
