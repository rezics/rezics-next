import { resetGrowthTables } from './growth-reset.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { actorFixture } from './actor-side-fixture.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { parentCreationAuthorization, creationCapability } from '../../src/access/parent-creation.ts';
import { runCommand } from '../../src/command/command.ts';
import { readAccount } from '../../src/access/account-data.ts';
import type { Access, Resource } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await db.admin.query(`CREATE TABLE public.authorization_growth_resource (
    route integer NOT NULL, id uuid NOT NULL,
    creation_xid xid8 NOT NULL DEFAULT pg_current_xact_id(), PRIMARY KEY(route,id)
  )`);
  await db.admin.query(`CREATE TABLE public.authorization_growth_tuple (
    route integer NOT NULL, source text NOT NULL, external_key uuid NOT NULL, value integer NOT NULL,
    PRIMARY KEY(route,source,external_key)
  )`);
}, 30_000);
afterAll(async () => {
  await db?.close();
});

for (const axis of ['combined', 'grants', 'unrelated groups', 'history'] as const)
  for (const mode of ['stable tuple', 'creation'] as const) {
    const suffix = axis === 'combined' ? '' : ` [${axis}]`;
    test(
      `${mode} authorization composes bounded actor proofs, authority validation and target execution` + suffix,
      async () => {
        // Each path starts with the same population; prior runs must not flatten
        // the first growth step by leaving a larger authority index behind.
        await resetGrowthTables(db.admin, [
          'access.resource_grant',
          'access.resource_role_grant',
          'access.resource_denial',
          'access.organization_member',
          'access.membership_inverse',
          'access.principal_assignment',
          'access.account',
          'core.receipt',
          'public.authorization_growth_resource',
          'public.authorization_growth_tuple',
        ]);
        const f = await actorFixture(db.pool, db.admin);
        await db.admin.query('INSERT INTO public.authorization_growth_resource(route,id) VALUES ($1,$2)', [
          f.resource.route,
          f.resource.id,
        ]);
        await db.admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
          f.resource.route,
          f.resource.id,
        ]);
        await f.grant(f.organizationId, 'owner', f.resource, '[2000-01-01,)');
        await db.admin.query(
          "UPDATE access.organization_member SET valid='[2000-01-01,)' WHERE route=$1 AND organization_id=$2",
          [routeOf(f.organizationId), f.organizationId],
        );
        let account = await readAccount(db.admin, routeOf(f.actorId)!, f.actorId);
        const permission = f.permissions({ accountEvidence: () => account });
        let preparations = 0;
        const access: Access = {
          ...permission,
          async prepare(...args) {
            // Count the independently anchored identity evidence as part of the path.
            account = await readAccount(db.pool, routeOf(f.actorId)!, f.actorId);
            preparations++;
            return permission.prepare!(...args);
          },
        };
        const anchor = {
          resource: f.resource,
          async validate(client: Parameters<Access['authorize']>[0]) {
            return (
              (
                await client.query('SELECT 1 FROM public.authorization_growth_resource WHERE route=$1 AND id=$2', [
                  f.resource.route,
                  f.resource.id,
                ])
              ).rowCount === 1
            );
          },
        };
        const report = await checkGrowth(db, {
          name: `${mode} composed authorization` + suffix,
          bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
          repetitions: 3,
          warmups: 1,
          async grow(database, scale, previous) {
            const grows = (dimension: typeof axis) => !previous || axis === 'combined' || axis === dimension;
            const from = previous * 256;
            const to = scale * 256;
            const ids = Array.from({ length: to - from }, () => newId(f.resource.route));
            if (grows('unrelated groups')) {
              await database.admin.query(
                `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
          SELECT $1,id,'organization','active',$3 FROM unnest($2::uuid[]) id`,
                [f.resource.route, ids, f.transactionId],
              );
              // Seed every read relation, including receipt replay, above small-table
              // sequential-scan sizes. These are unrelated keys, not new actor groups.
              await database.admin.query(
                `INSERT INTO access.membership_inverse
          (route,account_id,kind,group_id,reservation_id,transaction_id)
          SELECT $1,id,'organization',$3,id,$4 FROM unnest($2::uuid[]) id`,
                [f.resource.route, ids, f.organizationId, f.transactionId],
              );
              await database.admin.query(
                `INSERT INTO access.principal_assignment
          (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
          SELECT $1,$2,id,$3,'(,)',$5 FROM unnest($4::uuid[]) id`,
                [routeOf(f.principalId), f.principalId, f.actorId, ids, f.transactionId],
              );
              await database.admin.query(
                `INSERT INTO core.receipt
          (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
          SELECT $1,'account',$2,$3,id::text || '-' || n,$4,1,1,$5,'{}'::jsonb
          FROM unnest($6::uuid[]) id CROSS JOIN generate_series(1,4) n`,
                [partitionOf(0x9876), f.actorId, `growth.resource.${mode}`, Buffer.alloc(32), f.transactionId, ids],
              );
              if (axis === 'unrelated groups')
                await database.admin.query(
                  `INSERT INTO access.organization_member
              (route,organization_id,member_account_id,role,valid,transaction_id)
              SELECT $1,id,$3,'owner','(,)',$4 FROM unnest($2::uuid[]) id`,
                  [f.resource.route, ids, f.actorId, f.transactionId],
                );
            }
            if (grows('grants')) {
              // Grow unrelated anchors AND same-authority ACLs without increasing K.
              await database.admin.query(
                `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
          SELECT $1::integer,$2::uuid,id,'owner','subject:read','(,)'::tstzrange,$4::uuid FROM unnest($3::uuid[]) id
          UNION ALL SELECT $1,id,id,'','subject:read','(,)',$4 FROM unnest($3::uuid[]) id`,
                [f.resource.route, f.resource.id, ids, f.transactionId],
              );
              await database.admin.query(
                `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
          SELECT $1,$2,id,'owner','fixture.reader','(,)',$4 FROM unnest($3::uuid[]) id`,
                [f.resource.route, f.resource.id, ids, f.transactionId],
              );
              await database.admin.query(
                `INSERT INTO access.resource_denial(route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
          SELECT $1,$2,id,'member','subject:read','resource','(,)',$4 FROM unnest($3::uuid[]) id`,
                [f.resource.route, f.resource.id, ids, f.transactionId],
              );
            }
            if (grows('history')) {
              // Native temporal seeks must also stay bounded as matched-key history grows.
              await database.admin.query(
                `INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id)
          SELECT $1,$2,$3,'owner','subject:read',tstzrange('1900-01-01'::timestamptz+n*interval '1 minute',
            '1900-01-01'::timestamptz+(n+1)*interval '1 minute','[)'),$6
          FROM generate_series($4::integer,$5::integer-1) n`,
                [f.resource.route, f.resource.id, f.organizationId, from, to, f.transactionId],
              );
              await database.admin.query(
                `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id)
          SELECT $1,$2,$3,'owner',tstzrange('1900-01-01'::timestamptz+n*interval '1 minute',
            '1900-01-01'::timestamptz+(n+1)*interval '1 minute','[)'),$6
          FROM generate_series($4::integer,$5::integer-1) n`,
                [routeOf(f.organizationId), f.organizationId, f.actorId, from, to, f.transactionId],
              );
            }
            if (!previous || axis === 'combined') {
              await database.admin.query(
                'INSERT INTO public.authorization_growth_resource(route,id) SELECT $1,id FROM unnest($2::uuid[]) id',
                [f.resource.route, ids],
              );
              await database.admin.query(
                `INSERT INTO public.authorization_growth_tuple SELECT $1,'noise',id,1 FROM unnest($2::uuid[]) id`,
                [0x9876, ids],
              );
            }
            await database.admin.query('VACUUM (ANALYZE)');
          },
          async operation(database, scale, repetition) {
            const resource: Resource = { route: 0x9876, id: newId(0x9876) };
            const deadline = Date.now() + 5000;
            const context = { pool: database.pool, deadline, partition: partitionOf(resource.route) };
            const authorization =
              mode === 'stable tuple'
                ? resourceAuthorization({ access, actor: f.delegated, action: 'subject:read', anchor, context })
                : parentCreationAuthorization({
                    access,
                    actor: f.delegated,
                    action: 'subject:read',
                    parent: anchor,
                    context: {
                      ...context,
                      resource,
                      creation: {
                        async validate(tx, child) {
                          return (
                            (
                              await tx.query(
                                'SELECT 1 FROM public.authorization_growth_resource WHERE route=$1 AND id=$2 AND creation_xid=pg_current_xact_id()',
                                [child.route, child.id],
                              )
                            ).rowCount === 1
                          );
                        },
                      },
                    },
                  });
            const result = await runCommand(
              database.pool,
              {
                partition: context.partition,
                deadline,
                authorization,
                basis: {
                  actorAccountId: f.actorId,
                  clientId: f.delegated.clientId,
                  requestedBy: f.delegated.requestedBy,
                },
                receipt: {
                  actorAccountId: f.actorId,
                  kind: `growth.resource.${mode}`,
                  key: `${scale}-${repetition}`,
                  digest: Buffer.alloc(32),
                },
              },
              async (tx) => {
                if (mode === 'stable tuple') {
                  const target = await tx.query(
                    `INSERT INTO public.authorization_growth_tuple VALUES ($1,'catalog',$2,1)
            ON CONFLICT(route,source,external_key) DO UPDATE SET value=authorization_growth_tuple.value+1`,
                    [resource.route, f.actorId],
                  );
                  expect(target.rowCount).toBe(1);
                } else {
                  const target = await tx.query(
                    'INSERT INTO public.authorization_growth_resource(route,id) VALUES ($1,$2)',
                    [resource.route, resource.id],
                  );
                  expect(target.rowCount).toBe(1);
                  const capability = await creationCapability(tx, resource, f.actorId);
                  capability.complete();
                }
                return { value: 'done', events: [{ type: 'com.rezics.test.growth-resource-authorized.v1', data: {} }] };
              },
            );
            expect(result.value).toBe('done');
          },
        });
        expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
        expect(preparations).toBe(12);
        const [first, ...rest] = report.samples;
        expect(rest.every(({ cost }) => cost.statements === first!.cost.statements)).toBe(true);
      },
      120_000,
    );
  }
