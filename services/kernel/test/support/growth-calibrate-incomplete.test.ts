import { expect, test } from 'bun:test';
import { growthCalibrationReport } from '../../scripts/growth-calibrate.ts';

const profile = (check: string, scales: number[]): string =>
  JSON.stringify({
    file: 'test/growth.test.ts',
    check,
    scales,
    repetitions: scales.map(() => [{ rows: 1, blocks: 1, statements: 1 }]),
    relationSizes: scales.map(() => ({})),
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    shadow: Object.fromEntries(['rows', 'blocks', 'statements'].map((metric) => [metric, { outcome: 'compatible' }])),
  });

test('explains omitted calibration checks without inventing a calibration', () => {
  const calibration = [
    {
      name: 'calibration-a',
      text: `${profile('missing run', [1, 4, 16])}\n${profile('scale mismatch', [1, 4, 16])}`,
    },
    { name: 'calibration-b', text: profile('scale mismatch', [1, 8, 64]) },
  ];

  expect(() =>
    growthCalibrationReport(calibration, { name: 'coverage', text: profile('coverage', [1, 4, 16]) }),
  ).toThrow(
    /No complete unchanged-code checks are available for rows, blocks, statements\.[\s\S]*test\/growth\.test\.ts[\s\S]*missing run[\s\S]*calibration-b[\s\S]*scale mismatch[\s\S]*mismatched scales[\s\S]*calibration-a: 1, 4, 16; calibration-b: 1, 8, 64/,
  );
});
