import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  assertGrowth,
  GrowthBoundError,
  growthViolations,
  type Bound,
  type GrowthSample,
  type Metric,
} from './growth-bound.ts';
import { assertGrowthAccessPaths, type AccessPathSample } from './growth-access-path.ts';
import { capture, openGrowthDatabase, settle } from './growth.ts';
import { costOf, type Cost } from './growth-cost.ts';

const allBounds = (bound: Bound): Record<Metric, Bound> => ({
  rows: bound,
  blocks: 'constant',
  statements: 'constant',
});
const series = (scales: readonly [number, number, number], values: readonly [number, number, number]): GrowthSample[] =>
  scales.map((scale, index) => ({
    scale,
    cost: { rows: values[index]!, blocks: 1, statements: 1 },
  }));

for (const scales of [
  [1, 8, 64],
  [2, 16, 128],
] as const) {
  test(`accepts constant, logarithmic and linear series at scales ${scales.join(', ')}`, () => {
    const constant = series(scales, [7, 7, 8]);
    const logarithmic = series(scales, scales.map((x) => 3 + 2 * Math.log2(x)) as [number, number, number]);
    const linear = series(scales, scales.map((x) => 10 * x) as [number, number, number]);
    expect(growthViolations(constant, allBounds('constant'))).toEqual([]);
    expect(growthViolations(logarithmic, allBounds('logarithmic'))).toEqual([]);
    expect(growthViolations(linear, allBounds('linear'))).toEqual([]);
  });
}

test('rejects linear growth declared logarithmic and power growth faster than a cube root', () => {
  const scales = [1, 8, 64] as const;
  expect(growthViolations(series(scales, scales), allBounds('logarithmic'))).toHaveLength(1);
  expect(
    growthViolations(
      series(scales, scales.map((x) => Math.sqrt(x)) as [number, number, number]),
      allBounds('logarithmic'),
      { rows: { absolute: 0, relative: 0 } },
    ),
  ).toHaveLength(1);
});

test('rejects quadratic growth declared linear', () => {
  const scales = [1, 8, 64] as const;
  expect(
    growthViolations(series(scales, scales.map((x) => x * x) as [number, number, number]), allBounds('linear')),
  ).toHaveLength(1);
});

test('rejects any growth beyond slack for a constant bound', () => {
  expect(growthViolations(series([1, 8, 64], [7, 10, 11]), allBounds('constant'))).toHaveLength(1);
});

test('absorbs one B-tree level of growth in blocks under default slack', () => {
  const samples: GrowthSample[] = [30, 30, 40].map((blocks, index) => ({
    scale: [1, 8, 64][index]!,
    cost: { rows: 1, blocks, statements: 1 },
  }));
  expect(growthViolations(samples, { rows: 'constant', blocks: 'logarithmic', statements: 'constant' })).toEqual([]);
  expect(growthViolations(samples, { rows: 'constant', blocks: 'constant', statements: 'constant' })).toEqual([]);
});

test('requires three increasing scales with an equal ratio of at least four', () => {
  for (const scales of [
    [1, 8],
    [1, 8, 32],
    [1, 4, 16.1],
    [1, 3, 9],
    [1, 8, 63],
  ] as number[][]) {
    expect(() =>
      growthViolations(
        scales.map((scale) => ({ scale, cost: { rows: 1, blocks: 1, statements: 1 } })),
        allBounds('constant'),
      ),
    ).toThrow(TypeError);
  }
  expect(() => growthViolations(series([1, 8, 64], [1, Number.NaN, 1]), allBounds('constant'))).toThrow(TypeError);
});

test('names the metric, values and largest relations in the error', () => {
  const samples = series([1, 8, 64], [1, 8, 64]).map((sample, index) => ({
    ...sample,
    cost: {
      ...sample.cost,
      ...(index === 2
        ? {
            relations: {
              small_table: { rows: 5, blocks: 2 },
              largest_rows: { rows: 100, blocks: 3 },
              largest_blocks: { rows: 4, blocks: 90 },
            },
          }
        : {}),
    },
  }));
  let error: unknown;
  try {
    assertGrowth(samples, { rows: 'logarithmic', blocks: 'constant', statements: 'constant' });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GrowthBoundError);
  expect((error as Error).message).toContain('rows');
  expect((error as Error).message).toContain('1, 8, 64');
  expect((error as Error).message).toContain('largest_rows');
  expect((error as Error).message).toContain('largest_blocks');
});

test('names sequentially scanned relations in a bound error', () => {
  const samples: GrowthSample[] = [1, 8, 64].map((scale, index) => ({
    scale,
    cost: {
      rows: [1, 10, 100][index]!,
      blocks: 1,
      statements: 1,
      relations: {
        small_relation: { rows: 100, blocks: 2, sequentialScans: index === 2 ? 1 : 0 },
      },
    },
  }));
  let error: unknown;
  try {
    assertGrowth(samples, allBounds('constant'));
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(GrowthBoundError);
  expect((error as Error).message).toContain(
    "Sequential scans: small_relation (100 rows) (a sequential scan of a small relation is the planner's choice; seed every relation the operation reads to thousands of rows at the smallest scale)",
  );

  const withoutScans = samples.map((sample) => ({
    ...sample,
    cost: { ...sample.cost, relations: { small_relation: { rows: 100, blocks: 2, sequentialScans: 0 } } },
  }));
  let errorWithoutScans: unknown;
  try {
    assertGrowth(withoutScans, allBounds('constant'));
  } catch (caught) {
    errorWithoutScans = caught;
  }
  expect(errorWithoutScans).toBeInstanceOf(GrowthBoundError);
  expect((errorWithoutScans as Error).message).not.toContain('Sequential scans:');
});

test('an access-path rejection reports its exact measured relation, scale, pages, repetition and scan count', () => {
  const relation = 'content.report';
  const repetition: Cost = {
    rows: 68,
    blocks: 2,
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 1,
    sharedHit: 2,
    sharedRead: 0,
    relations: { [relation]: { rows: 68, blocks: 2, nodes: 1, sequentialScans: 1 } },
  };
  const sample: AccessPathSample = {
    scale: 256,
    relationSizes: { [relation]: { reltuples: 520, relpages: 9 } },
    repetitions: [repetition],
  };

  let error: unknown;
  try {
    assertGrowthAccessPaths('content reports', [sample], [relation]);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  const diagnostic = (error as Error).message;
  expect(diagnostic).toContain('content reports');
  expect(diagnostic).toContain(relation);
  expect(diagnostic).toContain('scale 256');
  expect(diagnostic).toContain('9 pages');
  expect(diagnostic).toContain('repetition 1');
  expect(diagnostic).toContain('1 sequential scan');
});

test('settled PostgreSQL pages govern scans without changing measured costs or growth verdicts', async () => {
  const database = await openGrowthDatabase();
  const schema = `growth_access_path_${randomUUID().replaceAll('-', '')}`;
  const smallRelation = `${schema}.small_table`;
  const largeRelation = `${schema}.large_table`;
  const smallSql = `"${schema}"."small_table"`;
  const largeSql = `"${schema}"."large_table"`;
  let schemaCreated = false;
  try {
    await database.admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await database.admin.query(`CREATE TABLE ${smallSql} (id integer NOT NULL)`);
    await database.admin.query(`INSERT INTO ${smallSql} (id) VALUES (1)`);
    await database.admin.query(`CREATE TABLE ${largeSql} (id integer NOT NULL, payload text NOT NULL)`);

    let largeSize: { reltuples: number; relpages: number } | undefined;
    for (let batch = 0; batch < 4; batch++) {
      const first = batch * 128 + 1;
      const last = first + 127;
      await database.admin.query(
        `INSERT INTO ${largeSql} (id, payload)
         SELECT rows.id, string_agg(md5((rows.id * 32 + chunks.n)::text), '' ORDER BY chunks.n)
           FROM generate_series($1::integer, $2::integer) AS rows(id)
           CROSS JOIN generate_series(1, 32) AS chunks(n)
          GROUP BY rows.id`,
        [first, last],
      );
      await settle(database, { relations: [smallRelation, largeRelation], analyze: true });
      const size = await database.admin.query<{ reltuples: number; relpages: number }>(
        `SELECT reltuples::float8 AS reltuples, relpages::integer AS relpages
           FROM pg_class WHERE oid = $1::regclass`,
        [largeRelation],
      );
      largeSize = {
        reltuples: Number(size.rows[0]!.reltuples),
        relpages: Number(size.rows[0]!.relpages),
      };
      if (largeSize.relpages > 8) break;
    }

    const smallSizeResult = await database.admin.query<{ reltuples: number; relpages: number }>(
      `SELECT reltuples::float8 AS reltuples, relpages::integer AS relpages
         FROM pg_class WHERE oid = $1::regclass`,
      [smallRelation],
    );
    const smallSize = {
      reltuples: Number(smallSizeResult.rows[0]!.reltuples),
      relpages: Number(smallSizeResult.rows[0]!.relpages),
    };
    expect(smallSize.relpages).toBeGreaterThanOrEqual(0);
    expect(smallSize.relpages).toBeLessThanOrEqual(8);
    expect(largeSize).toBeDefined();
    expect(largeSize!.relpages).toBeGreaterThan(8);

    const smallCapture = await capture(database, () =>
      database.pool.query(`SELECT id FROM ${smallSql} WHERE id >= 0`),
    );
    const largeCapture = await capture(database, () =>
      database.pool.query(`SELECT id FROM ${largeSql} WHERE id >= 0`),
    );
    const smallCost = costOf(smallCapture.capture);
    const largeCost = costOf(largeCapture.capture);
    const smallScans = smallCost.relations[smallRelation]?.sequentialScans;
    const largeScans = largeCost.relations[largeRelation]?.sequentialScans;
    expect(smallCost.relations[smallRelation]?.rows).toBeGreaterThan(0);
    expect(smallCost.relations[smallRelation]?.blocks).toBeGreaterThan(0);
    expect(smallScans).toBeGreaterThan(0);
    expect(largeCost.relations[largeRelation]?.rows).toBeGreaterThan(0);
    expect(largeCost.relations[largeRelation]?.blocks).toBeGreaterThan(0);
    expect(largeScans).toBeGreaterThan(0);

    const makeSample = (
      scale: number,
      relation: string,
      size: { reltuples: number; relpages: number },
      cost: Cost,
    ): AccessPathSample => ({
      scale,
      relationSizes: { [relation]: size },
      repetitions: [cost],
    });
    const samples = [
      makeSample(32, smallRelation, smallSize, smallCost),
      makeSample(256, largeRelation, largeSize!, largeCost),
    ];
    const measuredBefore = JSON.stringify([smallCost, largeCost]);
    const growthSamples = [smallCost, largeCost, largeCost].map((cost, index) => ({
      scale: [1, 8, 64][index]!,
      cost: { rows: cost.rows, blocks: cost.blocks, statements: cost.statements },
    }));
    const verdictBefore = growthViolations(growthSamples, allBounds('constant'));

    expect(() => assertGrowthAccessPaths('tiny relation scan', [samples[0]!], [smallRelation])).not.toThrow();
    let error: unknown;
    try {
      assertGrowthAccessPaths('large relation scan', [samples[1]!], [largeRelation]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const diagnostic = (error as Error).message;
    expect(diagnostic).toContain('large relation scan');
    expect(diagnostic).toContain(largeRelation);
    expect(diagnostic).toContain('scale 256');
    expect(diagnostic).toContain(`${largeSize!.relpages} pages`);
    expect(diagnostic).toContain('repetition 1');
    expect(diagnostic).toContain(`${largeScans} sequential scan`);
    expect(JSON.stringify([smallCost, largeCost])).toBe(measuredBefore);
    expect(growthViolations(growthSamples, allBounds('constant'))).toEqual(verdictBefore);
  } finally {
    try {
      if (schemaCreated) await database.admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await database.close();
    }
  }
});
