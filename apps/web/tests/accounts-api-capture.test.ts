import { expect, test } from 'bun:test';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  API_CAPTURE_DIRECTORY,
  API_CAPTURE_JOURNEYS,
  assertAuthorityDenial,
  captureResponse,
  classifyAuthorityDenial,
  collectApiCapture,
  hasNativeCaptureOwnership,
  parseCaptureHandoff,
  runApiCaptureOnHandoff,
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
      access_token: 'private bearer',
      refresh_token: 'private refresh token',
      effectRef: 'private effect reference',
      key: 'private operation key',
      subjectId: 'private subject',
      purpose: 'set-password',
      digest: 'private digest',
      reference: 'private approval reference',
      expiresAt: 'private expiry',
      receiptId: 'private receipt',
      replayed: false,
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
    shape: {
      error: 'string',
      effect_status: 'string',
      access_token: 'string',
      refresh_token: 'string',
      effectRef: 'string',
      key: 'string',
      subjectId: 'string',
      purpose: 'string',
      digest: 'string',
      reference: 'string',
      expiresAt: 'string',
      receiptId: 'string',
      replayed: 'boolean',
      account_id: 'string',
      sessions: 'array',
    },
    code: 'credential_effect_denied',
    effectStatus: 'not_applied',
  });
  expect(captureResponse({ error: 'private diagnostic', effect_status: 'private' })).toEqual({
    shape: { error: 'string', effect_status: 'string' },
  });
});

test('authority loss requires the owning denial code and classifies overload as unknown', async () => {
  expect(classifyAuthorityDenial('auth', { status: 401, value: { error: 'authentication_denied' } })).toBe(
    'qualified-denial',
  );
  expect(classifyAuthorityDenial('auth', { status: 302, value: { error: 'authentication_denied' } })).toBe('not-denial');
  expect(classifyAuthorityDenial('kernel', { status: 401, value: { code: 'invalid_credentials' } })).toBe(
    'qualified-denial',
  );
  expect(classifyAuthorityDenial('kernel', { status: 401, value: { code: 'authentication_required' } })).toBe(
    'not-denial',
  );
  expect(classifyAuthorityDenial('auth', { status: 503, value: { error: 'overloaded' } })).toBe('unknown');

  const called: string[] = [];
  const cases = await collectApiCapture(
    {
      J03: async () => {
        called.push('J03');
        assertAuthorityDenial('auth', { status: 503, value: { error: 'overloaded' } }, 'old password');
      },
      J04: async () => {
        called.push('J04');
      },
      J10: async () => {
        called.push('J10');
      },
    },
    async () => {},
  );
  expect(called).toEqual([...API_CAPTURE_JOURNEYS]);
  expect(cases.map((entry) => entry.result)).toEqual(['unknown', 'PASS', 'PASS']);
  expect(cases[0]?.phases).toMatchObject([{ classification: 'unknown', unknownKind: 'overload' }]);
});

test('API capture requires the registered native task attempt', () => {
  expect(
    hasNativeCaptureOwnership({
      GOAL_TASK_ID: '292712ee-3fd6-4e9d-8dd5-3e5265f620d2',
      GOAL_ATTEMPT: '1',
      GOAL_ACCEPTANCE_REQUIRES: 'native',
    }),
  ).toBe(true);
  expect(
    hasNativeCaptureOwnership({
      GOAL_TASK_ID: '292712ee-3fd6-4e9d-8dd5-3e5265f620d2',
      GOAL_ATTEMPT: '1',
      GOAL_ACCEPTANCE_REQUIRES: 'notnative',
    }),
  ).toBe(false);
  expect(
    hasNativeCaptureOwnership({
      GOAL_TASK_ID: '292712ee-3fd6-4e9d-8dd5-3e5265f620d2',
      GOAL_ACCEPTANCE_REQUIRES: 'native',
    }),
  ).toBe(false);
});

test('capture admits the supplied runtime with running or failed seed and absent result bytes', async () => {
  const directory = resolve(import.meta.dir, '../../../.temp', `capture-seed-state-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const seedResultPath = join(directory, 'not-created.json');
  const handoff = (seedState: 'running' | 'failed') =>
    parseCaptureHandoff({
      slot: 'manual-page-review-lease-test',
      runtimeRevision: 'a'.repeat(40),
      runtimeService: 'rezics-page-review-test.service',
      runtimeLeasePid: 12345,
      runtimeStackPid: 12346,
      seedCompleted: false,
      seedState,
      seedResultPath,
      origins: {
        web: 'http://127.0.0.1:41001',
        issuer: 'http://127.0.0.1:41002',
        native: 'http://127.0.0.1:41003',
        kernel: 'http://127.0.0.1:41004',
      },
      keysPath: '/runtime/private-keys',
      bindingsPath: '/runtime/private-bindings',
      recoveryDirectory: '/runtime/private-recovery',
    });
  const expectedSnapshots = [['J03'], ['J03', 'J04'], ['J03', 'J04', 'J10']];
  const persisted: { identity: Record<string, unknown>; caseIds: string[] }[] = [];
  try {
    expect(await Bun.file(seedResultPath).exists()).toBe(false);
    for (const state of ['running', 'failed'] as const) {
      const called: string[] = [];
      const result = await runApiCaptureOnHandoff(
        handoff(state),
        'b'.repeat(40),
        {
          J03: async () => void called.push('J03'),
          J04: async () => void called.push('J04'),
          J10: async () => void called.push('J10'),
        },
        async (identity, cases) => persisted.push({ identity, caseIds: cases.map((row) => row.id) }),
      );

      expect(called).toEqual([...API_CAPTURE_JOURNEYS]);
      expect(result.cases.map((row) => row.result)).toEqual(['PASS', 'PASS', 'PASS']);
      expect(result.identity).toMatchObject({
        sourceRevision: 'b'.repeat(40),
        runtimeRevision: 'a'.repeat(40),
        slot: 'manual-page-review-lease-test',
        runtimeService: 'rezics-page-review-test.service',
        lease: { runtimeLeasePid: 12345, runtimeStackPid: 12346 },
        seed: { completed: false, state },
      });
      expect(JSON.stringify(result.identity)).not.toContain(seedResultPath);
      expect(JSON.stringify(result.identity)).not.toContain('sha256');
      expect(await Bun.file(seedResultPath).exists()).toBe(false);
    }
    expect(persisted.map((snapshot) => snapshot.caseIds)).toEqual([...expectedSnapshots, ...expectedSnapshots]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
