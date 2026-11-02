import { expect, test } from 'bun:test';
import {
  GROWTH_PROFILE_DIAGNOSTIC_EXPANSION,
  growthProfileCheckId,
  readGrowthProfiles,
} from './growth-profile-read.ts';
import {
  GROWTH_PROFILE_INPUT_LIMITS,
  growthProfileLines,
  type GrowthProfileInputSource,
} from './growth-profile-input.ts';

function reject(source: GrowthProfileInputSource, detail: string) {
  expect(() => readGrowthProfiles([source])).toThrow(detail);
}

test('bounds total bytes and identifies the source line', () => {
  const line = `${' '.repeat(GROWTH_PROFILE_INPUT_LIMITS.lineBytes)}\n`;
  reject(
    { name: 'large-run', text: line.repeat(33) },
    `large-run:32 exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.totalBytes} byte profile input limit`,
  );
});

test('bounds physical lines and record length with source locations', () => {
  reject(
    { name: 'many-lines', text: '\n'.repeat(GROWTH_PROFILE_INPUT_LIMITS.lines) },
    `many-lines:${GROWTH_PROFILE_INPUT_LIMITS.lines + 1} exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.lines} physical profile line limit`,
  );
  reject(
    { name: 'long-line', text: 'x'.repeat(GROWTH_PROFILE_INPUT_LIMITS.lineBytes + 1) },
    `long-line:1 exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.lineBytes} byte profile line limit`,
  );
});

test('bounds nonblank records before malformed JSON parsing', () => {
  reject(
    { name: 'many-records', text: '{}\n'.repeat(GROWTH_PROFILE_INPUT_LIMITS.records + 1) },
    `many-records:${GROWTH_PROFILE_INPUT_LIMITS.records + 1} exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.records} profile record limit`,
  );
});

test('preserves CRLF, blank lines, and trailing empty line numbering', () => {
  expect([...growthProfileLines({ name: 'valid-run', text: '{}\r\n \n' })]).toEqual([
    { line: 1, text: '{}' },
    { line: 2, text: ' ' },
    { line: 3, text: '' },
  ]);
});

function profile(check: string): string {
  const sample = { rows: 0, blocks: 0, statements: 0 };
  const outcome = { outcome: 'compatible' };
  return JSON.stringify({
    file: 't.ts',
    check,
    scales: [1, 2, 3],
    repetitions: [[sample], [sample], [sample]],
    relationSizes: [{}, {}, {}],
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    shadow: { rows: outcome, blocks: outcome, statements: outcome },
  });
}

test('Incomplete profile diagnostics admit a finite aggregate check-by-run expansion before allocating missing-run output, while preserving ordinary complete and omitted groups', () => {
  const ordinary = readGrowthProfiles([
    { name: 'run-a', text: `${profile('shared')}\n${profile('partial')}` },
    { name: 'run-b', text: profile('shared') },
  ]);
  expect(ordinary.series.rows).toHaveLength(1);
  expect(ordinary.omitted).toEqual([
    {
      file: 't.ts',
      check: 'partial',
      occurrence: 1,
      missingRuns: ['run-b'],
      scalesByRun: [{ run: 'run-a', scales: [1, 2, 3] }],
    },
  ]);

  const runs = 32;
  const extraChecks = Math.floor(GROWTH_PROFILE_DIAGNOSTIC_EXPANSION / runs) + 1;
  expect(() =>
    readGrowthProfiles([
      {
        name: 'run-a',
        text: Array.from({ length: extraChecks }, (_, index) => profile(`check ${index}`)).join('\n'),
      },
      ...Array.from({ length: runs - 1 }, (_, index) => ({ name: `empty-${index}`, text: '' })),
    ]),
  ).toThrow(
    `Growth profile ${growthProfileCheckId('t.ts', `check ${extraChecks - 1}`)} exceeds the ${GROWTH_PROFILE_DIAGNOSTIC_EXPANSION} check×run diagnostic expansion (${extraChecks * runs} check×run pairs)`,
  );
});
