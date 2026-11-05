import { expect, test } from 'bun:test';
import candidates from '../../src/access/permission-candidates.sql';
import permission from '../../src/access/permission-check.sql';
import {
  readCurrentResourceRolePage,
  verifyCurrentResourceRoleFrontier,
} from '../../src/access/current-resource-roles.ts';
import { advanceCurrentResourceRoles } from '../../src/access/current-resource-roles-work.ts';
import { mintReadTime } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase } from '../support/growth.ts';

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [...('Node Type' in node ? [node] : []), ...Object.values(node).flatMap(nodes)];
}

test('real native role permission seeks skip interval history with a semantic predecessor bound', async () => {
  const db = await openGrowthDatabase();
  const resource = newId(0x4678),
    actor = newId(0),
    transaction = newId(0);
  const input = {
    route: 0x4678,
    resource_ids: [resource],
    action: 'subject:read',
    actor_id: actor,
    principal_id: '',
    roles: [{ account_id: actor, organization_id: actor, role: 'owner', member: true, valid: '(,)' }],
    grant_roles: ['semantic.context.owner'],
  };
  async function probe(at: string, allowed: boolean) {
    expect(
      await permission.run(db.pool, {
        ...input,
        at,
        include_global: false,
        anonymous: false,
        floor: false,
        deadline: 'infinity',
      }),
    ).toMatchObject([{ resourceId: resource, allowed }]);
    expect(await candidates.run(db.pool, { ...input, at })).toEqual(
      allowed ? [{ accountId: actor, organizationId: actor }] : [],
    );
  }
  try {
    await db.admin.query(
      `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
      SELECT $1,$2,$3,role,'semantic.context.owner',valid::tstzrange,$4
      FROM unnest(ARRAY['','owner']) role CROSS JOIN unnest(ARRAY[
        '(,1899-01-01)', '[2030-01-01,2030-01-02)', '[2030-01-03,2030-01-04)', '[2200-01-01,)'
      ]) valid`,
      [input.route, resource, actor, transaction],
    );
    const report = await checkGrowth(db, {
      name: 'native role exact-key lower-bound history',
      scales: [256, 1024, 4608],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        await database.admin.query(
          `INSERT INTO access.resource_role_grant
          (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
          SELECT $1,$2,$3,role,'semantic.context.owner',
            tstzrange(start+n*interval '1 minute',start+(n+1)*interval '1 minute','[)'),$4
          FROM generate_series($5::integer,$6::integer-1) n CROSS JOIN unnest(ARRAY['','owner']) role
          CROSS JOIN unnest(ARRAY['1900-01-01'::timestamptz,'2100-01-01'::timestamptz]) start`,
          [input.route, resource, actor, transaction, previous, scale],
        );
      },
      async prepare(database) {
        const measured = await capture(database, async () => {
          await probe('2030-01-01T12:00:00Z', true);
          await probe('2030-01-02T00:00:00Z', false);
        });
        const scans = nodes(measured.capture.plans).filter(
          (node) => node['Relation Name'] === 'resource_role_grant' && Number(node['Actual Loops']) > 0,
        );
        expect(scans.length).toBeGreaterThan(0);
        for (const scan of scans) {
          expect(scan['Index Name']).toBe('resource_role_grant_predecessor');
          expect(String(scan['Index Cond'])).toContain('COALESCE(lower(valid)');
          expect(scan['Actual Rows']).toBeLessThanOrEqual(1);
          expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
        }
      },
      async operation() {
        await probe('2030-01-01T12:00:00Z', true);
        await probe('2030-01-02T00:00:00Z', false);
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([256, 1024, 4608]);
    expect(report.samples.every((sample) => sample.cost.statements === 4)).toBe(true);
    for (const [at, allowed] of [
      ['-infinity', true],
      ['1899-01-01', false],
      ['2029-12-31', false],
      ['2030-01-01', true],
      ['2030-01-02', false],
      ['2030-01-03', true],
      ['2030-01-04', false],
      ['2199-12-31', false],
      ['2200-01-01', true],
      ['infinity', true],
    ] as const)
      await probe(at, allowed);
    // The actual Access schema guarantees inclusive finite starts and exclusive finite ends.
    // Do not silently broaden this assumption if the schema is changed later.
    for (const valid of ['(2040-01-01,2040-01-02)', '[2040-01-01,2040-01-02]', '[2030-01-01,2030-01-02)']) {
      await expect(
        db.admin.query(
          `INSERT INTO access.resource_role_grant
        (route,resource_id,subject_id,grant_role,valid,transaction_id)
        VALUES ($1,$2,$3,'semantic.context.owner',$4,$5)`,
          [input.route, resource, actor, valid, transaction],
        ),
      ).rejects.toThrow();
    }
  } finally {
    await db.close();
  }
}, 180000);

test('a complete current-role key access path never certifies stale or unknown roster absence', async () => {
  const db = await openGrowthDatabase();
  const resource = { route: 0x4679, id: newId(0x4679) };
  const roles = ['semantic.context.owner'];
  const input = { resource, roles, at: await mintReadTime(db.pool), after: null, limit: 1 };
  try {
    // A genuinely unknown resource is not an initialized empty roster.
    expect(await readCurrentResourceRolePage(db.pool, input)).toEqual({ status: 'unavailable' });
    const subjects = [newId(0), newId(0), newId(0)];
    await db.admin.query(
      `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
      SELECT $1,$2,subject,role,'semantic.context.owner','(,)'::tstzrange,$3
      FROM unnest($4::uuid[],ARRAY['','owner','member']) AS s(subject,role)`,
      [resource.route, resource.id, newId(0), subjects],
    );
    while (
      !(
        await db.admin.query<{ complete: boolean }>(
          'SELECT complete FROM access.current_resource_role_install WHERE singleton',
        )
      ).rows[0]!.complete
    )
      await advanceCurrentResourceRoles(db.pool);
    const first = await readCurrentResourceRolePage(db.pool, input);
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') throw new Error('Known installed resource must be ready');
    expect(first.rows).toHaveLength(1);
    expect(first.after).not.toBeNull();
    const second = await readCurrentResourceRolePage(db.pool, { ...input, after: first.after });
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') throw new Error('Stable native continuation must resume');
    expect(second.rows[0]!.intervalKey).not.toBe(first.rows[0]!.intervalKey);
    const third = await readCurrentResourceRolePage(db.pool, { ...input, after: second.after });
    expect(third.status).toBe('ready');
    if (third.status !== 'ready') throw new Error('Complete roster must remain ready');
    expect(third.after).toBeNull();
    expect([...first.rows, ...second.rows, ...third.rows].map((row) => row.subjectRole).sort()).toEqual([
      '',
      'member',
      'owner',
    ]);
    expect(
      await verifyCurrentResourceRoleFrontier(db.pool, { resource, frontier: first.frontier, at: input.at }),
    ).toEqual({ status: 'ready' });
    await db.admin.query('DELETE FROM access.resource_role_grant WHERE resource_id=$1', [resource.id]);
    expect(await readCurrentResourceRolePage(db.pool, { ...input, after: first.after })).toEqual({
      status: 'unavailable',
    });
    expect(
      await verifyCurrentResourceRoleFrontier(db.pool, { resource, frontier: first.frontier, at: input.at }),
    ).toEqual({ status: 'unavailable' });
    expect(await readCurrentResourceRolePage(db.pool, input)).toMatchObject({ status: 'ready', rows: [], after: null });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE access.current_resource_role_install SET complete=false WHERE singleton');
      expect(await readCurrentResourceRolePage(client, input)).toEqual({ status: 'unavailable' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  } finally {
    await db.close();
  }
});

test('future start and finite end invalidate the frontier until default bounded catch-up processes them', async () => {
  const db = await openGrowthDatabase();
  const resource = { route: 0x4680, id: newId(0x4680) };
  const roles = ['semantic.context.owner'];
  try {
    await db.admin.query(
      `INSERT INTO access.resource_role_grant
      (route,resource_id,subject_id,grant_role,valid,transaction_id)
      VALUES ($1,$2,$3,$4,'[2050-01-01,2050-01-02)'::tstzrange,$5)`,
      [resource.route, resource.id, newId(0), roles[0], newId(0)],
    );
    while (
      !(
        await db.admin.query<{ complete: boolean }>(
          'SELECT complete FROM access.current_resource_role_install WHERE singleton',
        )
      ).rows[0]!.complete
    )
      await advanceCurrentResourceRoles(db.pool);
    const at = await mintReadTime(db.pool, () => new Date('2050-01-02T00:00:00Z'));
    const input = { resource, roles, at, after: null, limit: 100 };
    const before = await readCurrentResourceRolePage(db.pool, { ...input, at: await mintReadTime(db.pool) });
    expect(before.status).toBe('ready');
    if (before.status !== 'ready') throw new Error('Future role must have a ready pre-start frontier');
    expect(before.rows).toEqual([]);
    expect(before.frontier.validUntil).not.toBeNull();
    // Both boundaries invalidate readiness at equality until their actual native work is processed.
    const start = await mintReadTime(db.pool, () => new Date('2050-01-01T00:00:00Z'));
    expect(await readCurrentResourceRolePage(db.pool, { ...input, at: start })).toEqual({ status: 'unavailable' });
    expect(await readCurrentResourceRolePage(db.pool, input)).toEqual({ status: 'unavailable' });
    await db.admin.query("SELECT access.advance_current_resource_roles('2050-01-01'::timestamptz)");
    const during = await readCurrentResourceRolePage(db.pool, { ...input, at: start });
    expect(during).toMatchObject({ status: 'ready', rows: [expect.objectContaining({ grantRole: roles[0] })] });
    expect(await readCurrentResourceRolePage(db.pool, input)).toEqual({ status: 'unavailable' });
    await db.admin.query("SELECT access.advance_current_resource_roles('2050-01-02'::timestamptz)");
    expect(await readCurrentResourceRolePage(db.pool, input)).toMatchObject({ status: 'ready', rows: [] });
    expect(await verifyCurrentResourceRoleFrontier(db.pool, { resource, frontier: before.frontier, at })).toEqual({
      status: 'unavailable',
    });
  } finally {
    await db.close();
  }
});
