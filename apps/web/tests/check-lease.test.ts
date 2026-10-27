import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { acquireStackSlot } from '../../../scripts/stack-lease.ts';
import { runWebTestLanes } from '../scripts/check.ts';

const app = resolve(import.meta.dir, '..');
const root = resolve(app, '../..');
mkdirSync(join(root, '.temp'), { recursive: true });
const temporary = mkdtempSync(join(root, '.temp/check-lease-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

type FakeTestOptions = { stackHeavy?: boolean; delay?: number };

function addFakeTest(directory: string, events: string, name: string, options: FakeTestOptions = {}): string {
  const source = [
    "import { expect, test } from 'bun:test';",
    "import { writeFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    options.stackHeavy ? `// Stack-heavy marker: import { chromium } from '${['play', 'wright'].join('')}';` : '',
    `const events = ${JSON.stringify(events)};`,
    `const name = ${JSON.stringify(name)};`,
    'test(name, async () => {',
    '  writeFileSync(join(events, `start-${name}`), String(Date.now()));',
    '  writeFileSync(join(events, `environment-${name}.json`), JSON.stringify({',
    '    slot: process.env.REZICS_STACK_SLOT ?? null,',
    '    isolated: process.env.WEB_TEST_STATE_DIR !== undefined,',
    '  }));',
    `  await Bun.sleep(${options.delay ?? 200});`,
    '  writeFileSync(join(events, `end-${name}`), String(Date.now()));',
    '  expect(true).toBe(true);',
    '});',
  ]
    .filter(Boolean)
    .join('\n');
  const path = join(directory, name);
  writeFileSync(path, source);
  return relative(app, path).split('\\').join('/');
}

function scenario(name: string) {
  const directory = join(temporary, name);
  const tests = join(directory, 'tests');
  const events = join(directory, 'events');
  const lease = join(directory, 'lease');
  mkdirSync(tests, { recursive: true });
  mkdirSync(events, { recursive: true });
  return { tests, events, lease };
}

function runOptions(
  run: ReturnType<typeof scenario>,
  files: string[],
  env: NodeJS.ProcessEnv = {},
  onComplete?: (outcome: { file: string; output?: string }) => void,
) {
  const inherited = {
    ...process.env,
    REZICS_STACK_LEASE_DIR: run.lease,
    WEB_CHECK_EVENTS: run.events,
    ...env,
  };
  if (env.REZICS_STACK_SLOT === undefined) delete inherited.REZICS_STACK_SLOT;
  delete inherited.REZICS_STACK_LEASE;
  delete inherited.WEB_TEST_STATE_DIR;
  return {
    files,
    directory: app,
    timingsFile: join(run.lease, 'timings.json'),
    env: inherited,
    onComplete,
  };
}

function interval(events: string, name: string): [number, number] {
  return [
    Number(readFileSync(join(events, `start-${name}`), 'utf8')),
    Number(readFileSync(join(events, `end-${name}`), 'utf8')),
  ];
}

function maxParallel(events: string, names: string[]): number {
  const changes = names.flatMap((name) => {
    const [start, end] = interval(events, name);
    return [
      { time: start, amount: 1 },
      { time: end, amount: -1 },
    ];
  });
  changes.sort((left, right) => left.time - right.time || left.amount - right.amount);
  let active = 0;
  let maximum = 0;
  for (const change of changes) {
    active += change.amount;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function environment(events: string, name: string): { slot: string | null; isolated: boolean } {
  return JSON.parse(readFileSync(join(events, `environment-${name}.json`), 'utf8')) as {
    slot: string | null;
    isolated: boolean;
  };
}

test('leases every stack-heavy file while pure unit files run outside the isolated wrapper', async () => {
  const run = scenario('unheld');
  const browserFiles = [
    addFakeTest(run.tests, run.events, 'browser-one.test.ts', { stackHeavy: true, delay: 500 }),
    addFakeTest(run.tests, run.events, 'browser-two.test.ts', { stackHeavy: true, delay: 500 }),
    addFakeTest(run.tests, run.events, 'browser-three.test.ts', { stackHeavy: true, delay: 500 }),
  ];
  const unitFiles = [
    addFakeTest(run.tests, run.events, 'unit-one.test.ts', { delay: 350 }),
    addFakeTest(run.tests, run.events, 'unit-two.test.ts', { delay: 350 }),
  ];
  const outcomes = new Map<string, string>();
  const options = runOptions(
    run,
    [...browserFiles, ...unitFiles],
    {
      REZICS_STACK_SLOTS: '2',
      WEB_BROWSER_CHECK_CONCURRENCY: '3',
      WEB_UNIT_CHECK_CONCURRENCY: '2',
    },
    (outcome) => outcomes.set(outcome.file, outcome.output ?? ''),
  );

  const result = await runWebTestLanes(options);

  expect(result.failed).toEqual([]);
  expect(result.concurrency).toEqual({ browser: 3, unit: 2 });
  expect(
    maxParallel(
      run.events,
      browserFiles.map((file) => file.split('/').at(-1)!),
    ),
  ).toBe(2);
  expect(
    maxParallel(
      run.events,
      unitFiles.map((file) => file.split('/').at(-1)!),
    ),
  ).toBe(2);
  for (const file of browserFiles) {
    const name = file.split('/').at(-1)!;
    expect(environment(run.events, name).slot).toMatch(/^\d+\/2$/);
    expect(environment(run.events, name).isolated).toBe(true);
    expect(outcomes.get(file)).toContain('stack-lease: web isolated slot');
  }
  for (const file of unitFiles) {
    const name = file.split('/').at(-1)!;
    expect(environment(run.events, name)).toEqual({ slot: null, isolated: false });
    expect(outcomes.get(file)).not.toContain('stack-lease:');
  }
});

test('serializes stack-heavy files inside an inherited single slot without taking another slot', async () => {
  const run = scenario('inherited');
  const browserFiles = [
    addFakeTest(run.tests, run.events, 'inherited-one.test.ts', { stackHeavy: true, delay: 150 }),
    addFakeTest(run.tests, run.events, 'inherited-two.test.ts', { stackHeavy: true, delay: 150 }),
  ];
  const leaseEnvironment = {
    ...process.env,
    REZICS_STACK_LEASE_DIR: run.lease,
    REZICS_STACK_SLOTS: '1',
  };
  delete leaseEnvironment.REZICS_STACK_SLOT;
  delete leaseEnvironment.REZICS_STACK_LEASE;
  const parentSlot = await acquireStackSlot('web check parent', leaseEnvironment);
  const outcomes = new Map<string, string>();
  let finishedBeforeGuard = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const runPromise = runWebTestLanes(
    runOptions(
      run,
      browserFiles,
      {
        ...leaseEnvironment,
        ...parentSlot.env,
        WEB_BROWSER_CHECK_CONCURRENCY: '2',
      },
      (outcome) => outcomes.set(outcome.file, outcome.output ?? ''),
    ),
  );
  const guard = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 3000);
  });

  try {
    finishedBeforeGuard = await Promise.race([runPromise.then(() => true), guard.then(() => false)]);
  } finally {
    if (timer) clearTimeout(timer);
    await parentSlot.release();
  }
  const result = await runPromise;

  expect(finishedBeforeGuard).toBe(true);
  expect(result.failed).toEqual([]);
  expect(result.concurrency.browser).toBe(1);
  expect(
    maxParallel(
      run.events,
      browserFiles.map((file) => file.split('/').at(-1)!),
    ),
  ).toBe(1);
  for (const file of browserFiles) {
    const name = file.split('/').at(-1)!;
    expect(environment(run.events, name)).toEqual({ slot: parentSlot.env.REZICS_STACK_SLOT, isolated: true });
    expect(outcomes.get(file)).not.toContain('stack-lease: web isolated slot');
  }
});
