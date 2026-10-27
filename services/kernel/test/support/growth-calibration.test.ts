import { expect, test } from 'bun:test';
import { calibrateUncertainty, detectableSlope, type CalibrationCheck } from './growth-calibration.ts';

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
});
