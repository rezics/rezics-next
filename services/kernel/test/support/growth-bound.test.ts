import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  affineEnvelope,
  assertGrowth,
  classifyEngineWork,
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

test('growth bounds reject negative measured work and invalid optional evidence', () => {
  for (const metric of ['rows', 'blocks', 'statements'] as const) {
    const samples = [1, 8, 64].map((scale) => ({
      scale,
      cost: { rows: 0, blocks: 0, statements: 0, [metric]: -1 },
    }));
    expect(() => growthViolations(samples, allBounds('constant'))).toThrow(TypeError);
  }
  expect(() =>
    growthViolations(
      [1, 8, 64].map((scale) => ({ scale, cost: { rows: 0, blocks: 0, statements: 0, requestBytes: -1 } })),
      allBounds('constant'),
    ),
  ).toThrow(TypeError);
  expect(() =>
    growthViolations(
      [1, 8, 64].map((scale) => ({
        scale,
        cost: { rows: 0, blocks: 0, statements: 0, relations: { 'app.items': { rows: -1, blocks: 0 } } },
      })),
      allBounds('constant'),
    ),
  ).toThrow(TypeError);
  expect(() =>
    growthViolations(
      series([1, 8, 64], [1, 1, 1]).map((sample) => ({
        ...sample,
        cost: { ...sample.cost, backgroundRows: -1 },
      })),
      allBounds('constant'),
    ),
  ).toThrow(/backgroundRows/);
  expect(growthViolations(series([1, 8, 64], [0, 0, 0]), allBounds('constant'))).toEqual([]);
});

test('growth-bound arithmetic refuses overflow in scale ratios, slack and derived allowance', () => {
  expect(() =>
    growthViolations(
      [Number.MIN_VALUE, 1, 4096].map((scale) => ({ scale, cost: { rows: 1, blocks: 1, statements: 1 } })),
      allBounds('constant'),
    ),
  ).toThrow(TypeError);
  expect(() =>
    growthViolations(
      series([1, 8, 64], [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE]),
      allBounds('constant'),
      {
        rows: { absolute: 0, relative: 2 },
      },
    ),
  ).toThrow(/Relative rows growth slack/);
  expect(() =>
    growthViolations(series([1, 8, 64], [0, Number.MAX_VALUE, Number.MAX_VALUE]), allBounds('linear'), {
      rows: { absolute: 0, relative: 0 },
    }),
  ).toThrow(/rows growth allowance/);
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
    "Sequential scans: small_relation (100 rows) (a sequential scan may be a planner's choice for a small relation; use measured relation pages for the path guard; the growth bounds still apply)",
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
    repetitions: [
      { ...repetition, relations: { [relation]: { ...repetition.relations[relation]!, sequentialScans: 0 } } },
      repetition,
      { ...repetition, relations: { [relation]: { ...repetition.relations[relation]!, sequentialScans: 0 } } },
    ],
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
  expect(diagnostic).toContain('actual pages 9');
  expect(diagnostic).toContain('repetition 2');
  expect(diagnostic).toContain('scan count 1');
});

test('an observed relation needs an explicit finite nonnegative scan count', () => {
  const relation = 'content.report';
  const measured: Omit<Cost, 'relations'> = {
    rows: 68,
    blocks: 2,
    statements: 1,
    controlStatements: 0,
    catalogStatements: 0,
    plans: 1,
    sharedHit: 2,
    sharedRead: 0,
  };
  const makeSample = (scans: number | undefined): AccessPathSample => ({
    scale: 32,
    relationSizes: { [relation]: { reltuples: 68, relpages: 2 } },
    repetitions: [
      {
        ...measured,
        relations: {
          [relation]: {
            rows: 68,
            blocks: 2,
            nodes: 1,
            ...(scans === undefined ? {} : { sequentialScans: scans }),
          },
        },
      } as unknown as Cost,
    ],
  });

  expect(() => assertGrowthAccessPaths('missing scans', [makeSample(undefined)], [relation])).toThrow(
    /scan count missing/,
  );
  for (const scans of [NaN, Infinity, -1])
    expect(() => assertGrowthAccessPaths('invalid scans', [makeSample(scans)], [relation])).toThrow(
      /invalid sequential scan count/,
    );
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

    const smallCapture = await capture(database, () => database.pool.query(`SELECT id FROM ${smallSql} WHERE id >= 0`));
    const largeCapture = await capture(database, () => database.pool.query(`SELECT id FROM ${largeSql} WHERE id >= 0`));
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
    expect(diagnostic).toContain(`actual pages ${largeSize!.relpages}`);
    expect(diagnostic).toContain('repetition 1');
    expect(diagnostic).toContain(`scan count ${largeScans}`);
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

test('an affine intercept plus linear slope passes the linear family and records packing residuals', () => {
  const scales = [1, 8, 64] as const;
  const affine = scales.map((scale) => 80 + 2.5 * scale) as [number, number, number];
  expect(growthViolations(series(scales, affine), allBounds('linear'))).toEqual([]);
  const envelope = affineEnvelope(scales, affine);
  expect(envelope.intercept).toBeCloseTo(80, 6);
  expect(envelope.slope).toBeCloseTo(2.5, 6);
  expect(envelope.maxResidual).toBeLessThan(1e-6);
});

test('a packing jump that is not affine fails linear and keeps relation and scan evidence', () => {
  const samples = series([1, 8, 64], [80, 90, 400]).map((sample, index) => ({
    ...sample,
    cost: {
      ...sample.cost,
      relations: {
        'dbos.workflow_events': {
          rows: [10, 80, 640][index]!,
          blocks: [80, 90, 400][index]!,
          sequentialScans: index === 2 ? 1 : 0,
        },
      },
    },
    relationSizes: {
      'dbos.workflow_events': {
        reltuples: [32_778, 32_848, 33_408][index]!,
        relpages: [200, 180, 90][index]!,
      },
    },
  }));
  const violations = growthViolations(samples, allBounds('linear'), { rows: { absolute: 0, relative: 0 } });
  expect(violations.length).toBeGreaterThan(0);
  let error: unknown;
  try {
    assertGrowth(samples, allBounds('linear'), { rows: { absolute: 0, relative: 0 } });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GrowthBoundError);
  expect((error as Error).message).toContain('dbos.workflow_events');
  expect((error as Error).message).toContain('Plan transitions');
  expect((error as Error).message).toContain('heap packing');
  const envelope = affineEnvelope([1, 8, 64], [80, 90, 400]);
  expect(envelope.maxResidual).toBeGreaterThan(50);
  const classified = classifyEngineWork(samples);
  expect(classified.class).toBe('plan-transition');
  expect(classified.packing.some((line) => line.includes('heap packing'))).toBe(true);
  expect(classified.planTransitions.length).toBeGreaterThan(0);
  expect(classified.envelope.maxResidual).toBeGreaterThan(50);
});

test('an affine series stays affine and does not reprice background or packing', () => {
  const blocks = [80, 97.5, 240] as const;
  const samples = series([1, 8, 64], [10, 10, 10]).map((sample, index) => ({
    ...sample,
    cost: { ...sample.cost, blocks: blocks[index]!, backgroundStatements: 0 },
  }));
  const classified = classifyEngineWork(samples);
  expect(classified.class).toBe('affine');
  expect(classified.backgroundGrew).toBe(false);
  expect(classified.envelope.slope).toBeGreaterThan(0);
  expect(growthViolations(samples, { rows: 'constant', blocks: 'linear', statements: 'constant' })).toEqual([]);
});

test('background growth is classified separately from the linear family', () => {
  const blocks = [80, 97.5, 240] as const;
  const samples = series([1, 8, 64], [10, 10, 10]).map((sample, index) => ({
    ...sample,
    cost: { ...sample.cost, blocks: blocks[index]!, backgroundStatements: index },
  }));
  const classified = classifyEngineWork(samples);
  expect(classified.class).toBe('background');
  expect(classified.backgroundGrew).toBe(true);
  expect(growthViolations(samples, { rows: 'constant', blocks: 'linear', statements: 'constant' })).toEqual([]);
});

test('independent background rows, buffers, and bytes remain visible when statement count is flat', () => {
  const metrics = ['backgroundRows', 'backgroundBlocks', 'backgroundRequestBytes', 'backgroundResponseBytes'] as const;
  for (const metric of metrics) {
    const samples = series([1, 8, 64], [10, 10, 10]).map((sample, index) => ({
      ...sample,
      cost: {
        ...sample.cost,
        backgroundStatements: 1,
        [metric]: [1, 8, 64][index]!,
      },
    }));
    const classified = classifyEngineWork(samples);
    expect(classified.class, metric).toBe('background');
    expect(classified.backgroundGrew, metric).toBe(true);
    expect(growthViolations(samples, allBounds('constant')), metric).toEqual([]);
  }

  let error: unknown;
  try {
    assertGrowth(
      series([1, 8, 64], [10, 80, 640]).map((sample, index) => ({
        ...sample,
        cost: {
          ...sample.cost,
          backgroundStatements: 1,
          backgroundRows: [4, 32, 256][index]!,
          backgroundBlocks: [2, 16, 128][index]!,
          backgroundRequestBytes: [64, 512, 4096][index]!,
          backgroundResponseBytes: [32, 256, 2048][index]!,
        },
      })),
      allBounds('constant'),
    );
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(GrowthBoundError);
  expect((error as Error).message).toContain('Scale 64 independent background work');
  expect((error as Error).message).toContain('backgroundRows 256');
  expect((error as Error).message).toContain('backgroundBlocks 128');
  expect((error as Error).message).toContain('backgroundRequestBytes 4096');
  expect((error as Error).message).toContain('backgroundResponseBytes 2048');
});
