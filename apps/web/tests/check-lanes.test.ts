import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { browserWorkerCommand, browserWorkerRequest, runBrowserWorker, runWebTestLanes } from '../scripts/check.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
const temporary = mkdtempSync(join(app, 'tests/check-lanes-'));
const fakeTests = join(temporary, 'tests');
const events = join(temporary, 'events');
mkdirSync(fakeTests, { recursive: true });
mkdirSync(events, { recursive: true });

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function addFakeTest(
  name: string,
  options: {
    browser?: boolean;
    delay?: number;
    failure?: string;
    serverIndependentFile?: string;
    waitForStart?: string;
  } = {},
) {
  const file = join(fakeTests, options.serverIndependentFile ?? name);
  const source = [
    "import { expect, test } from 'bun:test';",
    "import { existsSync, writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    options.browser ? "// Browser test marker: import { chromium } from 'playwright';" : '',
    `const events = ${JSON.stringify(events)};`,
    `const name = ${JSON.stringify(name)};`,
    `test(${JSON.stringify(name)}, async () => {`,
    '  writeFileSync(join(events, `start-${name}`), String(Date.now()));',
    ...(options.waitForStart
      ? [
          `  const deadline = Date.now() + 10000;`,
          `  while (!existsSync(join(events, ${JSON.stringify(`start-${options.waitForStart}`)}))) {`,
          '    if (Date.now() > deadline) throw new Error("parallel peer did not start");',
          '    await Bun.sleep(10);',
          '  }',
        ]
      : []),
    `  await Bun.sleep(${options.delay ?? 50});`,
    options.failure ? `  throw new Error(${JSON.stringify(options.failure)});` : '  expect(true).toBe(true);',
    '  writeFileSync(join(events, `end-${name}`), String(Date.now()));',
    '});',
  ]
    .filter(Boolean)
    .join('\n');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return relative(app, file).split('\\').join('/');
}

function timing(wall: number) {
  return { wall, create: 0, drop: 0, outsideTests: 0, result: 'pass', tests: [] };
}

function options(run: string, files: string[], env: NodeJS.ProcessEnv = {}) {
  return {
    files,
    directory: app,
    timingsFile: join(temporary, `${run}-timings.json`),
    env: { ...process.env, WEB_CHECK_EVENTS: events, ...env },
  };
}

test('runs fake files longest first in separate browser and unit pools, then records their wall times', async () => {
  const browserSlow = addFakeTest('browser-slow.test.ts', {
    browser: true,
    serverIndependentFile: 'ordered/scripts/check-placement.test.ts',
  });
  const browserFast = addFakeTest('browser-fast.test.ts', {
    browser: true,
    serverIndependentFile: 'ordered/scripts/focused.test.ts',
  });
  const unitSlow = addFakeTest('unit-slow.test.ts');
  const unitFast = addFakeTest('unit-fast.test.ts');
  const runOptions = options('ordered', [browserFast, unitFast, browserSlow, unitSlow], {
    WEB_BROWSER_CHECK_CONCURRENCY: '1',
    WEB_UNIT_CHECK_CONCURRENCY: '1',
  });
  writeFileSync(
    runOptions.timingsFile,
    JSON.stringify({
      recorded: new Date().toISOString(),
      files: {
        [browserSlow]: timing(40),
        [browserFast]: timing(1),
        [unitSlow]: timing(30),
        [unitFast]: timing(2),
      },
    }),
  );

  const result = await runWebTestLanes(runOptions);
  expect(result.failed).toEqual([]);
  expect(readFileSync(join(events, `start-${browserSlow}`), 'utf8')).toBeTruthy();
  expect(Number(readFileSync(join(events, `start-${browserSlow}`), 'utf8'))).toBeLessThan(
    Number(readFileSync(join(events, `start-${browserFast}`), 'utf8')),
  );
  expect(Number(readFileSync(join(events, `start-${unitSlow}`), 'utf8'))).toBeLessThan(
    Number(readFileSync(join(events, `start-${unitFast}`), 'utf8')),
  );

  const recorded = JSON.parse(readFileSync(runOptions.timingsFile, 'utf8')) as {
    files: Record<string, { wall: number; result: string }>;
  };
  for (const file of [browserSlow, browserFast, unitSlow, unitFast]) {
    expect(recorded.files[file]?.wall).toBeGreaterThan(0);
    expect(recorded.files[file]?.result).toBe('pass');
  }
}, 30_000);

test('a verifier test-name selector reaches each fresh per-file Bun process unchanged', async () => {
  const file = join(fakeTests, 'filtered.test.ts');
  const selected = join(events, 'filter-selected');
  const excluded = join(events, 'filter-excluded');
  writeFileSync(
    file,
    [
      "import { test } from 'bun:test';",
      "import { writeFileSync } from 'node:fs';",
      `test('selected route', () => writeFileSync(${JSON.stringify(selected)}, 'ran'));`,
      `test('excluded route', () => writeFileSync(${JSON.stringify(excluded)}, 'ran'));`,
    ].join('\n'),
  );
  const run = options('filtered', [relative(app, file).split('\\').join('/')]);

  const result = await runWebTestLanes({ ...run, testArgs: ['--test-name-pattern', 'selected route'] });

  expect(result.failed).toEqual([]);
  expect(readFileSync(selected, 'utf8')).toBe('ran');
  expect(() => readFileSync(excluded, 'utf8')).toThrow();
});

test('a placed browser worker keeps the selected Bun filter through per-file execution', async () => {
  const selected = join(events, 'browser-filter-selected');
  const excluded = join(events, 'browser-filter-excluded');
  const file = join(fakeTests, 'filter/scripts/check-placement-custody.test.ts');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      "import { test } from 'bun:test';",
      "import { writeFileSync } from 'node:fs';",
      "// Browser test marker: import { chromium } from 'playwright';",
      `test('selected server route', () => writeFileSync(${JSON.stringify(selected)}, 'ran'));`,
      `test('excluded server route', () => writeFileSync(${JSON.stringify(excluded)}, 'ran'));`,
    ].join('\n'),
  );
  const selectedFile = relative(app, file).split('\\').join('/');
  const report = relative(root, join(temporary, 'browser-filter-report')).split('\\').join('/');
  const testArgs = ['--timeout', '15000', '--reporter=dot', '--test-name-pattern', 'selected server route'];
  const command = browserWorkerCommand({ files: [selectedFile], report, testScript: 'bun run test', testArgs });
  expect(command.slice(-(testArgs.length + 2))).toEqual([selectedFile, '--', ...testArgs]);

  const worker = browserWorkerRequest(command.slice(2));
  expect(worker).toEqual({ files: [selectedFile], report, testScript: 'bun run test', testArgs });
  if (!worker) throw new Error('placed browser command was not recognized by its receiving route');
  try {
    const result = await runBrowserWorker({ ...worker, env: options('browser-filter', []).env });
    expect(result).toBe(0);
    expect(readFileSync(selected, 'utf8')).toBe('ran');
    expect(() => readFileSync(excluded, 'utf8')).toThrow();
  } finally {
    rmSync(resolve(root, report), { recursive: true, force: true });
  }
}, 30_000);

test('bounds browser lanes separately while unit files use a wider pool', async () => {
  const browserOne = addFakeTest('browser-one.test.ts', {
    browser: true,
    delay: 500,
    serverIndependentFile: 'pools/scripts/check-placement.test.ts',
  });
  const browserTwo = addFakeTest('browser-two.test.ts', {
    browser: true,
    delay: 500,
    serverIndependentFile: 'pools/scripts/focused.test.ts',
  });
  const unitOne = addFakeTest('unit-one.test.ts', { delay: 1000, waitForStart: 'unit-two.test.ts' });
  const unitTwo = addFakeTest('unit-two.test.ts', { delay: 1000, waitForStart: 'unit-one.test.ts' });
  const runOptions = options('pools', [browserOne, browserTwo, unitOne, unitTwo], {
    WEB_BROWSER_CHECK_CONCURRENCY: '1',
    WEB_UNIT_CHECK_CONCURRENCY: '2',
  });

  const result = await runWebTestLanes(runOptions);
  expect(result.failed).toEqual([]);
  const start = (name: string) => Number(readFileSync(join(events, `start-${name}`), 'utf8'));
  const end = (name: string) => Number(readFileSync(join(events, `end-${name}`), 'utf8'));
  expect(start('browser-two.test.ts')).toBeGreaterThanOrEqual(end('browser-one.test.ts'));
  expect(Math.max(start('unit-one.test.ts'), start('unit-two.test.ts'))).toBeLessThan(
    Math.min(end('unit-one.test.ts'), end('unit-two.test.ts')),
  );
}, 30_000);

test('reports a failed fake file with its own output', async () => {
  const passing = addFakeTest('unit-pass.test.ts');
  const failing = addFakeTest('unit-fail.test.ts', { failure: 'failure-output-owned-by-this-file' });
  const outcomes: { file: string; error?: Error }[] = [];
  const result = await runWebTestLanes({
    ...options('failure', [passing, failing], { WEB_UNIT_CHECK_CONCURRENCY: '2' }),
    onComplete: (outcome) => outcomes.push(outcome),
  });

  expect(result.failed).toEqual([failing]);
  const failed = outcomes.find((outcome) => outcome.file === failing);
  expect(failed?.error?.message).toContain(failing);
  expect(failed?.error?.message).toContain('failure-output-owned-by-this-file');
});

test('a placed browser worker serializes files that share its generated source and Vite cache', async () => {
  const first = addFakeTest('worker-browser-first.test.ts', {
    browser: true,
    delay: 500,
    serverIndependentFile: 'worker/scripts/check-placement.test.ts',
  });
  const second = addFakeTest('worker-browser-second.test.ts', {
    browser: true,
    delay: 500,
    serverIndependentFile: 'worker/scripts/focused.test.ts',
  });
  const env = { ...process.env, WEB_BROWSER_CHECK_CONCURRENCY: '3' };
  delete env.REZICS_STACK_SLOT;
  const result = await runBrowserWorker({
    files: [first, second],
    report: relative(root, join(temporary, 'worker-report')),
    env,
  });
  expect(result).toBe(0);
  const start = (name: string) => Number(readFileSync(join(events, `start-${name}`), 'utf8'));
  const end = (name: string) => Number(readFileSync(join(events, `end-${name}`), 'utf8'));
  expect(start('worker-browser-second.test.ts')).toBeGreaterThanOrEqual(end('worker-browser-first.test.ts'));
}, 30_000);
