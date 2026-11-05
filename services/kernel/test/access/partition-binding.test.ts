import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { checkKeys, checkSqlFiles } from '../support/partition-binding.ts';

await import('reylo/register');
const { readPublicIdentities } = await import('../../src/access/account-data.ts');
const { newId } = await import('../../src/route/route.ts');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(() => pool.end());

test('every Access statement is bound to one partition', async () => {
  const results = await checkSqlFiles(pool, new URL('../../src/access/', import.meta.url).pathname);
  expect(results.filter((result) => 'bound' in result.binding && !result.binding.bound)).toEqual([]);
});

test('every Access unique key leads with route or partition_no', async () => {
  expect((await checkKeys(pool)).filter((key) => key.startsWith('access.'))).toEqual([]);
});

test('public identity batches retain request order and disclosure across partition probes', async () => {
  const client = await pool.connect();
  const active = newId(0x1234);
  const suspended = newId(0x2345);
  const deleted = newId(0x1234);
  const pending = newId(0x2345);
  const missing = newId(0x1234);
  try {
    await client.query('BEGIN');
    for (const [route, id, state] of [
      [0x1234, active, 'active'],
      [0x2345, suspended, 'suspended'],
      [0x1234, deleted, 'deleted'],
      [0x2345, pending, 'pending'],
    ] as const) {
      await client.query(
        `INSERT INTO access.account(route, account_id, kind, state, handle, display_name, transaction_id)
         VALUES ($1, $2, 'actor', $3, 'identity_fixture', 'Identity fixture', $4)`,
        [route, id, state, Bun.randomUUIDv7()],
      );
    }
    expect(
      await readPublicIdentities(
        client,
        [0x2345, 0x1234, 0x2345, 0x1234, 0x1234, 0x1234],
        [suspended, deleted, pending, active, missing, active],
      ),
    ).toEqual([
      {
        id: suspended,
        kind: 'actor',
        handle: 'identity_fixture',
        displayName: 'Identity fixture',
        state: 'active',
        automated: false,
        operatorId: null,
      },
      {
        id: deleted,
        kind: 'actor',
        state: 'deleted',
      },
      {
        id: active,
        kind: 'actor',
        handle: 'identity_fixture',
        displayName: 'Identity fixture',
        state: 'active',
        automated: false,
        operatorId: null,
      },
      {
        id: active,
        kind: 'actor',
        handle: 'identity_fixture',
        displayName: 'Identity fixture',
        state: 'active',
        automated: false,
        operatorId: null,
      },
    ]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
