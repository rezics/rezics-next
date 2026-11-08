import { expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  API_CAPTURE_DIRECTORY,
  API_CAPTURE_JOURNEYS,
  captureResponse,
  collectApiCapture,
} from '../scripts/accounts-goal-walk.ts';

test('capture selects only original recovery, replacement and revocation and retains failed siblings independently', async () => {
  const directory = resolve(import.meta.dir, '../../../.temp', `capture-selection-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const census = join(directory, 'journeys.json');
  const visual = join(directory, 'visual.json');
  const capture = join(directory, 'capture.json');
  await writeFile(census, 'complete nineteen-row census');
  await writeFile(visual, 'visual owner evidence');
  const called: string[] = [];
  const snapshots: string[][] = [];
  try {
    const operations = {
      J01: async () => {
        called.push('J01');
      },
      J03: async () => {
        called.push('J03');
        throw new Error('private recovery material');
      },
      J04: async () => {
        called.push('J04');
        throw new Error('private approval reference');
      },
      J10: async () => {
        called.push('J10');
      },
    };
    const cases = await collectApiCapture(operations, async (rows) => {
      snapshots.push(rows.map((row) => row.id));
      await writeFile(capture, JSON.stringify(rows));
    });
    expect(called).toEqual([...API_CAPTURE_JOURNEYS]);
    expect(cases.map((row) => row.result)).toEqual(['FAIL', 'FAIL', 'PASS']);
    expect(snapshots).toEqual([['J03'], ['J03', 'J04'], ['J03', 'J04', 'J10']]);
    expect(cases.every((row) => row.personaRole === 'newly registered ordinary human')).toBe(true);
    expect(await readFile(capture, 'utf8')).not.toContain('private');
    expect(await readFile(census, 'utf8')).toBe('complete nineteen-row census');
    expect(await readFile(visual, 'utf8')).toBe('visual owner evidence');
    expect(API_CAPTURE_DIRECTORY).toBe('.temp/goal/accounts/post-seed-api-capture');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('capture response allowlist excludes arbitrary values and private fields', () => {
  expect(
    captureResponse({
      error: 'credential_effect_denied',
      effect_status: 'not_applied',
      account_id: 'private subject',
      password: 'private',
      cookie: 'private',
      access_token: 'private',
      reference: 'private',
      client_assertion: 'private',
      sessions: [{ token: 'private' }],
      unknown: 'private',
    }),
  ).toEqual({
    shape: { error: 'string', effect_status: 'string', account_id: 'string', sessions: 'array' },
    code: 'credential_effect_denied',
    effectStatus: 'not_applied',
  });
  expect(captureResponse({ error: 'private diagnostic', effect_status: 'private' })).toEqual({
    shape: { error: 'string', effect_status: 'string' },
  });
});
