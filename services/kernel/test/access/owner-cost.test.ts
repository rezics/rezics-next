import { afterAll, beforeAll, expect, test } from 'bun:test';
import { LifecycleDeniedError } from '../../src/access/lifecycle.ts';
import { nodes, ownerCostFixture, type Plan } from './owner-cost-fixture.ts';

let f: Awaited<ReturnType<typeof ownerCostFixture>>;
beforeAll(async () => {
  f = await ownerCostFixture();
});
afterAll(async () => {
  if (f) await f.close();
});

test('the real owner guard has constant examined rows and logarithmic buffers at three scales', async () => {
  const measurements: { scale: number; label: string; buffers: number; examined: number; scans: Plan[] }[] = [];
  function record(scale: number, label: string, plan: Plan) {
    // Count table/index visits, not rows passed through a Subquery Scan.
    const scans = nodes(plan).filter((node) => node['Relation Name'] || node['Index Name']);
    const examined = scans.reduce(
      (sum, node) =>
        sum +
        node['Actual Loops'] *
          (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)),
      0,
    );
    const buffers = (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
    measurements.push({ scale, label, buffers, examined, scans });
    console.info('owner guard EXPLAIN', { scale, label, buffers, examined });
  }
  for (const scale of [64, 512, 4096]) {
    await f.seed(scale);
    for (const target of [f.actor, f.member, f.expired, f.absent]) {
      record(scale, target, await f.explain(target));
    }
    f.commandPlans.length = 0;
    await f.change(f.member, 'member');
    await f.change(f.owners[1]!, null);
    await expect(f.tombstone()).rejects.toBeInstanceOf(LifecycleDeniedError);
    expect(f.commandPlans).toHaveLength(3);
    f.commandPlans.forEach((plan, index) => record(scale, `command-${index}`, plan));
  }
  for (const { scans, examined } of measurements) {
    expect(examined).toBeLessThanOrEqual(3);
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
  for (const baseline of measurements.filter((sample) => sample.scale === 64)) {
    for (const sample of measurements.filter((sample) => sample.label === baseline.label)) {
      // A native tree needs only O(log R) page visits. Allow four extra pages
      // per doubling (two probes, internal/leaf pages), never a linear factor.
      expect(sample.buffers).toBeLessThanOrEqual(baseline.buffers + 4 * Math.log2(sample.scale / baseline.scale));
      expect(sample.examined).toBe(baseline.examined);
    }
  }
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
