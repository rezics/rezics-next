import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

await import('reylo/register');
const { default: record } = await import('../../src/access/resource-denial-record.sql');
const { default: end } = await import('../../src/access/resource-denial-end.sql');
const { default: grant } = await import('../../src/access/resource-group-grant.sql');

let db: GrowthDatabase;
const route = 0x3b12;
const key = {
  route,
  resource_id: newId(route),
  subject_id: newId(route),
  subject_role: '',
  action: 'realm:participate',
  reason: 'realm_ban',
  grant_role: 'realm.member',
  transaction_id: Bun.randomUUIDv7(),
};
const groupKey = { ...key, subject_role: 'member' };
const at = '2030-01-01T00:00:00Z';
const later = '2031-01-01T00:00:00Z';
const tables = ['resource_denial', 'resource_role_grant'] as const;
type Table = (typeof tables)[number];

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
});
afterAll(async () => db?.close());

async function seed(table: Table, history: boolean, count: number, offset = 0) {
  // Bulk equivalents of record/end and grant/revoke cycles: disjoint closed
  // intervals for this exact key, or open intervals for unrelated subjects.
  const columns = table === 'resource_denial' ? 'action, reason' : 'subject_kind, grant_role';
  const values = table === 'resource_denial' ? "'realm:participate', 'realm_ban'" : "'identity', 'realm.member'";
  await db.admin.query(
    `INSERT INTO access.${table}
      (route, resource_id, subject_id, subject_role, ${columns}, valid, transaction_id)
     SELECT $1, $2, CASE WHEN $7::boolean THEN $3::uuid ELSE gen_random_uuid() END, $8, ${values},
       CASE WHEN $7 THEN tstzrange('1990-01-01'::timestamptz + (n+$6)*interval '2 seconds',
         '1990-01-01'::timestamptz + (n+$6)*interval '2 seconds' + interval '1 second', '[)')
         ELSE '(,)'::tstzrange END, $4
     FROM generate_series(1, $5::integer) n`,
    [
      route,
      key.resource_id,
      key.subject_id,
      key.transaction_id,
      count,
      offset,
      history,
      table === 'resource_denial' ? '' : 'member',
    ],
  );
}

async function rolledBack(operation: (client: PoolClient) => Promise<void>) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

for (const command of ['record', 'end', 'grant'] as const) {
  for (const series of ['closed history', 'unrelated keys'] as const) {
    test(`${command}: open interval lookup stays bounded as ${series} grow`, async () => {
      const table = command === 'grant' ? 'resource_role_grant' : 'resource_denial';
      await db.admin.query(`TRUNCATE access.${table}`);
      await seed(table, false, 4096);
      if (series === 'unrelated keys') await seed(table, true, 512);
      // The measured key always has one open row, beyond its closed history.
      if (command === 'grant') await grant.run(db.admin, { ...groupKey, at });
      else await record.run(db.admin, { ...key, at });

      const operation = () =>
        rolledBack(async (client) => {
          if (command === 'grant') {
            expect((await grant.run(client, { ...groupKey, at })).outcome).toBe('open');
          } else if (command === 'end') {
            expect((await end.run(client, { ...key, at: later })).outcome).toBe('closed');
            expect((await end.run(client, { ...key, at: later })).outcome).toBe('absent');
          } else {
            expect((await record.run(client, { ...key, at })).outcome).toBe('open');
            expect((await end.run(client, { ...key, at: later })).outcome).toBe('closed');
            expect((await record.run(client, { ...key, at: later })).outcome).toBe('inserted');
            expect((await record.run(client, { ...key, at: later })).outcome).toBe('open');
          }
        });
      const report = await checkGrowth(db, {
        name: `${command}: ${series}`,
        scales: [1, 8, 64],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        slack: { rows: { absolute: 0, relative: 0 } },
        async grow(_database, scale, previous) {
          await seed(table, series === 'closed history', (scale - previous) * 512, previous * 512);
          await db.admin.query(`VACUUM (ANALYZE) access.${table}`);
        },
        operation,
      });
      for (const { cost } of report.samples) {
        expect(cost.rows).toBe(command === 'record' ? 4 : command === 'end' ? 2 : 1);
        expect(cost.statements).toBe(command === 'record' ? 4 : command === 'end' ? 2 : 1);
      }
      console.info(
        report.name,
        report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          statements: cost.statements,
          blocks: cost.blocks,
        })),
      );
      const observed = await capture(db, operation);
      // Both the open-row read and the denial update must use the partial index.
      for (const plan of observed.capture.plans) {
        const json = JSON.stringify(plan);
        expect(json).toContain(`"Index Name":"${table}_open"`);
        for (const [, index] of json.matchAll(/"Index Name":"([^"]+)"/g)) expect(index).toBe(`${table}_open`);
        expect(json).not.toContain('"Node Type":"Seq Scan"');
      }
    }, 60000);
  }
}

test('partial unique indexes enforce one open interval per complete key', async () => {
  for (const table of tables) {
    await db.admin.query(`TRUNCATE access.${table}`);
    await seed(table, true, 2);
    if (table === 'resource_denial') await record.run(db.admin, { ...key, at });
    else await grant.run(db.admin, { ...groupKey, at });
    const columns = table === 'resource_denial' ? 'action, reason' : 'subject_kind, grant_role';
    // The temporal primary key also rejects this overlap. Remove it only in
    // this rolled-back transaction to prove the partial index enforces uniqueness.
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE access.${table} DROP CONSTRAINT ${table}_pkey`);
      await expect(
        client.query(
          `INSERT INTO access.${table}
            (route, resource_id, subject_id, subject_role, ${columns}, valid, transaction_id)
           SELECT route, resource_id, subject_id, subject_role, ${columns},
             tstzrange($1::timestamptz, NULL, '[)'), transaction_id
           FROM access.${table} WHERE upper_inf(valid)`,
          [later],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: `${table}_open` });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
});

test('T still filters future open rows and preserves denial close outcomes', async () => {
  await db.admin.query('TRUNCATE access.resource_denial, access.resource_role_grant');
  await record.run(db.admin, { ...key, at: later });
  expect((await end.run(db.admin, { ...key, at })).outcome).toBe('absent');
  expect((await end.run(db.admin, { ...key, at: later })).outcome).toBe('unclosable');
  // Recording before a future interval still refuses overlapping history.
  await expect(record.run(db.admin, { ...key, at })).rejects.toThrow();
  await grant.run(db.admin, { ...groupKey, at: later });
  await expect(grant.run(db.admin, { ...groupKey, at })).rejects.toThrow();
});
