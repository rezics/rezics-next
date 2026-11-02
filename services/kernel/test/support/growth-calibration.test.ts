import { expect, test } from 'bun:test';
import { growthCalibrationReport } from '../../scripts/growth-calibrate.ts';
import {
  GROWTH_CALIBRATION_LIMITS,
  calibrateUncertainty,
  detectableSlope,
  type CalibrationCheck,
} from './growth-calibration.ts';

const scales = [1, 4, 16, 64, 256];

function checkRuns(check: string, runs: readonly (readonly number[])[]): CalibrationCheck {
  return {
    check,
    runs: runs.map((values) =>
      values.map((value, index) => ({
        scale: scales[index]!,
        repetitions: [value, value, value],
      })),
    ),
  };
}

function jitteredRun(values: readonly number[], halfSpread: number) {
  return values.map((value, index) => ({
    scale: scales[index]!,
    repetitions: [value - halfSpread, value, value + halfSpread],
  }));
}

test('calibration finds the smallest absolute and relative uncertainty that covers the unchanged-code series', () => {
  const statementsValues = [10, 14, 20, 28, 40];
  const rowsValues = scales.map(() => 20);
  const blocksValues = [20, 40, 80, 160, 320];
  const statements = calibrateUncertainty([
    checkRuns(
      'statements',
      Array.from({ length: 5 }, () => statementsValues),
    ),
  ]);
  expect(statements).toMatchObject({ absolute: 0, relative: 0, exact: true, points: 25, heldOutCoverage: 1 });

  const rows = calibrateUncertainty([
    { check: 'rows', runs: Array.from({ length: 5 }, () => jitteredRun(rowsValues, 1)) },
  ]);
  expect(rows.absolute).toBe(1);
  expect(rows.relative).toBe(0);

  const proportional = calibrateUncertainty([
    {
      check: 'blocks',
      runs: Array.from({ length: 5 }, () =>
        blocksValues.map((value, index) => ({
          scale: scales[index]!,
          repetitions: [value * 0.9, value, value * 1.1],
        })),
      ),
    },
  ]);
  expect(proportional.relative).toBeGreaterThan(0);
  // The relative term captures the growing spread with a smaller floor than the absolute rows fit.
  expect(proportional.absolute).toBeLessThan(rows.absolute);
});

test('calibration reports exact metrics and validates on held-out runs', () => {
  const stationary = checkRuns(
    'stationary',
    Array.from({ length: 5 }, () => [10, 10, 10, 10, 10]),
  );
  const exact = calibrateUncertainty([stationary]);
  expect(exact).toEqual({
    absolute: 0,
    relative: 0,
    exact: true,
    points: 25,
    heldOutCoverage: 1,
    worst: [1, 4, 16, 64, 256].map((scale) => ({
      check: 'stationary',
      run: 0,
      scale,
      reference: 10,
      need: 0,
    })),
  });

  const outlierRuns = Array.from({ length: 5 }, (_, run) => {
    const values = [10, 10, 10, 10, 10];
    if (run === 4) values[2] = 20;
    return values;
  });
  const tolerated = calibrateUncertainty([checkRuns('outlier', outlierRuns)], { coverage: 0.9 });
  const fullyCovered = calibrateUncertainty([checkRuns('outlier', outlierRuns)]);
  expect(tolerated.absolute).toBe(0);
  expect(fullyCovered.absolute).toBe(10);

  const shifted = checkRuns('shifted', [
    [10, 10, 10, 10, 10],
    [10, 10, 10, 10, 10],
    [20, 20, 20, 20, 20],
  ]);
  const shiftedResult = calibrateUncertainty([shifted]);
  expect(shiftedResult.heldOutCoverage).toBeLessThan(1);
  expect(shiftedResult.worst).toEqual(
    [1, 4, 16, 64, 256].map((scale) => ({
      check: 'shifted',
      run: 2,
      scale,
      reference: 10,
      need: 10,
    })),
  );

  const twoRuns = checkRuns('two-runs', [
    [10, 10, 10, 10, 10],
    [20, 20, 20, 20, 20],
  ]);
  expect(calibrateUncertainty([twoRuns]).heldOutCoverage).toBe(0);
});

test('calibration keeps the fit objective finite for large finite measurements', () => {
  const maximum = Number.MAX_VALUE;
  const result = calibrateUncertainty([
    {
      check: 'large',
      runs: Array.from({ length: 5 }, (_, run) => [
        { scale: 1, repetitions: [run === 4 ? maximum / 2 : maximum] },
        { scale: 4, repetitions: [maximum / 10] },
      ]),
    },
  ]);
  expect(result).toMatchObject({ absolute: 0, relative: 0.5, points: 10 });
});

test('the detectable effect is the smallest linear slope a constant or logarithmic bound rejects at the given scales', () => {
  const base = 100;
  const uncertainty = { absolute: 5, relative: 0 };
  const dense = detectableSlope([1, 4, 16, 64, 256], uncertainty, 'constant', base);
  const sparse = detectableSlope([1, 8, 64], uncertainty, 'constant', base);
  expect(dense).toBeLessThan(sparse);

  const exact = detectableSlope([1, 4, 16, 64, 256], { absolute: 0, relative: 0 }, 'constant', base);
  expect(exact).toBeLessThan(1e-6 * base);

  const logarithmic = detectableSlope([1, 4, 16, 64, 256], uncertainty, 'logarithmic', base);
  expect(logarithmic).toBeGreaterThan(dense);
  expect(Number.isFinite(logarithmic)).toBe(true);
  expect(detectableSlope([1, 4, 16, 64, 256], { absolute: 10, relative: 0.95 }, 'logarithmic', base)).toBe(
    Number.POSITIVE_INFINITY,
  );

  const beyondSearchCap = detectableSlope([1, 4, 16], { absolute: 1e12, relative: 0 }, 'constant', base);
  expect(Number.isFinite(beyondSearchCap)).toBe(true);
  expect(beyondSearchCap).toBeGreaterThan(1e9);
});

test('calibration refuses work above advertised capacity and names the input', () => {
  const extraRuns = Array.from({ length: GROWTH_CALIBRATION_LIMITS.runsPerCheck + 1 }, () => [
    { scale: 1, repetitions: [1] },
  ]);
  expect(() => calibrateUncertainty([{ check: 'heavy-run', runs: extraRuns }])).toThrow(
    `Calibration check heavy-run exceeds the ${GROWTH_CALIBRATION_LIMITS.runsPerCheck} run capacity (${extraRuns.length} runs)`,
  );

  const extraChecks = Array.from({ length: GROWTH_CALIBRATION_LIMITS.checks + 1 }, (_, index) =>
    checkRuns(`check-${index}`, [
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
    ]),
  );
  expect(() => calibrateUncertainty(extraChecks)).toThrow(
    `Calibration exceeds the ${GROWTH_CALIBRATION_LIMITS.checks} check capacity (${extraChecks.length} checks)`,
  );

  const scaleCount = Math.floor(GROWTH_CALIBRATION_LIMITS.points / 2) + 1;
  const wideRun = Array.from({ length: scaleCount }, (_, index) => ({ scale: index + 1, repetitions: [1] }));
  expect(() => calibrateUncertainty([{ check: 'wide', runs: [wideRun, wideRun] }])).toThrow(
    `Calibration check wide exceeds the ${GROWTH_CALIBRATION_LIMITS.points} point capacity (${scaleCount * 2} check×run×scale points)`,
  );
});

test('profile calibration refuses over-capacity work after bounded admission', () => {
  const profile = JSON.stringify({
    file: 'test/growth.test.ts',
    check: 'heavy-run',
    scales: [1, 4, 16],
    repetitions: [
      [{ rows: 1, blocks: 1, statements: 1 }],
      [{ rows: 1, blocks: 1, statements: 1 }],
      [{ rows: 1, blocks: 1, statements: 1 }],
    ],
    relationSizes: [{}, {}, {}],
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    shadow: Object.fromEntries(['rows', 'blocks', 'statements'].map((metric) => [metric, { outcome: 'compatible' }])),
  });
  const calibration = Array.from({ length: GROWTH_CALIBRATION_LIMITS.runsPerCheck + 1 }, (_, index) => ({
    name: `run-${index + 1}`,
    text: profile,
  }));
  expect(() =>
    growthCalibrationReport(calibration, { name: 'coverage', text: profile }),
  ).toThrow(
    `Calibration check ${JSON.stringify(['test/growth.test.ts', 'heavy-run'])} exceeds the ${GROWTH_CALIBRATION_LIMITS.runsPerCheck} run capacity (${calibration.length} runs)`,
  );
});
