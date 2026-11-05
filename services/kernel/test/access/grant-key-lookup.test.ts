import { expect, test } from 'bun:test';
import permission from '../../src/access/permission-check.sql';
import candidates from '../../src/access/permission-candidates.sql';
import governance from '../../src/access/governance-reach-candidates.sql';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../support/growth.ts';

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [...('Node Type' in node ? [node] : []), ...Object.values(node).flatMap(nodes)];
}

test('grant permission probes seek one exact-key predecessor across unrelated and same-key history', async () => {
  const db = await openGrowthDatabase();
  const resource = '00000000-0000-8000-8000-000000000000';
  const actor = newId(0);
  const transaction = newId(0);
  const input = {
    route: 0,
    resource_ids: [resource],
    action: 'organization:create',
    actor_id: actor,
    principal_id: '',
    roles: [{ account_id: actor, organization_id: actor, role: 'owner', member: true, valid: '(,)' }],
    grant_roles: [],
  };
  async function probe(at: string, allowed: boolean) {
    const result = await permission.run(db.pool, {
      ...input,
      at,
      include_global: false,
      anonymous: false,
      floor: false,
      deadline: 'infinity',
    });
    expect(result).toMatchObject([{ resourceId: resource, allowed }]);
    for (const statement of [candidates, governance]) {
      expect(await statement.run(db.pool, { ...input, at })).toEqual(
        allowed ? [{ accountId: actor, organizationId: actor }] : [],
      );
    }
  }
  async function assertProbe(database: typeof db, scale: number) {
    const observed = await capture(database, () => probe('2030-01-01T12:00:00Z', true));
    const scans = nodes(observed.capture.plans).filter(
      (node) => node['Relation Name'] === 'resource_grant' && Number(node['Actual Loops']) > 0,
    );
    expect(scans.length).toBeGreaterThan(0);
    for (const node of scans) {
      expect(node['Node Type'], JSON.stringify({ scale, scans })).toBe('Index Only Scan');
      expect(node['Index Name'], JSON.stringify({ scale, scans })).toBe('resource_grant_pkey_lookup');
      const condition = String(node['Index Cond']);
      // Both lexicographic bounds have the identical exact subject/action prefix.
      // Empty is below every stored nonempty range; the upper bound ends at T.
      const key = 'ROW(g.subject_kind, g.subject_id, g.subject_role, g.action, g.valid)';
      expect(condition, JSON.stringify({ scale, scans })).toContain(`${key} >= ROW(`);
      expect(condition, JSON.stringify({ scale, scans })).toContain(`${key} <= ROW(`);
      for (const key of ['k.subject_kind', 'k.subject_id', 'k.subject_role', "'organization:create'::text"])
        expect(condition.split(key).length - 1, JSON.stringify({ scale, scans })).toBe(2);
      expect(condition, JSON.stringify({ scale, scans })).toContain("'empty'::tstzrange");
      expect(condition, JSON.stringify({ scale, scans })).toContain('tstzrange(');
      expect(node['Actual Rows'], JSON.stringify({ scale, scans })).toBeLessThanOrEqual(1);
      expect(node['Rows Removed by Filter'] ?? 0, JSON.stringify({ scale, scans })).toBe(0);
    }
  }
  try {
    const indexes = await db.admin.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'access' AND indexname = 'resource_grant_pkey_lookup'",
    );
    expect(indexes.rows[0]?.indexdef).toContain(
      "WHERE ((route = 0) AND (resource_id = '00000000-0000-8000-8000-000000000000'::uuid))",
    );
    await db.admin.query(
      `INSERT INTO access.resource_grant
       (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
       SELECT 0,$1,$2,role,'organization:create',valid::tstzrange,$3
       FROM unnest(ARRAY['','owner']) role CROSS JOIN unnest(ARRAY[
         '(,1899-01-01)', '[2030-01-01,2030-01-02)', '[2030-01-03,2030-01-04)', '[2200-01-01,)'
       ]) valid`,
      [resource, actor, transaction],
    );
    const report = await checkGrowth(db, {
      name: 'exact grant key predecessor',
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        // The smallest population is already indexed. Grow unrelated principals
        // on the same Global resource, other resources, and both past and future
        // intervals of the exact measured direct and organization-role keys.
        await database.admin.query(
          `INSERT INTO access.resource_grant
           (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
           SELECT 0,$1::uuid,gen_random_uuid(),'','organization:create','(,)'::tstzrange,$3::uuid
           FROM generate_series($4::integer,$5::integer-1) n
           UNION ALL
           SELECT 0,$6::uuid,$2::uuid,'','organization:create','(,)'::tstzrange,$3::uuid
           UNION ALL
           SELECT 0,$1::uuid,$2::uuid,role,'organization:create',
             tstzrange(start+n*interval '1 minute',start+(n+1)*interval '1 minute','[)'),$3::uuid
           FROM generate_series($4::integer,$5::integer-1) n
           CROSS JOIN unnest(ARRAY['','owner']) role
           CROSS JOIN unnest(ARRAY['1900-01-01'::timestamptz,'2100-01-01'::timestamptz]) start`,
          [resource, actor, transaction, previous * 256, scale * 256, newId(0)],
        );
        await database.admin.query('VACUUM ANALYZE access.resource_grant');
        await assertProbe(database, scale);
      },
      prepare: assertProbe,
      operation: () => probe('2030-01-01T12:00:00Z', true),
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 8, 64]);
    for (const [at, allowed] of [
      ['-infinity', true],
      ['1899-01-01T00:00:00Z', false],
      ['2029-12-31T00:00:00Z', false],
      ['2030-01-01T00:00:00Z', true],
      ['2030-01-02T00:00:00Z', false],
      ['2030-01-03T00:00:00Z', true],
      ['2030-01-04T00:00:00Z', false],
      ['2199-12-31T00:00:00Z', false],
      ['2200-01-01T00:00:00Z', true],
      ['infinity', true],
    ] as const)
      await probe(at, allowed);
  } finally {
    await db.close();
  }
}, 120000);
