import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { e2eArgs, failedSelection, parseJUnit, selectedTestExecuted } from './acceptance.ts';
import { measuredBrowserStep, replaceBrowserStackEnvironment, runPreparedJourneys, type BrowserStepResult } from './e2e.ts';
import { discoverJourneyPreparations, type JourneyPreparation } from './e2e-preparation.ts';

const preparation = (name: string): JourneyPreparation => ({
  journey: `apps/web/tests/${name}.e2e.ts`, command: ['bun', 'prepare.ts'],
  step: `Prepare ${name}`, slug: name, budgetMs: 1_000,
});

function fixture() {
  const parent = resolve(import.meta.dir, '../../.temp');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'prepared-journeys-'));
  const journeys = join(root, 'apps/web/tests');
  mkdirSync(journeys, { recursive: true });
  return { root, artifactDir: root, results: () => parseJUnit(readFileSync(join(root, 'e2e.xml'), 'utf8'), 'e2e'),
    journey: (name: string) => writeFileSync(join(journeys, `${name}.e2e.ts`), ''),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe('restored browser stack credentials', () => {
  const previous = {
    ACCOUNT_BASE_URL: 'http://127.0.0.1:4101', MAIN_PORT: '4102',
    PLATFORM_FIRST_ADMIN_ACCOUNT: 'empty-stack-admin', ACCOUNT_OPERATOR_USER_IDS: 'empty-stack-operator',
    ACCOUNT_MAIN_CLIENT_ID: 'empty-stack-main-client', ACCOUNT_MAIN_CLIENT_SECRET: 'empty-stack-secret',
    WEB_OAUTH_CLIENT_ID: 'empty-stack-web-client',
  };
  const settings = { REZICS_QA_RUN_ID: 'browser-run', REZICS_STACK_PROFILE: 'qa',
    REZICS_WEB_E2E_BASE_URL: 'http://127.0.0.1:4200', CI: '1' };

  test('the restored issuer, administrator and clients replace the empty stack identities', () => {
    const env: NodeJS.ProcessEnv = { ...settings, ...previous };
    replaceBrowserStackEnvironment(env, previous, {
      ACCOUNT_BASE_URL: 'http://127.0.0.1:4301', MAIN_PORT: '4302',
      PLATFORM_FIRST_ADMIN_ACCOUNT: 'retained-admin', ACCOUNT_OPERATOR_USER_IDS: 'restored-operator',
      ACCOUNT_MAIN_CLIENT_ID: 'restored-main-client', ACCOUNT_MAIN_CLIENT_SECRET: 'restored-secret',
      WEB_OAUTH_CLIENT_ID: 'restored-web-client',
    });
    expect(env).toEqual({
      ...settings, ACCOUNT_BASE_URL: 'http://127.0.0.1:4301', MAIN_PORT: '4302',
      PLATFORM_FIRST_ADMIN_ACCOUNT: 'retained-admin', ACCOUNT_OPERATOR_USER_IDS: 'restored-operator',
      ACCOUNT_MAIN_CLIENT_ID: 'restored-main-client', ACCOUNT_MAIN_CLIENT_SECRET: 'restored-secret',
      WEB_OAUTH_CLIENT_ID: 'restored-web-client',
    });
  });

  test('absent restored administrator and client credentials are removed while QA settings remain', () => {
    const env: NodeJS.ProcessEnv = { ...settings, ...previous };
    replaceBrowserStackEnvironment(env, previous, { ACCOUNT_BASE_URL: 'http://127.0.0.1:4301', MAIN_PORT: '4302' });
    expect(env).toEqual({ ...settings, ACCOUNT_BASE_URL: 'http://127.0.0.1:4301', MAIN_PORT: '4302' });
    expect(Object.hasOwn(env, 'PLATFORM_FIRST_ADMIN_ACCOUNT')).toBe(false);
    expect(Object.hasOwn(env, 'ACCOUNT_OPERATOR_USER_IDS')).toBe(false);
    expect(Object.hasOwn(env, 'ACCOUNT_MAIN_CLIENT_ID')).toBe(false);
    expect(Object.hasOwn(env, 'ACCOUNT_MAIN_CLIENT_SECRET')).toBe(false);
    expect(Object.hasOwn(env, 'WEB_OAUTH_CLIENT_ID')).toBe(false);
  });
});

describe('journey preparation isolation', () => {
  test('simulated admission keeps preparation timing independent of host memory and its full execution budget', async () => {
    const f = fixture();
    let clock = 0;
    const events: string[] = [];
    const steps: BrowserStepResult[] = [];
    try {
      const result = await measuredBrowserStep('Prepare retained', 1_000, async budget => {
        events.push('prepare');
        expect(budget).toBe(1_000);
        clock += 7;
      }, { root: f.root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: 20_000, now: () => clock,
        admission: async (_need, options) => {
          events.push('admission');
          expect(options.deadline).toBe(20_000);
          clock += 16_000;
          options.onAdmissionWait?.(16_000);
        }, record: result => steps.push(result) });
      expect(events).toEqual(['admission', 'prepare']);
      expect(result).toEqual({ step: 'Prepare retained', budgetMs: 1_000, elapsedMs: 7,
        admissionWaitMs: 16_000, passed: true });
      expect(steps).toEqual([result]);
    } finally { f.cleanup(); }
  });

  test('discovery retains a stack restore hook instead of falling back to fresh data preparation', async () => {
    const f = fixture();
    try {
      f.journey('retained');
      writeFileSync(join(f.root, 'prepare.ts'), '');
      writeFileSync(join(f.root, 'apps/web/tests/retained.prepare.ts'), `
        export const preparation = ${JSON.stringify({ command: ['bun', 'prepare.ts'],
          step: 'Retained corpus', slug: 'retained', budgetMs: 1000 })};
        export async function restoreStack(input) {
          return { runId: input.runId + '-copy', apps: { MAIN_PORT: '4321' }, stop: async () => {} };
        }
      `);
      const [selected] = await discoverJourneyPreparations(f.root);
      expect(selected?.restoreStack).toBeFunction();
      const restored = await selected!.restoreStack!({ runId: 'browser', webOrigin: 'http://127.0.0.1:3003',
        accountsPort: '3004' });
      expect(restored.runId).toBe('browser-copy');
      expect(restored.apps).toEqual({ MAIN_PORT: '4321' });
      await restored.stop();
    } finally { f.cleanup(); }
  });

  test('a malformed stack restore hook is refused before fresh preparation can run', async () => {
    const f = fixture();
    try {
      f.journey('invalid');
      writeFileSync(join(f.root, 'apps/web/tests/invalid.prepare.ts'), `
        export const preparation = ${JSON.stringify({ command: ['bun', 'prepare.ts'],
          step: 'Invalid restore', slug: 'invalid', budgetMs: 1000 })};
        export const restoreStack = true;
      `);
      await expect(discoverJourneyPreparations(f.root)).rejects.toThrow('restoreStack must be a function');
    } finally { f.cleanup(); }
  });

  for (const error of ['Prepare first failed (1)', 'Prepare first exceeded its 1s budget']) {
    test(`${error}: the next preparation and journey run, with both file outcomes reported`, async () => {
      const f = fixture();
      try {
        const first = preparation('first'), second = preparation('second');
        const admitted: string[] = [], prepared: string[] = [], launched: (readonly string[])[] = [], steps: BrowserStepResult[] = [];
        const failures = await runPreparedJourneys([first, second], [first.journey, second.journey, '--project', 'chromium'], {
          root: f.root, artifactDir: f.artifactDir,
          prepare: async item => {
            await measuredBrowserStep(item.step, item.budgetMs, async () => {
              prepared.push(item.journey);
              if (item === first) throw new Error(error);
            }, { root: f.root, env: { REZICS_STACK_PROFILE: 'qa' }, deadline: Date.now() + 10_000,
              admission: async () => { admitted.push(item.journey); }, record: result => steps.push(result) });
          },
          playwright: async args => {
            launched.push(args);
            writeFileSync(join(f.artifactDir, 'e2e.xml'), `<testsuites><testsuite tests="1"><testcase name="second journey" classname="second.e2e.ts" time="1" /></testsuite></testsuites>`);
          },
        });
        expect(admitted).toEqual([first.journey, second.journey]);
        expect(prepared).toEqual([first.journey, second.journey]);
        expect(launched).toEqual([['--project', 'chromium', second.journey]]);
        expect(failures).toEqual([{ preparation: first, error }]);
        expect(steps.map(step => step.passed)).toEqual([false, true]);
        expect(f.results()).toEqual([
          expect.objectContaining({ file: second.journey, failed: false }),
          expect.objectContaining({ file: first.journey, name: first.step, failed: true, skipped: false, preparationFailure: true,
            detail: `${first.step}: ${error}; see logs/e2e-first.log` }),
        ]);
        // The tier uses this condition even when every launched test passed.
        expect(failures.length > 0).toBe(true);
      } finally { f.cleanup(); }
    });
  }

  test('when every selected preparation fails, both files fail without starting Playwright', async () => {
    const f = fixture();
    try {
      const preparations = [preparation('first'), preparation('second')];
      let launches = 0;
      const failures = await runPreparedJourneys(preparations, preparations.map(item => item.journey), {
        root: f.root, artifactDir: f.artifactDir,
        prepare: async item => { throw new Error(`${item.step} failed (1)`); },
        playwright: async () => { launches++; },
      });
      expect(launches).toBe(0);
      expect(failures).toHaveLength(2);
      expect(f.results().map(result => ({ file: result.file, failed: result.failed, detail: result.detail }))).toEqual(
        preparations.map(item => ({ file: item.journey, failed: true,
          detail: `${item.step}: ${item.step} failed (1); see logs/e2e-${item.slug}.log` })),
      );
    } finally { f.cleanup(); }
  });

  test('a full tier still runs undeclared journeys and filters matching path forms', async () => {
    const f = fixture();
    try {
      f.journey('first'); f.journey('second'); f.journey('unprepared');
      const first = preparation('first'), second = preparation('second');
      for (const args of [[], ['./apps/web/tests/first.e2e.ts', join(f.root, second.journey), 'unprepared.e2e.ts']]) {
        let launched: readonly string[] = [];
        await runPreparedJourneys([first, second], args, {
          root: f.root, artifactDir: f.artifactDir,
          prepare: async item => { if (item === first) throw new Error('denied'); },
          playwright: async remaining => { launched = remaining; writeFileSync(join(f.artifactDir, 'e2e.xml'), '<testsuites />'); },
        });
        expect(launched).toEqual(args.length ? [join(f.root, second.journey), 'unprepared.e2e.ts']
          : [second.journey, 'apps/web/tests/unprepared.e2e.ts']);
      }
    } finally { f.cleanup(); }
  });

  test('a Playwright error still leaves preparation failures beside its partial report', async () => {
    const f = fixture();
    try {
      const first = preparation('first'), second = preparation('second');
      await expect(runPreparedJourneys([first], [first.journey, second.journey], {
        root: f.root, artifactDir: f.artifactDir,
        prepare: async () => { throw new Error('denied <403> & "closed"'); },
        playwright: async () => {
          writeFileSync(join(f.artifactDir, 'e2e.xml'), `<testsuites><testsuite><testcase name="second" classname="second.e2e.ts"><failure message="browser failed" /></testcase></testsuite></testsuites>`);
          throw new Error('Playwright failed (1)');
        },
      })).rejects.toThrow('Playwright failed (1)');
      expect(f.results()).toEqual([
        expect.objectContaining({ file: second.journey, failed: true, detail: 'browser failed' }),
        expect.objectContaining({ file: first.journey, failed: true,
          detail: 'Prepare first: denied <403> & "closed"; see logs/e2e-first.log' }),
      ]);
    } finally { f.cleanup(); }
  });

  test('successful preparations retain the original selection and Playwright report', async () => {
    const f = fixture();
    try {
      const first = preparation('first');
      const args = [first.journey, '--project', 'chromium'];
      const xml = '<testsuites><testsuite><testcase name="first" classname="first.e2e.ts" /></testsuite></testsuites>';
      let launched: readonly string[] = [];
      expect(await runPreparedJourneys([first], args, {
        root: f.root, artifactDir: f.artifactDir, prepare: async () => {},
        playwright: async remaining => { launched = remaining; writeFileSync(join(f.artifactDir, 'e2e.xml'), xml); },
      })).toEqual([]);
      expect(launched).toEqual(args);
      expect(readFileSync(join(f.artifactDir, 'e2e.xml'), 'utf8')).toBe(xml);
    } finally { f.cleanup(); }
  });

  test('a failed-only rerun recovers preparation by running the full journey without a step-name grep', async () => {
    const f = fixture();
    try {
      const first = preparation('first');
      await runPreparedJourneys([first], [first.journey], {
        root: f.root, artifactDir: f.artifactDir,
        prepare: async () => { throw new Error('denied'); },
        playwright: async () => { throw new Error('a failed preparation must not start Playwright'); },
      });
      const prior = join(f.root, 'prior');
      mkdirSync(prior);
      writeFileSync(join(prior, 'e2e.xml'), readFileSync(join(f.artifactDir, 'e2e.xml')));
      writeFileSync(join(prior, 'acceptance.json'), JSON.stringify({ tiers: [{ name: 'e2e', status: 'failed' }] }));
      const selection = failedSelection(f.root, 'prior');
      expect(selection.tests).toEqual([expect.objectContaining({ name: first.step, preparationFailure: true })]);
      const args = e2eArgs(selection);
      expect(args).toEqual([first.journey]);
      let preparations = 0, launches = 0;
      expect(await runPreparedJourneys([first], args, {
        root: f.root, artifactDir: f.artifactDir,
        prepare: async () => { preparations++; },
        playwright: async remaining => {
          launches++;
          expect(remaining).toEqual([first.journey]);
          writeFileSync(join(f.artifactDir, 'e2e.xml'), `<testsuites><testsuite><testcase name="first journey succeeds" classname="first.e2e.ts" /></testsuite></testsuites>`);
        },
      })).toEqual([]);
      expect(preparations).toBe(1);
      expect(launches).toBe(1);
      expect(f.results()).toEqual([expect.objectContaining({ file: first.journey, failed: false })]);
      expect(selectedTestExecuted(selection.tests[0]!, f.results())).toBe(true);
    } finally { f.cleanup(); }
  });
});
