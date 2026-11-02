import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from './growth-capture.ts';
import { GrowthCaptureBudget, parseNativePlanNotice } from './growth-capture-budget.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let database: GrowthDatabase | undefined;

beforeAll(async () => {
  database = await openGrowthDatabase(databaseUrl);
});

afterAll(async () => {
  await database?.close();
});

test('an exhausted capture drains work, returns no partial evidence, and can be reused', async () => {
  let operationFinished = false;
  await expect(
    capture(
      database!,
      async () => {
        const values = await withConnection(database!.pool, async (client) => {
          const first = await client.query('SELECT 1 AS value');
          const second = await client.query('SELECT 2 AS value');
          return [first.rows[0]?.value, second.rows[0]?.value];
        });
        operationFinished = true;
        return values;
      },
      { telemetryLimits: { entries: 1 } },
    ),
  ).rejects.toThrow(/Growth capture #\d+ exceeded telemetry entry capacity \(1 entries\)/);
  expect(operationFinished).toBe(true);

  const recovered = await capture(database!, () =>
    withConnection(database!.pool, (client) => client.query('SELECT 3 AS value')),
  );
  expect(recovered.value.rows[0]).toEqual({ value: 3 });
  expect(recovered.capture.statements).toEqual(['SELECT 3 AS value']);
});

test('foreground and background evidence share limits and oversized notices are rejected before parsing', () => {
  const entries = new GrowthCaptureBudget(71, { entries: 1 });
  entries.retainStatementText('foreground', 0);
  expect(() => entries.retainStatementText('background', 0)).toThrow(
    /Growth capture #71 exceeded telemetry entry capacity \(1 entries\)/,
  );

  const bytes = new GrowthCaptureBudget(72, { entries: 2, bytes: 4 });
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
