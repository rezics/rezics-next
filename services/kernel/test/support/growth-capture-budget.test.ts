import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';
import { GrowthCaptureBudget, parseNativePlanNotice } from './growth-capture-budget.ts';
import { captureWithFoldedCost, growthFailureEvidence } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let database: GrowthDatabase | undefined;

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
});

afterAll(async () => {
  await database?.close();
});

test('an exhausted raw capture drains work, keeps bounded native evidence, and can be reused', async () => {
  let operationFinished = false;
  let failure: unknown;
  try {
    await capture(
      database!,
      async () => {
        const values = await withConnection(database!.pool, async (client) => {
          const values = [];
          for (let index = 1; index <= 8; index++) {
            const result = await client.query(`SELECT ${index} AS value`);
            values.push(result.rows[0]?.value);
          }
          return values;
        });
        operationFinished = true;
        return values;
      },
      { telemetryLimits: { entries: 8 } },
    );
  } catch (error) {
    failure = error;
  }
  expect(operationFinished).toBe(true);
  expect(failure).toBeInstanceOf(Error);
  const evidence = growthFailureEvidence(failure);
  expect(evidence).toMatchObject({ status: 'incomplete', phase: 'capture-retention' });
  const raw = evidence?.native as {
    mode: string;
    statements: readonly { text: string; index: number }[];
    foregroundPlans: readonly unknown[];
    foregroundPlanStatements: readonly (number | undefined)[];
    missingPlanOccurrences: readonly { index: number; text: string }[];
  };
  expect(raw.mode).toBe('raw');
  expect(raw.statements[0]).toMatchObject({ text: 'SELECT 1 AS value', index: 0 });
  expect(raw.foregroundPlans.length).toBeGreaterThan(0);
  expect(raw.foregroundPlanStatements).toContain(0);
  expect(raw.missingPlanOccurrences.length).toBeGreaterThan(0);
  expect(evidence?.omissions?.missingPlans).toBeGreaterThan(0);

  const recovered = await capture(database!, () =>
    withConnection(database!.pool, (client) => client.query('SELECT 3 AS value')),
  );
  expect(recovered.value.rows[0]).toEqual({ value: 3 });
  expect(recovered.capture.statements).toEqual(['SELECT 3 AS value']);
});

test('a folded capacity failure drains its caller, keeps costs when available, and the next capture is clean', async () => {
  let operationFinished = false;
  let failure: unknown;
  try {
    await captureWithFoldedCost(
      database!,
      async () => {
        const result = await withConnection(database!.pool, async (client) => {
          const values = [];
          for (let index = 1; index <= 12; index++) {
            const query = await client.query(`SELECT ${index} AS value`);
            values.push(query.rows[0]?.value);
          }
          return values;
        });
        operationFinished = true;
        return result;
      },
      { telemetryLimits: { entries: 8 } },
    );
  } catch (error) {
    failure = error;
  }
  expect(operationFinished).toBe(true);
  const evidence = growthFailureEvidence(failure);
  expect(evidence).toMatchObject({ status: 'incomplete', phase: 'capture-retention' });
  const folded = evidence?.native as {
    mode: string;
    statements: readonly { text: string; index: number }[];
    foldedCapture?: {
      kind: string;
      statements: readonly string[];
      planNotices: readonly { owner?: number; database: string }[];
    };
  };
  expect(folded.mode).toBe('cost-folded');
  expect(folded.statements[0]).toMatchObject({ text: 'SELECT 1 AS value', index: 0 });
  expect(folded.foldedCapture?.kind).toBe('growth-cost-folded');
  expect(folded.foldedCapture?.statements).toContain('SELECT 1 AS value');
  expect(folded.foldedCapture?.planNotices).toContainEqual(
    expect.objectContaining({ owner: 0, database: expect.any(String) }),
  );

  const recovered = await captureWithFoldedCost(database!, () =>
    withConnection(database!.pool, (client) => client.query('SELECT 5 AS value')),
  );
  expect(recovered.value.rows[0]).toEqual({ value: 5 });
  expect(recovered.capture.statements).toEqual(['SELECT 5 AS value']);
  expect(recovered.capture.rawPlansRetained).toBe(false);
});

test('foreground and background evidence share limits and oversized notices are rejected before parsing', () => {
  const entries = new GrowthCaptureBudget(71, { entries: 1 });
  entries.releaseFailureContextReserve();
  entries.retainStatementText('foreground', 0);
  expect(() => entries.retainStatementText('background', 0)).toThrow(
    /Growth capture #71 exceeded telemetry entry capacity \(1 entries\)/,
  );

  const bytes = new GrowthCaptureBudget(72, { entries: 2, bytes: 4 });
  bytes.releaseFailureContextReserve();
  bytes.retainStatementText('foreground', 3);
  let parsed = false;
  expect(() =>
    parseNativePlanNotice(bytes, '1', 'background', () => {
      parsed = true;
      return null;
    }),
  ).toThrow(/Growth capture #72 exceeded telemetry byte capacity \(4 charged bytes\)/);
  expect(parsed).toBe(false);

  expect(() =>
    parseNativePlanNotice(new GrowthCaptureBudget(73, { nativeNoticeBytes: 4 }), '12345', 'background', () => {
      parsed = true;
      return null;
    }),
  ).toThrow(/Growth capture #73 exceeded native notice byte capacity \(4 bytes\)/);
  expect(parsed).toBe(false);
});

test('folded summaries replace temporary notice bytes and recycle notice envelope entries', () => {
  const budget = new GrowthCaptureBudget(74, { entries: 2, bytes: 1_000, nativeNoticeBytes: 100 });
  budget.releaseFailureContextReserve();
  const notice = budget.retainNativeNotice(50, 'foreground');
  expect(budget.entriesUsed).toBe(1);
  expect(budget.chargedBytes).toBe(400);
  budget.retainFoldedSummary('foreground', 'cost summary', 0, 300);
  notice.release();
  expect(budget.entriesUsed).toBe(0);
  expect(budget.chargedBytes).toBe(300);
  for (let index = 0; index < 8; index++) {
    const next = budget.retainNativeNotice(10, 'foreground');
    expect(budget.entriesUsed).toBe(1);
    next.release();
    expect(budget.entriesUsed).toBe(0);
  }
  budget.retainNativePlanNode('foreground');
  budget.retainFoldedSummary('background', 'next occurrence', 1, 0);
  expect(budget.entriesUsed).toBe(2);
  expect(() => budget.retainFoldedSummary('background', 'overflow', 1, 0)).toThrow(
    /current 2, requested 1, total 3 entries/,
  );
});

test('ordinary capture work leaves an explicitly charged entry and byte envelope for failure context', () => {
  const budget = new GrowthCaptureBudget(75, { entries: 2, bytes: 1_000 });
  budget.retainStatementText('foreground', 500);
  expect(() => budget.retainStatementText('background', 0)).toThrow(/reserved for failure context/);

  budget.retainFailureContext(400);
  expect(budget.entriesUsed).toBe(2);
  expect(budget.chargedBytes).toBe(900);
  expect(() => budget.retainFailureContext(200)).toThrow(/failure context exceeded its reserved capacity/);
});
