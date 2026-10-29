import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/permission.ts';
import { accessCheck, type AccountActor, type Resource } from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const action = 'moderation:takedown';
const actorId = newId(0x2345);
const actorRoute = routeOf(actorId)!;
const target: Resource = { route: 0x6789, id: newId(0x6789) };
const globalId = '00000000-0000-8000-8000-000000000000';
const globalTransaction = newId(0);
const unrelatedResources: string[] = [];
const unrelatedAccounts: string[] = [];
let database: GrowthDatabase;
let actor: AccountActor;
let account: NonNullable<Awaited<ReturnType<typeof readAccount>>>;
const access = createAccess({
  actions: new Map([[action, { anonymous: false }]]),
  accountEvidence: (_actor, context) => context.account,
});

beforeAll(async () => {
  database = await openGrowthDatabase();
  await database.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [actorRoute, actorId],
  );
  account = (await readAccount(database.admin, actorRoute, actorId))!;
  actor = {
    kind: 'account',
    accountId: actorId,
    clientId: 'growth-client',
    scopes: [action],
    requestedBy: null,
    authnEpoch: 1,
  };
  await database.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES (0,$1,$2,$3,'(,)',$4)`,
    [globalId, actorId, action, globalTransaction],
  );
}, 30_000);

afterAll(async () => {
  if (!database) return;
  await database.admin.query('DELETE FROM access.resource_grant WHERE subject_id=$1 OR resource_id=ANY($2::uuid[])', [
    actorId,
    [...unrelatedResources, globalId],
  ]);
  await database.admin.query('DELETE FROM access.account WHERE account_id=ANY($1::uuid[])', [
    [actorId, ...unrelatedAccounts],
  ]);
  await database.close();
});

test('checkGrowth keeps Global authorization bounded as unrelated resources, grants and accounts grow', async () => {
  const report = await checkGrowth(database, {
    name: 'platform governance reach',
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    rule: 'series',
    async grow(growthDatabase, scale, previous) {
      if (previous === 0) {
        const baselineResources = Array.from({ length: 4096 }, () => newId(target.route));
        const baselineAccounts = Array.from({ length: 4096 }, () => newId(0x4567));
        unrelatedResources.push(...baselineResources);
        unrelatedAccounts.push(...baselineAccounts);
        await growthDatabase.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
           SELECT $1,resource_id,$2,$3,'(,)',$4 FROM unnest($5::uuid[]) AS resource_id`,
          [target.route, actorId, action, globalTransaction, baselineResources],
        );
        await growthDatabase.admin.query(
          `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
           SELECT $1,account_id,'actor','active',account_id FROM unnest($2::uuid[]) AS account_id`,
          [0x4567, baselineAccounts],
        );
        await growthDatabase.admin.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
           SELECT 0,$1,account_id,$2,'(,)',account_id FROM unnest($3::uuid[]) AS account_id`,
          [globalId, action, baselineAccounts],
        );
      }
      const count = (scale - previous) * 25;
      const resources = Array.from({ length: count }, () => newId(target.route));
      const accounts = Array.from({ length: count }, () => newId(0x4567));
      unrelatedResources.push(...resources);
      unrelatedAccounts.push(...accounts);
      await growthDatabase.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         SELECT $1,resource_id,$2,$3,'(,)',$4 FROM unnest($5::uuid[]) AS resource_id`,
        [target.route, actorId, action, globalTransaction, resources],
      );
      await growthDatabase.admin.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
         SELECT $1,account_id,'actor','active',account_id FROM unnest($2::uuid[]) AS account_id`,
        [0x4567, accounts],
      );
      await growthDatabase.admin.query(
        `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
         SELECT 0,$1,account_id,$2,'(,)',account_id FROM unnest($3::uuid[]) AS account_id`,
        [globalId, action, accounts],
      );
      await growthDatabase.admin.query('ANALYZE access.resource_grant');
      await growthDatabase.admin.query('ANALYZE access.account');
    },
    async operation(growthDatabase) {
      const context = { pool: growthDatabase.pool, deadline: Date.now() + 10_000, account };
      const check = await accessCheck(access, actor, action, target, context);
      expect(await check(growthDatabase.pool)).toBe(true);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
  expect(new Set(report.samples.map(({ cost }) => cost.statements)).size).toBe(1);
  const observed = await capture(database, async () => {
    const context = { pool: database.pool, deadline: Date.now() + 10_000, account };
    const check = await accessCheck(access, actor, action, target, context);
    expect(await check(database.pool)).toBe(true);
  });
  const nodes: Record<string, unknown>[] = [];
  const collectNodes = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collectNodes);
    else if (typeof value === 'object' && value !== null) {
      const node = value as Record<string, unknown>;
      if (typeof node['Node Type'] === 'string') nodes.push(node);
      Object.values(node).forEach(collectNodes);
    }
  };
  collectNodes(observed.capture.plans);
  const grantScans = nodes.filter(
    (node) => node['Relation Name'] === 'resource_grant' &&
      ['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(String(node['Node Type'])),
  );
  expect(grantScans.length).toBeGreaterThan(0);
  expect(grantScans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);
  const temporalGrantProbes = grantScans.filter((node) => node['Index Name'] === 'resource_grant_pkey');
  expect(temporalGrantProbes.length).toBeGreaterThan(0);
  expect(temporalGrantProbes.every((node) => String(node['Index Cond']).includes('valid @>'))).toBe(true);
}, 90_000);
