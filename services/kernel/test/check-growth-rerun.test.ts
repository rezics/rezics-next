import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runLaneSuite } from '../../../scripts/test-lanes.ts';

const projectRoot = resolve(import.meta.dir, '../../..');

async function withDirectory(use: (directory: string) => Promise<void>): Promise<void> {
  const temporaryRoot = resolve(projectRoot, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'kernel-growth-rerun-'));
  try {
    await use(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function writeTests(module: string, files: Record<string, string>): void {
  for (const [file, source] of Object.entries(files)) {
    const path = resolve(module, file);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, source);
  }
}

function laneEnvironment(directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_CHECK_TIMINGS: resolve(directory, 'timings'),
    FIXTURE_CHECK_CONCURRENCY: '1',
    FIXTURE_CHECK_ORDER: 'name',
    REZICS_STACK_LEASE_DIR: resolve(directory, 'lease'),
    REZICS_STACK_SLOTS: '1',
  };
  delete env.REZICS_STACK_SLOT;
  delete env.REZICS_STACK_LEASE;
  return env;
}

function growthTest(title: string, message: string, condition = 'true'): string {
  return [
    "import { test } from 'bun:test';",
    'class GrowthBoundError extends Error {',
    '  constructor(message: string) { super(message); this.name = "GrowthBoundError"; }',
    '}',
    `test(${JSON.stringify(title)}, () => { if (${condition}) throw new GrowthBoundError(${JSON.stringify(message)}); });`,
    '',
  ].join('\n');
}

test('a file whose only failures are growth bound errors is rerun alone under a stack slot and, passing, is reported as load-sensitive without failing the run', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const env = laneEnvironment(directory);
    const events: string[] = [];
    let runs = 0;
    writeTests(module, {
      'test/a.test.ts': growthTest(
        'first growth check',
        'rows for a on first run\nextra detail',
        'Number(process.env.ATTEMPT) < 4',
      ),
      'test/b.test.ts': growthTest(
        'second growth check',
        'rows for b on first run\nextra detail',
        'Number(process.env.ATTEMPT) < 4',
      ),
      'test/c.test.ts': "import { expect, test } from 'bun:test';\ntest('passes', () => expect(true).toBe(true));\n",
    });
    let output = '';
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result;
    try {
      result = await runLaneSuite({
        service: 'fixture',
        directory: module,
        files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
        partial: false,
        createDatabase: async (database) => void events.push(`create ${database}`),
        dropDatabase: async (database) => void events.push(`drop ${database}`),
        environment: (database) => {
          runs++;
          events.push(`run ${database} ${runs}`);
          return { ...env, ATTEMPT: String(runs) };
        },
        env,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result).toEqual({ failed: [], concurrency: 1 });
    expect(events).toEqual([
      'create fixture_test_1',
      'run fixture_test_1 1',
      'drop fixture_test_1',
      'create fixture_test_2',
      'run fixture_test_2 2',
      'drop fixture_test_2',
      'create fixture_test_3',
      'run fixture_test_3 3',
      'drop fixture_test_3',
      'create fixture_growth_1_test_1',
      'run fixture_growth_1_test_1 4',
      'drop fixture_growth_1_test_1',
      'create fixture_growth_2_test_1',
      'run fixture_growth_2_test_1 5',
      'drop fixture_growth_2_test_1',
    ]);
    expect(output).toContain('Load-sensitive growth checks (passed alone): 2\n');
    expect(output).toContain(
      'load-sensitive growth check: test/a.test.ts :: first growth check :: rows for a on first run',
    );
    expect(output).toContain(
      'load-sensitive growth check: test/b.test.ts :: second growth check :: rows for b on first run',
    );
    expect(output.slice(output.indexOf('Load-sensitive growth checks'))).not.toContain('extra detail');
  });
});

test('a growth file that fails again alone fails the run', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const env = laneEnvironment(directory);
    const events: string[] = [];
    writeTests(module, {
      'test/always-fails.test.ts': [
        "import { test } from 'bun:test';",
        "test('persistent growth', () => {",
        '  if (!process.env.REZICS_STACK_SLOT) throw new Error("rerun did not have a stack slot");',
        '  const error = new Error("rows still exceed the limit"); error.name = "GrowthBoundError"; throw error;',
        '});',
        '',
      ].join('\n'),
    });
    let runs = 0;
    let output = '';
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result;
    try {
      result = await runLaneSuite({
        service: 'fixture',
        directory: module,
        files: ['test/always-fails.test.ts'],
        partial: false,
        createDatabase: async (database) => void events.push(`create ${database}`),
        dropDatabase: async (database) => void events.push(`drop ${database}`),
        environment: (database) => {
          runs++;
          events.push(`run ${database}`);
          return { ...env };
        },
        env,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result).toEqual({ failed: ['test/always-fails.test.ts'], concurrency: 1 });
    expect(events).toEqual([
      'create fixture_test_1',
      'run fixture_test_1',
      'drop fixture_test_1',
      'create fixture_growth_1_test_1',
      'run fixture_growth_1_test_1',
      'drop fixture_growth_1_test_1',
    ]);
    expect(runs).toBe(2);
    expect(output).toContain('failed again alone');
    expect(output).not.toContain('Load-sensitive growth checks (passed alone)');
  });
});

test('a file with any failure other than a growth bound error is not rerun and fails the run', async () => {
  await withDirectory(async (directory) => {
    const module = resolve(directory, 'module');
    const env = laneEnvironment(directory);
    const events: string[] = [];
    writeTests(module, {
      'test/mixed.test.ts': [
        "import { expect, test } from 'bun:test';",
        'class GrowthBoundError extends Error { constructor() { super("rows exceed the limit"); this.name = "GrowthBoundError"; } }',
        "test('growth check', () => { throw new GrowthBoundError(); });",
        "test('ordinary check', () => expect(1).toBe(2));",
        '',
      ].join('\n'),
      'test/cleanup.test.ts': growthTest('growth before cleanup failure', 'rows exceed before cleanup'),
    });
    let output = '';
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let result;
    try {
      result = await runLaneSuite({
        service: 'fixture',
        directory: module,
        files: ['test/mixed.test.ts', 'test/cleanup.test.ts'],
        partial: false,
        createDatabase: async (database) => void events.push(`create ${database}`),
        dropDatabase: async (database) => {
          events.push(`drop ${database}`);
          if (database === 'fixture_test_1') throw new Error('drop refused');
        },
        environment: () => ({ ...env }),
        env,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result).toEqual({ failed: ['test/cleanup.test.ts', 'test/mixed.test.ts'], concurrency: 1 });
    expect(events).toEqual([
      'create fixture_test_1',
      'drop fixture_test_1',
      'create fixture_test_2',
      'drop fixture_test_2',
    ]);
    expect(output).not.toContain('failed again alone');
    expect(output).not.toContain('Load-sensitive growth checks (passed alone)');
  });
});
