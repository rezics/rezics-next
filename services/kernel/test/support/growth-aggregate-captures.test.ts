import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import {
  capture,
  checkGrowth,
  costOf,
  mergeGrowthCaptures,
  openGrowthDatabase,
  type Capture,
  type GrowthDatabase,
} from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_aggregate_captures_test';
const table = `${schema}.locked_rows`;
const grown = `${schema}.grown_rows`;
const triggerInput = `${schema}.trigger_input`;
const triggerLookup = `${schema}.trigger_lookup`;
let primary: GrowthDatabase;
let secondary: GrowthDatabase;

beforeAll(async () => {
  primary = await openGrowthDatabase(databaseUrl);
  secondary = await openGrowthDatabase(databaseUrl);
  await primary.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await primary.admin.query(`CREATE SCHEMA ${schema}`);
  await primary.admin.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
  await primary.admin.query(`CREATE TABLE ${grown} (id integer PRIMARY KEY)`);
  await primary.admin.query(`INSERT INTO ${table} VALUES (1)`);
  await primary.admin.query(`CREATE TABLE ${triggerLookup} (id integer PRIMARY KEY)`);
  await primary.admin.query(`INSERT INTO ${triggerLookup} VALUES (1)`);
  await primary.admin.query(`CREATE TABLE ${triggerInput} (id integer PRIMARY KEY)`);
  await primary.admin.query(`CREATE FUNCTION ${schema}.read_lookup() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE matched integer;
    BEGIN
      SELECT id INTO matched FROM ${triggerLookup} WHERE id = 1;
      RETURN NEW;
    END $$`);
  await primary.admin.query(
    `CREATE TRIGGER read_lookup AFTER INSERT ON ${triggerInput} FOR EACH ROW EXECUTE FUNCTION ${schema}.read_lookup()`,
  );
});

afterAll(async () => {
  try {
    await primary?.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await Promise.all([primary?.close(), secondary?.close()]);
  }
});

function isNestedCapture(value: unknown): value is { readonly authCapture: Capture; readonly status: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authCapture' in value &&
    typeof (value as { authCapture?: { statements?: unknown } }).authCapture?.statements === 'object'
  );
}

function aggregateBoth(primaryCapture: Capture, value: unknown) {
  if (!isNestedCapture(value)) throw new TypeError('operation omitted its nested native capture');
  return {
    capture: mergeGrowthCaptures([primaryCapture, value.authCapture]),
    databases: [
      { name: 'kernel', capture: primaryCapture },
      { name: 'auth', capture: value.authCapture },
    ],
  };
}

async function lockedRead(): Promise<number> {
  const result = await primary.pool.query<{ id: number }>(`SELECT id FROM ${table} WHERE id = 1 FOR UPDATE`);
  return result.rows[0]?.id ?? 0;
}

async function triggerWrite(id: number): Promise<Capture> {
  const measured = await capture(
    secondary,
    () => secondary.pool.query(`INSERT INTO ${triggerInput} VALUES ($1)`, [id]),
    { includeBackends: true },
  );
  return measured.capture;
}

test.serial(
  'mergeGrowthCaptures keeps trigger plans and shared buffers across a public HTTP producer and nested native write',
  async () => {
    await primary.admin.query(`TRUNCATE ${table}, ${triggerInput}`);
    await primary.admin.query(`INSERT INTO ${table} VALUES (1)`);
    const detail = {
      operationId: 'probe.growth_aggregate',
      'x-action': 'probe:read',
      'x-exposure': 'public',
    };
    const app = createApp({ pool: primary.pool }).get('/growth-probe', { detail }, async () => ({
      id: await lockedRead(),
    }));
    const measured = await capture(
      primary,
      async () => {
        const response = await app.handle(new Request('http://kernel.test/growth-probe'));
        const authCapture = await triggerWrite(1);
        return { status: response.status, body: await response.json(), authCapture };
      },
      { includeBackends: true },
    );
    expect(measured.value.status).toBe(200);
    expect(measured.value.body).toEqual({ id: 1 });
    const kernelCost = costOf(measured.capture);
    const authCost = costOf(measured.value.authCapture);
    const merged = mergeGrowthCaptures([measured.capture, measured.value.authCapture]);
    expect(merged.planDatabases?.length).toBe(merged.plans.length);
    expect(merged.statements.some((sql) => sql.includes('FOR UPDATE'))).toBe(true);
    expect(merged.statements.some((sql) => sql.includes(`INSERT INTO ${triggerInput}`))).toBe(true);
    expect(
      merged.plans.some(
        (plan) =>
          typeof plan === 'object' &&
          plan !== null &&
          'Query Text' in plan &&
          typeof plan['Query Text'] === 'string' &&
          plan['Query Text'].includes(`FROM ${triggerLookup}`),
      ),
    ).toBe(true);
    expect(costOf(merged)).toMatchObject({
      rows: kernelCost.rows + authCost.rows,
      sharedHit: kernelCost.sharedHit + authCost.sharedHit,
      sharedRead: kernelCost.sharedRead + authCost.sharedRead,
      blocks: kernelCost.blocks + authCost.blocks,
    });
  },
);

test.serial(
  'checkGrowth classifies merged native captures at three scales and refuses an omitted database',
  async () => {
    await primary.admin.query(`TRUNCATE ${grown}, ${triggerInput}`);
    const report = await checkGrowth(primary, {
      name: 'aggregated kernel and auth captures',
      scales: [1, 8, 64],
      repetitions: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      aggregateCaptures: aggregateBoth,
      async grow(_database, scale, previous) {
        await primary.admin.query(`INSERT INTO ${grown} SELECT generate_series($1::integer, $2::integer)`, [
          previous + 1,
          scale,
        ]);
      },
      async prepare(_database, _scale, repetition) {
        await withConnection(primary.pool, async (client) => {
          await client.query('BEGIN');
          await client.query(`INSERT INTO ${grown} VALUES ($1)`, [1_000_000 + repetition]);
          await client.query('ROLLBACK');
        });
      },
      async operation(_database, _scale, repetition) {
        const id = await lockedRead();
        const authCapture = await triggerWrite(10_000 + repetition);
        return { status: 200, authCapture, id };
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([1, 8, 64]);
    for (const sample of report.samples) {
      expect(sample.cost.sharedHit).toBeGreaterThanOrEqual(0);
      expect(sample.cost.sharedRead).toBeGreaterThanOrEqual(0);
      expect(sample.cost.blocks).toBe(sample.cost.sharedHit + sample.cost.sharedRead);
      for (const statements of sample.statementRepetitions) {
        expect(statements.some((item) => item.statement.includes('FOR UPDATE'))).toBe(true);
        expect(statements.some((item) => item.statement.includes(`INSERT INTO ${triggerInput}`))).toBe(true);
      }
    }

    await expect(
      checkGrowth(primary, {
        name: 'omitted auth capture',
        scales: [1, 8, 64],
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        aggregateCaptures(primaryCapture, value) {
          const aggregated = aggregateBoth(primaryCapture, value);
          return { capture: aggregated.capture, databases: aggregated.databases.slice(0, 1) };
        },
        async grow() {},
        async operation(_database, _scale, repetition) {
          const authCapture = await triggerWrite(20_000 + repetition);
          return { status: 200, authCapture };
        },
      }),
    ).rejects.toThrow(/omitted auth capture: aggregateCaptures omitted native statements, plans or background work/);

    await expect(
      checkGrowth(primary, {
        name: 'stripped aggregate evidence',
        scales: [1, 8, 64],
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        aggregateCaptures(primaryCapture, value) {
          const aggregated = aggregateBoth(primaryCapture, value);
          return {
            capture: {
              statements: aggregated.capture.statements,
              plans: aggregated.capture.plans,
              requestBytes: aggregated.capture.statements.map(() => 0),
              responseBytes: aggregated.capture.statements.map(() => 0),
              backgroundStatements: aggregated.capture.backgroundStatements,
            },
            databases: aggregated.databases,
          };
        },
        async grow() {},
        async operation(_database, _scale, repetition) {
          const authCapture = await triggerWrite(30_000 + repetition);
          return { status: 200, authCapture };
        },
      }),
    ).rejects.toThrow(
      /stripped aggregate evidence: aggregateCaptures omitted native statements, plans or background work/,
    );
  },
  120_000,
);
