import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4567;
const organization = newId(route);
const others = [newId(route), newId(route)];
const speakers = Array.from({ length: 21 }, () => newId(route)).sort();
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
beforeAll(async () => {
  db = await openGrowthDatabase();
  kernel = createKernel({ pool: db.pool, routeKey: new Uint8Array(32).fill(31) });
});
afterAll(async () => db?.close());

test('organization speakers page stays bounded as unrelated and revoked assignments grow', async () => {
  const report = await checkGrowth(db, {
    name: 'organization speakers page',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    warmups: 1,
    async grow(database, scale, previous) {
      if (previous === 0) {
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,speakers_listed,transaction_id)
          SELECT $1,id,'organization','active',true,id FROM unnest($2::uuid[]) seed(id)`,
          [route, [organization, ...others]],
        );
        await database.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
          SELECT $1,id,'actor','active',id FROM unnest($2::uuid[]) seed(id)`,
          // Keep public identity probes selective even at the first assignment scale.
          [route, [...speakers, ...Array.from({ length: 4096 }, () => newId(route))]],
        );
        await database.admin.query(
          `INSERT INTO access.principal_assignment
          (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
          SELECT $1,$2,id,id,'(,)',id FROM unnest($3::uuid[]) seed(id)`,
          [route, organization, speakers],
        );
      }
      const ids = Array.from({ length: (scale - previous) * 8 }, () => newId(route));
      for (const principal of [organization, ...others]) {
        await database.admin.query(
          `INSERT INTO access.principal_assignment
          (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
          SELECT $1,$2,id,$4,'(,)',id FROM unnest($3::uuid[]) seed(id)`,
          [route, principal, ids, speakers[0]],
        );
        if (principal === organization)
          await database.admin.query(
            `UPDATE access.principal_assignment SET revoked_at='2000-01-01',valid='(,2000-01-01)'
            WHERE route=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])`,
            [route, principal, ids],
          );
      }
      // Duplicate current assignments must not turn a distinct page into a history scan.
      await database.admin.query(
        `INSERT INTO access.principal_assignment
        (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
        SELECT $1,$2,id,$3,'(,)',id FROM unnest($4::uuid[]) seed(id)`,
        [route, organization, speakers[0], ids.map(() => newId(route))],
      );
    },
    async operation() {
      const response = await kernel.handle(
        new Request(`https://kernel.test/v1/accounts/${organization}/speakers?limit=20`),
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.speakers.map(({ id }: { id: string }) => id)).toEqual(speakers.slice(0, 20));
      expect(body.next).toMatch(/^[A-Za-z0-9_-]+$/);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(3);
    expect(sample.cost.relations?.['access.account']?.rows).toBe(21);
  }
}, 60_000);
