import { expect, test } from 'bun:test';
import pg from 'pg';
import inverse from '../../src/access/permission-inverse.sql';
import { newId } from '../../src/route/route.ts';
import { costOf } from '../support/growth-cost.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

test('an empty membership inverse probes both kinds without scanning unrelated accounts', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const route = 0x1234;
    const accountId = newId(route);
    await client.query(
      `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
       VALUES ($1, $2, 'actor', 'pending', $2)`,
      [route, accountId],
    );
    await client.query(
      `INSERT INTO access.membership_inverse
       (route, account_id, kind, group_id, reservation_id, transaction_id)
       SELECT 26520, id, 'organization', id, id, id FROM unnest($1::uuid[]) AS id`,
      [Array.from({ length: 256 }, () => newId(26520))],
    );
    // Fresh writes need not be all-visible. The small inverse must still seek
    // the absent account rather than scan all 256 unrelated memberships.
    await client.query('ANALYZE access.account; ANALYZE access.membership_inverse');
    const parameters = { route, account_id: accountId, members: null };
    expect(await inverse.run(client, parameters)).toEqual([{ accountId, complete: true, kind: null, id: null }]);
    const { rows } = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${inverse.sql}`,
      inverse.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const cost = costOf({ statements: [], plans: [rows[0]['QUERY PLAN']] });
    expect(cost.relations['access.membership_inverse']).toMatchObject({ rows: 0, sequentialScans: 0 });
  } finally {
    await client.end();
  }
});
