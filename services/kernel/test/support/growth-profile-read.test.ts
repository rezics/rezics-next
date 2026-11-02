import { expect, test } from 'bun:test';
import { growthCalibrationReport } from '../../scripts/growth-calibrate.ts';
import { growthRunEligibility, type GrowthCheck, type ReportSample } from './growth.ts';
import {
  growthMeasurementIdentity,
  growthProfileCheckId,
  readGrowthProfiles,
  type GrowthMeasurementIdentity,
  type GrowthProfileEligibility,
} from './growth-profile-read.ts';

const TEST_SOURCE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TEST_MEASUREMENT = growthMeasurementIdentity(0, TEST_SOURCE);

type LineOptions = Readonly<{
  check: string;
  scales?: readonly number[];
  offset?: number;
  relationFirst?: number;
  relationLast?: number;
  measurement?: GrowthMeasurementIdentity | null;
  outcomes?: readonly [
    'compatible' | 'violation' | 'inconclusive',
    'compatible' | 'violation' | 'inconclusive',
    'compatible' | 'violation' | 'inconclusive',
  ];
  eligibility?: GrowthProfileEligibility;
}>;

function profileLine({
  check,
  scales = [1, 4, 16],
  offset = 0,
  relationFirst = 10,
  relationLast = 100,
  measurement = TEST_MEASUREMENT,
  outcomes = ['compatible', 'compatible', 'compatible'],
  eligibility,
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
    ...(measurement === null ? {} : { measurement }),
    shadow: Object.fromEntries(
      (['rows', 'blocks', 'statements'] as const).map((metric, index) => [metric, { outcome: outcomes[index] }]),
    ),
    ...(eligibility === undefined ? {} : { eligibility }),
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
          outcomes: ['violation', 'compatible', 'inconclusive'],
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
    outcomes: { rows: 'violation', blocks: 'compatible', statements: 'inconclusive' },
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

test('different declared bounds omit a check and identify each run declaration', () => {
  const read = readGrowthProfiles([
    { name: 'run-1', text: profileLine({ check: 'different bounds' }) },
    {
      name: 'run-2',
      text: profileLine({ check: 'different bounds' }).replace('"rows":"constant"', '"rows":"linear"'),
    },
  ]);

  expect(read.series.rows).toEqual([]);
  expect(read.omitted[0]).toMatchObject({
    file: 'test/search/growth-example.test.ts',
    check: 'different bounds',
    occurrence: 1,
    incompatibleBoundsByRun: [
      { run: 'run-1', bounds: { rows: 'constant' } },
      { run: 'run-2', bounds: { rows: 'linear' } },
    ],
  });
});

test('invalid profile lines identify the run and line', () => {
  expect(() => readGrowthProfiles([{ name: 'bad-run', text: '{not json}\n' }])).toThrow('bad-run:1 is not valid JSON');
  const broken = JSON.parse(profileLine({ check: 'broken' })) as { eligibility?: { status: string } };
  broken.eligibility = { status: 'maybe' };
  expect(() => readGrowthProfiles([{ name: 'bad-eligibility', text: JSON.stringify(broken) }])).toThrow(
    'bad-eligibility:1.eligibility.status is unknown',
  );
});

test('ineligible runs are omitted from calibration with their reason', () => {
  const reason = 'counted unit slots at scale 8: value 5 exceeds limit 1';
  const sources = [
    {
      name: 'run-1',
      text: [
        profileLine({ check: 'guarded check', eligibility: { status: 'eligible' } }),
        profileLine({ check: 'legacy check' }),
      ].join('\n'),
    },
    {
      name: 'run-2',
      text: [
        profileLine({
          check: 'guarded check',
          offset: 1,
          eligibility: { status: 'ineligible', reason },
        }),
        profileLine({ check: 'legacy check', offset: 1 }),
      ].join('\n'),
    },
  ];
  const read = readGrowthProfiles(sources);

  expect(read.series.rows.map(({ check }) => check)).toEqual([
    growthProfileCheckId('test/search/growth-example.test.ts', 'legacy check'),
  ]);
  expect(read.omitted).toEqual([
    {
      file: 'test/search/growth-example.test.ts',
      check: 'guarded check',
      occurrence: 1,
      missingRuns: [],
      scalesByRun: [
        { run: 'run-1', scales: [1, 4, 16] },
        { run: 'run-2', scales: [1, 4, 16] },
      ],
      ineligibleRuns: [{ run: 'run-2', reason }],
    },
  ]);
  expect(
    growthCalibrationReport(sources, { name: 'coverage', text: profileLine({ check: 'legacy check' }) }),
  ).toContain(`run-2: ${reason}`);
});

const eligibilityCheck = (overrides: Partial<GrowthCheck> = {}): GrowthCheck => ({
  name: 'eligibility fixture',
  bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
  grow: async () => {},
  operation: async () => {},
  ...overrides,
});

test('harness eligibility follows background, attempt-ledger and counted-unit guards', () => {
  const scales = [1, 8, 64];
  expect(
    growthRunEligibility(
      eligibilityCheck(),
      scales.map((scale) => ({ scale, cost: {} }) as unknown as ReportSample),
    ),
  ).toEqual({ status: 'eligible' });

  const background = 'SELECT id FROM records';
  expect(
    growthRunEligibility(eligibilityCheck({ name: 'poller' }), [
      { scale: 1, cost: { backgroundCosts: { [background]: { rows: 10, blocks: 0, bounded: true } } } },
      { scale: 8, cost: { backgroundCosts: { [background]: { rows: 100, blocks: 0, bounded: true } } } },
      { scale: 64, cost: { backgroundCosts: { [background]: { rows: 10, blocks: 0, bounded: true } } } },
    ] as unknown as ReportSample[]),
  ).toEqual({
    status: 'ineligible',
    reason: `poller: background statement with largest rows ${JSON.stringify(background)}; rows per statement grows from 10 to 100 at scale 8, beyond default slack 2`,
  });

  const ledger = (statements: number) => ({
    commands: 1,
    byOutcome: { committed: 1 },
    attemptsPerCommand: 1,
    repetitions: [
      {
        byOutcome: { committed: 1 },
        attemptsPerCommand: 1,
        ledger: [{ backend: 1, outcome: 'committed', statements, occurrences: [] }],
      },
    ],
  });
  expect(
    growthRunEligibility(
      eligibilityCheck({ attempts: { commands: 1 } }),
      scales.map((scale, index) => ({
        scale,
        attempts: ledger(index === 1 ? 2 : 1),
        occurrenceRepetitions: [{ statements: [], backgroundStatements: [] }],
      })) as unknown as ReportSample[],
    ),
  ).toMatchObject({
    status: 'ineligible',
    reason: expect.stringMatching(/committed attempt.*statement counts differ/),
  });

  expect(
    growthRunEligibility(
      eligibilityCheck({ counted: { read: () => ({ slots: 0 }), limits: { slots: 1 } } }),
      scales.map((scale) => ({
        scale,
        counted: { slots: { value: scale === 8 ? 5 : 1, repetitions: [scale === 8 ? 5 : 1] } },
      })) as unknown as ReportSample[],
    ),
  ).toEqual({
    status: 'ineligible',
    reason: 'counted unit slots at scale 8 repetition 1: value 5 exceeds limit 1',
  });
});

test('incompatible indexProbes, source revisions and unidentified legacy lines are omitted with per-run diagnostics', () => {
  const otherSource = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const read = readGrowthProfiles([
    {
      name: 'run-1',
      text: [
        profileLine({ check: 'probe mismatch', measurement: growthMeasurementIdentity(0, TEST_SOURCE) }),
        profileLine({ check: 'legacy check', measurement: null, relationFirst: 100, relationLast: 100 }),
      ].join('\n'),
    },
    {
      name: 'run-2',
      text: [
        profileLine({ check: 'probe mismatch', measurement: growthMeasurementIdentity(2, TEST_SOURCE) }),
        profileLine({ check: 'legacy check', measurement: null, offset: 1, relationFirst: 100, relationLast: 90 }),
        profileLine({ check: 'source mismatch', measurement: growthMeasurementIdentity(0, otherSource) }),
      ].join('\n'),
    },
    {
      name: 'run-3',
      text: profileLine({ check: 'source mismatch', measurement: growthMeasurementIdentity(0, TEST_SOURCE) }),
    },
  ]);

  expect(read.series.rows).toEqual([]);
  expect(read.omitted).toEqual([
    {
      file: 'test/search/growth-example.test.ts',
      check: 'legacy check',
      occurrence: 1,
      missingRuns: ['run-3'],
      scalesByRun: [
        { run: 'run-1', scales: [1, 4, 16] },
        { run: 'run-2', scales: [1, 4, 16] },
      ],
      incompatibleMeasurementsByRun: [
        { run: 'run-1', measurement: null },
        { run: 'run-2', measurement: null },
      ],
    },
    {
      file: 'test/search/growth-example.test.ts',
      check: 'probe mismatch',
      occurrence: 1,
      missingRuns: ['run-3'],
      scalesByRun: [
        { run: 'run-1', scales: [1, 4, 16] },
        { run: 'run-2', scales: [1, 4, 16] },
      ],
      incompatibleMeasurementsByRun: [
        { run: 'run-1', measurement: growthMeasurementIdentity(0, TEST_SOURCE) },
        { run: 'run-2', measurement: growthMeasurementIdentity(2, TEST_SOURCE) },
      ],
    },
    {
      file: 'test/search/growth-example.test.ts',
      check: 'source mismatch',
      occurrence: 1,
      missingRuns: ['run-1'],
      scalesByRun: [
        { run: 'run-2', scales: [1, 4, 16] },
        { run: 'run-3', scales: [1, 4, 16] },
      ],
      incompatibleMeasurementsByRun: [
        { run: 'run-2', measurement: growthMeasurementIdentity(0, otherSource) },
        { run: 'run-3', measurement: growthMeasurementIdentity(0, TEST_SOURCE) },
      ],
    },
  ]);
  expect(read.entries).toHaveLength(6);
  expect(read.shadowOutcomes).toHaveLength(6);
  expect(read.nonGrowingRelations).toEqual([
    {
      file: 'test/search/growth-example.test.ts',
      check: 'legacy check',
      occurrence: 1,
      run: 'run-1',
      relation: 'public.stable',
      first: 100,
      last: 100,
    },
    {
      file: 'test/search/growth-example.test.ts',
      check: 'legacy check',
      occurrence: 1,
      run: 'run-2',
      relation: 'public.stable',
      first: 100,
      last: 90,
    },
  ]);

  expect(() =>
    growthCalibrationReport(
      [
        { name: 'calibration-1', text: profileLine({ check: 'legacy check', measurement: null }) },
        { name: 'calibration-2', text: profileLine({ check: 'legacy check', measurement: null, offset: 1 }) },
      ],
      { name: 'coverage', text: profileLine({ check: 'legacy check', measurement: null, offset: 2 }) },
    ),
  ).toThrow('unidentified measurement');
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
