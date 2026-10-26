import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { actorFixture, type ActorFixture } from './actor-side-fixture.ts';
import { resourceAuthorizationPage } from '../../src/access/resource-authorization.ts';
import { authoritativeTimeValue, runCommand } from '../../src/command/command.ts';
import { readAccount } from '../../src/access/account-data.ts';
import type { Access, ResourcePage } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await db.admin.query('CREATE TABLE public.authorization_page_growth(route integer, id uuid, PRIMARY KEY(route,id))');
}, 30_000);
afterAll(async () => {
  await db?.close();
});

for (const series of ['page size', 'unrelated population'] as const) {
  test(`page authorization keeps its statement count fixed as ${series} grows`, async () => {
    let f: ActorFixture;
    let access: Access;
    const ids: string[] = [];
    const report = await checkGrowth(db, {
      name: `page authorization ${series}`,
      bounds: {
        statements: 'constant',
        rows: series === 'page size' ? 'linear' : 'constant',
        blocks: series === 'page size' ? 'linear' : 'logarithmic',
      },
      repetitions: 3,
      warmups: 1,
      async grow(database, scale, previous) {
        if (previous === 0) {
          await database.admin.query(`TRUNCATE access.resource_grant, access.resource_role_grant,
            access.resource_denial, access.organization_member, access.membership_inverse,
            access.principal_assignment, access.account, core.receipt, public.authorization_page_growth CASCADE`);
          f = await actorFixture(database.pool, database.admin);
          let account = await readAccount(database.admin, routeOf(f.actorId)!, f.actorId);
          const permissions = f.permissions({ accountEvidence: () => account });
          access = {
            ...permissions,
            async preparePage(...args) {
              account = await readAccount(database.pool, routeOf(f.actorId)!, f.actorId);
              return permissions.preparePage!(...args);
            },
            async authorizePage(client, actor, action, page, evidence, time) {
              if (series !== 'page size')
                return permissions.authorizePage!(client, actor, action, page, evidence, time);
              const decision = await permissions.authorizeExplicit!(client, actor, action, page, evidence, time);
              expect(decision.explicit).toBe(true);
              return decision.allowed;
            },
          };
        }
        const size = series === 'page size' ? scale : 8;
        const added = Array.from({ length: size - ids.length }, () => newId(f.resource.route));
        ids.push(...added);
        await database.admin.query(
          'INSERT INTO public.authorization_page_growth SELECT $1,id FROM unnest($2::uuid[]) id',
          [f.resource.route, added],
        );
        // Both actor and delegation principal need the same independently verified group.
        await database.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
          SELECT $1,id,$3,'owner','subject:read','(,)',$4 FROM unnest($2::uuid[]) id`,
          [f.resource.route, added, f.organizationId, f.transactionId],
        );
        if (previous === 0 || series === 'unrelated population') {
          const noise = Array.from(
            {
              length: (previous === 0 ? 4096 : 0) + (series === 'unrelated population' ? (scale - previous) * 256 : 0),
            },
            () => newId(f.resource.route),
          );
          await database.admin.query(
            `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
            SELECT $1,id,'actor','active',$3 FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId],
          );
          await database.admin.query(
            'INSERT INTO public.authorization_page_growth SELECT $1,id FROM unnest($2::uuid[]) id',
            [f.resource.route, noise],
          );
          await database.admin.query(
            `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
            SELECT $1::integer,id,id,'subject:read','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id
            UNION ALL SELECT $1::integer,$4::uuid,id,'subject:read','(,)'::tstzrange,$3::uuid FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId, ids[0]],
          );
          await database.admin.query(
            `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
            SELECT $1,$4,id,'fixture.reader','(,)',$3 FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId, ids[0]],
          );
          await database.admin.query(
            `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
            SELECT $1,$4,id,'subject:read','resource','(,)',$3 FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.transactionId, ids[0]],
          );
          await database.admin.query(
            `INSERT INTO access.membership_inverse
            (route,account_id,kind,group_id,reservation_id,transaction_id)
            SELECT $1,id,'organization',$3,id,$4 FROM unnest($2::uuid[]) id`,
            [f.resource.route, noise, f.organizationId, f.transactionId],
          );
          await database.admin.query(
            `INSERT INTO access.organization_member
            (route,organization_id,member_account_id,role,valid,transaction_id)
            SELECT $1,$3,id,'owner','(,)',$4 FROM unnest($2::uuid[]) id`,
            [routeOf(f.organizationId), noise, f.organizationId, f.transactionId],
          );
          await database.admin.query(
            `INSERT INTO access.principal_assignment
            (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
            SELECT $1,$3,id,$4,'(,)',$5 FROM unnest($2::uuid[]) id`,
            [routeOf(f.principalId), noise, f.principalId, f.actorId, f.transactionId],
          );
          await database.admin.query(
            `INSERT INTO core.receipt
            (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
            SELECT $1,'account',$2,'test.page.noise',id::text,$3,1,1,$4,'{}'::jsonb FROM unnest($5::uuid[]) id`,
            [partitionOf(f.resource.route), f.actorId, Buffer.alloc(32), f.transactionId, noise],
          );
        }
      },
      async operation(database, scale, repetition) {
        const page: ResourcePage = { route: f.resource.route, resourceType: 'fixture.page', ids };
        const deadline = Date.now() + 10_000;
        const authorization = resourceAuthorizationPage({
          access,
          actor: f.delegated,
          action: 'subject:read',
          anchor: {
            ...page,
            async validate(client, time) {
              authoritativeTimeValue(time);
              return (
                (
                  await client.query(
                    'SELECT id FROM public.authorization_page_growth WHERE route=$1 AND id=ANY($2::uuid[])',
                    [page.route, page.ids],
                  )
                ).rowCount === page.ids.length
              );
            },
          },
          context: { pool: database.pool, deadline, partition: partitionOf(page.route) },
        });
        const result = await runCommand(
          database.pool,
          {
            partition: partitionOf(page.route),
            deadline,
            authorization,
            basis: { actorAccountId: f.actorId, clientId: f.delegated.clientId, requestedBy: f.delegated.requestedBy },
            receipt: {
              actorAccountId: f.actorId,
              kind: 'test.page.growth',
              key: `${series}-${scale}-${repetition}`,
              digest: Buffer.alloc(32),
            },
          },
          async () => ({ value: 'executed', events: [{ type: 'com.rezics.test.resource-authorized.v1', data: {} }] }),
        );
        expect(result.value).toBe('executed');
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
    if (series === 'page size') expect(report.samples[2]!.cost.rows).toBeGreaterThan(report.samples[0]!.cost.rows);
    else expect(new Set(report.samples.map(({ cost }) => cost.rows)).size).toBe(1);
  }, 120_000);
}
