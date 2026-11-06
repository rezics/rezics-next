import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOSClient, WORKFLOW_STATUS_SCAN_RAW_LIMIT } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import {
  createScanClient,
  deleteScanRows,
  enableAutoExplain,
  expectIndexedScan,
  insertScanPayload,
  insertScanStatus,
  observeScanPlans,
  readAllPages,
  scanPrefix,
  type ScanPlan,
} from './support/sdk-workflow-selection.ts';

const databaseUrl = process.env.DATABASE_URL ?? '';
if (databaseUrl === '') throw new Error('DATABASE_URL must name the migrated test database');

const scales = [256, 1024, 4096] as const;
const selected = 8;
const cutoff = 1_700_000_000_000;
const prefix = scanPrefix();
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const plans: ScanPlan[] = [];
let client: DBOSClient;
let detach: () => void = () => {};

beforeAll(async () => {
  detach = observeScanPlans(pool, plans);
  await enableAutoExplain(pool);
  client = await createScanClient(databaseUrl, pool);
  await seed('floor', 32_768, {
    application: `${prefix}floor`,
    status: 'SUCCESS',
    createdAt: cutoff - 400_000,
    completedAt: cutoff - 400_000,
  });
  await analyze();
});

afterAll(async () => {
  detach();
  await deleteScanRows(pool, `${prefix}%`);
  await client.destroy();
  await pool.end();
});

function ids(kind: string, amount: number, offset = 0): string[] {
  return Array.from(
    { length: amount },
    (_, index) => `${prefix}${kind}:${String(offset + index + 1).padStart(8, '0')}`,
  );
}

async function seed(
  kind: string,
  amount: number,
  fields: {
    readonly application: string;
    readonly status: string;
    readonly createdAt: number;
    readonly completedAt: number | null;
  },
  offset = 0,
): Promise<string[]> {
  const values = ids(kind, amount, offset);
  await insertScanStatus(pool, values, fields);
  await insertScanPayload(pool, values);
  return values;
}

async function analyze(): Promise<void> {
  await pool.query('ANALYZE dbos.workflow_status, dbos.workflow_input, dbos.workflow_output');
}

async function capture<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly captured: ScanPlan[] }> {
  const start = plans.length;
  const result = await run();
  return { result, captured: plans.slice(start) };
}

test('pending, recent-completed and unrelated prefixes grow independently at 256/1024/4096 with selected work fixed', async () => {
  const selectedIds = await seed('selected', selected, {
    application: `${prefix}pending`,
    status: 'SUCCESS',
    createdAt: cutoff - 10,
    completedAt: cutoff - 10,
  });
  let pendingGrown = 0;
  let recentGrown = 0;
  let foreignGrown = 0;
  const evidence: unknown[] = [];

  for (const scale of scales) {
    await seed(
      'pending',
      scale - pendingGrown,
      {
        application: `${prefix}pending`,
        status: 'PENDING',
        createdAt: cutoff - 10_000,
        completedAt: null,
      },
      pendingGrown,
    );
    pendingGrown = scale;
    await seed(
      'recent',
      scale - recentGrown,
      {
        application: `${prefix}recent`,
        status: 'SUCCESS',
        createdAt: cutoff - 8_000,
        completedAt: cutoff + 1,
      },
      recentGrown,
    );
    recentGrown = scale;
    await seed(
      'foreign',
      scale - foreignGrown,
      {
        application: `${prefix}foreign`,
        status: 'SUCCESS',
        createdAt: cutoff - 10_000,
        completedAt: cutoff - 10_000,
      },
      foreignGrown,
    );
    foreignGrown = scale;
    await analyze();

    const pendingOpen = await capture(() =>
      client.openWorkflowStatusScan({ applicationName: `${prefix}pending`, createdBefore: cutoff }),
    );
    const pendingPages = await capture(() => readAllPages(client, pendingOpen.result, WORKFLOW_STATUS_SCAN_RAW_LIMIT));
    const recentOpen = await capture(() =>
      client.openWorkflowStatusScan({ applicationName: `${prefix}recent`, createdBefore: cutoff }),
    );
    const recentPages = await capture(() => readAllPages(client, recentOpen.result, WORKFLOW_STATUS_SCAN_RAW_LIMIT));
    const foreignOpen = await capture(() =>
      client.openWorkflowStatusScan({ applicationName: `${prefix}foreign`, createdBefore: cutoff }),
    );
    const selectedOpen = await capture(() =>
      client.openWorkflowStatusScan({ applicationName: `${prefix}pending`, createdBefore: cutoff }),
    );
    const selectedPage = await capture(() =>
      client.readWorkflowStatusScanPage(
        {
          ...selectedOpen.result,
          lastExaminedKey: {
            createdAt: cutoff - 10_000,
            workflowID: ids('pending', 1, scale - 1)[0]!,
          },
        },
        { rawLimit: WORKFLOW_STATUS_SCAN_RAW_LIMIT },
      ),
    );

    for (const plan of [
      ...pendingOpen.captured,
      ...pendingPages.captured,
      ...recentOpen.captured,
      ...recentPages.captured,
      ...foreignOpen.captured,
      ...selectedOpen.captured,
      ...selectedPage.captured,
    ]) {
      expectIndexedScan(plan, plan.query.includes('scan-open') ? 'open' : 'page');
    }
    expect(pendingOpen.captured.some((plan) => plan.actualRows === 1)).toBe(true);
    expect(foreignOpen.captured.every((plan) => plan.actualRows <= 1)).toBe(true);
    expect(pendingPages.result.flatMap((page) => page.copies.map((copy) => copy.workflowID))).toEqual(selectedIds);
    expect(recentPages.result.flatMap((page) => page.copies)).toEqual([]);
    expect(pendingPages.result.every((page) => page.examined <= WORKFLOW_STATUS_SCAN_RAW_LIMIT)).toBe(true);
    expect(selectedPage.result.copies.map((copy) => copy.workflowID)).toEqual(selectedIds);
    expect(selectedPage.result.examined).toBe(selected);
    evidence.push({
      scale,
      pendingPages: pendingPages.result.map((page) => ({ examined: page.examined, copies: page.copies.length })),
      recentPages: recentPages.result.map((page) => ({ examined: page.examined, copies: page.copies.length })),
      selectedExamined: selectedPage.result.examined,
      opens: [pendingOpen, recentOpen, foreignOpen, selectedOpen].map(({ captured }) =>
        captured.map((plan) => ({
          rows: plan.actualRows,
          blocks: plan.sharedBlocks,
          indexes: plan.indexes,
          output: plan.output.slice(0, 8),
        })),
      ),
      pages: [...pendingPages.captured, ...recentPages.captured, ...selectedPage.captured].map((plan) => ({
        rows: plan.actualRows,
        blocks: plan.sharedBlocks,
        indexes: plan.indexes,
        output: plan.output.slice(0, 8),
        query: plan.query.includes('workflow_input') || plan.query.includes('workflow_output'),
      })),
    });
  }
  console.log(`workflow-status-scan-growth ${JSON.stringify(evidence)}`);
}, 180_000);
