import { expect, test } from 'bun:test';
import { growthCalibrationReport } from '../../scripts/growth-calibrate.ts';
import { growthProfileCheckId, readGrowthProfiles } from './growth-profile-read.ts';

type LineOptions = Readonly<{
  check: string;
  scales?: readonly number[];
  offset?: number;
  relationFirst?: number;
  relationLast?: number;
  outcomes?: readonly [
    'compatible' | 'violation' | 'insufficient-evidence',
    'compatible' | 'violation' | 'insufficient-evidence',
    'compatible' | 'violation' | 'insufficient-evidence',
  ];
}>;

function profileLine({
  check,
  scales = [1, 4, 16],
  offset = 0,
  relationFirst = 10,
  relationLast = 100,
  outcomes = ['compatible', 'compatible', 'compatible'],
}: LineOptions): string {
  const relationSize = (reltuples: number) => ({ reltuples, relpages: reltuples > 0 ? Math.ceil(reltuples / 10) : 0 });
  const relationSizes = scales.map((_, index) => ({
    'public.stable': relationSize(index === scales.length - 1 ? relationLast : relationFirst),
    'public.growing': relationSize(index === 0 ? 10 : 100),
  }));
  return JSON.stringify({
    file: 'test/search/growth-example.test.ts',
    check,
    scales,
    seeding: scales.map(() => ({ statements: 0, rowsWritten: 0, growMs: 0, vacuumMs: 0 })),
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: scales.map((_, index) =>
      [0, 1, 2].map((repeat) => ({
        rows: 10 + offset + index + repeat,
        blocks: 20 + offset + index * 2 + repeat,
        statements: 3 + repeat,
      })),
    ),
    relationSizes,
    shadow: Object.fromEntries(
      (['rows', 'blocks', 'statements'] as const).map((metric, index) => [metric, { outcome: outcomes[index] }]),
    ),
  });
}

test('profile lines become per-metric calibration series grouped by check, with relations that did not grow', () => {
  const read = readGrowthProfiles([
    {
      name: 'run-1',
      text: [
        profileLine({ check: 'stable check', relationFirst: 100, relationLast: 100 }),
        profileLine({ check: 'missing check' }),
        profileLine({ check: 'different scales', scales: [1, 4, 16] }),
      ].join('\n'),
    },
    {
      name: 'run-2',
      text: [
        profileLine({
          check: 'stable check',
          offset: 2,
          relationFirst: 100,
          relationLast: 90,
          outcomes: ['violation', 'compatible', 'insufficient-evidence'],
        }),
        profileLine({ check: 'missing check', offset: 1 }),
        profileLine({ check: 'different scales', scales: [1, 8, 64] }),
      ].join('\n'),
    },
    {
      name: 'run-3',
      text: [
        profileLine({ check: 'stable check', offset: 4, relationFirst: 100, relationLast: 100 }),
        profileLine({ check: 'different scales', scales: [1, 8, 64], offset: 2 }),
      ].join('\n'),
    },
  ]);

  expect(read.series.rows).toEqual([
    {
      check: growthProfileCheckId('test/search/growth-example.test.ts', 'stable check'),
      runs: [
        [
          { scale: 1, repetitions: [10, 11, 12] },
          { scale: 4, repetitions: [11, 12, 13] },
          { scale: 16, repetitions: [12, 13, 14] },
        ],
        [
          { scale: 1, repetitions: [12, 13, 14] },
          { scale: 4, repetitions: [13, 14, 15] },
          { scale: 16, repetitions: [14, 15, 16] },
        ],
        [
          { scale: 1, repetitions: [14, 15, 16] },
          { scale: 4, repetitions: [15, 16, 17] },
          { scale: 16, repetitions: [16, 17, 18] },
        ],
      ],
    },
  ]);
  expect(read.series.blocks[0]!.runs[0]![0]!.repetitions).toEqual([20, 21, 22]);
  expect(read.series.statements[0]!.runs[0]![0]!.repetitions).toEqual([3, 4, 5]);
  expect(read.omitted).toEqual([
    {
      file: 'test/search/growth-example.test.ts',
      check: 'different scales',
      occurrence: 1,
      missingRuns: [],
      scalesByRun: [
        { run: 'run-1', scales: [1, 4, 16] },
        { run: 'run-2', scales: [1, 8, 64] },
        { run: 'run-3', scales: [1, 8, 64] },
      ],
    },
    {
      file: 'test/search/growth-example.test.ts',
      check: 'missing check',
      occurrence: 1,
      missingRuns: ['run-3'],
      scalesByRun: [
        { run: 'run-1', scales: [1, 4, 16] },
        { run: 'run-2', scales: [1, 4, 16] },
      ],
    },
  ]);
  expect(read.nonGrowingRelations).toEqual([
    {
      file: 'test/search/growth-example.test.ts',
      check: 'stable check',
      occurrence: 1,
      run: 'run-1',
      relation: 'public.stable',
      first: 100,
      last: 100,
    },
    {
      file: 'test/search/growth-example.test.ts',
      check: 'stable check',
      occurrence: 1,
      run: 'run-2',
      relation: 'public.stable',
      first: 100,
      last: 90,
    },
    {
      file: 'test/search/growth-example.test.ts',
      check: 'stable check',
      occurrence: 1,
      run: 'run-3',
      relation: 'public.stable',
      first: 100,
      last: 100,
    },
  ]);
  expect(read.shadowOutcomes).toContainEqual({
    file: 'test/search/growth-example.test.ts',
    check: 'stable check',
    occurrence: 1,
    run: 'run-2',
    outcomes: { rows: 'violation', blocks: 'compatible', statements: 'insufficient-evidence' },
  });
});

test('repeated same-named checks get separate calibration occurrences', () => {
  const read = readGrowthProfiles([
    {
      name: 'run-1',
      text: [profileLine({ check: 'same name' }), profileLine({ check: 'same name', offset: 10 })].join('\n'),
    },
    { name: 'run-2', text: profileLine({ check: 'same name', offset: 2 }) },
  ]);

  expect(read.series.rows).toHaveLength(1);
  expect(read.series.rows[0]!.runs).toHaveLength(2);
  expect(read.omitted).toEqual([
    {
      file: 'test/search/growth-example.test.ts',
      check: 'same name',
      occurrence: 2,
      missingRuns: ['run-2'],
      scalesByRun: [{ run: 'run-1', scales: [1, 4, 16] }],
    },
  ]);
});

test('invalid profile lines identify the run and line', () => {
  expect(() => readGrowthProfiles([{ name: 'bad-run', text: '{not json}\n' }])).toThrow('bad-run:1 is not valid JSON');
});

test("the calibration report states each metric's uncertainty, its held-out coverage and the detectable slope", () => {
  const report = growthCalibrationReport(
    [
      { name: 'calibration-1', text: profileLine({ check: 'calibration check', offset: 0 }) },
      { name: 'calibration-2', text: profileLine({ check: 'calibration check', offset: 2 }) },
    ],
    { name: 'coverage', text: profileLine({ check: 'coverage check', offset: 1 }) },
  );

  for (const metric of ['rows', 'blocks', 'statements']) {
    expect(report).toContain(`| ${metric} | 100% |`);
    expect(report).toContain(`| ${metric} | 99% |`);
    expect(report).toContain(`| ${metric} | 100% | constant | 1, 8, 64 |`);
    expect(report).toContain(`| ${metric} | 99% | logarithmic | 1, 4, 16, 64, 256 |`);
  }
  expect(report).toContain('| Metric | Requested coverage | Absolute E | Relative E | Exact | Held-out coverage |');
  expect(report).toContain(
    '| Metric | Coverage | Bound | Scales | Base | Detectable slope | Smallest extra work or scan detectable |',
  );
  expect(report).toContain('extra rows visited per input row');
  expect(report).toContain('extra buffer blocks touched per input row');
  expect(report).toContain('extra SQL statements per input row');
});
