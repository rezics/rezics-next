import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { dispatchTest, selectTestCommand } from '../../../scripts/qa/test.ts';
import { testArgs } from '../../../scripts/qa/acceptance.ts';
import { parseArgs } from '../../../scripts/qa/core.ts';
import { GiB, waitForMemory } from '../../../scripts/qa/memory-admission.ts';

test('explicit web, Accounts and shared UI stories wait for host admission before launching', async () => {
  const root = resolve(import.meta.dir, '../../..');
  for (const workspace of ['apps/web', 'apps/accounts', 'packages/ui']) {
    const file = [...new Bun.Glob(`${workspace}/**/*.stories.tsx`).scanSync({ cwd: root })][0]!;
    expect(file).toBeDefined();
    const args = [file, '--reporter=junit', '--outputFile=.temp/selected-stories.xml'];
    const expected = selectTestCommand(args);
    let release!: () => void;
    const waiting = new Promise<void>(done => { release = done; });
    let requested = false;
    const launches: [string, string[]][] = [];
    const result = dispatchTest(args, { deadline: 1234, env: { REZICS_STACK_PROFILE: 'qa' }, admission: async (need, options) => {
      expect(need).toEqual({ vm: 0, host: 4 * GiB, hostReserve: 8 * GiB, vmReserve: 0 });
      expect(options.deadline).toBe(1234);
      requested = true;
      await waiting;
    }, runner: async command => { launches.push(command); return 7; } });
    await Promise.resolve();
    expect(requested).toBe(true);
    expect(launches).toEqual([]);
    release();
    expect(await result).toBe(7);
    expect(launches).toEqual([expected]);
  }
});

test('a Storybook admission failure prevents launch', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const file = [...new Bun.Glob('apps/web/**/*.stories.tsx').scanSync({ cwd: root })][0]!;
  let launched = false;
  await expect(dispatchTest([file], { env: { REZICS_STACK_PROFILE: 'qa' }, admission: async () => { throw new Error('Memory admission deadline reached'); },
    runner: async () => { launched = true; return 0; } })).rejects.toThrow('Memory admission deadline reached');
  expect(launched).toBe(false);
});

test('standalone stories wait beyond a short execution duration and honor the inherited run deadline', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const file = [...new Bun.Glob('apps/web/**/*.stories.tsx').scanSync({ cwd: root })][0]!;
  const env = { REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '200' };
  let now = 0, launched = false, admissionWaitMs = 0;
  const admission: typeof waitForMemory = (need, options) => {
    expect(options.deadline).toBe(200);
    return waitForMemory(need, { ...options, now: () => now, pollMs: 60, announce: () => {},
      onAdmissionWait: ms => { admissionWaitMs += ms; }, sleep: async ms => { now += ms; },
      read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: (now < 120 ? 11 : 12) * GiB }),
    });
  };
  expect(await dispatchTest([file], { env, deadline: 500, admission, runner: async () => {
    expect(now).toBe(120);
    launched = true;
    now += 10;
    return 0;
  } })).toBe(0);
  expect(launched).toBe(true);
  expect(admissionWaitMs).toBe(120);
  expect(now).toBe(130);
  now = 0; launched = false;
  await expect(dispatchTest([file], { env, deadline: 500,
    admission: (need, options) => waitForMemory(need, { ...options, now: () => now, pollMs: 60, announce: () => {},
      sleep: async ms => { now += ms; }, read: async () => ({ vmTotal: 0, vmUsed: 0, hostAvailable: 11 * GiB }),
    }), runner: async () => { launched = true; return 0; },
  })).rejects.toThrow('Memory admission deadline reached');
  expect(now).toBe(200);
  expect(launched).toBe(false);
});

test('saved non-QA standalone stories bypass reserve calculation despite Goal metadata', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const file = [...new Bun.Glob('apps/web/**/*.stories.tsx').scanSync({ cwd: root })][0]!;
  expect(await dispatchTest([file], {
    env: { REZICS_STACK_PROFILE: 'prod', GOAL_TASK_ID: 'G-1234', REZICS_QA_HOST_RESERVE_GIB: 'invalid',
      REZICS_QA_MEMORY_DEADLINE: 'invalid' }, admission: async () => { throw new Error('Unexpected QA admission'); },
    runner: async () => 0,
  })).toBe(0);
});

test('ordinary explicit tests keep their existing dispatch without Storybook admission', async () => {
  const args = ['services/main/tests/command.test.ts', '-t', 'profile'];
  const launches: [string, string[]][] = [];
  const code = await dispatchTest(args, { admission: async () => { throw new Error('Unexpected Storybook admission'); },
    runner: async command => { launches.push(command); return 0; } });
  expect(code).toBe(0);
  expect(launches).toEqual([selectTestCommand(args)]);
});

test('QA09: explicit unit paths still run without a service stack', () => {
  expect(selectTestCommand(['services/main/tests/command.test.ts', '-t', 'profile'])).toEqual([
    'bun', ['test', 'services/main/tests/command.test.ts', '-t', 'profile'],
  ]);
});

test('QA10/MODEL17: native model matrix selects the isolated strict model tier', () => {
  expect(selectTestCommand(['model/tests/native-equivalence.test.ts', '-t', 'MODEL17']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'model', '--file',
      'model/tests/native-equivalence.test.ts', '--id', 'MODEL17']]);
  expect(testArgs('model')).toEqual(['infra/jena/tests/command.integration.test.ts',
    'services/main/tests/read-snapshot-native.test.ts',
    'model/compiler/generate.test.ts',
    'model/tests/native-equivalence.test.ts', 'model/tests/daily-rating.test.ts',
    'model/tests/experience-rating.test.ts', 'model/tests/source-reification.test.ts',
    'model/tests/validation-shape-terms.test.ts', 'model/tests/reasoning-profile.test.ts',
    'model/tests/event-time.test.ts', 'packages/model/tests/generated.test.ts']);
  expect(selectTestCommand(['infra/jena/tests/command.integration.test.ts', '-t', 'MODEL17']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'model', '--file',
      'infra/jena/tests/command.integration.test.ts', '--id', 'MODEL17']]);
});

test('QA10: registered integration paths and acceptance IDs select shared QA setup', () => {
  expect(selectTestCommand(['services/main/tests/acting-context.integration.test.ts', '-t', 'IAM03']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'integration', '--file',
      'services/main/tests/acting-context.integration.test.ts', '--id', 'IAM03']]);
  expect(selectTestCommand(['tests/qa/integration/shared-stack.test.ts', '-t', 'IAM01']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'integration', '--file',
      'tests/qa/integration/shared-stack.test.ts', '--id', 'IAM01']]);
  expect(parseArgs(['--tier', 'integration', '--file',
    'tests/qa/integration/shared-stack.test.ts', '--id', 'IAM01']))
    .toEqual({ tier: 'integration', onlyFailed: undefined, keep: false, record: false,
      files: ['tests/qa/integration/shared-stack.test.ts'], id: 'IAM01' });
  expect(testArgs('integration', undefined, { files: ['tests/qa/integration/shared-stack.test.ts'],
    id: 'IAM01' })).toEqual(['tests/qa/integration/shared-stack.test.ts', '-t',
      '^(?:[A-Z][A-Z0-9]*\\d{2,}/)*IAM01(?:/|:)']);
});

test('QA11: selected runs reject unsafe paths and full-record combinations', () => {
  expect(() => selectTestCommand(['tests/qa/integration/shared-stack.test.ts',
    'model/compiler/generate.test.ts'])).toThrow('separate commands');
  expect(() => selectTestCommand(['../outside.test.ts'])).toThrow('outside this checkout or missing');
  expect(() => parseArgs(['--record', '--tier', 'integration', '--id', 'OPS01']))
    .toThrow('--record requires a full run');
  for (const file of ['activate', 'edit', 'full-work']) {
    expect(() => testArgs('integration', undefined,
      { files: [`services/main/tests/${file}.integration.test.ts`] })).toThrow('not registered');
  }
  for (const file of ['outbox', 'recovery']) {
    expect(() => testArgs('fault/recovery', undefined,
      { files: [`services/main/tests/${file}.integration.test.ts`] })).toThrow('not registered');
  }
});

test('QA10/SYS02: registered fault file routes to its isolated tier', () => {
  expect(selectTestCommand(['tests/qa/fault-recovery/lost-response.test.ts', '-t', 'SYS02']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'fault/recovery', '--file',
      'tests/qa/fault-recovery/lost-response.test.ts', '--id', 'SYS02']]);
  expect(testArgs('fault/recovery', undefined, { files: ['tests/qa/fault-recovery/lost-response.test.ts'],
    id: 'SYS02' })).toEqual(['tests/qa/fault-recovery/lost-response.test.ts', '-t',
      '^(?:[A-Z][A-Z0-9]*\\d{2,}/)*SYS02(?:/|:)']);
  expect(selectTestCommand(['services/main/tests/content-recovery.integration.test.ts', '-t', 'OPS03']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'fault/recovery', '--file',
      'services/main/tests/content-recovery.integration.test.ts', '--id', 'OPS03']]);
});

test('QA10/OPS05: registered load file routes to the isolated k6 tier', () => {
  expect(selectTestCommand(['tests/qa/load/public-query.test.ts', '-t', 'OPS05']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'load', '--file',
      'tests/qa/load/public-query.test.ts', '--id', 'OPS05']]);
  expect(testArgs('load', undefined, { files: ['tests/qa/load/public-query.test.ts'],
    id: 'OPS05' })).toEqual(['tests/qa/load/public-query.test.ts', '-t',
      '^(?:[A-Z][A-Z0-9]*\\d{2,}/)*OPS05(?:/|:)']);
});

test('QA10: web browser file routes through the isolated e2e tier', () => {
  expect(selectTestCommand(['apps/web/tests/public-search.e2e.ts']))
    .toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'e2e', '--file',
      'apps/web/tests/public-search.e2e.ts']]);
});


test('Bun script owner files select their bounded tier without a service stack', () => {
  expect(selectTestCommand(['scripts/dev/seed/api.test.ts'])).toEqual([
    'bun', ['scripts/qa/cli.ts', '--tier', 'owner', '--file', 'scripts/dev/seed/api.test.ts'],
  ]);
  expect(parseArgs(['--tier', 'owner']).tier).toBe('owner');
});


test('owner file selection accepts Bun TSX tests', () => {
  expect(parseArgs(['--tier', 'owner', '--file', 'packages/document/tests/checker.test.tsx']).files)
    .toEqual(['packages/document/tests/checker.test.tsx']);
});
