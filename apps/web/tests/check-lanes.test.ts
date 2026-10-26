import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runWebTestLanes } from '../scripts/check.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/check-lanes-'));
const fakeTests = join(temporary, 'tests');
const events = join(temporary, 'events');
mkdirSync(fakeTests, { recursive: true });
mkdirSync(events, { recursive: true });

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function addFakeTest(name: string, options: { browser?: boolean; delay?: number; failure?: string } = {}) {
  const source = [
    "import { expect, test } from 'bun:test';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    options.browser ? "// Browser test marker: import { chromium } from 'playwright';" : '',
    `const events = ${JSON.stringify(events)};`,
    `const name = ${JSON.stringify(name)};`,
    `test(${JSON.stringify(name)}, async () => {`,
    '  writeFileSync(join(events, `start-${name}`), String(Date.now()));',
    `  await Bun.sleep(${options.delay ?? 50});`,
    options.failure ? `  throw new Error(${JSON.stringify(options.failure)});` : '  expect(true).toBe(true);',
    '  writeFileSync(join(events, `end-${name}`), String(Date.now()));',
    '});',
  ]
    .filter(Boolean)
    .join('\n');
  writeFileSync(join(fakeTests, name), source);
  return relative(app, join(fakeTests, name)).split('\\').join('/');
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
  const browserSlow = addFakeTest('browser-slow.test.ts', { browser: true });
  const browserFast = addFakeTest('browser-fast.test.ts', { browser: true });
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
});

test('bounds browser lanes separately while unit files use a wider pool', async () => {
  const browserOne = addFakeTest('browser-one.test.ts', { browser: true, delay: 500 });
  const browserTwo = addFakeTest('browser-two.test.ts', { browser: true, delay: 500 });
  const unitOne = addFakeTest('unit-one.test.ts', { delay: 500 });
  const unitTwo = addFakeTest('unit-two.test.ts', { delay: 500 });
  const runOptions = options('pools', [browserOne, browserTwo, unitOne, unitTwo], {
    WEB_BROWSER_CHECK_CONCURRENCY: '1',
    WEB_UNIT_CHECK_CONCURRENCY: '2',
  });

  const result = await runWebTestLanes(runOptions);
  expect(result.failed).toEqual([]);
  const start = (name: string) => Number(readFileSync(join(events, `start-${name}`), 'utf8'));
  expect(Math.abs(start('unit-one.test.ts') - start('unit-two.test.ts'))).toBeLessThan(400);
  expect(Math.abs(start('browser-one.test.ts') - start('browser-two.test.ts'))).toBeGreaterThan(400);
});

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
