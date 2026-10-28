import { afterAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import {
  deleteAccountNoticePage,
  deleteExpiredNoticesPage,
  NOTICE_PAGE_SIZE,
  writeNotices,
} from '../../src/content/notices.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const scales = [256, 1024, 4096] as const;
const route = 0x4567;
const forbiddenPlannerSetting = /\b(SET|set_config)\b[^;]*\benable_/is;
const NOTICE_INDEX_ENTRY_OVERHEAD = NOTICE_PAGE_SIZE + 8;
const NOTICE_PLAN_ROW_OVERHEAD = NOTICE_PAGE_SIZE * 2 + 8;

function recipients(atRoute: number): string[] {
  return Array.from({ length: 32 }, () => newId(atRoute));
}

function otherPartitionRecipients(): string[] {
  return [1, 2, 3, 4].flatMap((offset) => Array.from({ length: 8 }, () => newId(route + offset * 16)));
}

async function seedNotices(account: string, count: number, createdAt: Date): Promise<void> {
  if (count === 0) return;
  const ids = Array.from({ length: count }, () => newId(routeFor(account)));
  await db.admin.query(
    `INSERT INTO content.notice (route, recipient_id, notice_id, kind, source_id, created_at)
     SELECT $1, $2, requested.id, 'reply', requested.id, $4::timestamptz
     FROM unnest($3::uuid[]) AS requested(id)`,
    [routeFor(account), account, ids, createdAt],
  );
}

function routeFor(account: string): number {
  const route = routeOf(account);
  if (route === null) throw new TypeError('Invalid notice recipient');
  return route;
}

function planNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (!value || typeof value !== 'object') return [];
  const node = value as Record<string, unknown>;
  if (node.Plan && typeof node.Plan === 'object') return planNodes(node.Plan);
  const children = Array.isArray(node.Plans) ? node.Plans.flatMap(planNodes) : [];
  return [node, ...children];
}

async function explainPage(
  pool: typeof db.pool,
  query: string,
  parameters: readonly unknown[],
  indexName: string,
  boundColumns: readonly string[],
): Promise<void> {
  const result = await pool.query<{ 'QUERY PLAN': unknown }>(query, [...parameters]);
  const raw = result.rows[0]?.['QUERY PLAN'];
  const document = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const nodes = planNodes(document);
  const scan = nodes.find(
    (node) =>
      ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'].includes(String(node['Node Type'])) &&
      node['Index Name'] === indexName,
  );
  expect(scan, `Expected an index range scan on ${indexName}: ${JSON.stringify(document)}`).toBeDefined();
  const indexCondition = String(scan!['Index Cond']);
  for (const column of boundColumns) expect(indexCondition).toContain(column);
  expect(Number(scan!['Actual Rows']), JSON.stringify(document)).toBeLessThanOrEqual(
    NOTICE_PAGE_SIZE + NOTICE_INDEX_ENTRY_OVERHEAD,
  );
  const heapScan = nodes.find((node) => node['Node Type'] === 'Bitmap Heap Scan' && node['Relation Name'] === 'notice');
  if (heapScan)
    expect(Number(heapScan['Actual Rows']), JSON.stringify(document)).toBeLessThanOrEqual(NOTICE_PAGE_SIZE + 8);
  const page = nodes.find((node) => node['Node Type'] === 'Limit');
  expect(page).toBeDefined();
  expect(Number(page!['Actual Rows'])).toBeLessThanOrEqual(NOTICE_PAGE_SIZE + 8);
}

async function observed<T>(
  pool: typeof db.pool,
  action: () => Promise<T>,
): Promise<{ value: T; statements: string[] }> {
  const trace = observeSql(pool);
  try {
    const value = await action();
    return { value, statements: trace.records.map((record) => record.statement) };
  } finally {
    await trace.close();
  }
}

function expectNoPlannerSettings(statements: readonly string[]): void {
  expect(statements.some((statement) => forbiddenPlannerSetting.test(statement))).toBe(false);
}

function expectConstantNoticeCost(report: Awaited<ReturnType<typeof checkGrowth>>, rowLimit: number): void {
  expect(report.samples.map((sample) => sample.scale)).toEqual([...scales]);
  for (const sample of report.samples) {
    const cost = sample.cost as typeof sample.cost & { relations: NonNullable<typeof sample.cost.relations> };
    expect(cost.rows).toBe(report.samples[0]!.cost.rows);
    expect(cost.statements).toBe(report.samples[0]!.cost.statements);
    const notice = cost.relations['content.notice'];
    expect(notice).toBeDefined();
    // PostgreSQL accounts for page reads, target tuple lookups and the bounded delete as separate plan rows.
    expect(notice!.rows).toBeLessThanOrEqual(rowLimit + NOTICE_PLAN_ROW_OVERHEAD);
    expect(notice!.sequentialScans).toBe(0);
  }
}

test('notice writes and bounded pages stay constant while other recipients and partitions grow', async () => {
  const writeRecipients = recipients(route);
  const writeOtherPartitionRecipients = otherPartitionRecipients();
  const writer = newId(route);
  const writeReport = await checkGrowth(db, {
    name: 'Notice write',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    warmups: 1,
    async grow(_growthDb, scale, previous) {
      const added = scale - previous;
      for (const account of writeRecipients) await seedNotices(account, added, new Date('2026-10-01T00:00:00Z'));
      for (const account of writeOtherPartitionRecipients)
        await seedNotices(account, added, new Date('2026-10-01T00:00:00Z'));
    },
    async operation(growthDb) {
      const input = {
        recipientId: writer,
        noticeId: newId(route),
        kind: 'reply' as const,
        actorId: null,
        threadId: null,
        postId: null,
        decisionId: null,
        reportId: null,
        sourceId: newId(route),
        createdAt: new Date('2026-10-02T00:00:00Z'),
      };
      const result = await observed(growthDb.pool, () => writeNotices(growthDb.pool, [input]));
      expect(result.value).toBe(1);
      expectNoPlannerSettings(result.statements);
    },
  });
  expectConstantNoticeCost(writeReport, 1);

  const retentionWarmupAccount = newId(route);
  const retentionAccount = newId(route);
  const retentionRecipients = recipients(route);
  const retentionOtherPartitionRecipients = otherPartitionRecipients();
  const warmupCutoff = new Date('2000-01-01T00:00:00Z');
  const cutoff = new Date('2000-01-02T00:00:00Z');
  const retentionReport = await checkGrowth(db, {
    name: 'Notice retention page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale, previous) {
      await seedNotices(retentionWarmupAccount, NOTICE_PAGE_SIZE, new Date('1999-12-31T00:00:00Z'));
      await seedNotices(retentionAccount, NOTICE_PAGE_SIZE, new Date('2000-01-01T12:00:00Z'));
      for (const account of retentionRecipients)
        await seedNotices(account, scale - previous, new Date('2026-10-01T00:00:00Z'));
      for (const account of retentionOtherPartitionRecipients)
        await seedNotices(account, scale - previous, new Date('2026-10-01T00:00:00Z'));
    },
    async warmup(growthDb) {
      const result = await observed(growthDb.pool, async () => {
        await explainPage(
          growthDb.admin,
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           SELECT ctid, notice_id FROM content.notice
           WHERE route = $1 AND created_at < $2::timestamptz
           ORDER BY created_at, notice_id LIMIT 1000 FOR UPDATE`,
          [route, warmupCutoff],
          'notice_route_created_idx',
          ['route', 'created_at'],
        );
        return deleteExpiredNoticesPage(growthDb.pool, route, warmupCutoff);
      });
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
    async operation(growthDb) {
      const result = await observed(growthDb.pool, () => deleteExpiredNoticesPage(growthDb.pool, route, cutoff));
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
  });
  expectConstantNoticeCost(retentionReport, NOTICE_PAGE_SIZE);

  const erasedWarmupAccount = newId(route);
  const erasedAccount = newId(route);
  const erasureRecipients = recipients(route);
  const erasureOtherPartitionRecipients = otherPartitionRecipients();
  const erasureReport = await checkGrowth(db, {
    name: 'Account notice erasure page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale, previous) {
      await seedNotices(erasedWarmupAccount, NOTICE_PAGE_SIZE, new Date('2026-10-01T00:00:00Z'));
      await seedNotices(erasedAccount, NOTICE_PAGE_SIZE, new Date('2026-10-01T00:00:00Z'));
      for (const account of erasureRecipients)
        await seedNotices(account, scale - previous, new Date('2026-10-01T00:00:00Z'));
      for (const account of erasureOtherPartitionRecipients)
        await seedNotices(account, scale - previous, new Date('2026-10-01T00:00:00Z'));
    },
    async warmup(growthDb) {
      const result = await observed(growthDb.pool, async () => {
        await explainPage(
          growthDb.admin,
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           SELECT ctid, notice_id FROM content.notice
           WHERE route = $1 AND recipient_id = $2::uuid
           ORDER BY created_at, notice_id LIMIT 1000 FOR UPDATE`,
          [route, erasedWarmupAccount],
          'notice_recipient_created_idx',
          ['route', 'recipient_id'],
        );
        return deleteAccountNoticePage(growthDb.pool, erasedWarmupAccount);
      });
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
    async operation(growthDb) {
      const result = await observed(growthDb.pool, () => deleteAccountNoticePage(growthDb.pool, erasedAccount));
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
  });
  expectConstantNoticeCost(erasureReport, NOTICE_PAGE_SIZE);
}, 180_000);
