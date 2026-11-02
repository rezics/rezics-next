import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GROWTH_PROFILE_OUTPUT_LIMITS,
  GrowthProfileExportError,
  appendGrowthProfile,
  growthProfileExportMode,
} from './growth-profile-output.ts';

let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'growth-profile-output-'));
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('GROWTH_PROFILE_REQUIRED is best-effort unless set to 1', () => {
  expect(growthProfileExportMode(undefined)).toBe('best-effort');
  expect(growthProfileExportMode('1')).toBe('required');
  expect(() => growthProfileExportMode('true')).toThrow("GROWTH_PROFILE_REQUIRED must be '1' when set");
});

test('required export cannot succeed when the artifact cannot be written', () => {
  const destination = join(directory, 'missing', 'required.jsonl');
  try {
    appendGrowthProfile({ destination, record: { check: 'required' }, mode: 'required' });
    throw new Error('expected required export to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(GrowthProfileExportError);
    if (!(error instanceof GrowthProfileExportError)) throw error;
    expect(error.destination).toBe(destination);
    expect(error.message).toContain(`GROWTH_PROFILE ${destination} was not written:`);
    expect(error.cause).toBeInstanceOf(Error);
  }
  expect(existsSync(destination)).toBe(false);
});

test('best-effort export warns once per destination and does not throw', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const first = join(directory, 'missing-a', 'profile.jsonl');
  const second = join(directory, 'missing-b', 'profile.jsonl');
  try {
    expect(appendGrowthProfile({ destination: first, record: { check: 'a' } })).toBeUndefined();
    expect(appendGrowthProfile({ destination: first, record: { check: 'a-again' } })).toBeUndefined();
    expect(appendGrowthProfile({ destination: second, record: { check: 'b' } })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]![0]).toContain(`GROWTH_PROFILE ${first} was not written:`);
    expect(warn.mock.calls[1]![0]).toContain(`GROWTH_PROFILE ${second} was not written:`);
  } finally {
    warn.mockRestore();
  }
});

test('required export appends a complete JSONL record', async () => {
  const destination = join(directory, 'delivered.jsonl');
  const first = appendGrowthProfile({ destination, record: { check: 'one', scales: [1, 8, 64] }, mode: 'required' });
  const second = appendGrowthProfile({ destination, record: { check: 'two' }, mode: 'required' });
  expect(first?.destination).toBe(destination);
  expect(second?.bytes).toBeGreaterThan(0);
  const lines = (await readFile(destination, 'utf8')).split('\n');
  expect(lines.at(-1)).toBe('');
  expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual([
    { check: 'one', scales: [1, 8, 64] },
    { check: 'two' },
  ]);
});

test('an oversized record is refused before any bytes are written', () => {
  const destination = join(directory, 'too-large.jsonl');
  const record = { payload: 'x'.repeat(GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes) };
  expect(() => appendGrowthProfile({ destination, record, mode: 'required' })).toThrow(
    `exceeds the ${GROWTH_PROFILE_OUTPUT_LIMITS.lineBytes} byte profile line limit`,
  );
  expect(existsSync(destination)).toBe(false);
});
