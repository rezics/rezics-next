import { createHash, randomUUID } from 'node:crypto';
import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { runCommand } from '../../src/command/command.ts';
import { partitionOf } from '../../src/route/route.ts';
import { pinLegacyFactsPage } from '../../src/library/profile-migration-page.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c59;
const id = (n: number) => `00000000-0000-7000-8000-6c59${n.toString(16).padStart(8, '0')}`;
const digest = 'sha256:' + 'd'.repeat(64);
const pin = { provenance: 'legacy', releaseDigest: digest, acceptingType: null, profileId: 'legacy-fixed-v1' };
const time = '2026-10-27T12:00:00.000Z';
async function page(kind: 'entry' | 'session' | 'copy', after: string | null, limit: number, releaseDigest = digest) {
  const key = randomUUID();
  return runCommand(
    pool,
    {
      partition: partitionOf(route),
      receipt: {
        actorAccountId: id(1),
        kind: 'fixture.legacy-pin-page',
        key,
        digest: createHash('sha256').update(key).digest(),
      },
    },
    async (tx) => ({
      value: await pinLegacyFactsPage(tx, { accountId: id(1), kind, releaseDigest, after, limit }),
      events: [{ type: 'com.rezics.test.migration.v1', subject: id(1), data: { kind } }],
    }),
  );
}
test('bounded native legacy pin pages preserve original facts and refuse terminal-owner maintenance', async () => {
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)`,
    [route, id(1)],
  );
  await pool.query(
    `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id) SELECT $1,$2,('00000000-0000-7000-8000-6c59'||lpad(to_hex(n),8,'0'))::uuid,'planned',7,$3,$3,$4 FROM generate_series(10,212) n`,
    [route, id(1), time, id(80)],
  );
  const before = (
    await pool.query(
      `SELECT to_jsonb(e)-'library_profile_pin' AS payload FROM library.entry e WHERE route=$1 AND account_id=$2 ORDER BY subject_id`,
      [route, id(1)],
    )
  ).rows;
  let p = (await page('entry', null, 100)).value;
  expect(p.examined).toBe(100);
  expect(p.changed).toBe(100);
  expect(p.exhausted).toBe(false);
  const firstAfter = p.after;
  p = (await page('entry', p.after, 100)).value;
  expect(p.examined).toBe(100);
  expect(p.changed).toBe(100);
  p = (await page('entry', p.after, 100)).value;
  expect(p.examined).toBe(3);
  expect(p.changed).toBe(3);
  expect(p.exhausted).toBe(true);
  const after = (
    await pool.query(
      `SELECT to_jsonb(e)-'library_profile_pin' AS payload,library_profile_pin AS pin FROM library.entry e WHERE route=$1 AND account_id=$2 ORDER BY subject_id`,
      [route, id(1)],
    )
  ).rows;
  expect(after.map((x) => ({ payload: x.payload }))).toEqual(before);
  for (const row of after) expect(row.pin).toEqual(pin);
  expect((await page('entry', firstAfter, 100, 'sha256:' + 'e'.repeat(64))).value.changed).toBe(0);
  await pool.query(
    `INSERT INTO library.copy(route,copy_id,account_id,subject_id,status,note,revision,created_at,updated_at,transaction_id) VALUES($1,$2,$3,$4,'owned','Preserve note',4,$5,$5,$6)`,
    [route, id(300), id(1), id(301), time, id(80)],
  );
  expect((await page('copy', null, 100)).value.changed).toBe(1);
  expect(
    (
      await pool.query(
        `SELECT library_profile_pin AS pin,kind,note,revision,updated_at::text,transaction_id FROM library.copy WHERE route=$1 AND copy_id=$2`,
        [route, id(300)],
      )
    ).rows[0],
  ).toMatchObject({ pin, kind: 'legacy-unspecified', note: 'Preserve note', revision: 4, transaction_id: id(80) });
  await pool.query(
    `INSERT INTO library.progress_session(route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,last_changed_at,transaction_id) VALUES($1,$2,$3,$4,'completed_units','chapter',3,'active',6,$5,$5,$6)`,
    [route, id(400), id(1), id(401), time, id(80)],
  );
  await pool.query(
    `INSERT INTO library.progress_unit(route,session_id,unit_id,added_at) SELECT $1,$2,n,$3 FROM unnest(ARRAY['1','3','7']) n`,
    [route, id(400), time],
  );
  expect((await page('session', null, 100)).value.changed).toBe(1);
  expect(
    (
      await pool.query(`SELECT unit_id FROM library.progress_unit WHERE route=$1 AND session_id=$2 ORDER BY unit_id`, [
        route,
        id(400),
      ])
    ).rows.map((x) => x.unit_id),
  ).toEqual(['1', '3', '7']);
  const s = (
    await pool.query(
      `SELECT library_profile_pin AS pin,revision,completed_unit_count,transaction_id FROM library.progress_session WHERE route=$1 AND session_id=$2`,
      [route, id(400)],
    )
  ).rows[0];
  expect(s).toEqual({ pin, revision: 6, completed_unit_count: 3, transaction_id: id(80) });
  await expect(page('entry', null, 101)).rejects.toBeDefined();
  await expect(page('entry', null, 1, 'not-a-digest')).rejects.toBeDefined();
  await pool.query(`UPDATE access.account SET state='deleted',authn_fenced=true WHERE route=$1 AND account_id=$2`, [
    route,
    id(1),
  ]);
  await expect(page('entry', null, 100)).rejects.toBeDefined();
});
