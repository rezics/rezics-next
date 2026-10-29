import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountStandingCheck } from '../../src/access/index.ts';
import { newId } from '../../src/route/route.ts';
import { admittedAccess } from '../support/admitted-access.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { resetGrowthTables } from './growth-reset.ts';
import { actorFixture } from './actor-side-fixture.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await db.admin.query('CREATE TABLE public.standing_growth_resource(route integer,id uuid,PRIMARY KEY(route,id))');
}, 30000);
afterAll(async () => db?.close());

for (const size of [1, 4]) {
  for (const outcome of ['allowed', 'denied', 'inactive'] as const) {
    test(`standing ${size === 1 ? 'resource' : 'route page'} ${outcome}: constant statements and logarithmic blocks as grants, accounts and resources grow`, async () => {
      await resetGrowthTables(db.admin, [
        'access.account',
        'access.resource_grant',
        'access.resource_role_grant',
        'access.resource_denial',
        'access.membership_inverse',
        'access.organization_member',
        'access.principal_assignment',
        'access.lifecycle_coordination',
        'public.standing_growth_resource',
      ]);
      const f = await actorFixture(db.pool, db.admin);
      const access = admittedAccess({ actions: f.config.actions, resourceRoles: f.config.resourceRoles! });
      const ids = [f.resource.id, ...Array.from({ length: size - 1 }, () => newId(f.resource.route))];
      for (const id of ids.slice(1)) await f.grant(f.actorId, '', { ...f.resource, id });
      if (outcome === 'denied') await f.deny(f.actorId, '');
      if (outcome === 'inactive')
        await db.admin.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
          0x1234,
          f.actorId,
        ]);
      await db.admin.query('INSERT INTO public.standing_growth_resource SELECT $1,id FROM unnest($2::uuid[]) id', [
        f.resource.route,
        ids,
      ]);
      const target = size === 1 ? f.resource : { route: f.resource.route, resourceType: 'fixture.route', ids };
      const report = await checkGrowth(db, {
        name: `account standing ${size} ${outcome}`,
        scales: [1, 8, 64],
        rule: 'series',
        bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
        repetitions: 3,
        warmups: 1,
        async grow(database, scale, previous) {
          const noise = Array.from({ length: (scale - previous) * 256 }, () => newId(f.resource.route));
          await database.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id,membership_inverse_complete)
             SELECT $1,id,'actor','active',$3,true FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId],
          );
          await database.admin.query(
            'INSERT INTO public.standing_growth_resource SELECT $1,id FROM unnest($2::uuid[]) id',
            [f.resource.route, noise],
          );
          await database.admin.query(
            `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
             SELECT $1::integer,id,id,'subject:read','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id
             UNION ALL SELECT $1::integer,$4::uuid,id,'subject:read','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId, f.resource.id],
          );
          await database.admin.query(
            `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
             SELECT $1,$4,id,'fixture.reader','(,)',$3 FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId, f.resource.id],
          );
          await database.admin.query(
            `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
             SELECT $1,$4,id,'subject:read','resource','(,)',$3 FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId, f.resource.id],
          );
        },
        async operation(database) {
          const result = await accountStandingCheck(access, {
            accountId: f.actorId,
            action: 'subject:read',
            target,
            context: { pool: database.pool, deadline: Date.now() + 5000 },
          });
          expect(result).toEqual(
            Object.fromEntries(
              ids.map((id, index) => [id, outcome !== 'inactive' && !(outcome === 'denied' && index === 0)]),
            ),
          );
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
      for (const sample of report.samples) expect(sample.cost.statements).toBe(outcome === 'inactive' ? 1 : 6);
    }, 180000);
  }
}
