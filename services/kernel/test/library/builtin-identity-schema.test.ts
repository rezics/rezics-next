import { afterAll, expect, test } from 'bun:test';
import pg, { type PoolClient } from 'pg';
import { readCollection } from '../../src/library/collection-store.ts';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());
const route = 0x6c63;
const id = (n: number) => `00000000-0000-7000-8000-6c63${n.toString(16).padStart(8, '0')}`;
const time = '2026-10-27T12:00:00.000Z';
const releaseA = 'sha256:' + 'a'.repeat(64),
  releaseB = 'sha256:' + 'b'.repeat(64);
async function sqlstate(c: PoolClient, code: string, body: () => Promise<unknown>) {
  await c.query('SAVEPOINT invalid_builtin');
  let error: unknown;
  try {
    await body();
  } catch (e) {
    error = e;
  }
  await c.query('ROLLBACK TO SAVEPOINT invalid_builtin');
  expect(error).toMatchObject({ code });
}
test('builtin Collection identities share the existing header preserve stable state keys and keep private query references out of legacy views', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const add = (
      n: number,
      owner = id(1),
      kind: 'curated' | 'dynamic' = 'dynamic',
      builtin: string | null = 'everything',
      digest: string | null = null,
      profile: string | null = null,
      set: string | null = null,
      state: string | null = null,
    ) =>
      c.query(
        `INSERT INTO library.collection(route,collection_id,curator_account_id,title,visibility,state,revision,created_at,updated_at,transaction_id,membership_kind,builtin_kind,builtin_release_digest,builtin_profile_id,builtin_state_set_id,builtin_state_id) VALUES($1,$2,$3,'Builtin fixture','private','active',1,$4,$4,$3,$5,$6,$7,$8,$9,$10)`,
        [route, id(n), owner, time, kind, builtin, digest, profile, set, state],
      );
    await add(10);
    await sqlstate(c, '23505', () => add(11));
    await add(12, id(2));
    await add(20, id(1), 'dynamic', 'state', releaseA, 'fixture.game', 'fixture.states', 'planned');
    await sqlstate(c, '23505', () =>
      add(21, id(1), 'dynamic', 'state', releaseB, 'fixture.game', 'fixture.states', 'planned'),
    );
    await c.query(`UPDATE library.collection SET builtin_release_digest=$3 WHERE route=$1 AND collection_id=$2`, [
      route,
      id(20),
      releaseB,
    ]);
    expect(
      (
        await c.query(
          `SELECT collection_id,builtin_release_digest FROM library.collection WHERE route=$1 AND collection_id=$2`,
          [route, id(20)],
        )
      ).rows,
    ).toEqual([{ collection_id: id(20), builtin_release_digest: releaseB }]);
    await add(22, id(2), 'dynamic', 'state', releaseA, 'fixture.game', 'fixture.states', 'planned');
    await add(23, id(1), 'dynamic', 'state', releaseA, 'fixture.game', 'fixture.states', 'active');
    await sqlstate(c, '23514', () => add(30, id(1), 'curated', 'everything'));
    await sqlstate(c, '23514', () => add(31, id(1), 'dynamic', 'state', releaseA, 'fixture.game', null, 'planned'));
    await sqlstate(c, '23514', () =>
      add(32, id(1), 'dynamic', 'state', releaseA, 'bad\n', 'fixture.states', 'planned'),
    );
    await sqlstate(c, '23514', () =>
      add(33, id(1), 'dynamic', 'state', releaseA, 'x'.repeat(65), 'fixture.states', 'planned'),
    );
    await add(40, id(1), 'curated', null);
    await sqlstate(c, '23514', () =>
      c.query(`UPDATE library.collection SET membership_kind='dynamic' WHERE route=$1 AND collection_id=$2`, [
        route,
        id(40),
      ]),
    );
    const view = await readCollection(c, route, id(40));
    for (const field of [
      'membershipKind',
      'membership_kind',
      'builtinKind',
      'builtin_kind',
      'builtin_profile_id',
      'builtin_release_digest',
    ])
      expect(view).not.toHaveProperty(field);
    await c.query(
      `UPDATE library.collection SET builtin_kind=NULL,builtin_release_digest=NULL,builtin_profile_id=NULL,builtin_state_set_id=NULL,builtin_state_id=NULL WHERE route=$1 AND collection_id=$2`,
      [route, id(20)],
    );
    expect(
      (
        await c.query(
          `SELECT membership_kind,builtin_kind FROM library.collection WHERE route=$1 AND collection_id=$2`,
          [route, id(20)],
        )
      ).rows,
    ).toEqual([{ membership_kind: 'dynamic', builtin_kind: null }]);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});
