import { expect, test } from 'bun:test';
import pg from 'pg';
import inverse from '../../src/access/permission-inverse.sql';
import { newId, routeOf } from '../../src/route/route.ts';
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

test('scalar and batched inverse reads preserve both complete kind ranges and account coverage', async () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const accounts = [0x2134, 0x3456, 0x4567, 0x5678, 0x789a, 0x2134].map(newId);
    const [actor, principal, empty, incomplete, missing, unrelated] = accounts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    await client.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
       SELECT get_byte(uuid_send(id),10)*256+get_byte(uuid_send(id),11),id,'actor','active',id
       FROM unnest($1::uuid[]) id`,
      [accounts.filter((id) => id !== missing)],
    );
    await client.query('UPDATE access.account SET membership_inverse_complete=false WHERE account_id=$1', [incomplete]);
    const groups = Array.from({ length: 1001 }, (_, index) => ({
      kind: index % 2 ? 'realm' : 'organization',
      id: newId(0xa000 + (index % 16)),
    }));
    // The two kinds together reach the cap. The producer must also expose an
    // over-cap rowset intact so its consumers can refuse it rather than truncate.
    for (const [accountId, count] of [
      [actor, 1000],
      [principal, 1001],
      [incomplete, 2],
      [missing, 2],
      [unrelated, 1001],
    ] as const)
      await client.query(
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
         SELECT $1,$2,g.kind,g.id,g.id,g.id
         FROM jsonb_to_recordset($3::jsonb) AS g(kind text,id uuid)`,
        [routeOf(accountId), accountId, JSON.stringify(groups.slice(0, count))],
      );
    const members = accounts
      .filter((id) => id !== unrelated)
      .map((account_id) => ({ route: routeOf(account_id)!, account_id }));
    // Neither fallback arguments nor another account on the same route may leak
    // into a batch. Missing accounts have no coverage row, even with inverse rows.
    const batch = await inverse.run(client, { route: routeOf(unrelated)!, account_id: unrelated, members });
    const sorted = <T>(rows: T[]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const expected = members.flatMap<Awaited<ReturnType<typeof inverse.run>>[number]>(({ account_id }) => {
      if (account_id === missing) return [];
      if (account_id === empty) return [{ accountId: empty, complete: true, kind: null, id: null }];
      const count = account_id === actor ? 1000 : account_id === principal ? 1001 : 2;
      return groups
        .slice(0, count)
        .map((group) => ({ accountId: account_id, complete: account_id !== incomplete, ...group }));
    });
    expect(sorted(batch)).toEqual(sorted(expected));
    for (const member of members) {
      const single = await inverse.run(client, { ...member, members: null });
      expect(sorted(single)).toEqual(sorted(expected.filter((row) => row.accountId === member.account_id)));
    }
    expect(await inverse.run(client, { route: routeOf(actor)! + 1, account_id: actor, members: null })).toEqual([]);
    expect(await inverse.run(client, { route: routeOf(actor)!, account_id: actor, members: [] })).toEqual([]);
    // Compare the actual rowsets to the former single account-prefix range on
    // this migrated schema, without assuming an order between the two kinds.
    const reference = await client.query(
      `SELECT c.account_id::text AS "accountId",c.complete,i.kind,i.group_id::text AS id
       FROM jsonb_to_recordset($1::jsonb) AS m(route integer,account_id uuid)
       JOIN access.membership_inverse_coverage c ON c.route=m.route AND c.account_id=m.account_id
       LEFT JOIN access.membership_inverse i ON i.route=c.route AND i.account_id=c.account_id`,
      [JSON.stringify(members)],
    );
    expect(sorted(batch)).toEqual(sorted(reference.rows));
    await expect(
      client.query(
        `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
       VALUES ($1,$2,'unknown',$3,$3,$3)`,
        [routeOf(actor), actor, newId(0xabcd)],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'membership_inverse_kind_check' });
    await client.query('ANALYZE access.account; ANALYZE access.membership_inverse');
    const parameters = { route: routeOf(actor)!, account_id: actor, members: JSON.stringify(members) };
    const { rows } = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ${inverse.sql}`,
      inverse.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const cost = costOf({ statements: [], plans: [rows[0]['QUERY PLAN']] });
    expect(cost.relations['access.membership_inverse']).toMatchObject({ sequentialScans: 0 });
    // EXPLAIN rounds per-loop row averages; exact cardinality is checked above.
    expect(cost.relations['access.membership_inverse']!.rows).toBeGreaterThan(0);
    expect(cost.relations['access.membership_inverse']!.rows).toBeLessThanOrEqual(
      expected.filter((row) => row.id !== null).length + members.length * 2,
    );
  } finally {
    await client.end();
  }
});
