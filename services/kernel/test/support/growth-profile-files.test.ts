import { afterAll, expect, test } from 'bun:test';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { readGrowthProfileFiles, readGrowthProfileHandle } from '../../scripts/growth-profile-files.ts';
import { GROWTH_PROFILE_INPUT_LIMITS } from './growth-profile-input.ts';

const temporary = join(import.meta.dir, '../../../.temp');
mkdirSync(temporary, { recursive: true });
const root = mkdtempSync(join(temporary, 'growth-profile-files-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const budgetDetail = `exceeds the ${GROWTH_PROFILE_INPUT_LIMITS.totalBytes} byte profile input limit`;

function openFds(): number {
  return readdirSync(`/proc/${process.pid}/fd`).length;
}

function writeProfile(name: string, text: string): string {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
}

function writeSparse(name: string, size: number): string {
  const path = join(root, name);
  const fd = openSync(path, 'w');
  ftruncateSync(fd, size);
  closeSync(fd);
  return path;
}

test('loads ordinary JSONL with run basenames and preserved text', async () => {
  const first = writeProfile('calibration-a.jsonl', '{}\r\n \n');
  const second = writeProfile('coverage-run.jsonl', '{"check":"stable"}\n');
  expect(await readGrowthProfileFiles([first, second])).toEqual([
    { name: 'calibration-a', text: '{}\r\n \n' },
    { name: 'coverage-run', text: '{"check":"stable"}\n' },
  ]);
});

test('rejects oversized and aggregate files before retaining them, closes handles, and keeps source errors', async () => {
  const small = writeProfile('small-run.jsonl', '{}\n');
  const large = writeSparse('large-run.jsonl', GROWTH_PROFILE_INPUT_LIMITS.totalBytes + 1);
  const missing = join(root, 'missing-run.jsonl');
  const before = openFds();

  await expect(readGrowthProfileFiles([large])).rejects.toThrow(`large-run:1 ${budgetDetail}`);
  await expect(readGrowthProfileFiles([small, large])).rejects.toThrow(`large-run:1 ${budgetDetail}`);
  expect(openFds()).toBe(before);

  try {
    await readGrowthProfileFiles([small, missing]);
    throw new Error('expected missing profile to fail');
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect((error as NodeJS.ErrnoException).path).toBe(missing);
  }
  expect(openFds()).toBe(before);
});

test('rejects a file that grew after its size was observed without retaining the extra bytes', async () => {
  const path = writeProfile('grew-run.jsonl', 'hello\n');
  const before = openFds();
  const handle = await open(path, 'r');
  try {
    await expect(readGrowthProfileHandle(handle, 'grew-run', 4, 0)).rejects.toThrow('grew-run:1 changed while reading');
  } finally {
    await handle.close();
  }
  expect(openFds()).toBe(before);
});
