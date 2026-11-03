import { afterAll, expect, test } from 'bun:test';
import { randomInt } from 'node:crypto';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { fromPlainText } from '@rezics/document';
import type { CloudEvent } from '../../src/events/log.ts';
import { createModerationDecisionEffect } from '../../src/content/moderation-decisions.ts';
import { createReportEffect } from '../../src/content/report-effect.ts';
import { createReportOutcomeEffect } from '../../src/content/report-outcomes.ts';
import { seedReportGrowth } from './support/report-growth.ts';
import { createContentNotificationGrowthDriver, type ContentNotificationGrowthDriver } from './notification-driver.ts';
import {
  deleteAccountNoticePage,
  deleteExpiredNoticesPage,
  eraseAccountNoticesPage,
  NOTICE_PAGE_SIZE,
  writeNotices,
} from '../../src/content/notices.ts';
import { newId, routeOf, ROUTES } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const scales = [256, 1024, 4096] as const;
const firstRoute = randomInt(0, ROUTES - 64 - scales.length + 1);
const forbiddenPlannerSetting = /\b(SET|set_config)\b[^;]*\benable_/is;
const NOTICE_INDEX_ENTRY_OVERHEAD = NOTICE_PAGE_SIZE + 8;
const NOTICE_PLAN_ROW_OVERHEAD = NOTICE_PAGE_SIZE * 2 + 8;

function routeAtScale(scale: number): number {
  const index = scales.indexOf(scale as (typeof scales)[number]);
  if (index < 0) throw new RangeError('Unknown notice growth scale');
  return firstRoute + index;
}

function recipients(atRoute: number): string[] {
  return Array.from({ length: 32 }, () => newId(atRoute));
}

function otherPartitionRecipients(atRoute: number): string[] {
  return [1, 2, 3, 4].flatMap((offset) => Array.from({ length: 8 }, () => newId(atRoute + offset * 16)));
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

async function seedFinalizations(account: string, count: number, createdAt: Date): Promise<void> {
  if (count === 0) return;
  const route = routeFor(account);
  const ids = Array.from({ length: count }, () => newId(route));
  await db.admin.query(
    `INSERT INTO content.notice_finalization(route,recipient_id,kind,source_id,sent,created_at)
     SELECT $1,$2,'reply',requested.id,false,$4::timestamptz
     FROM unnest($3::uuid[]) AS requested(id)`,
    [route, account, ids, createdAt],
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
  const writeReport = await checkGrowth(db, {
    name: 'Notice write',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    warmups: 1,
    async grow(_growthDb, scale) {
      const atRoute = routeAtScale(scale);
      for (const account of recipients(atRoute)) await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
      for (const account of otherPartitionRecipients(atRoute))
        await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
    },
    async operation(growthDb, scale) {
      const atRoute = routeAtScale(scale);
      const input = {
        recipientId: newId(atRoute),
        noticeId: newId(atRoute),
        kind: 'reply' as const,
        actorId: null,
        threadId: null,
        postId: null,
        decisionId: null,
        reportId: null,
        sourceId: newId(atRoute),
        createdAt: new Date('2026-10-02T00:00:00Z'),
      };
      const result = await observed(growthDb.pool, () => writeNotices(growthDb.pool, [input]));
      expect(result.value).toBe(1);
      expectNoPlannerSettings(result.statements);
    },
  });
  expectConstantNoticeCost(writeReport, 1);

  const retentionWarmupAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const retentionAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const warmupCutoff = new Date('2000-01-01T00:00:00Z');
  const cutoff = new Date('2000-01-02T00:00:00Z');
  const retentionReport = await checkGrowth(db, {
    name: 'Notice retention page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale) {
      const atRoute = routeAtScale(scale);
      await seedNotices(retentionWarmupAccounts.get(scale)!, NOTICE_PAGE_SIZE, new Date('1999-12-31T00:00:00Z'));
      await seedNotices(retentionAccounts.get(scale)!, NOTICE_PAGE_SIZE, new Date('2000-01-01T12:00:00Z'));
      for (const account of recipients(atRoute)) await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
      for (const account of otherPartitionRecipients(atRoute))
        await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
    },
    async warmup(growthDb, scale) {
      const atRoute = routeAtScale(scale);
      const result = await observed(growthDb.pool, async () => {
        await explainPage(
          growthDb.admin,
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           SELECT ctid, notice_id FROM content.notice
           WHERE route = $1 AND created_at < $2::timestamptz
           ORDER BY created_at, notice_id LIMIT 1000 FOR UPDATE`,
          [atRoute, warmupCutoff],
          'notice_route_created_idx',
          ['route', 'created_at'],
        );
        return deleteExpiredNoticesPage(growthDb.pool, atRoute, warmupCutoff);
      });
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
    async operation(growthDb, scale) {
      const atRoute = routeAtScale(scale);
      const result = await observed(growthDb.pool, () => deleteExpiredNoticesPage(growthDb.pool, atRoute, cutoff));
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
  });
  expectConstantNoticeCost(retentionReport, NOTICE_PAGE_SIZE);

  const erasedWarmupAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const erasedAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const erasureReport = await checkGrowth(db, {
    name: 'Account notice erasure page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale) {
      const atRoute = routeAtScale(scale);
      await seedNotices(erasedWarmupAccounts.get(scale)!, NOTICE_PAGE_SIZE, new Date('2026-10-01T00:00:00Z'));
      await seedNotices(erasedAccounts.get(scale)!, NOTICE_PAGE_SIZE, new Date('2026-10-01T00:00:00Z'));
      for (const account of recipients(atRoute)) await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
      for (const account of otherPartitionRecipients(atRoute))
        await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
    },
    async warmup(growthDb, scale) {
      const atRoute = routeAtScale(scale);
      const result = await observed(growthDb.pool, async () => {
        await explainPage(
          growthDb.admin,
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           SELECT ctid, notice_id FROM content.notice
           WHERE route = $1 AND recipient_id = $2::uuid
           ORDER BY created_at DESC, notice_id DESC LIMIT 1000 FOR UPDATE`,
          [atRoute, erasedWarmupAccounts.get(scale)!],
          'notice_recipient_created_idx',
          ['route', 'recipient_id'],
        );
        return deleteAccountNoticePage(growthDb.pool, erasedWarmupAccounts.get(scale)!);
      });
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
    async operation(growthDb, scale) {
      const result = await observed(growthDb.pool, () =>
        deleteAccountNoticePage(growthDb.pool, erasedAccounts.get(scale)!),
      );
      expect(result.value).toBe(NOTICE_PAGE_SIZE);
      expectNoPlannerSettings(result.statements);
    },
  });
  expectConstantNoticeCost(erasureReport, NOTICE_PAGE_SIZE);
}, 180_000);

test('finalization cleanup and empty terminal lifecycle pages stay bounded at the seeded scales', async () => {
  const warmupAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const measuredAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const cutoff = new Date('2000-01-02T00:00:00Z');
  const expired = new Date('1999-12-31T00:00:00Z');
  const cleanup = await checkGrowth(db, {
    name: 'Expired notice finalization cleanup',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale) {
      const atRoute = routeAtScale(scale);
      await seedFinalizations(warmupAccounts.get(scale)!, NOTICE_PAGE_SIZE, expired);
      await seedFinalizations(measuredAccounts.get(scale)!, NOTICE_PAGE_SIZE, expired);
      for (const account of recipients(atRoute)) await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
      for (const account of otherPartitionRecipients(atRoute))
        await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
    },
    async warmup(growthDb, scale) {
      expect(await deleteExpiredNoticesPage(growthDb.pool, routeAtScale(scale), cutoff)).toBe(NOTICE_PAGE_SIZE);
    },
    async operation(growthDb, scale) {
      expect(await deleteExpiredNoticesPage(growthDb.pool, routeAtScale(scale), cutoff)).toBe(NOTICE_PAGE_SIZE);
      return scale;
    },
  });
  expect(cleanup.samples.map((sample) => sample.scale)).toEqual([...scales]);
  for (const sample of cleanup.samples) {
    expect(sample.cost.rows).toBe(cleanup.samples[0]!.cost.rows);
    expect(sample.cost.statements).toBe(cleanup.samples[0]!.cost.statements);
    const table = sample.cost.relations?.['content.notice_finalization'];
    expect(table).toBeDefined();
    expect(table!.rows).toBeLessThanOrEqual(NOTICE_PAGE_SIZE + 16);
    expect(table!.sequentialScans).toBe(0);
  }
  console.info(JSON.stringify(cleanup));

  const emptyExpired = await checkGrowth(db, {
    name: 'Empty expired notice terminal page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale) {
      const atRoute = routeAtScale(scale);
      for (const account of recipients(atRoute)) await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
      for (const account of otherPartitionRecipients(atRoute))
        await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
    },
    async operation(growthDb, scale) {
      expect(await deleteExpiredNoticesPage(growthDb.pool, routeAtScale(scale), cutoff)).toBe(0);
      return scale;
    },
  });
  expect(emptyExpired.samples.map((sample) => sample.scale)).toEqual([...scales]);
  console.info(JSON.stringify(emptyExpired));

  const emptyErasure = await checkGrowth(db, {
    name: 'Empty notice erasure terminal page',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale) {
      const atRoute = routeAtScale(scale);
      for (const account of recipients(atRoute)) await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
      for (const account of otherPartitionRecipients(atRoute))
        await seedNotices(account, scale, new Date('2026-10-01T00:00:00Z'));
    },
    async operation(growthDb, scale) {
      const result = await eraseAccountNoticesPage({ pool: growthDb.pool }, newId(routeAtScale(scale)), null);
      expect(result).toEqual({ next: null, found: 0, pending: 0 });
      return scale;
    },
  });
  expect(emptyErasure.samples.map((sample) => sample.scale)).toEqual([...scales]);
  console.info(JSON.stringify(emptyErasure));

  const pressureAccounts = new Map<number, string>(scales.map((scale) => [scale, newId(routeAtScale(scale))]));
  const eraseAll = async (pool: typeof db.pool, account: string): Promise<number> => {
    let after: string | null = null;
    let found = 0;
    for (;;) {
      const page = await eraseAccountNoticesPage({ pool }, account, after);
      found += page.found;
      if (page.next === null) {
        expect(page.pending).toBe(0);
        return found;
      }
      expect(page.pending).toBeGreaterThan(0);
      after = page.next;
    }
  };
  const completeParticipant = await checkGrowth(db, {
    name: 'Complete notice-erasure participant pages',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(_growthDb, scale, previous) {
      const account = pressureAccounts.get(scale)!;
      await seedNotices(account, scale - previous, new Date('2026-10-01T00:00:00Z'));
      await seedFinalizations(account, scale - previous, new Date('2026-10-01T00:00:00Z'));
    },
    async warmup(growthDb, scale) {
      const account = newId(routeAtScale(scale));
      await seedNotices(account, 55, new Date('2026-10-01T00:00:00Z'));
      await seedFinalizations(account, 55, new Date('2026-10-01T00:00:00Z'));
      expect(await eraseAll(growthDb.pool, account)).toBe(110);
    },
    async prepare(_growthDb, scale) {
      const account = newId(routeAtScale(scale));
      pressureAccounts.set(scale, account);
      await seedNotices(account, 55, new Date('2026-10-01T00:00:00Z'));
      await seedFinalizations(account, 55, new Date('2026-10-01T00:00:00Z'));
    },
    async operation(growthDb, scale) {
      const account = pressureAccounts.get(scale)!;
      expect(await eraseAll(growthDb.pool, account)).toBe(110);
      return scale;
    },
  });
  expect(completeParticipant.samples.map((sample) => sample.scale)).toEqual([...scales]);
  console.info(JSON.stringify(completeParticipant));
}, 300_000);

const moderationScales = [64, 256, 1024] as const;
const takedownEventType = 'com.rezics.content.moderation.takedown.v1';
const reportCreatedEventType = 'com.rezics.content.report.created.v1';
const appealResolvedEventType = 'com.rezics.content.moderation.appeal-resolved.v1';

type NativeEventRow = {
  partition_no: number;
  position: string;
  epoch: number;
  id: string;
  type: string;
  subject: string;
  data: unknown;
  recorded_at: Date;
};

async function nativeEvent(growthDb: GrowthDatabase, type: string, subject: string): Promise<CloudEvent> {
  const { rows } = await growthDb.admin.query<NativeEventRow>(
    `SELECT partition_no,position::text,epoch,id::text,type,subject::text,data,recorded_at
     FROM core.outbox WHERE type=$1 AND subject=$2 ORDER BY position DESC LIMIT 1`,
    [type, subject],
  );
  const row = rows[0];
  if (!row) throw new Error(`Missing native ${type} event for ${subject}`);
  return {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${row.partition_no}.${row.epoch}`,
    type: row.type,
    subject: row.subject,
    time: new Date(row.recorded_at).toISOString(),
    datacontenttype: 'application/json',
    sequence: BigInt(row.position).toString().padStart(19, '0'),
    data: row.data,
  };
}

type NotificationGrowthFixture = Awaited<ReturnType<ContentNotificationGrowthDriver['provision']>>;

async function createRunnerThread(driver: ContentNotificationGrowthDriver, fixture: NotificationGrowthFixture) {
  const result = await driver.createThread(
    { boardId: fixture.publicBoardId, body: fromPlainText('Moderation runner cost'), visibility: 'published' },
    { actor: fixture.author, key: JSON.stringify(crypto.randomUUID()) },
  );
  if (!result.response.ok || !result.value)
    throw new Error(`Native runner thread creation failed (${result.response.status})`);
  return result.value;
}

async function createTakedownEvent(
  driver: ContentNotificationGrowthDriver,
  fixture: NotificationGrowthFixture,
  growthDb: GrowthDatabase,
  target: { kind: 'thread' | 'post'; id: string },
): Promise<CloudEvent> {
  const result = await driver.takedown(target, 'Runner cost fixture', {
    actor: fixture.moderator,
    key: JSON.stringify(crypto.randomUUID()),
  });
  if (!result.response.ok) throw new Error(`Native takedown failed (${result.response.status})`);
  return nativeEvent(growthDb, takedownEventType, target.id);
}

async function decisionIdForTarget(growthDb: GrowthDatabase, target: { kind: 'thread' | 'post'; id: string }) {
  const route = routeOf(target.id);
  if (route === null) throw new TypeError('Invalid moderation target');
  const { rows } = await growthDb.admin.query<{ decision_id: string }>(
    `SELECT decision_id::text FROM content.moderation_decision
     WHERE route=$1 AND target_kind=$2 AND target_id=$3 ORDER BY decided_at DESC LIMIT 1`,
    [route, target.kind, target.id],
  );
  if (!rows[0]) throw new Error(`Missing moderation decision for ${target.id}`);
  return rows[0].decision_id;
}

async function createAppealResolutionEvent(
  driver: ContentNotificationGrowthDriver,
  fixture: NotificationGrowthFixture,
  growthDb: GrowthDatabase,
): Promise<CloudEvent> {
  const thread = await createRunnerThread(driver, fixture);
  const target = { kind: 'thread' as const, id: thread.id };
  await createTakedownEvent(driver, fixture, growthDb, target);
  const decisionId = await decisionIdForTarget(growthDb, target);
  const created = await driver.appeal(decisionId, 'Runner cost appeal', {
    actor: fixture.author,
    key: JSON.stringify(crypto.randomUUID()),
  });
  if (!created.response.ok || !created.value) throw new Error(`Native appeal failed (${created.response.status})`);
  const resolved = await driver.resolveAppeal(created.value.id, 'uphold', 'Runner cost resolution', {
    actor: fixture.secondModerator,
    key: JSON.stringify(crypto.randomUUID()),
  });
  if (!resolved.response.ok) throw new Error(`Native appeal resolution failed (${resolved.response.status})`);
  return nativeEvent(growthDb, appealResolvedEventType, created.value.id);
}

async function seedNoticeHistory(growthDb: GrowthDatabase, account: string, count: number): Promise<void> {
  if (count === 0) return;
  const route = routeOf(account);
  if (route === null) throw new TypeError('Invalid notification recipient');
  const ids = Array.from({ length: count }, () => newId(route));
  await growthDb.admin.query(
    `INSERT INTO content.notice(route,recipient_id,notice_id,kind,source_id,created_at)
     SELECT $1,$2,requested.id,'reply',requested.id,'2026-10-01T00:00:00Z'::timestamptz
     FROM unnest($3::uuid[]) AS requested(id)`,
    [route, account, ids],
  );
}

async function seedTargetReports(
  growthDb: GrowthDatabase,
  reporterId: string,
  targetId: string,
  count: number,
  createdAt: string,
): Promise<string[]> {
  const reportRoute = routeOf(reporterId);
  const targetRoute = routeOf(targetId);
  if (reportRoute === null || targetRoute === null) throw new TypeError('Invalid native report fixture route');
  const rows = Array.from({ length: count }, () => ({
    reportId: newId(reportRoute),
    reportRoute,
    targetKind: 'post' as const,
    targetId,
    targetRoute,
    createdAt,
    transactionId: crypto.randomUUID(),
    idempotencyKey: `growth-${crypto.randomUUID()}`,
    reporterAccountId: reporterId,
  }));
  await seedReportGrowth(growthDb.admin, rows);
  return rows.map(({ reportId }) => reportId);
}

async function expectModerationNotice(growthDb: GrowthDatabase, recipientId: string, sourceId: string): Promise<void> {
  const recipientRoute = routeOf(recipientId);
  if (recipientRoute === null) throw new TypeError('Invalid moderation notice recipient');
  const { rows } = await growthDb.admin.query<{ notice_id: string }>(
    `SELECT notice_id::text FROM content.notice
     WHERE route=$1 AND recipient_id=$2 AND source_id=$3 AND kind='moderation_decision'`,
    [recipientRoute, recipientId, sourceId],
  );
  expect(rows).toHaveLength(1);
}

test('native takedown, report, appeal, and report-resolution runners stay classified at seeded scales', async () => {
  const driver = await createContentNotificationGrowthDriver();
  const fixture = await driver.provision();
  const growthDb = driver.growthDatabase;
  const moderationEffect = createModerationDecisionEffect(growthDb.pool);
  const reportEffect = createReportEffect(growthDb.pool);
  const reportOutcomeEffect = createReportOutcomeEffect(growthDb.pool);
  const createdAt = new Date(Date.parse(fixture.now) - 1_000).toISOString();
  try {
    const takedownWarmups = new Map<number, CloudEvent>();
    const takedownRuns = new Map<number, CloudEvent>();
    const takedowns = await checkGrowth(growthDb, {
      name: 'Native required takedown notice runner',
      scales: moderationScales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      async grow(db, scale, previous) {
        await seedNoticeHistory(db, fixture.author.id, scale - previous);
        const thread = await createRunnerThread(driver, fixture);
        takedownWarmups.set(scale, await createTakedownEvent(driver, fixture, db, { kind: 'thread', id: thread.id }));
      },
      async warmup(_db, scale) {
        await moderationEffect.run(takedownWarmups.get(scale)!);
      },
      async prepare(db, scale) {
        const thread = await createRunnerThread(driver, fixture);
        takedownRuns.set(scale, await createTakedownEvent(driver, fixture, db, { kind: 'thread', id: thread.id }));
      },
      async operation(_db, scale) {
        await moderationEffect.run(takedownRuns.get(scale)!);
        return scale;
      },
    });
    expect(takedowns.samples.map((sample) => sample.scale)).toEqual([...moderationScales]);
    for (const event of [...takedownWarmups.values(), ...takedownRuns.values()]) {
      const data = event.data as { targetKind: 'thread' | 'post'; targetId: string };
      const decisionId = await decisionIdForTarget(growthDb, { kind: data.targetKind, id: data.targetId });
      await expectModerationNotice(growthDb, fixture.author.id, decisionId);
    }
    console.info(JSON.stringify(takedowns));

    const reportThread = await createRunnerThread(driver, fixture);
    const reportTarget = { kind: 'post' as const, id: reportThread.firstPost.id };
    const reportWarmups = new Map<number, CloudEvent>();
    const reportRuns = new Map<number, CloudEvent>();
    const reports = await checkGrowth(growthDb, {
      name: 'Native report projection runner',
      scales: moderationScales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      async grow(db, scale, previous) {
        const route = routeOf(reportTarget.id)!;
        const unrelated = newId(route);
        const reportRoute = routeOf(fixture.reporter.id)!;
        const distractors = Array.from({ length: scale - previous }, () => ({
          reportId: newId(reportRoute),
          reportRoute,
          targetKind: 'post' as const,
          targetId: unrelated,
          targetRoute: route,
          createdAt,
          transactionId: crypto.randomUUID(),
          idempotencyKey: `growth-${crypto.randomUUID()}`,
          reporterAccountId: fixture.reporter.id,
        }));
        await seedReportGrowth(db.admin, distractors);
        const result = await driver.report(reportTarget, {
          actor: fixture.reporter,
          key: JSON.stringify(crypto.randomUUID()),
        });
        if (!result.response.ok || !result.value) throw new Error(`Native report failed (${result.response.status})`);
        reportWarmups.set(scale, await nativeEvent(db, reportCreatedEventType, result.value.reportId));
      },
      async warmup(_db, scale) {
        await reportEffect.run(reportWarmups.get(scale)!);
      },
      async prepare(db, scale) {
        const result = await driver.report(reportTarget, {
          actor: fixture.reporter,
          key: JSON.stringify(crypto.randomUUID()),
        });
        if (!result.response.ok || !result.value) throw new Error(`Native report failed (${result.response.status})`);
        reportRuns.set(scale, await nativeEvent(db, reportCreatedEventType, result.value.reportId));
      },
      async operation(_db, scale) {
        await reportEffect.run(reportRuns.get(scale)!);
        return scale;
      },
    });
    expect(reports.samples.map((sample) => sample.scale)).toEqual([...moderationScales]);
    for (const event of [...reportWarmups.values(), ...reportRuns.values()]) {
      const reportId = event.subject;
      if (event.type !== reportCreatedEventType || typeof reportId !== 'string' || routeOf(reportId) === null)
        throw new TypeError('Invalid native report event subject');
      const data = event.data as { reportId: string; targetId: string };
      expect(reportId).toBe(data.reportId);
      const targetRoute = routeOf(data.targetId);
      const reportRoute = routeOf(fixture.reporter.id);
      if (targetRoute === null || reportRoute === null) throw new TypeError('Invalid projected report route');
      const { rows } = await growthDb.admin.query<{ report_id: string }>(
        `SELECT report_id::text FROM content.report_target
         WHERE route=$1 AND target_kind='post' AND target_id=$2 AND report_route=$3 AND report_id=$4`,
        [targetRoute, data.targetId, reportRoute, reportId],
      );
      expect(rows).toEqual([{ report_id: reportId }]);
    }
    console.info(JSON.stringify(reports));

    const appealWarmups = new Map<number, CloudEvent>();
    const appealRuns = new Map<number, CloudEvent>();
    const appeals = await checkGrowth(growthDb, {
      name: 'Native required appeal notice runner',
      scales: moderationScales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      warmups: 1,
      async grow(db, scale, previous) {
        await seedNoticeHistory(db, fixture.author.id, scale - previous);
        appealWarmups.set(scale, await createAppealResolutionEvent(driver, fixture, db));
      },
      async warmup(_db, scale) {
        await moderationEffect.run(appealWarmups.get(scale)!);
      },
      async prepare(db, scale) {
        appealRuns.set(scale, await createAppealResolutionEvent(driver, fixture, db));
      },
      async operation(_db, scale) {
        await moderationEffect.run(appealRuns.get(scale)!);
        return scale;
      },
    });
    expect(appeals.samples.map((sample) => sample.scale)).toEqual([...moderationScales]);
    for (const event of [...appealWarmups.values(), ...appealRuns.values()]) {
      const appealId = event.subject;
      if (event.type !== appealResolvedEventType || typeof appealId !== 'string' || routeOf(appealId) === null)
        throw new TypeError('Invalid native appeal-resolution event subject');
      expect(appealId).toBe((event.data as { appealId: string }).appealId);
      await expectModerationNotice(growthDb, fixture.author.id, appealId);
    }
    console.info(JSON.stringify(appeals));

    const reportResolutionWarmups = new Map<number, { event: CloudEvent; reportIds: string[] }>();
    const reportResolutionRuns = new Map<number, { event: CloudEvent; targetId: string; reportIds: string[] }>();
    const prepareReportResolution = async (db: GrowthDatabase, count: number) => {
      const thread = await createRunnerThread(driver, fixture);
      const target = { kind: 'post' as const, id: thread.firstPost.id };
      const reportIds = await seedTargetReports(db, fixture.reporter.id, target.id, count, createdAt);
      const event = await createTakedownEvent(driver, fixture, db, target);
      return { event, targetId: target.id, reportIds };
    };
    const reportResolutions = await checkGrowth(growthDb, {
      name: 'Native bounded report-resolution runner',
      scales: moderationScales,
      bounds: { rows: 'linear', blocks: 'linear', statements: 'linear' },
      repetitions: 1,
      warmups: 1,
      async grow(db, scale) {
        reportResolutionWarmups.set(scale, await prepareReportResolution(db, scale));
      },
      async warmup(db, scale) {
        await reportOutcomeEffect.run(reportResolutionWarmups.get(scale)!.event);
      },
      async prepare(db, scale) {
        reportResolutionRuns.set(scale, await prepareReportResolution(db, scale));
      },
      async operation(_db, scale) {
        await reportOutcomeEffect.run(reportResolutionRuns.get(scale)!.event);
        return scale;
      },
    });
    expect(reportResolutions.samples.map((sample) => sample.scale)).toEqual([...moderationScales]);
    for (const sample of reportResolutions.samples) {
      const run = reportResolutionRuns.get(sample.scale)!;
      const { rows } = await growthDb.admin.query<{ resolved: number; notices: number }>(
        `SELECT count(*) FILTER (WHERE outcome='actioned')::int AS resolved,
                (SELECT count(*)::int FROM content.notice
                 WHERE route=$1 AND recipient_id=$2 AND source_id=ANY($3::uuid[])) AS notices
         FROM content.report WHERE report_id=ANY($3::uuid[])`,
        [routeOf(fixture.reporter.id), fixture.reporter.id, run.reportIds],
      );
      expect(rows[0]).toEqual({ resolved: sample.scale, notices: sample.scale });
    }
    console.info(JSON.stringify(reportResolutions));
  } finally {
    await driver.close();
  }
}, 600_000);
