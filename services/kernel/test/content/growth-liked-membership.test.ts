import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { readLikedMembership } from '../../src/content/liked-read.ts';
import membershipSql from '../../src/content/liked-membership.sql';
import { newId, routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth, measure } from '../support/growth.ts';
import { explainPlanEntries, walkPlanTree, type PlanNode } from '../support/growth-plan-walk.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  createMembershipGrowthFixture,
  membershipScales,
  membershipVersion,
  type MembershipAxis,
} from './support/growth-liked-membership-fixture.ts';

type Fixture = Awaited<ReturnType<typeof createMembershipGrowthFixture>>;

/** Inspect the actual caller query's native auto_explain notice; never replay SQL with EXPLAIN. */
async function membership(f: Fixture, ids: readonly string[], actorId = f.actorId) {
  const observer = observeSql(f.db.pool);
  const client = await f.db.pool.connect();
  const plans: PlanNode[] = [];
  const notice = (message: { readonly message?: string | undefined }) => {
    const marker = 'plan:\n';
    if (!message.message?.startsWith('duration:') || !message.message.includes(marker)) return;
    const document: unknown = JSON.parse(message.message.slice(message.message.indexOf(marker) + marker.length));
    for (const entry of explainPlanEntries(document)) plans.push(entry.plan);
  };
  client.on('notice', notice);
  try {
    const value = await readLikedMembership(client, { actorAccountId: actorId, subjectIds: ids });
    expect(observer.records).toHaveLength(1);
    const execution = observer.records[0]!;
    expect(execution.statement).toBe(membershipSql.sql);
    expect(execution.parameters[membershipSql.params.indexOf('actor_id')]).toBe(actorId);
    expect(execution.parameters[membershipSql.params.indexOf('target_ids')]).toEqual([...new Set(ids)]);
    expect(plans).toHaveLength(1);
    const nodes = [...walkPlanTree(plans[0]!)].map(({ node }) => node);
    const scans = nodes.filter((node) => node['Relation Name'] === 'reaction');
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    const k = new Set(ids).size;
    expect(scan['Actual Loops']).toBe(k);
    if (k > 0) {
      expect(['Index Scan', 'Index Only Scan']).toContain(String(scan['Node Type']));
      // A seek must bind the entire primary key, rather than scan the actor's eligible set.
      for (const column of ['route', 'actor_account_id', 'target_id'])
        expect(String(scan['Index Cond'])).toContain(column);
      expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(1);
      expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(1);
    }
    return value;
  } finally {
    client.off('notice', notice);
    client.release();
    await observer.close();
  }
}

for (const axis of ['other-actors', 'same-actor-history'] as const satisfies readonly MembershipAxis[]) {
  test(`Liked membership fixed batches stay indexed as ${axis} grows independently`, async () => {
    const f = await createMembershipGrowthFixture();
    try {
      const selected = new Set([f.liked, f.loved]);
      const small = [f.liked, f.loved, f.laughed, f.otherOnly, f.absent, f.liked];
      const full = [...small.slice(0, 5), ...Array.from({ length: 251 }, () => newId(routeOf(f.liked)!))];
      const cases = [
        { name: 'small', ids: small, expected: selected },
        { name: '256', ids: full, expected: selected },
        { name: 'no matches', ids: [f.laughed, f.otherOnly, f.absent], expected: new Set<string>() },
        { name: 'empty input with nonempty actor source', ids: [], expected: new Set<string>() },
      ];
      for (const item of cases) {
        await f.resetNoise();
        const report = await checkGrowth(f.db, {
          name: `Liked membership ${axis}, ${item.name}`,
          scales: membershipScales,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          rule: 'series',
          // One complete-key descent per deduplicated ID, plus the source-version lookup.
          indexProbes: new Set(item.ids).size + 1,
          async grow(_db, scale, previous) {
            expect(await f.grow(axis, scale, previous)).toEqual({
              reactions: scale,
              actors: axis === 'other-actors' ? scale : 1,
              receipts: axis === 'same-actor-history' ? scale : 0,
              events: axis === 'same-actor-history' ? scale : 0,
              basis: axis === 'same-actor-history' ? scale : 0,
            });
          },
          async operation() {
            const value = await membership(f, item.ids);
            expect(value.subjects).toEqual(item.expected);
            expect(value.version).toBe(membershipVersion);
            expect(typeof value.version).toBe('bigint');
          },
        });
        expect(report.samples.map(({ scale }) => scale)).toEqual([...membershipScales]);
        for (const sample of report.samples) {
          for (const cost of sample.repetitions) {
            expect(cost.statements).toBe(1);
            expect(cost.backgroundStatements ?? 0).toBe(0);
            expect(cost.backgroundRows ?? 0).toBe(0);
            expect(cost.backgroundBlocks ?? 0).toBe(0);
            const reaction = cost.relations['content.reaction'];
            if (reaction) {
              expect(reaction.rows).toBeLessThanOrEqual(new Set(item.ids).size);
              expect(reaction.sequentialScans).toBe(0);
            }
          }
          console.info(JSON.stringify({
            operation: report.name, scale: sample.scale, version: membershipVersion.toString(),
            requested: item.ids, rows: sample.cost.rows, blocks: sample.cost.blocks,
            statements: sample.cost.statements, relations: sample.cost.relations,
            verdicts: report.verdicts,
          }));
        }
        assertGrowthAccessPaths(report.name, report.samples, [
          'content.reaction_liked_version',
          ...(item.ids.length ? ['content.reaction'] : []),
        ]);
      }
      // An unseen source version stays a bigint baseline, without asserting permission or completeness.
      const baseline = await measure(f.db, () => membership(f, [], f.baselineActorId));
      expect(baseline.value).toEqual({ subjects: new Set(), version: 0n });
      expect(baseline.cost.statements).toBe(1);
      const guard = await measure(f.db, async () => {
        const client: PoolClient = await f.db.pool.connect();
        try {
          await expect(readLikedMembership(client, {
            actorAccountId: f.actorId, subjectIds: Array(257).fill(f.liked),
          })).rejects.toThrow('At most 256 liked membership ids');
        } finally { client.release(); }
      });
      expect(guard.cost.statements).toBe(0);
    } finally { await f.close(); }
  }, 1_200_000);
}
