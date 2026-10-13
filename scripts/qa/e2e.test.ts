import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { e2eArgs, failedSelection, parseJUnit, selectedTestExecuted } from './acceptance.ts';
import { browserSafetyEnvironment, browserStackEnvironment, measuredBrowserStep, runPreparedJourneys, startBrowserStack,
  type BrowserStack, type BrowserStepResult } from './e2e.ts';
import { discoverJourneyPreparations, type JourneyPreparation } from './e2e-preparation.ts';

const preparation = (name: string): JourneyPreparation => ({
  journey: `apps/web/tests/${name}.e2e.ts`, command: ['bun', 'prepare.ts'],
  step: `Prepare ${name}`, slug: name, budgetMs: 1_000,
});

test('browser safety uses distinct existing fixture Accounts and never inherits another stack roster', () => {
  const roster = browserSafetyEnvironment({ member: { id: 'member' }, operator: { id: 'operator' } });
  expect(roster).toEqual({ SAFETY_PRIMARY_ACCOUNT: 'member', SAFETY_BACKUP_ACCOUNT: 'operator' });
  expect(browserStackEnvironment({ SAFETY_PRIMARY_ACCOUNT: 'old-member', SAFETY_BACKUP_ACCOUNT: 'old-operator' }, {})).toEqual({});
  expect(browserStackEnvironment({ SAFETY_PRIMARY_ACCOUNT: 'old-member' }, roster)).toEqual(roster);
  expect(() => browserSafetyEnvironment({ member: { id: 'same' }, operator: { id: 'same' } })).toThrow('distinct');
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
    const env = browserStackEnvironment({ ...settings, ...previous }, {
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
    const env = browserStackEnvironment({ ...settings, ...previous },
      { ACCOUNT_BASE_URL: 'http://127.0.0.1:4301', MAIN_PORT: '4302' });
    expect(env).toEqual({ ...settings, ACCOUNT_BASE_URL: 'http://127.0.0.1:4301', MAIN_PORT: '4302' });
    expect(Object.hasOwn(env, 'PLATFORM_FIRST_ADMIN_ACCOUNT')).toBe(false);
    expect(Object.hasOwn(env, 'ACCOUNT_OPERATOR_USER_IDS')).toBe(false);
    expect(Object.hasOwn(env, 'ACCOUNT_MAIN_CLIENT_ID')).toBe(false);
    expect(Object.hasOwn(env, 'ACCOUNT_MAIN_CLIENT_SECRET')).toBe(false);
    expect(Object.hasOwn(env, 'WEB_OAUTH_CLIENT_ID')).toBe(false);
  });
});

describe('browser storage ownership', () => {
  const missingBackup = "ENOENT: no such file or directory, open '.temp/launch-corpus/recipes/backups/retained/backup.json'";
  const stack = (runId: string): BrowserStack => ({ runId, apps: { MAIN_PORT: '4321' }, stop: async () => {} });
  const retained = (name: string): JourneyPreparation => ({ ...preparation(name),
    restoreStack: async () => stack('retained-copy') });

  test('a retained recipe run starts exactly one storage project, before application setup', async () => {
    const f = fixture();
    try {
      const recipes = retained('launch-real-recipes');
      const projects: string[] = [], events: string[] = [];
      const owned = await startBrowserStack([recipes], {
        root: f.root, playwrightArgs: [recipes.journey],
        restore: async () => { projects.push('restored'); events.push('restore'); return stack('retained-copy'); },
        fresh: async () => { projects.push('empty'); return stack('empty'); },
      });
      expect(owned.stack?.runId).toBe('retained-copy');
      expect(owned.failures).toEqual([]);
      events.push('setup');
      await runPreparedJourneys([recipes], [recipes.journey], {
        root: f.root, artifactDir: f.artifactDir, initialFailures: owned.failures,
        prepare: async () => { events.push('prepare'); },
        playwright: async () => { events.push('playwright'); },
      });
      expect(projects).toEqual(['restored']);
      expect(events).toEqual(['restore', 'setup', 'prepare', 'playwright']);
    } finally { f.cleanup(); }
  });

  test('a missing retained recipe backup allows fresh setup, preparation and Playwright for another journey', async () => {
    const f = fixture();
    try {
      const recipes = retained('launch-real-recipes'), another = preparation('another');
      const args = [recipes.journey, another.journey, '--project', 'chromium'];
      const events: string[] = [];
      const owned = await startBrowserStack([recipes, another], {
        root: f.root, playwrightArgs: args,
        restore: async () => { events.push('restore'); throw new Error(missingBackup); },
        fresh: async () => { events.push('fresh'); return stack('empty'); },
      });
      expect(owned.stack?.runId).toBe('empty');
      expect(owned.failures).toEqual([{ preparation: recipes, error: missingBackup }]);
      // The owner records restoration before the application child can start.
      await runPreparedJourneys([], [recipes.journey], {
        root: f.root, artifactDir: f.artifactDir, initialFailures: owned.failures,
        prepare: async () => { throw new Error('no preparations selected'); },
        playwright: async () => { throw new Error('failed-only selection must not start Playwright'); },
      });
      events.push('setup');
      const failures = await runPreparedJourneys([recipes, another], args, {
        root: f.root, artifactDir: f.artifactDir, initialFailures: owned.failures,
        prepare: async item => { events.push(item.journey); },
        playwright: async selected => {
          expect(selected).toEqual(['--project', 'chromium', another.journey]);
          events.push('playwright');
          writeFileSync(join(f.artifactDir, 'e2e.xml'), `<testsuites><testsuite><testcase name="another" classname="another.e2e.ts" /></testsuite></testsuites>`);
        },
      });
      expect(events).toEqual(['restore', 'fresh', 'setup', another.journey, 'playwright']);
      expect(failures).toEqual(owned.failures);
      expect(f.results()).toEqual([
        expect.objectContaining({ file: another.journey, failed: false }),
        expect.objectContaining({ file: recipes.journey, failed: true, preparationFailure: true,
          detail: `${recipes.step}: ${missingBackup}; see logs/e2e-${recipes.slug}.log` }),
      ]);
    } finally { f.cleanup(); }
  });

  test('a missing recipe-only backup reports its journey without starting empty storage or Playwright', async () => {
    const f = fixture();
    try {
      const recipes = retained('launch-real-recipes');
      const owned = await startBrowserStack([recipes], {
        root: f.root, playwrightArgs: [recipes.journey],
        restore: async () => { throw new Error(missingBackup); },
        fresh: async () => { throw new Error('failed-only selection must not start empty storage'); },
      });
      expect(owned.stack).toBeUndefined();
      await runPreparedJourneys([recipes], [recipes.journey], {
        root: f.root, artifactDir: f.artifactDir, initialFailures: owned.failures,
        prepare: async () => { throw new Error('failed restore must not rebuild its fixture'); },
        playwright: async () => { throw new Error('failed-only selection must not start Playwright'); },
      });
      // A reporter retry preserves exactly one failure, including when no browser wrote XML.
      await runPreparedJourneys([], [recipes.journey], {
        root: f.root, artifactDir: f.artifactDir, initialFailures: owned.failures,
        prepare: async () => {}, playwright: async () => {},
      });
      expect(f.results()).toEqual([expect.objectContaining({ file: recipes.journey, failed: true,
        detail: `${recipes.step}: ${missingBackup}; see logs/e2e-${recipes.slug}.log` })]);
    } finally { f.cleanup(); }
  });

  test('a failed fresh stack startup keeps the retained journey restore failure in its report', async () => {
    const f = fixture();
    try {
      const recipes = retained('launch-real-recipes'), another = preparation('another');
      await expect(startBrowserStack([recipes, another], {
        root: f.root, playwrightArgs: [recipes.journey, another.journey],
        restore: async () => { throw new Error(missingBackup); },
        recordFailure: async failure => {
          await runPreparedJourneys([], [recipes.journey], {
            root: f.root, artifactDir: f.artifactDir, initialFailures: [failure],
            prepare: async () => {}, playwright: async () => {},
          });
        },
        fresh: async () => { throw new Error('fresh storage startup unavailable'); },
      })).rejects.toThrow('fresh storage startup unavailable');
      expect(f.results()).toEqual([expect.objectContaining({ file: recipes.journey, failed: true,
        detail: `${recipes.step}: ${missingBackup}; see logs/e2e-${recipes.slug}.log` })]);
    } finally { f.cleanup(); }
  });

  test('incompatible retained journeys fail individually while another selected journey uses the one restored stack', async () => {
    const f = fixture();
    try {
      const first = retained('first'), second = retained('second'), another = preparation('another');
      const args = [first.journey, second.journey, another.journey];
      const restored: string[] = [];
      const owned = await startBrowserStack([first, second, another], {
        root: f.root, playwrightArgs: args,
        restore: async item => { restored.push(item.journey); return stack('first-copy'); },
        fresh: async () => { throw new Error('retained stack already owns storage'); },
      });
      expect(restored).toEqual([first.journey]);
      expect(owned.failures).toEqual([{ preparation: second,
        error: 'This journey needs a different retained stack; select it in a separate browser run' }]);
      const prepared: string[] = [];
      await runPreparedJourneys([first, second, another], args, {
        root: f.root, artifactDir: f.artifactDir, initialFailures: owned.failures,
        prepare: async item => { prepared.push(item.journey); },
        playwright: async selected => { expect(selected).toEqual([first.journey, another.journey]); },
      });
      expect(prepared).toEqual([first.journey, another.journey]);
    } finally { f.cleanup(); }
  });
});

describe('journey preparation isolation', () => {
  test('the browser recipe preparation declares its storage hook without importing execution tooling', () => {
    const declaration = readFileSync(resolve(import.meta.dir, '../../apps/web/tests/launch-real-recipes.prepare.ts'), 'utf8');
    expect(new Bun.Transpiler({ loader: 'ts' }).scanImports(declaration)).toEqual([]);
  });

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

  test('discovery defers storage module loading until the runner restores its selected journey', async () => {
    const f = fixture();
    try {
      f.journey('retained');
      const loaded = join(f.root, 'storage-loaded');
      writeFileSync(join(f.root, 'prepare.ts'), `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(loaded)}, 'loaded');
        export async function restore(input) {
          return { runId: input.runId + '-copy', apps: { MAIN_PORT: '4321' }, stop: async () => {} };
        }
      `);
      writeFileSync(join(f.root, 'apps/web/tests/retained.prepare.ts'), `
        export const preparation = ${JSON.stringify({ command: ['bun', 'prepare.ts'],
          step: 'Retained corpus', slug: 'retained', budgetMs: 1000 })};
        export const restoreStack = { module: 'prepare.ts', exportName: 'restore' };
      `);
      const [selected] = await discoverJourneyPreparations(f.root);
      expect(selected?.restoreStack).toBeFunction();
      expect(existsSync(loaded)).toBe(false);
      const restored = await selected!.restoreStack!({ runId: 'browser', webOrigin: 'http://127.0.0.1:3003',
        accountsPort: '3004' });
      expect(restored.runId).toBe('browser-copy');
      expect(restored.apps).toEqual({ MAIN_PORT: '4321' });
      expect(existsSync(loaded)).toBe(true);
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
      await expect(discoverJourneyPreparations(f.root)).rejects.toThrow('restoreStack must declare module and exportName');
    } finally { f.cleanup(); }
  });

  test('restore declarations reject missing or external modules and invalid export names before startup', async () => {
    for (const declaration of [
      { module: 'missing.ts', exportName: 'restore' },
      { module: '../prepare.ts', exportName: 'restore' },
      { module: '/tmp/prepare.ts', exportName: 'restore' },
      { module: 'prepare.ts', exportName: 'restore()' },
      { module: 'prepare.ts', exportName: 'restore', extra: true },
    ]) {
      const f = fixture();
      try {
        f.journey('invalid');
        writeFileSync(join(f.root, 'prepare.ts'), '');
        writeFileSync(join(f.root, 'apps/web/tests/invalid.prepare.ts'), `
          export const preparation = ${JSON.stringify({ command: ['bun', 'prepare.ts'],
            step: 'Invalid restore', slug: 'invalid', budgetMs: 1000 })};
          export const restoreStack = ${JSON.stringify(declaration)};
        `);
        await expect(discoverJourneyPreparations(f.root)).rejects.toThrow('existing repository module and exported function');
      } finally { f.cleanup(); }
    }
  });

  test('a missing or non-callable module export reports the restore failure on invocation', async () => {
    for (const moduleSource of ['export const other = true;', 'export const restore = true;']) {
      const f = fixture();
      try {
        f.journey('invalid');
        writeFileSync(join(f.root, 'prepare.ts'), moduleSource);
        writeFileSync(join(f.root, 'apps/web/tests/invalid.prepare.ts'), `
          export const preparation = ${JSON.stringify({ command: ['bun', 'prepare.ts'],
            step: 'Invalid restore', slug: 'invalid', budgetMs: 1000 })};
          export const restoreStack = { module: 'prepare.ts', exportName: 'restore' };
        `);
        const [selected] = await discoverJourneyPreparations(f.root);
        await expect(selected!.restoreStack!({ runId: 'browser', webOrigin: 'http://127.0.0.1:3003', accountsPort: '3004' }))
          .rejects.toThrow('restoreStack export restore must be a function');
      } finally { f.cleanup(); }
    }
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
