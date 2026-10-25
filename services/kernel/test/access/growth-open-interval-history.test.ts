import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

await import('reylo/register');
const { default: record } = await import('../../src/access/resource-denial-record.sql');
const { default: end } = await import('../../src/access/resource-denial-end.sql');
const { default: grant } = await import('../../src/access/resource-group-grant.sql');

let db: GrowthDatabase;
const route = 0x3b12;
const key = {
  route,
  resource_id: newId(route),
  subject_id: newId(route),
  subject_role: '',
  action: 'realm:participate',
  reason: 'realm_ban',
  grant_role: 'realm.member',
  transaction_id: Bun.randomUUIDv7(),
};
const groupKey = { ...key, subject_role: 'member' };
const scaleValues = [1, 8, 64] as const;
const historyStart = Date.parse('2029-12-31T22:00:00Z');
const unrelatedAt = '2030-01-01T00:00:00Z';
const tables = ['resource_denial', 'resource_role_grant'] as const;
type Table = (typeof tables)[number];
type Statistics = 'analyze after growth' | 'leave growth unanalyzed';

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
});
afterAll(async () => db?.close());

function at(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

async function seedUnrelated(table: Table, count: number) {
  const columns = table === 'resource_denial' ? 'action, reason' : 'subject_kind, grant_role';
  const values = table === 'resource_denial' ? "'realm:participate', 'realm_ban'" : "'identity', 'realm.member'";
  await db.admin.query(
    `INSERT INTO access.${table}
      (route, resource_id, subject_id, subject_role, ${columns}, valid, transaction_id)
     SELECT $1, $2, gen_random_uuid(), $3, ${values}, '(,)'::tstzrange, $4
     FROM generate_series(1, $5::integer) n`,
    [route, key.resource_id, table === 'resource_denial' ? '' : 'member', key.transaction_id, count],
  );
}

async function addDenialCycle(start: number) {
  expect((await record.run(db.admin, { ...key, at: at(start) })).outcome).toBe('inserted');
  expect((await end.run(db.admin, { ...key, at: at(start + 1000) })).outcome).toBe('closed');
}

async function rolledBack(operation: (client: PoolClient) => Promise<void>) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await operation(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function planNodes(value: unknown, nodes: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) planNodes(child, nodes);
  } else if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    if (typeof object['Node Type'] === 'string') nodes.push(object);
    for (const child of Object.values(object)) planNodes(child, nodes);
  }
  return nodes;
}

function expectIndexedOpenLookup(plans: readonly unknown[], table: Table) {
  const nodes = planNodes(plans);
  const relationScans = nodes.filter(
    (node) =>
      node['Relation Name'] === table &&
      ['Seq Scan', 'Index Scan', 'Index Only Scan', 'Bitmap Heap Scan'].includes(String(node['Node Type'])),
  );
  expect(relationScans.length).toBeGreaterThan(0);
  expect(relationScans.every((node) => node['Node Type'] !== 'Seq Scan')).toBe(true);

  const indexes = nodes.filter(
    (node) => typeof node['Index Name'] === 'string' && String(node['Index Name']).startsWith(`${table}_`),
  );
  expect(indexes.length).toBeGreaterThan(0);
  for (const node of indexes) {
    const index = String(node['Index Name']);
    const allowed = [
      `${table}_open`,
      `${table}_pkey`,
      ...(table === 'resource_denial' ? ['resource_denial_permission'] : []),
    ];
    expect(allowed).toContain(index);
    if (index !== `${table}_open`) {
      const condition = String(node['Index Cond'] ?? '');
      expect(condition).toContain('valid');
      expect(condition).toContain('@>');
    }
  }
}

async function checkDenialHistory(statistics: Statistics) {
  const table = 'resource_denial';
  await db.admin.query(`TRUNCATE access.${table}`);
  await seedUnrelated(table, 4096);
  await db.admin.query(`VACUUM (ANALYZE) access.${table}`);

  let cursor = historyStart;
  let openAt: number | undefined;
  const times = new Map<number, string>();
  const operation = (scale: number) =>
    rolledBack(async (client) => {
      const measuredAt = times.get(scale)!;
      expect((await record.run(client, { ...key, at: measuredAt })).outcome).toBe('open');
      expect((await end.run(client, { ...key, at: at(Date.parse(measuredAt) + 1000) })).outcome).toBe('closed');
      const nextAt = at(Date.parse(measuredAt) + 2000);
      expect((await record.run(client, { ...key, at: nextAt })).outcome).toBe('inserted');
      expect((await record.run(client, { ...key, at: nextAt })).outcome).toBe('open');
    });

  const report = await checkGrowth(db, {
    name: `denial closed history (${statistics})`,
    scales: scaleValues,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    slack: { rows: { absolute: 0, relative: 0 } },
    async grow(_database, scale, previous) {
      if (openAt !== undefined) {
        const closeAt = openAt + 1000;
        expect((await end.run(db.admin, { ...key, at: at(closeAt) })).outcome).toBe('closed');
        cursor = closeAt + 1000;
      }
      for (let count = previous; count < scale; count++) {
        await addDenialCycle(cursor);
        cursor += 2000;
      }
      openAt = cursor + 1000;
      times.set(scale, at(openAt));
      expect((await record.run(db.admin, { ...key, at: at(openAt) })).outcome).toBe('inserted');
      cursor = openAt;
      if (statistics === 'analyze after growth') await db.admin.query(`VACUUM (ANALYZE) access.${table}`);
    },
    operation: (_database, scale) => operation(scale),
  });

  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(4);
    expect(cost.statements).toBe(4);
  }
  const observed = await capture(db, () => operation(64));
  expectIndexedOpenLookup(observed.capture.plans, table);
}

async function checkDenialUnrelated(statistics: Statistics) {
  const table = 'resource_denial';
  await db.admin.query(`TRUNCATE access.${table}`);
  await seedUnrelated(table, 4096);
  await addDenialCycle(historyStart);
  await record.run(db.admin, { ...key, at: unrelatedAt });
  await db.admin.query(`VACUUM (ANALYZE) access.${table}`);

  const operation = () =>
    rolledBack(async (client) => {
      expect((await record.run(client, { ...key, at: unrelatedAt })).outcome).toBe('open');
      expect((await end.run(client, { ...key, at: at(Date.parse(unrelatedAt) + 1000) })).outcome).toBe('closed');
      const nextAt = at(Date.parse(unrelatedAt) + 2000);
      expect((await record.run(client, { ...key, at: nextAt })).outcome).toBe('inserted');
      expect((await record.run(client, { ...key, at: nextAt })).outcome).toBe('open');
    });

  const report = await checkGrowth(db, {
    name: `denial unrelated keys (${statistics})`,
    scales: scaleValues,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    slack: { rows: { absolute: 0, relative: 0 } },
    async grow(_database, scale, previous) {
      await seedUnrelated(table, (scale - previous) * 512);
      if (statistics === 'analyze after growth') await db.admin.query(`VACUUM (ANALYZE) access.${table}`);
    },
    operation: () => operation(),
  });

  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(4);
    expect(cost.statements).toBe(4);
  }
  const observed = await capture(db, operation);
  expectIndexedOpenLookup(observed.capture.plans, table);
}

async function checkGroupUnrelated(statistics: Statistics) {
  const table = 'resource_role_grant';
  await db.admin.query(`TRUNCATE access.${table}`);
  await seedUnrelated(table, 4096);
  await grant.run(db.admin, { ...groupKey, at: unrelatedAt });
  await db.admin.query(`VACUUM (ANALYZE) access.${table}`);

  const operation = (scale: number) =>
    rolledBack(async (client) => {
      const measuredAt = at(Date.parse(unrelatedAt) + scale * 1000);
      expect((await grant.run(client, { ...groupKey, at: measuredAt })).outcome).toBe('open');
    });
  const report = await checkGrowth(db, {
    name: `group role grant unrelated keys (${statistics})`,
    scales: scaleValues,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    slack: { rows: { absolute: 0, relative: 0 } },
    async grow(_database, scale, previous) {
      await seedUnrelated(table, (scale - previous) * 512);
      if (statistics === 'analyze after growth') await db.admin.query(`VACUUM (ANALYZE) access.${table}`);
    },
    operation: (_database, scale) => operation(scale),
  });

  for (const { cost } of report.samples) {
    expect(cost.rows).toBe(1);
    expect(cost.statements).toBe(1);
  }
  const observed = await capture(db, () => operation(64));
  expectIndexedOpenLookup(observed.capture.plans, table);
}

for (const statistics of ['analyze after growth', 'leave growth unanalyzed'] as const) {
  test(`denial lookup stays bounded as recent closed history grows (${statistics})`, async () => {
    await checkDenialHistory(statistics);
  }, 60000);

  test(`denial lookup stays bounded as unrelated keys grow (${statistics})`, async () => {
    await checkDenialUnrelated(statistics);
  }, 60000);

  test(`repeated group role grants stay bounded as unrelated keys grow (${statistics})`, async () => {
    await checkGroupUnrelated(statistics);
  }, 60000);
}

test('partial unique indexes enforce one open interval per complete key', async () => {
  for (const table of tables) {
    await db.admin.query(`TRUNCATE access.${table}`);
    if (table === 'resource_denial') await record.run(db.admin, { ...key, at: unrelatedAt });
    else await grant.run(db.admin, { ...groupKey, at: unrelatedAt });
    const columns = table === 'resource_denial' ? 'action, reason' : 'subject_kind, grant_role';
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE access.${table} DROP CONSTRAINT ${table}_pkey`);
      await expect(
        client.query(
          `INSERT INTO access.${table}
            (route, resource_id, subject_id, subject_role, ${columns}, valid, transaction_id)
           SELECT route, resource_id, subject_id, subject_role, ${columns},
             tstzrange($1::timestamptz, NULL, '[)'), transaction_id
           FROM access.${table} WHERE upper_inf(valid)`,
          [at(Date.parse(unrelatedAt) + 1000)],
        ),
      ).rejects.toMatchObject({ code: '23505', constraint: `${table}_open` });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }
});

test('T still filters future open rows and preserves denial close outcomes', async () => {
  await db.admin.query('TRUNCATE access.resource_denial, access.resource_role_grant');
  const later = at(Date.parse(unrelatedAt) + 1000);
  await record.run(db.admin, { ...key, at: later });
  expect((await end.run(db.admin, { ...key, at: unrelatedAt })).outcome).toBe('absent');
  expect((await end.run(db.admin, { ...key, at: later })).outcome).toBe('unclosable');
  await expect(record.run(db.admin, { ...key, at: unrelatedAt })).rejects.toThrow();
  await grant.run(db.admin, { ...groupKey, at: later });
  await expect(grant.run(db.admin, { ...groupKey, at: unrelatedAt })).rejects.toThrow();
});
