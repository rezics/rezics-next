import { expect, test } from 'bun:test';
import pg from 'pg';
import { newId } from '../../src/route/route.ts';

test('a new resource grant skips old interval keys while replacement and maintenance rebuild them', async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const route = 0x1357;
    const grant = await client.query<{ key: string }>(
      `INSERT INTO access.resource_role_grant
         (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
       VALUES ($1,$2,'identity',$3,'','semantic.subject.owner',tstzrange(NULL,NULL),$4)
       RETURNING erasure_key::text AS key`,
      [route, newId(route), newId(0x2468), crypto.randomUUID()],
    );
    const key = grant.rows[0]!.key;
    // An unbounded new interval has no temporal boundaries. Inspect only this transaction's native scan counts.
    const reads = await client.query<{ scans: string }>(
      `SELECT (seq_scan+COALESCE(idx_scan,0))::text AS scans FROM pg_stat_xact_user_tables
       WHERE relid='access.current_resource_role_due'::regclass`,
    );
    expect(reads.rows[0]!.scans).toBe('0');
    const state = async () =>
      (
        await client.query<{ held: number; boundaries: number }>(
          `SELECT (SELECT count(*)::integer FROM access.current_resource_role_key WHERE interval_key=$1) AS held,
                  (SELECT count(*)::integer FROM access.current_resource_role_due WHERE interval_key=$1) AS boundaries`,
          [key],
        )
      ).rows[0];
    expect(await state()).toEqual({ held: 1, boundaries: 0 });
    const otherRoute = route + 1;
    const otherResource = newId(otherRoute);
    for (const [table, insert] of [
      [
        'current_resource_role_key',
        `INSERT INTO access.current_resource_role_key
         SELECT $1,$2,grant_role,subject_kind,subject_id,subject_role,interval_key
         FROM access.current_resource_role_key WHERE interval_key=$3`,
      ],
      ['current_resource_role_due', 'INSERT INTO access.current_resource_role_due VALUES ($1,$2,now(),$3)'],
    ] as const) {
      await client.query('SAVEPOINT other_route');
      await expect(client.query(insert, [otherRoute, otherResource, key])).rejects.toMatchObject({
        code: '23503',
        constraint: table + '_interval_key_fkey',
      });
      await client.query('ROLLBACK TO SAVEPOINT other_route');
    }
    await client.query(
      `UPDATE access.resource_role_grant g
       SET valid=tstzrange(f.processed_at + interval '1 day',f.processed_at + interval '2 days')
       FROM access.current_resource_role_frontier f
       WHERE (f.route,f.resource_id)=(g.route,g.resource_id) AND g.erasure_key=$1`,
      [key],
    );
    expect(await state()).toEqual({ held: 0, boundaries: 2 });
    await client.query(
      `INSERT INTO access.current_resource_role_due
       SELECT route,resource_id,upper(valid)+interval '1 day',erasure_key
       FROM access.resource_role_grant WHERE erasure_key=$1`,
      [key],
    );
    await client.query(
      'SELECT access.index_current_resource_role(g) FROM access.resource_role_grant g WHERE erasure_key=$1',
      [key],
    );
    expect(await state()).toEqual({ held: 0, boundaries: 2 });
    await client.query('DELETE FROM access.resource_role_grant WHERE erasure_key=$1', [key]);
    expect(await state()).toEqual({ held: 0, boundaries: 0 });
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
  }
});
