import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import {
  pageDueEntryDeletions,
  purgeDueEntryDeletion,
  type DueEntryDeletionKey,
} from '../../src/library/entry-due-store.ts';
import { partitionOf } from '../../src/route/route.ts';
import {
  capture,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  settle,
  withoutCatalogTexts,
  type GrowthDatabase,
} from '../support/growth.ts';

const scales = [256, 1024, 4096] as const;
const route = 0x6c71;
const partition = partitionOf(route);
const due = '2026-10-28T00:00:00.000001Z';
const early = '2026-10-28T00:00:00.000000Z';
const future = '2026-11-27T00:00:00.000001Z';
const prefix = '2026-10-01T00:00:00.000001Z';
const zero = '00000000-0000-0000-0000-000000000000';
function id(r: number, n: number): string {
  return `10000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
}
const key: DueEntryDeletionKey = {
  restoreUntil: due,
  route,
  accountId: id(route, 90000),
  // Native deletion ids are UUID locators, with no account-route encoding requirement.
  deletionId: 'f0000000-0000-4000-8000-000000000001',
};
const later = { ...key, restoreUntil: future, deletionId: 'f0000000-0000-4000-8000-000000000003' };
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function archive(k: DueEntryDeletionKey): Promise<void> {
  await db.admin.query(
    `INSERT INTO library.entry_deleted
      (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,
       incarnation_id,deletion_id,deleted_revision,deleted_at,restore_until)
     VALUES($1,$2,$3,'planned',1,'2026-01-01','2026-01-02',$4,$5,$6,2,
       $7::timestamptz-interval '720 hours',$7::timestamptz)`,
    [k.route, k.accountId, id(k.route, 90001), id(k.route, 90002), id(k.route, 90003), k.deletionId, k.restoreUntil],
  );
}

async function fixed(): Promise<void> {
  await db.admin.query('DELETE FROM library.entry_deleted');
  await db.admin.query('DELETE FROM library.entry');
  await archive(key);
  await archive(later); // Same subject and incarnation as the expired episode.
  await archive({ ...key, deletionId: 'f0000000-0000-4000-8000-000000000002' });
  await archive({ ...key, accountId: id(route, 90010) });
  await archive({ ...key, route: route + 1, accountId: id(route + 1, 90000) });
  await db.admin.query(
    `INSERT INTO library.entry
      (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,incarnation_id)
     VALUES ($1,$2,$3,'planned',1,'2026-01-01','2026-01-02',$4,$5)`,
    [route, key.accountId, id(route, 90001), id(route, 90002), id(route, 90004)],
  );
}

async function grow(previous: number, scale: number): Promise<void> {
  if (previous === 0) await fixed();
  // Independent due, exact deadline ties, future and other-partition populations. The due prefix is already
  // examined by continuation/empty probes. Live replacements grow alongside their independent archives.
  for (const [group, [r, deadline]] of (
    [
      [route, prefix],
      [route, due],
      [route, future],
      [route + 16, due],
      [route + 16, future],
    ] as const
  ).entries()) {
    await db.admin.query(
      `WITH population AS (
        SELECT n, ($6::text||'-0000-7000-8000-'||lpad(to_hex($1::int),4,'0')||
          lpad(to_hex(n),8,'0'))::uuid AS id FROM generate_series($2::int,$3::int) n
      )
      INSERT INTO library.entry_deleted
        (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,
         incarnation_id,deletion_id,deleted_revision,deleted_at,restore_until)
      SELECT $1,$4,id,'planned',1,'2026-01-01','2026-01-02',id,id,id,2,
        $5::timestamptz-interval '720 hours',$5::timestamptz FROM population`,
      [r, previous + 1, scale, id(r, 1), deadline, `2000000${group}`],
    );
  }
  await db.admin.query(
    `INSERT INTO library.entry
      (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,incarnation_id)
     SELECT $1,$2,id,'planned',1,'2026-01-01','2026-01-02',id,
       ('30000000'||substring(id::text from 9))::uuid
     FROM (SELECT ('20000000-0000-7000-8000-'||lpad(to_hex($1::int),4,'0')||
       lpad(to_hex(n),8,'0'))::uuid id FROM generate_series($3::int,$4::int) n) s`,
    [route, id(route, 1), previous + 1, scale],
  );
}

test('raw continuation retains every microsecond and full tuple tie, independent of caller filters', async () => {
  await fixed();
  await archive({
    ...key,
    restoreUntil: '2026-10-28T00:00:00.000002Z',
    deletionId: 'f0000000-0000-4000-8000-000000000004',
  });
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    const input = { partition, cutoff: due, limit: 1 };
    let after: DueEntryDeletionKey | undefined;
    const examined: DueEntryDeletionKey[] = [];
    for (;;) {
      const page = await pageDueEntryDeletions(c, { ...input, ...(after ? { after } : {}) });
      if (page.length === 0) break;
      expect(Object.keys(page[0]!).sort()).toEqual(['accountId', 'deletionId', 'restoreUntil', 'route']);
      expect(page[0]!.restoreUntil).toContain('00:00:00.000001');
      examined.push(page[0]!);
      after = page[0]!; // Even when every candidate is rejected by a later caller filter.
    }
    expect(examined).toHaveLength(4);
    expect(examined.map((k) => [k.route, k.accountId, k.deletionId])).toEqual([
      [route, key.accountId, key.deletionId],
      [route, key.accountId, 'f0000000-0000-4000-8000-000000000002'],
      [route, id(route, 90010), key.deletionId],
      [route + 1, id(route + 1, 90000), key.deletionId],
    ]);
    const original = examined[0]!;
    expect(await purgeDueEntryDeletion(c, original, { time: early })).toBe(false);
    expect(await purgeDueEntryDeletion(c, { ...original, restoreUntil: early }, { time: due })).toBe(false);
    expect(await purgeDueEntryDeletion(c, original, { time: '2026-10-28T02:00:00.000001+02:00' })).toBe(true);
    expect(await purgeDueEntryDeletion(c, original, { time: future })).toBe(false);
    expect(await purgeDueEntryDeletion(c, later, { time: due })).toBe(false);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

test('invalid budgets and inconsistent structural locators reject before querying storage', async () => {
  const c = {
    query: () => {
      throw new Error('Invalid input reached storage');
    },
  } as unknown as Pick<PoolClient, 'query'>;
  const input = { partition, cutoff: due, limit: 1 };
  for (const limit of [0, -1, 1.5, 101, NaN, Infinity])
    await expect(pageDueEntryDeletions(c, { ...input, limit })).rejects.toBeInstanceOf(RangeError);
  for (const badPartition of [-1, 4096, 1.5, NaN])
    await expect(pageDueEntryDeletions(c, { ...input, partition: badPartition })).rejects.toBeInstanceOf(RangeError);
  for (const after of [
    { ...key, route: -1 },
    { ...key, route: route + 1 },
    { ...key, route: route + 16, accountId: id(route + 16, 90000) },
    { ...key, accountId: zero },
    { ...key, deletionId: 'invalid' },
  ])
    await expect(pageDueEntryDeletions(c, { ...input, after })).rejects.toBeInstanceOf(RangeError);
  await expect(purgeDueEntryDeletion(c, { ...key, accountId: zero }, { time: due })).rejects.toBeInstanceOf(RangeError);
});

const branches = ['first', 'continuation', 'empty', 'wrongdeadline', 'expired', 'notdue', 'missing'] as const;
type Branch = (typeof branches)[number];
async function operation(branch: Branch): Promise<void> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    if (branch === 'first' || branch === 'continuation' || branch === 'empty') {
      const after =
        branch === 'first'
          ? undefined
          : branch === 'continuation'
            ? { ...key, deletionId: zero }
            : { ...key, route: route + 1, accountId: id(route + 1, 90000) };
      const limit = branch === 'first' ? 100 : 4;
      const page = await pageDueEntryDeletions(c, { partition, cutoff: due, limit, ...(after ? { after } : {}) });
      expect(page).toHaveLength(branch === 'empty' ? 0 : limit);
      if (branch === 'continuation') expect(page[0]!.deletionId).toBe(key.deletionId);
    } else {
      const target =
        branch === 'wrongdeadline'
          ? { ...key, restoreUntil: early }
          : branch === 'missing'
            ? { ...key, deletionId: zero }
            : key;
      expect(await purgeDueEntryDeletion(c, target, { time: branch === 'notdue' ? early : due })).toBe(
        branch === 'expired',
      );
    }
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

// Inspect native plan nodes only; costs and catalog classification come from the shared all-pool harness.
function planNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (value === null || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  return [...('Node Type' in node ? [node] : []), ...Object.values(node).flatMap(planNodes)];
}

test('native due seeks and every exact purge branch have bounded physical work as retained and live populations grow', async () => {
  for (const branch of branches) {
    const report = await checkGrowth(db, {
      name: `Entry due storage (${branch})`,
      scales,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      async grow(_database, scale, previous) {
        await grow(previous, scale);
        await settle(db, { relations: ['library.entry_deleted', 'library.entry'], analyze: true });
        const probe = await capture(db, () => operation(branch));
        const classification = catalogStatementBound(probe.capture);
        expect(classification.catalogStatements).toBeLessThanOrEqual(classification.allowedStatements);
        const cost = costOf(probe.capture); // Actual rows times loops, removals, and heap/index blocks.
        expect(cost.statements).toBe(1);
        expect(cost.plans).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        const nodes = planNodes(withoutCatalogTexts(probe.capture, classification).plans);
        const scans = nodes.filter((node) => node['Relation Name'] === 'entry_deleted' && node['Index Name']);
        expect(scans).toHaveLength(1);
        expect(scans[0]!['Index Name']).toBe(
          ['first', 'continuation', 'empty'].includes(branch) ? 'entry_deleted_due' : 'entry_deleted_pkey',
        );
        expect(scans[0]!['Actual Loops']).toBe(1);
        expect(nodes.some((node) => node['Node Type'] === 'Sort' || node['Node Type'] === 'Seq Scan')).toBe(false);
        expect(Object.keys(cost.relations)).toEqual(['library.entry_deleted']);
      },
      operation: () => operation(branch),
    });
    for (const sample of report.samples) {
      expect(sample.cost.statements).toBe(1);
      expect(sample.cost.rows).toBeLessThanOrEqual(branch === 'first' ? 100 : branch === 'continuation' ? 4 : 1);
      expect(sample.cost.relations['library.entry_deleted']!.sequentialScans).toBe(0);
    }
    // Purge probes roll back, including the successful branch; later episode and live replacement stay byte-exact.
    expect(
      (
        await db.admin.query('SELECT count(*)::int AS n FROM library.entry_deleted WHERE route=$1 AND account_id=$2', [
          route,
          key.accountId,
        ])
      ).rows[0]!.n,
    ).toBe(3);
    expect(
      (
        await db.admin.query(
          'SELECT incarnation_id FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, key.accountId, id(route, 90001)],
        )
      ).rows[0]!.incarnation_id,
    ).toBe(id(route, 90004));
  }
}, 300_000);
