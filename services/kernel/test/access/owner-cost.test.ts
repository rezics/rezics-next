import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { resetGrowthTables } from './growth-reset.ts';
import { nodes, ownerCostFixture, type Plan } from './owner-cost-fixture.ts';

let f: Awaited<ReturnType<typeof ownerCostFixture>>;
let growth: GrowthDatabase;
beforeAll(async () => {
  growth = await openGrowthDatabase();
  f = await ownerCostFixture({ pool: growth.openPool(), reader: growth.openPool(), growth });
});
afterAll(async () => {
  if (f) await f.close();
  if (growth) await growth.close();
});

test('the owner guard and its lifecycle commands stay within constant rows and logarithmic blocks as members grow', async () => {
  async function resetCommandState() {
    await resetGrowthTables(growth.admin, [
      'core.receipt',
      'core.outbox',
      'editorial.write_basis',
      'access.lifecycle_coordination',
      'access.lifecycle_membership_slot',
      'access.membership_inverse',
      'access.membership_inverse_terminal',
    ]);
  }

  function assertPlanShape(plan: Plan) {
    // Count table/index visits, not rows passed through a Subquery Scan.
    const scans = nodes(plan).filter((node) => node['Relation Name'] || node['Index Name']);
    expect(scans).toHaveLength(2);
    expect(scans[0]!['Index Name']).toBe('organization_member_owner_probe');
    expect(scans[1]!['Index Cond']).toContain('member_account_id =');
    expect(scans.every((node) => /Index (Only )?Scan/.test(node['Node Type']))).toBe(true);
    for (const scan of scans) {
      expect(scan['Index Cond']).toContain('route =');
      expect(scan['Index Cond']).toContain('organization_id =');
      expect(scan['Index Cond']).toContain('valid @>');
    }
  }

  async function exercise(memberToChange: string, ownerToRemove: string) {
    const plans: Plan[] = [];
    for (const target of [f.actor, f.member, f.expired, f.absent]) {
      plans.push(await f.explain(target));
    }
    f.commandPlans.length = 0;
    await f.change(memberToChange, 'member');
    await f.change(ownerToRemove, null);
    await expect(f.tombstone()).rejects.toBeInstanceOf(LifecycleDeniedError);
    expect(f.commandPlans).toHaveLength(3);
    plans.push(...f.commandPlans);
    for (const plan of plans) assertPlanShape(plan);
  }

  const report = await checkGrowth(growth, {
    name: 'the owner guard and its lifecycle commands stay within constant rows and logarithmic blocks as members grow',
    scales: [64, 512, 4096],
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_database, scale) {
      await f.seed(scale, undefined, async () => {
        const holder = new pg.Client({ connectionString: growth.url, application_name: 'owner-growth-snapshot' });
        await holder.connect();
        await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await holder.query('SELECT count(*) FROM access.organization_member');
        return async () => {
          await holder.query('COMMIT');
          await holder.end();
        };
      });
    },
    async warmup(_database, scale) {
      await exercise(f.owners[2]!, f.owners[3]!);
      await resetCommandState();
      await f.seed(scale);
    },
    async operation(_database, scale) {
      await exercise(f.member, f.owners[1]!);
      await resetCommandState();
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 30000);

test('zero, one and many owner outcomes distinguish owners from current and expired members', async () => {
  for (const count of [0, 1, 4]) {
    await f.seed(64, count);
    expect(await f.read(f.actor)).toEqual({ owners: Math.min(count, 2), target: count > 0 ? 1 : 0 });
    for (const target of [f.member, f.expired, f.absent]) {
      expect(await f.read(target)).toEqual({ owners: Math.min(count, 2), target: 0 });
    }
  }
  // Every owner is recognized, including those outside the bounded owner pair.
  for (const owner of f.owners) expect(await f.read(owner)).toEqual({ owners: 2, target: 1 });
  // Current means the exact half-open validity interval, including its start.
  expect(await f.read(f.actor, '2025-01-01T00:00:00Z')).toEqual({ owners: 2, target: 1 });
  expect(await f.read(f.actor, '2024-12-31T23:59:59Z')).toEqual({ owners: 0, target: 0 });
  expect(await f.read(f.expired, '2000-01-01T01:00:00Z')).toEqual({ owners: 2, target: 1 });
  expect(await f.read(f.expired, '2000-01-01T01:30:00Z')).toEqual({ owners: 0, target: 0 });
  await f.seed(64, 1);
  for (const role of ['member', null] as const) {
    await expect(f.change(f.actor, role)).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  await expect(f.tombstone()).rejects.toBeInstanceOf(LifecycleDeniedError);
  await f.change(f.member, 'member');
  await f.change(f.member, null);
  await f.change(f.owners[1]!, 'owner');
  await f.change(f.actor, null);
  const observation = await f.reader.query<{ at: string }>('SELECT clock_timestamp()::text AS at');
  expect(await f.read(f.owners[1]!, observation.rows[0]!.at)).toEqual({ owners: 1, target: 1 });
  await expect(f.change(f.owners[1]!, null)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await f.seed(64, 0);
  await expect(f.change(f.member, 'owner')).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect((await f.tombstone()).value.accountId).toBe(f.organizationId);
});
