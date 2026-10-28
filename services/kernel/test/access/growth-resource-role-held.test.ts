import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resourceRoleHeld } from '../../src/access/resource-role-held.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const resource = { route, id: newId(route) };
const accountId = newId(0xabcd);
const role = 'semantic.context.owner';
const at = new Date('2026-10-01T12:00:00Z');
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => db?.close());

test('resourceRoleHeld stays constant as role grants grow', async () => {
  const report = await checkGrowth(db, {
    name: 'resourceRoleHeld',
    scales: [1, 8, 64],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      if (previous === 0)
        await database.admin.query(
          `INSERT INTO access.resource_role_grant
           (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
           VALUES ($1,$2,'identity',$3,'',$4,'[2026-10-01,)',$2)`,
          [route, resource.id, accountId, role],
        );
      // Thousands of rows in each competing neighborhood even at the smallest scale.
      await database.admin.query(
        `INSERT INTO access.resource_role_grant
         (route,resource_id,subject_kind,subject_id,subject_role,grant_role,valid,transaction_id)
         SELECT $1,$2,'identity',gen_random_uuid(),'',$4,'(,)',$2
         FROM generate_series(1,$5::integer)
         UNION ALL
         SELECT $1,$2,'identity',$3,'','other.role.' || n,'(,)',$2
         FROM generate_series($6::integer+1,$7::integer) n
         UNION ALL
         SELECT $1,overlay(gen_random_uuid()::text placing '4567' from 25 for 4)::uuid,'identity',$3,'',$4,'(,)',$2
         FROM generate_series(1,$5::integer)
         UNION ALL
         SELECT $1,$2,'identity',$3,'',$4,
           tstzrange('2000-01-01'::timestamptz+n*interval '2 seconds',
                     '2000-01-01'::timestamptz+(n*2+1)*interval '1 second','[)'),$2
         FROM generate_series($6::integer+1,$7::integer) n`,
        [route, resource.id, accountId, role, (scale - previous) * 2048, previous * 2048, scale * 2048],
      );
    },
    async operation() {
      expect(await resourceRoleHeld(db.pool, { resource, role, accountId, at })).toBe(true);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(1);
    expect(cost.statements).toBe(1);
  }
}, 120_000);
