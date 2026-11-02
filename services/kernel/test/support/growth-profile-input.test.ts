import { expect, test } from 'bun:test';
import { readGrowthProfiles } from './growth-profile-read.ts';
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
