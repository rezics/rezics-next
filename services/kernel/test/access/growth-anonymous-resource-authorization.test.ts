import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createAccess } from '../../src/access/index.ts';
import { createResourceAnonymousEligibility } from '../../src/access/eligibility.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import { ANONYMOUS_PRINCIPAL_ID, principalCommandIdentity, runCommand } from '../../src/command/command.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
const authority = { route: 0x1234, id: newId(0x1234) };
const targetRoute = 0x9876;
const partition = partitionOf(targetRoute);
const action = 'report:create';
const transactionId = newId(targetRoute);
const kind = 'test.anonymous-growth-report';
beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  await db.admin.query(`CREATE TABLE public.anonymous_growth_authority (
    route integer NOT NULL,id uuid NOT NULL,eligible boolean NOT NULL DEFAULT true,
    revision integer NOT NULL DEFAULT 1,PRIMARY KEY(route,id))`);
  await db.admin.query(`CREATE TABLE public.anonymous_growth_report (
    route integer NOT NULL,id uuid NOT NULL,secret text NOT NULL,PRIMARY KEY(route,id))`);
  await db.admin.query('INSERT INTO public.anonymous_growth_authority(route,id) VALUES ($1,$2)', [
    authority.route,
    authority.id,
  ]);
});
afterAll(async () => {
  await db?.close();
});

test('actual anonymous helper and report executor stay bounded as same-authority ACLs and report history grow', async () => {
  let prepares = 0;
  let verifies = 0;
  const actor = { kind: 'anonymous' } as const;
  const access = createAccess({
    actions: new Map([[action, { anonymous: true }]]),
  });
  const eligibility = createResourceAnonymousEligibility({
    resource: authority,
    action,
    async prepare({ pool }) {
      prepares++;
      // H=1, a bounded route-owned container/revision point read, with no connection held.
      const row = (
        await pool.query('SELECT revision FROM public.anonymous_growth_authority WHERE route=$1 AND id=$2', [
          authority.route,
          authority.id,
        ])
      ).rows[0];
      return row ? { revision: row.revision, turnstile: { verified: true } } : null;
    },
    async verify({ client, evidence }) {
      verifies++;
      const row = (
        await client.query('SELECT eligible,revision FROM public.anonymous_growth_authority WHERE route=$1 AND id=$2', [
          authority.route,
          authority.id,
        ])
      ).rows[0];
      return !!row && row.eligible && row.revision === evidence.revision && evidence.turnstile.verified;
    },
  });
  const report = await checkGrowth(db, {
    name: 'Anonymous shared authorization and private report',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    scales: [1, 4, 16],
    repetitions: 3,
    warmups: 1,
    async grow(database, scale, previous) {
      const from = previous * 1024;
      const to = scale * 1024;
      const ids = Array.from({ length: to - from }, () => newId(authority.route));
      await database.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
        SELECT $1,id,'actor','active',$3 FROM unnest($2::uuid[]) id`,
        [authority.route, ids, transactionId],
      );
      await database.admin.query(
        `INSERT INTO access.resource_grant
        (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
        SELECT $1,$2,id,'',$4,'(,)',$5 FROM unnest($3::uuid[]) id`,
        [authority.route, authority.id, ids, action, transactionId],
      );
      await database.admin.query(
        `INSERT INTO access.resource_role_grant
        (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
        SELECT $1,$2,id,'','content.post.owner','(,)',$4 FROM unnest($3::uuid[]) id`,
        [authority.route, authority.id, ids, transactionId],
      );
      await database.admin.query(
        `INSERT INTO access.resource_denial
        (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
        SELECT $1,$2,id,'',$4,'resource','(,)',$5 FROM unnest($3::uuid[]) id`,
        [authority.route, authority.id, ids, action, transactionId],
      );
      await database.admin.query(
        'INSERT INTO public.anonymous_growth_authority(route,id) SELECT $1,id FROM unnest($2::uuid[]) id',
        [authority.route, ids],
      );
      await database.admin.query(
        "INSERT INTO public.anonymous_growth_report SELECT $1,id,'history' FROM unnest($2::uuid[]) id",
        [targetRoute, ids],
      );
      await database.admin.query(
        `INSERT INTO core.receipt
        (partition_no,principal_kind,principal_id,command_kind,idempotency_key,request_digest,epoch,position,transaction_id,response)
        SELECT $1,'anonymous',$2,$3,'00000000-0000-4000-8000-' || lpad(n::text,12,'0'),$4,1,1,$5,'{"secret":"history"}'::jsonb
        FROM generate_series($6::integer,$7::integer-1) n`,
        [partition, ANONYMOUS_PRINCIPAL_ID, kind, Buffer.alloc(32), transactionId, from, to],
      );
      await database.admin.query('VACUUM (ANALYZE)');
    },
    async operation(database) {
      const resource = { route: targetRoute, id: newId(targetRoute) };
      const deadline = Date.now() + 5000;
      const authorization = resourceAuthorization({
        access,
        actor,
        action,
        anchor: {
          resource: { ...authority, eligibility },
          async validate(client) {
            return (
              (
                await client.query('SELECT 1 FROM public.anonymous_growth_authority WHERE route=$1 AND id=$2', [
                  authority.route,
                  authority.id,
                ])
              ).rowCount === 1
            );
          },
        },
        context: { pool: database.pool, partition, deadline },
      });
      const options = {
        ...principalCommandIdentity(actor),
        partition,
        deadline,
        authorization,
        receipt: { kind, key: randomUUID().toUpperCase(), digest: Buffer.alloc(32) },
      };
      const first = await runCommand(database.pool, options, async (tx) => {
        await tx.query('INSERT INTO public.anonymous_growth_report VALUES ($1,$2,$3)', [
          resource.route,
          resource.id,
          'private',
        ]);
        return {
          value: { id: resource.id },
          events: [{ type: 'com.rezics.test.anonymous-growth-report.v1', data: {} }],
        };
      });
      expect(first.replayed).toBe(false);
      expect(
        await runCommand(database.pool, options, async () => {
          throw new Error('Replay ran effect');
        }),
      ).toEqual({ ...first, replayed: true });
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 4, 16]);
  expect(prepares).toBe(24);
  expect(verifies).toBe(24);
  for (const { cost } of report.samples) {
    expect(cost.relations?.['access.account']?.rows ?? 0).toBe(0);
    expect(cost.relations?.['public.anonymous_growth_authority']?.rows).toBe(6);
    expect(cost.relations?.['public.anonymous_growth_report']?.sequentialScans).toBe(0);
    expect(cost.relations?.['public.anonymous_growth_report']?.blocks).toBeGreaterThan(0);
    expect(cost.relations?.['access.resource_denial']).toBeDefined();
    expect(cost.statements).toBe(report.samples[0]!.cost.statements);
  }
  console.log(JSON.stringify({ name: report.name, samples: report.samples }));
}, 120_000);
