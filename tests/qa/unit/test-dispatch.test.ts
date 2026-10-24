import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { qaArtifactDirectory } from '../../../scripts/qa/core.ts';
import { STORY_SCREENSHOTS_ENV } from '../../../scripts/qa/story-screenshots.ts';
import { dispatchTest, selectTestCommand, selectTestGroups, type TestDispatchOptions } from '../../../scripts/qa/test.ts';

const root = resolve(import.meta.dir, '../../..');
const directories: string[] = [];

function artifactRoot(): string {
  const temporary = join(root, '.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'story-dispatch-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('one mixed unit and story invocation keeps sequential execution and story screenshot artifacts', async () => {
  const artifacts = artifactRoot();
  const unit = 'apps/web/features/tracking/series-progress-panel.test.tsx';
  const story = 'apps/web/features/tracking/edition-preference.stories.tsx';
  const groups = selectTestGroups([unit, story]);
  expect(groups.map(group => group.files)).toEqual([[unit], [story]]);
  let launches = 0;
  let admissions = 0;
  let screenshotDirectory = '';
  const code = await dispatchTest([unit, story], {
    env: { REZICS_STACK_PROFILE: 'qa', REZICS_QA_ARTIFACT_ROOT: artifacts },
    admission: async () => { admissions++; },
    runner: async (command, env) => {
      expect(command).toEqual(groups[launches]!.command);
      if (launches++ === 0) {
        expect(env?.[STORY_SCREENSHOTS_ENV]).toBeUndefined();
        return 1;
      }
      screenshotDirectory = env![STORY_SCREENSHOTS_ENV]!;
      expect(isAbsolute(screenshotDirectory)).toBe(true);
      expect(existsSync(screenshotDirectory)).toBe(true);
      return 0;
    },
  });
  expect(code).toBe(1);
  expect(launches).toBe(2);
  expect(admissions).toBe(1);
  const summary = readFileSync(join(dirname(screenshotDirectory), 'summary.md'), 'utf8');
  expect(summary).toContain(story);
  expect(summary).toContain('passed');
});

for (const workspace of ['apps/web', 'apps/accounts', 'packages/ui']) {
  test(`${workspace} story dispatch supplies an absolute screenshot artifact directory before launch`, async () => {
    const artifacts = artifactRoot();
    const file = [...new Bun.Glob(`${workspace}/**/*.stories.tsx`).scanSync({ cwd: root })][0]!;
    expect(file).toBeDefined();
    const args = [file, '--reporter=dot'];
    const expectedCode = workspace === 'apps/accounts' ? 7 : 0;
    let screenshots = '';
    const code = await dispatchTest(args, {
      env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts, STORY_DISPATCH_PARENT: 'retained' },
      admission: async () => { throw new Error('Production-profile stories need no QA admission'); },
      runner: async (command, env) => {
        expect(command).toEqual(selectTestCommand(args));
        expect(env?.STORY_DISPATCH_PARENT).toBe('retained');
        screenshots = env?.[STORY_SCREENSHOTS_ENV] ?? '';
        expect(isAbsolute(screenshots)).toBe(true);
        expect(basename(screenshots)).toBe('story-screenshots');
        expect(dirname(dirname(screenshots))).toBe(artifacts);
        expect(basename(dirname(screenshots))).toMatch(/^\d{8}t\d{6}-[a-f0-9]{6}$/);
        expect(existsSync(screenshots)).toBe(true);
        expect(readFileSync(join(dirname(screenshots), 'summary.md'), 'utf8'))
          .toContain(`Story screenshots: \`${screenshots}\``);
        return expectedCode;
      },
    });
    expect(code).toBe(expectedCode);
    const summary = readFileSync(join(dirname(screenshots), 'summary.md'), 'utf8');
    expect(summary).toContain(file);
    expect(summary).toContain(expectedCode === 0 ? 'passed' : 'failed');
    expect(readdirSync(artifacts)).toEqual([basename(dirname(screenshots))]);
  });
}

test('story dispatch defaults to the harness’s QA artifact directory', async () => {
  let directory = '';
  try {
    await dispatchTest(['packages/ui/src/components/badge.stories.tsx'], {
      env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: undefined },
      runner: async (_, env) => {
        directory = dirname(env![STORY_SCREENSHOTS_ENV]!);
        expect(dirname(directory)).toBe(resolve(qaArtifactDirectory(root)));
        expect(relative(directory, env![STORY_SCREENSHOTS_ENV]!)).toBe('story-screenshots');
        return 0;
      },
    });
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary and mixed-tier dispatch do not supply screenshot environment or create story artifacts', async () => {
  const artifacts = artifactRoot();
  const env = { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts };
  for (const { args, expectedLaunches } of [
    { args: ['services/main/tests/command.test.ts', '-t', 'profile'], expectedLaunches: 1 },
    { args: ['apps/web/tests/g-944-shared-browser.test.ts', 'scripts/dev/seed/api.test.ts'], expectedLaunches: 2 },
  ]) {
    let launches = 0;
    expect(await dispatchTest(args, {
      env,
      admission: async () => { throw new Error('Non-story tests need no Storybook admission'); },
      runner: async (_, override) => {
        expect(override).toBeUndefined();
        launches++;
        return 0;
      },
    })).toBe(0);
    expect(launches).toBe(expectedLaunches);
    expect(readdirSync(artifacts)).toEqual([]);
  }
});

test('an invalid artifact root warns once per run and preserves passing and failing story exits', async () => {
  const artifacts = join(artifactRoot(), 'not-a-directory\nartifact-root');
  writeFileSync(artifacts, 'existing regular file');
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  let launches = 0;
  try {
    for (const expectedCode of [0, 7]) {
      expect(await dispatchTest(['packages/ui/src/components/badge.stories.tsx'], {
        env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts },
        runner: async (_, env) => {
          expect(dirname(dirname(env![STORY_SCREENSHOTS_ENV]!))).toBe(artifacts);
          launches++;
          return expectedCode;
        },
      })).toBe(expectedCode);
    }
  } finally { console.warn = original; }
  expect(launches).toBe(2);
  expect(warnings).toHaveLength(2);
  for (const warning of warnings) {
    expect(warning).toStartWith('Warning: story screenshot artifacts ');
    expect(warning).not.toMatch(/[\r\n]/);
  }
  expect(readFileSync(artifacts, 'utf8')).toBe('existing regular file');
});

test('a summary append failure warns and preserves the story exit', async () => {
  const artifacts = artifactRoot();
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => { warnings.push(String(message)); };
  try {
    expect(await dispatchTest(['packages/ui/src/components/badge.stories.tsx'], {
      env: { REZICS_STACK_PROFILE: 'prod', REZICS_QA_ARTIFACT_ROOT: artifacts },
      runner: async (_, env) => {
        const summary = join(dirname(env![STORY_SCREENSHOTS_ENV]!), 'summary.md');
        rmSync(summary);
        mkdirSync(summary);
        return 7;
      },
    })).toBe(7);
  } finally { console.warn = original; }
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toStartWith('Warning: story screenshot artifacts ');
});

const borrowedFlag = '--borrowed-public-domain-book';
const bookFile = 'tests/qa/integration/catalogue-real-book-reading.test.ts';
const borrowedArgs = [borrowedFlag, bookFile];

function borrowedControlOptions(artifacts: string): TestDispatchOptions {
  return {
    env: { REZICS_STACK_PROFILE: 'qa', REZICS_QA_ARTIFACT_ROOT: artifacts,
      REZICS_QA_RUN_ID: 'retained-delivery-control', REZICS_AUDIT_PRODUCT_REVISION: 'product-control',
      REZICS_AUDIT_TEST_REVISION: 'executable-control', REZICS_AUDIT_FRONTEND_REVISION: 'frontend-control',
      REZICS_AUDIT_FIXTURE_GENERATION: 'generation-control' },
    retainedPreflight: async () => {},
    borrowedBookPreflight: async () => {},
    hostAdmission: async (_, command, options) => options!.run!(command),
    runner: async () => { throw new Error('A refusal must not launch a test child'); },
  };
}

function borrowedReceipt(artifacts: string) {
  const runs = readdirSync(artifacts);
  expect(runs).toHaveLength(1);
  const directory = join(artifacts, runs[0]!);
  return { directory, execution: JSON.parse(readFileSync(join(directory, 'execution.json'), 'utf8')),
    acceptance: JSON.parse(readFileSync(join(directory, 'acceptance.json'), 'utf8')),
    summary: readFileSync(join(directory, 'summary.md'), 'utf8'),
    log: readFileSync(join(directory, 'logs/integration.log'), 'utf8') };
}

test('borrowed Book selection stays integration and accepts only its explicit path and normal timeout', () => {
  expect(selectTestGroups(borrowedArgs)).toEqual([{ tier: 'integration', files: [bookFile], borrowedPublicDomainBook: true,
    command: ['bun', ['test', '--timeout=60000', bookFile]] }]);
  expect(selectTestCommand([bookFile, '--timeout', '90000', borrowedFlag]))
    .toEqual(['bun', ['test', '--timeout', '90000', bookFile]]);
  expect(selectTestCommand([...borrowedArgs, '--timeout=90000']))
    .toEqual(['bun', ['test', '--timeout=90000', bookFile]]);
  // The explicit flag is essential: every ordinary integration consumer keeps the hosted route.
  expect(selectTestCommand([bookFile])).toEqual(['bun', ['scripts/qa/cli.ts', '--tier', 'integration', '--file', bookFile]]);
});

for (const args of [
  [borrowedFlag], [borrowedFlag, `${bookFile}.missing.test.ts`], [borrowedFlag, `./${bookFile}`],
  [borrowedFlag, resolve(root, bookFile)], [borrowedFlag, bookFile, bookFile], [...borrowedArgs, borrowedFlag],
  [...borrowedArgs, 'tests/qa/unit/test-dispatch.test.ts'],
  [...borrowedArgs, 'tests/qa/integration/catalogue-public-recipe-reading.test.ts'],
  ['--tier', 'integration', ...borrowedArgs], [...borrowedArgs, '--tier', 'unit'],
  [...borrowedArgs, '--affected'], [...borrowedArgs, '--list'], [...borrowedArgs, '-t', 'C28'],
  [...borrowedArgs, '--keep'], [...borrowedArgs, '--record'], [...borrowedArgs, '--reporter=junit'],
  [...borrowedArgs, '--timeout=abc'], [...borrowedArgs, '--timeout'],
  [...borrowedArgs, '--timeout=30000', '--timeout', '40000'],
  [`${borrowedFlag}=true`, bookFile], [...borrowedArgs, '--result-file', '.temp/not-dispatcher-owned.json'],
]) {
  test(`borrowed Book refuses non-exclusive selection: ${args.join(' ')}`, async () => {
    const artifacts = artifactRoot();
    const options = borrowedControlOptions(artifacts);
    options.retainedPreflight = async () => { throw new Error('Invalid selections must stop before preflight'); };
    await expect(dispatchTest(args, options)).rejects.toThrow();
    expect(readdirSync(artifacts)).toEqual([]);
  });
}

for (const failure of ['retained-source', 'metadata', 'host', 'stale-after-wait']) {
  test(`borrowed Book refuses ${failure} before a child and records no assertion reach`, async () => {
    const artifacts = artifactRoot();
    const options = borrowedControlOptions(artifacts);
    const events: string[] = [];
    options.retainedPreflight = async (checkout, files) => {
      events.push('retained');
      expect(checkout).toBe(root); expect(files).toEqual([bookFile]);
      if (failure === 'retained-source') throw new Error('Retained-source preflight refused');
    };
    options.borrowedBookPreflight = async () => {
      events.push('metadata');
      if (failure === 'metadata' || (failure === 'stale-after-wait' && events.length > 3))
        throw new Error('TEST PREMISE: pinned Book custody is missing or changed');
    };
    options.hostAdmission = async (_, command, admission) => {
      events.push('host');
      if (failure === 'host') throw new Error('CPU admission deadline reached; no work started');
      return admission!.run!(command);
    };
    expect(await dispatchTest(borrowedArgs, options)).toBe(1);
    expect(events).toEqual(failure === 'retained-source' ? ['retained'] : failure === 'metadata'
      ? ['retained', 'metadata'] : failure === 'host'
      ? ['retained', 'metadata', 'host'] : ['retained', 'metadata', 'host', 'metadata']);
    const receipt = borrowedReceipt(artifacts);
    expect(receipt.execution.childCode).toBeUndefined();
    expect(receipt.execution.originalOutcomeAssertionReach).toBe('not reached');
    expect(receipt.execution.failureClass).toBe('environment');
    expect(receipt.log).toContain(failure === 'host' ? 'CPU admission deadline'
      : failure === 'retained-source' ? 'Retained-source preflight refused' : 'pinned Book custody');
    expect(receipt.acceptance.certifiesFull).toBe(false);
    expect(receipt.acceptance.tests[0].name).toBe('QA file did not complete');
  });
}

test('borrowed Book default preflight refuses a genuinely absent corpus before host admission', async () => {
  const artifacts = artifactRoot(), options = borrowedControlOptions(artifacts);
  delete options.borrowedBookPreflight;
  options.hostAdmission = async () => { throw new Error('Missing corpus must stop before admission'); };
  const previous = process.cwd();
  try {
    process.chdir(artifacts);
    expect(await dispatchTest(borrowedArgs, options)).toBe(1);
  } finally { process.chdir(previous); }
  const receipt = borrowedReceipt(artifacts);
  expect(receipt.log).toContain('TEST PREMISE: missing .temp/goal/public-domain-corpus.json');
  expect(receipt.execution.phase).toBe('preflight');
  expect(receipt.execution.childCode).toBeUndefined();
});

for (const control of ['pass', 'assertion', 'setup', 'missing-report', 'timeout', 'runner-error'] as const) {
  test(`borrowed Book direct integration dispatch preserves ${control} evidence without selecting a lifecycle`, async () => {
    const artifacts = artifactRoot(), options = borrowedControlOptions(artifacts);
    const events: string[] = [];
    const deadline = Date.now() + 60_000;
    options.deadline = deadline;
    options.retainedPreflight = async () => { events.push('retained'); };
    options.borrowedBookPreflight = async () => { events.push('metadata'); };
    options.hostAdmission = async (gib, command, admission) => {
      events.push('host');
      expect(gib).toBe(1); expect(admission!.cpu).toBe(true);
      expect(admission!.deadline).toBe(deadline); expect(admission!.root).toBe(root);
      expect(command).toEqual(['bun', 'test', '--timeout=90000', bookFile]);
      return admission!.run!(command);
    };
    options.runner = async ([program, args], env, output) => {
      events.push('child');
      expect(program).toBe('bun'); expect(args.slice(0, 3)).toEqual(['test', '--timeout=90000', bookFile]);
      expect(args).toHaveLength(5); expect(args[3]).toBe('--reporter=junit');
      expect(args.join(' ')).not.toMatch(/cli\.ts|stack|pool|bootstrap|restore|reset|cleanup/);
      expect(env!.REZICS_QA_RUN_ID).toBe('retained-delivery-control');
      expect(env!.REZICS_AUDIT_TEST_REVISION).toBe('executable-control');
      expect(env!.REZICS_QA_MEMORY_DEADLINE).toBe(String(deadline));
      expect(Number(env!.REZICS_QA_RUN_REMAINING_MS)).toBeGreaterThan(0);
      expect(output!.deadline.waitDeadline).toBe(deadline);
      if (control === 'runner-error') throw new Error('Injected runner failed before a report');
      const junit = args[4]!.slice('--reporter-outfile='.length);
      expect(dirname(junit)).toBe(dirname(dirname(output!.log)));
      const detail = control === 'setup' ? 'TEST PREMISE: OAuth fixture attachment failed'
        : control === 'assertion' ? 'Injected assertion mismatch' : '';
      writeFileSync(output!.log, detail || 'Injected runner control; no original outcome executed');
      if (control !== 'missing-report') writeFileSync(junit,
        `<testsuites><testsuite name="dispatcher control" file="${bookFile}"><testcase name="Injected dispatcher control" file="${bookFile}" time="0.01">${detail ? `<failure message="${detail}" />` : ''}</testcase></testsuite></testsuites>`);
      if (control === 'timeout') output!.timedOut = true;
      return control === 'assertion' || control === 'setup' ? 7 : 0;
    };
    const expectedCode = control === 'pass' ? 0 : control === 'assertion' || control === 'setup' ? 7 : 1;
    expect(await dispatchTest([...borrowedArgs, '--timeout=90000'], options)).toBe(expectedCode);
    expect(events).toEqual(['retained', 'metadata', 'host', 'metadata', 'child']);
    const receipt = borrowedReceipt(artifacts);
    expect(receipt.execution.retainedRunId).toBe('retained-delivery-control');
    expect(receipt.execution.artifactRunId).toBe(basename(receipt.directory));
    expect(receipt.execution.artifactRunId).not.toBe(receipt.execution.retainedRunId);
    expect(receipt.execution.childCode).toBe(control === 'runner-error' ? undefined
      : control === 'assertion' || control === 'setup' ? 7 : 0);
    expect(receipt.execution.code).toBe(expectedCode);
    expect(receipt.execution.productRevision).toBe('product-control');
    expect(receipt.execution.testRevision).toBe('executable-control');
    expect(receipt.execution.frontendRevision).toBe('frontend-control');
    expect(receipt.execution.fixtureGeneration).toBe('generation-control');
    expect(receipt.acceptance.certifiesFull).toBe(false);
    expect(receipt.acceptance.tiers[0].name).toBe('integration');
    expect(receipt.execution.failureClass).toBe(control === 'pass' ? undefined : control === 'assertion' ? 'assertion'
      : control === 'setup' ? 'environment' : control === 'timeout' ? 'timeout' : 'harness');
    expect(receipt.summary).toContain('Borrowed delivery: retained-delivery-control; artifact run:');
    expect(existsSync(join(receipt.directory, 'integration.xml'))).toBe(true);
    expect(JSON.parse(readFileSync(join(receipt.directory, 'run-deadline.json'), 'utf8')).waitDeadline).toBe(deadline);
  });
}
