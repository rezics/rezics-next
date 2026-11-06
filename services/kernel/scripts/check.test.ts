import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { prepareArtifactRun, readArtifactCatalog, restoreArtifactReturns } from '../../../scripts/check-artifacts.ts';
import { capture as captureProcess } from '../../../scripts/test-lanes.ts';
import {
  assertSchemaConsistency,
  capture,
  cleanup,
  createPostgresConnectionSampler,
  formatConnectionRunSummary,
  formatFileConnectionResult,
  formatPostgresErrors,
  invokeTypecheck,
  moduleExtensionPolicyFailure,
  reportCheckFailure,
  reportPostgresErrors,
  runKernelCheckStages,
  startPostgresContainer,
} from './check.ts';
import { prepareReyloAnalysisCache } from './reylo-cache.ts';

function schemaFixture(): { root: string; kernel: string; dispose: () => void } {
  const temporary = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(resolve(temporary, 'schema-diagnostics-test-'));
  const kernel = resolve(root, 'services/kernel');
  mkdirSync(resolve(kernel, 'db/access'), { recursive: true });
  return { root, kernel, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('A genuine schema mismatch retains expected and actual normalized dumps and an actionable bounded structural diff identifying the owning schema path and exact source, while still failing before any journey test; missing expected files remain failures', async () => {
  const fixture = schemaFixture();
  try {
    const path = 'db/access/schema.sql';
    const heading = '-- Name: profile; Type: TABLE; Schema: access; Owner: -';
    const prefix = `${heading}\nCREATE TABLE access.profile (\n${Array.from({ length: 50 }, (_, i) => `    column_${i} text,`).join('\n')}\n`;
    const expected = `${prefix}    display_name text\n);\n`;
    const actual = `${prefix}    display_name character varying\n);\n`;
    writeFileSync(resolve(fixture.kernel, path), expected);
    const physical = randomUUID();
    const logical = randomUUID();
    const stage = prepareArtifactRun(fixture.root, physical);
    let journeyRan = false;
    let failure = '';
    try {
      await assertSchemaConsistency({ [path]: actual }, fixture.kernel, {
        REZICS_CHECK_ARTIFACTS_DIR: stage,
        REZICS_CHECK_ARTIFACTS_PHYSICAL_RUN_ID: physical,
        REZICS_CHECK_ID: logical,
        DATABASE_URL: 'postgres://secret:never-log-this@localhost/database',
      });
      journeyRan = true;
    } catch (error) {
      failure = String(error);
    }
    expect(journeyRan).toBe(false);
    expect(failure).toContain(`Schema dump differs from ${path}`);
    expect(failure).toContain('Checked source commit/tree: UNKNOWN');
    expect(failure).not.toContain('never-log-this');
    expect(failure).toContain(heading);
    expect(failure).toContain('-    display_name text');
    expect(failure).toContain('+    display_name character varying');
    expect(readFileSync(resolve(fixture.kernel, path), 'utf8')).toBe(expected);

    const [returned] = readArtifactCatalog(fixture.root, logical);
    expect(returned).toBeDefined();
    const artifacts = resolve(fixture.root, returned!);
    for (const file of ['expected.sql', 'actual.sql', 'difference.diff']) {
      expect(failure).toContain(resolve(artifacts, file));
    }
    cleanup([], () => {
      throw new Error('no container should be touched');
    });
    // Emulate loss of host-local files, then use the ordinary failure return boundary.
    rmSync(artifacts, { recursive: true });
    const restored = restoreArtifactReturns(fixture.root, stage, physical, logical);
    expect(restored.rejected).toEqual([]);
    expect(restored.missing).toEqual([]);
    expect(restored.restored).toHaveLength(3);
    expect(readFileSync(resolve(artifacts, 'expected.sql'), 'utf8')).toBe(expected);
    expect(readFileSync(resolve(artifacts, 'actual.sql'), 'utf8')).toBe(actual);
    expect(readFileSync(resolve(artifacts, 'difference.diff'), 'utf8')).toContain(heading);

    await expect(assertSchemaConsistency({ 'db/schema.sql': actual }, fixture.kernel, {})).rejects.toThrow(
      'Missing expected schema file: db/schema.sql',
    );
  } finally {
    fixture.dispose();
  }
});

test('equal schema dumps do not create diagnostics; missing expected dumps retain an explicit missing marker', async () => {
  const fixture = schemaFixture();
  try {
    const actual = 'CREATE TABLE access.profile (id uuid);\n';
    writeFileSync(resolve(fixture.kernel, 'db/schema.sql'), actual);
    await assertSchemaConsistency({ 'db/schema.sql': actual }, fixture.kernel, {});
    const parent = resolve(fixture.kernel, '.temp/schema-diagnostics');
    expect(existsSync(parent)).toBe(false);
    await expect(assertSchemaConsistency({ 'db/access/schema.sql': actual }, fixture.kernel, {})).rejects.toThrow(
      'Missing expected schema file: db/access/schema.sql',
    );
    const artifacts = resolve(parent, readdirSync(parent)[0]!);
    expect(existsSync(resolve(artifacts, 'expected.sql'))).toBe(false);
    expect(readFileSync(resolve(artifacts, 'expected.missing.txt'), 'utf8')).toContain('db/access/schema.sql');
    expect(readFileSync(resolve(artifacts, 'actual.sql'), 'utf8')).toBe(actual);
    expect(readFileSync(resolve(artifacts, 'difference.diff'), 'utf8')).toContain(`+${actual.trim()}`);
    expect(existsSync(resolve(fixture.kernel, 'db/access/schema.sql'))).toBe(false);
  } finally {
    fixture.dispose();
  }
});

test('schema diagnostics bound large changes and preserve failure when writing diagnostics fails', async () => {
  const fixture = schemaFixture();
  try {
    const expected = `${' '.repeat(500)}\n`.repeat(500);
    const actual = `${'x'.repeat(500)}\n`.repeat(500);
    writeFileSync(resolve(fixture.kernel, 'db/schema.sql'), expected);
    await expect(assertSchemaConsistency({ 'db/schema.sql': actual }, fixture.kernel, {})).rejects.toThrow(
      'Schema dump differs from db/schema.sql',
    );
    const parent = resolve(fixture.kernel, '.temp/schema-diagnostics');
    const artifacts = resolve(parent, readdirSync(parent)[0]!);
    const diff = readFileSync(resolve(artifacts, 'difference.diff'), 'utf8');
    expect(diff.length).toBeLessThan(16_000);
    expect(diff).toContain('lines omitted');
    expect(diff).toContain('line truncated');
    expect(diff).toContain('- ');
    expect(diff).toContain('+x');
    expect(readFileSync(resolve(artifacts, 'actual.sql'), 'utf8')).toBe(actual);
    rmSync(parent, { recursive: true });
    writeFileSync(parent, 'not a directory');
    await expect(assertSchemaConsistency({ 'db/schema.sql': actual }, fixture.kernel, {})).rejects.toThrow(
      'Schema diagnostics could not be retained; schema consistency still failed',
    );
    for (const path of ['../schema.sql', '/db/schema.sql', 'db/../schema.sql', 'db/access\\schema.sql']) {
      await expect(assertSchemaConsistency({ [path]: actual }, fixture.kernel, {})).rejects.toThrow(
        'Invalid schema dump path',
      );
    }
  } finally {
    fixture.dispose();
  }
});

test('the check database logs each error with its SQLSTATE', () => {
  const calls: string[][] = [];
  const container = startPostgresContainer((args) => (calls.push(args), 'postgres-container'));
  const args = calls[0]!;
  const prefix = args.indexOf('log_line_prefix=%m [%p] [%e] ');

  expect(container).toBe('postgres-container');
  expect(prefix).toBeGreaterThan(0);
  expect(args[prefix - 1]).toBe('-c');
});

test("a failing kernel check prints the database server's errors and fatal messages by SQLSTATE", () => {
  const logLines = [
    '2026-10-28 01:02:03 UTC [100] [53300] ERROR: outside the retained log tail',
    ...Array.from({ length: 298 }, (_, index) => `retained non-error line ${index}`),
    '2026-10-28 01:02:04 UTC [101] [53300] ERROR: remaining connection slots are reserved',
    '2026-10-28 01:02:05 UTC [102] [53300] ERROR: sorry, too many clients already',
    '2026-10-28 01:02:06 UTC [103] [57P03] FATAL: the database system is starting up',
    '2026-10-28 01:02:07 UTC [104] [XX000] PANIC: forced server panic',
  ].join('\n');
  const calls: string[][] = [];
  let printed = '';

  reportPostgresErrors(
    'postgres-container',
    (args) => (calls.push(args), logLines),
    (message) => (printed += message),
  );

  expect(calls).toEqual([['logs', '--tail', '300', 'postgres-container']]);
  expect(printed).toContain('grouped by SQLSTATE');
  expect(printed).toContain('53300 ERROR: 2; first: remaining connection slots are reserved');
  expect(printed).toContain('57P03 FATAL: 1; first: the database system is starting up');
  expect(printed).toContain('XX000 PANIC: 1; first: forced server panic');
  expect(printed).not.toContain('outside the retained log tail');
  expect(formatPostgresErrors('2026-10-28 01:02:08 UTC [105] [00000] LOG: checkpoint complete')).toBeNull();
});

test('a check whose database ran out of space reports an environment failure and exits 75', () => {
  const logOutput =
    '2026-10-28 01:02:03 UTC [100] [53100] ERROR: could not extend file "base/21191/20378": No space left on device';
  const calls: string[][] = [];
  let printed = '';

  const exitCode = reportCheckFailure(
    'postgres-container',
    [],
    (args) => {
      calls.push(args);
      if (args[0] === 'logs') return logOutput;
      return [
        'Filesystem 1B-blocks Used Available Use% Mounted on',
        'tmpfs 8589934592 1024 8589933568 1% /var/lib/postgresql',
      ].join('\n');
    },
    (message) => (printed += message),
    'check-host',
  );

  expect(exitCode).toBe(75);
  expect(calls).toEqual([
    ['logs', '--tail', '300', 'postgres-container'],
    ['exec', 'postgres-container', 'df', '-B1', '/var/lib/postgresql'],
  ]);
  expect(printed).toBe(
    `${formatPostgresErrors(logOutput)}\nkernel check: environment failure: database storage full (SQLSTATE 53100) on check-host; 8589933568 of 8589934592 bytes free\n`,
  );
});

test('a failed file reporting no space exits 75 and reports unknown disk usage when df fails', () => {
  const calls: string[][] = [];
  let printed = '';

  const exitCode = reportCheckFailure(
    'postgres-container',
    ['bun test ./test/growth.test.ts failed:\nNo space left on device'],
    (args) => {
      calls.push(args);
      if (args[0] === 'logs') return '';
      throw new Error('df failed');
    },
    (message) => (printed += message),
    'check-host',
  );

  expect(exitCode).toBe(75);
  expect(calls).toEqual([
    ['logs', '--tail', '300', 'postgres-container'],
    ['exec', 'postgres-container', 'df', '-B1', '/var/lib/postgresql'],
  ]);
  expect(printed).toBe(
    'kernel check: environment failure: database storage full (SQLSTATE 53100) on check-host; unknown of unknown bytes free\n',
  );
});

test('a check that fails for any other reason exits 1 without an environment line', () => {
  const calls: string[][] = [];
  let printed = '';

  const exitCode = reportCheckFailure(
    'postgres-container',
    ['bun test ./test/accounts.test.ts failed:\nExpected 1 to be 2'],
    (args) => (calls.push(args), ''),
    (message) => (printed += message),
    'check-host',
  );

  expect(exitCode).toBe(1);
  expect(calls).toEqual([['logs', '--tail', '300', 'postgres-container']]);
  expect(printed).toBe('');
});

test("the check reports each file's peak database connections and the run's peak against max_connections", async () => {
  const rows = [
    [
      { datname: 'postgres', count: '1' },
      { datname: 'rezics', count: '2' },
      { datname: 'kernel_analysis', count: '1' },
      { datname: 'kernel_test_1', count: '4' },
      { datname: 'kernel_test_2', count: '3' },
      { datname: 'kernel_test_3', count: '1' },
    ],
    [
      { datname: 'postgres', count: '1' },
      { datname: 'rezics', count: '1' },
      { datname: 'kernel_analysis', count: '1' },
      { datname: 'kernel_test_1', count: '6' },
      { datname: 'kernel_test_2', count: '5' },
      { datname: 'kernel_test_3', count: '2' },
    ],
  ];
  const queries: string[] = [];
  const sampler = createPostgresConnectionSampler(async (sql) => {
    queries.push(sql);
    return rows.shift() ?? [];
  });

  await sampler.sample();
  await sampler.sample();

  expect(queries).toEqual([
    'SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname',
    'SELECT datname, count(*) FROM pg_stat_activity GROUP BY datname',
  ]);
  expect(sampler.peakFor('kernel_test_1')).toBe(6);
  expect(sampler.peakFor('kernel_test_2')).toBe(5);
  expect(sampler.peakTotal()).toBe(16);
  expect(formatFileConnectionResult('test/accounts.test.ts', 'PASS', sampler.peakFor('kernel_test_1'))).toBe(
    'test/accounts.test.ts: PASS; peak database connections 6',
  );
  expect(
    formatConnectionRunSummary(
      sampler.peakTotal(),
      new Map([
        ['test/accounts.test.ts', sampler.peakFor('kernel_test_1')],
        ['test/search.test.ts', sampler.peakFor('kernel_test_2')],
        ['test/tags.test.ts', sampler.peakFor('kernel_test_3')],
        ['test/other.test.ts', 1],
      ]),
    ),
  ).toBe(
    'PostgreSQL connections: peak 16/500 max_connections; highest file peaks: test/accounts.test.ts=6, test/search.test.ts=5, test/tags.test.ts=2',
  );

  const unavailable = createPostgresConnectionSampler(async () => {
    throw new Error('sampling query failed');
  });
  await expect(unavailable.sample()).resolves.toBeUndefined();
});

/** Reylo names an entry by its statement and by its server: the URL's protocol, user, host, port and database. */
function reyloEntryName(statement: string, url: string): string {
  const database = new URL(url);
  const server = createHash('sha256')
    .update(`${database.protocol}//${database.username}@${database.host}${database.pathname}`)
    .digest('hex')
    .slice(0, 16);
  return `${createHash('sha256').update(statement).digest('hex').slice(0, 32)}-${server}.json`;
}

test('a focused check compiles on the host analysis: a statement is analysed once per change even in a new throwaway database, and the diagnostics equal a cold run', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'kernel-check-analysis-'));
  const workspace = join(repository, 'services/kernel');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src/first.sql'), 'select 1;\nselect 11;\n');
  writeFileSync(join(workspace, 'src/second.sql'), 'select 2 error;\n');
  const cacheRoot = join(repository, 'cache');
  let dumps: Record<string, string> = { 'db/schema.sql': 'create table first (id integer);' };
  const check = async (port: number, cache = cacheRoot) => {
    const url = `postgres://rezics:rezics@127.0.0.1:${port}/rezics?sslmode=disable`;
    const prepared = await prepareReyloAnalysisCache(
      { DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: 'fixture-container' },
      {
        repository,
        workspace,
        cacheRoot: cache,
        identity: () => 'fixed-toolchain',
        schemaDumps: () => ({ ...dumps }),
        generate: async (files, configFile, _env, root) => {
          // Reylo's generation reduced to its reuse rule: a statement whose entry exists under this server is kept.
          const queries = join(dirname(configFile), '.reylo', 'queries');
          mkdirSync(queries, { recursive: true });
          const served = JSON.parse(readFileSync(configFile, 'utf8').trim().slice('direct_url: '.length)) as string;
          for (const file of files)
            for (const statement of readFileSync(join(root, file), 'utf8')
              .split(';')
              .map((text) => text.trim())
              .filter(Boolean)) {
              const name = reyloEntryName(statement, served);
              if (!existsSync(join(queries, name))) writeFileSync(join(queries, name), JSON.stringify({ statement }));
            }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    );
    try {
      // The compiler reads the host analysis offline: its project names no database, so every statement is an entry.
      const diagnostics = invokeTypecheck(
        'tsc',
        null,
        prepared.environment,
        prepared.environment.REYLO_CONFIG!,
        (_program, _args, environment) => {
          const config = environment.REYLO_CONFIG!;
          expect(readFileSync(config, 'utf8')).toBe('direct_url: ""\n');
          const queries = join(dirname(config), '.reylo', 'queries');
          return readdirSync(queries)
            .map((name) => (JSON.parse(readFileSync(join(queries, name), 'utf8')) as { statement: string }).statement)
            .filter((statement) => statement.includes('error'))
            .sort();
        },
      );
      return {
        analyzed: prepared.analyzedFiles,
        total: prepared.totalFiles,
        written: prepared.writtenEntries,
        diagnostics,
      };
    } finally {
      prepared.dispose();
    }
  };

  try {
    expect(await check(5432)).toEqual({ analyzed: 2, total: 2, written: 3, diagnostics: ['select 2 error'] });
    expect(await check(5433)).toEqual({ analyzed: 0, total: 2, written: 0, diagnostics: ['select 2 error'] });

    writeFileSync(join(workspace, 'src/first.sql'), 'select 1;\nselect 12;\n');
    // The new database keeps the entry of the unchanged `select 1` and writes only the changed statement.
    expect(await check(5434)).toEqual({ analyzed: 1, total: 2, written: 1, diagnostics: ['select 2 error'] });
    // Publishing replaces the superseded snapshot, so each schema keeps one.
    const snapshots = () =>
      [...new Bun.Glob('reylo-kernel/*/*/snapshots/*').scanSync({ cwd: cacheRoot, onlyFiles: false })].length;
    expect(snapshots()).toBe(1);

    dumps = { 'db/schema.sql': 'create table first (id bigint);' };
    const migrated = await check(5435);
    expect(migrated).toEqual({ analyzed: 2, total: 2, written: 3, diagnostics: ['select 2 error'] });
    expect(snapshots()).toBe(2);
    expect(await check(5436)).toEqual({ analyzed: 0, total: 2, written: 0, diagnostics: ['select 2 error'] });
    expect(await check(5437, join(repository, 'cold-cache'))).toEqual(migrated);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('a failed analysis publishes nothing and reports itself unavailable, so the check keeps its own analysis for the SQL diagnostics', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'kernel-check-analysis-failed-'));
  const workspace = join(repository, 'services/kernel');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src/bad.sql'), 'select missing;\n');
  try {
    const prepared = await prepareReyloAnalysisCache(
      {
        DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable',
        KERNEL_DATABASE_CONTAINER: 'fixture-container',
      },
      {
        repository,
        workspace,
        cacheRoot: join(repository, 'cache'),
        identity: () => 'fixed-toolchain',
        schemaDumps: () => ({ 'db/schema.sql': 'create table first (id integer);' }),
        generate: async () => ({ status: 1, stdout: '', stderr: 'select missing: column does not exist' }),
      },
    );
    expect(prepared.available).toBe(false);
    expect(prepared.environment.REYLO_CONFIG).toBeUndefined();
    expect(existsSync(join(repository, 'cache', 'reylo-kernel'))).toBe(false);
    prepared.dispose();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

const COMBINED_DIAGNOSTICS = [
  "src/owned.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
  'src/owned.sql(12,3): error reylo1: column "missing" does not exist',
  '  Detail: relation items has columns id, name.',
  'src/foreign.sql(4,1): error reylo14: relation "other" does not exist',
  "error TS5083: Cannot read file 'tsconfig.base.json'.",
  '',
].join('\n');

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function checkStageFixture(options: {
  tscStatus: number;
  tscOutput: string;
  lintStatus?: number;
  formatStatus?: number;
}): {
  directory: string;
  programs: { tsc: string; lintProgram: string; formatProgram: string };
  ran: string;
  pass: string;
  fail: string;
  dispose: () => void;
} {
  const temporary = resolve(import.meta.dir, '../.temp');
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(resolve(temporary, 'kernel-check-stages-'));
  const ran = join(directory, 'ran.log');
  const tsc = join(directory, 'tsc');
  const lintProgram = join(directory, 'lint');
  const formatProgram = join(directory, 'format');
  writeExecutable(
    tsc,
    `#!/bin/sh
printf 'tsc\\n' >> "$KERNEL_CHECK_RAN"
cat <<'EOF'
${options.tscOutput}EOF
exit ${options.tscStatus}
`,
  );
  writeExecutable(
    lintProgram,
    `#!/bin/sh
printf 'lint\\n' >> "$KERNEL_CHECK_RAN"
printf 'lint error in src/owned.ts\\n' >&2
exit ${options.lintStatus ?? 1}
`,
  );
  writeExecutable(
    formatProgram,
    `#!/bin/sh
printf 'format\\n' >> "$KERNEL_CHECK_RAN"
printf 'format error in src/owned.ts\\n' >&2
exit ${options.formatStatus ?? 1}
`,
  );
  writeFileSync(
    join(directory, 'pass.test.ts'),
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.KERNEL_CHECK_RAN!, 'pass.test.ts\\n');
import { expect, test } from 'bun:test';
test('passes', () => expect(1).toBe(1));
`,
  );
  writeFileSync(
    join(directory, 'fail.test.ts'),
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.KERNEL_CHECK_RAN!, 'fail.test.ts\\n');
import { expect, test } from 'bun:test';
test('fails', () => expect(1).toBe(2));
`,
  );
  return {
    directory,
    programs: { tsc, lintProgram, formatProgram },
    ran,
    pass: 'pass.test.ts',
    fail: 'fail.test.ts',
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function runSelectedTests(directory: string, files: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  const failed: string[] = [];
  for (const file of files) {
    const result = await captureProcess(process.execPath, ['test', file], env, directory);
    if (result.status !== 0) failed.push(file);
  }
  return failed;
}

function writeModuleTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function extensionPolicyMessage(root: string): string {
  writeModuleTree(root, {
    'db/clean/migrations/20261025000100_clean.sql':
      '-- migrate:up\n-- create extension is for the kernel\nCREATE SCHEMA clean;\n',
    'db/greedy/migrations/20261025000300_search.sql':
      '-- migrate:up\ncreate\n  extension if not exists pg_trgm with schema greedy;\n',
  });
  const failure = moduleExtensionPolicyFailure(root);
  if (!failure) throw new Error('expected a module CREATE EXTENSION product failure');
  return failure;
}

test('one selected check runs every test after owned TS, Reylo, lint, format and module CREATE EXTENSION failures, then fails once with diagnostics and failed files', async () => {
  const fixture = checkStageFixture({ tscStatus: 2, tscOutput: COMBINED_DIAGNOSTICS });
  const phases: string[] = [];
  const env = { ...process.env, KERNEL_CHECK_RAN: fixture.ran };
  writeModuleTree(fixture.directory, {
    'db/clean/migrations/20261025000100_clean.sql':
      '-- migrate:up\n-- create extension is for the kernel\nCREATE SCHEMA clean;\n',
  });
  expect(moduleExtensionPolicyFailure(fixture.directory)).toBeNull();
  const extensionFailure = extensionPolicyMessage(fixture.directory);
  let failure = '';
  try {
    expect(extensionFailure).toContain('db/greedy/migrations/20261025000300_search.sql');
    expect(extensionFailure).not.toContain('db/clean/migrations');
    await runKernelCheckStages({
      plan: {
        files: ['src/owned.ts', 'src/owned.sql', fixture.pass, fixture.fail],
        tests: [fixture.pass, fixture.fail],
      },
      environment: env,
      reyloConfig: '/tmp/reylo.yaml',
      ownedFiles: ['src/owned.ts', 'src/owned.sql', fixture.pass, fixture.fail],
      programs: fixture.programs,
      captureCommand: capture,
      productFailures: [extensionFailure],
      aroundCompiler: async (work) => {
        phases.push('compiler');
        return work();
      },
      afterQuality: async () => {
        phases.push('quality');
      },
      runTests: async (files) => {
        phases.push('tests');
        return runSelectedTests(fixture.directory, files, env);
      },
    });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    const log = existsSync(fixture.ran) ? readFileSync(fixture.ran, 'utf8') : '';
    fixture.dispose();
    expect(log).toContain('tsc');
    expect(log).toContain('lint');
    expect(log).toContain('format');
    expect(log).toContain('pass.test.ts');
    expect(log).toContain('fail.test.ts');
    expect(phases).toEqual(['compiler', 'quality', 'tests']);
    const [actionable, compiler] = failure.split('Compiler output:\n');
    expect(actionable).toContain('error TS2322');
    expect(actionable).toContain('error reylo1');
    expect(actionable).toContain('error TS5083');
    expect(actionable).toContain('Module migrations must not create extensions');
    expect(actionable).toContain('db/greedy/migrations/20261025000300_search.sql');
    expect(actionable).toContain('lint error in src/owned.ts');
    expect(actionable).toContain('format error in src/owned.ts');
    expect(actionable).toContain('Kernel tests failed for 1 file(s):\nfail.test.ts');
    expect(actionable).not.toContain('reylo14');
    expect(compiler).toContain('reylo14');
  }
});

test('selected type-only and test-only failures, foreign Reylo success, full-module diagnostics and infrastructure stop at the failing stage', async () => {
  const typeOnly = checkStageFixture({ tscStatus: 2, tscOutput: COMBINED_DIAGNOSTICS, lintStatus: 0, formatStatus: 0 });
  const testOnly = checkStageFixture({ tscStatus: 0, tscOutput: '', lintStatus: 0, formatStatus: 0 });
  const foreign = checkStageFixture({
    tscStatus: 2,
    tscOutput: 'src/foreign.sql(4,1): error reylo14: relation "other" does not exist\n',
    lintStatus: 0,
    formatStatus: 0,
  });
  const full = checkStageFixture({ tscStatus: 2, tscOutput: COMBINED_DIAGNOSTICS, lintStatus: 0, formatStatus: 0 });
  const crashed = checkStageFixture({
    tscStatus: 2,
    tscOutput: 'fatal: compiler crashed\n',
    lintStatus: 0,
    formatStatus: 0,
  });
  const search = checkStageFixture({ tscStatus: 2, tscOutput: COMBINED_DIAGNOSTICS, lintStatus: 0, formatStatus: 0 });
  try {
    const typeEnv = { ...process.env, KERNEL_CHECK_RAN: typeOnly.ran };
    let typeFailure = '';
    try {
      await runKernelCheckStages({
        plan: { files: ['src/owned.ts', 'src/owned.sql', typeOnly.pass], tests: [typeOnly.pass] },
        environment: typeEnv,
        reyloConfig: '/tmp/reylo.yaml',
        ownedFiles: ['src/owned.ts', 'src/owned.sql', typeOnly.pass],
        programs: typeOnly.programs,
        captureCommand: capture,
        runTests: async (files) => runSelectedTests(typeOnly.directory, files, typeEnv),
      });
    } catch (error) {
      typeFailure = error instanceof Error ? error.message : String(error);
    }
    expect(typeFailure).toContain('error TS2322');
    expect(typeFailure).toContain('Compiler output:');
    expect(typeFailure).not.toContain('Kernel tests failed');
    expect(readFileSync(typeOnly.ran, 'utf8')).toContain('pass.test.ts');

    const testEnv = { ...process.env, KERNEL_CHECK_RAN: testOnly.ran };
    await expect(
      runKernelCheckStages({
        plan: { files: [testOnly.pass, testOnly.fail], tests: [testOnly.pass, testOnly.fail] },
        environment: testEnv,
        reyloConfig: '/tmp/reylo.yaml',
        ownedFiles: [testOnly.pass, testOnly.fail],
        programs: testOnly.programs,
        captureCommand: capture,
        runTests: async (files) => runSelectedTests(testOnly.directory, files, testEnv),
      }),
    ).rejects.toThrow('Kernel tests failed for 1 file(s):\nfail.test.ts');
    expect(readFileSync(testOnly.ran, 'utf8')).toContain('pass.test.ts');
    expect(readFileSync(testOnly.ran, 'utf8')).toContain('fail.test.ts');

    const foreignEnv = { ...process.env, KERNEL_CHECK_RAN: foreign.ran };
    await runKernelCheckStages({
      plan: { files: ['src/owned.ts', foreign.pass], tests: [foreign.pass] },
      environment: foreignEnv,
      reyloConfig: '/tmp/reylo.yaml',
      ownedFiles: ['src/owned.ts', foreign.pass],
      programs: foreign.programs,
      captureCommand: capture,
      runTests: async (files) => runSelectedTests(foreign.directory, files, foreignEnv),
    });
    expect(readFileSync(foreign.ran, 'utf8')).toContain('pass.test.ts');

    const fullEnv = { ...process.env, KERNEL_CHECK_RAN: full.ran };
    await expect(
      runKernelCheckStages({
        plan: { files: null, tests: [full.pass] },
        environment: fullEnv,
        reyloConfig: '/tmp/reylo.yaml',
        ownedFiles: null,
        programs: full.programs,
        captureCommand: capture,
        runTests: async (files) => runSelectedTests(full.directory, files, fullEnv),
      }),
    ).rejects.toThrow(/error reylo14/);
    expect(readFileSync(full.ran, 'utf8')).toContain('pass.test.ts');

    let testsRan = false;
    const crashedExtension = extensionPolicyMessage(crashed.directory);
    await expect(
      runKernelCheckStages({
        plan: { files: ['src/owned.ts'], tests: [crashed.pass] },
        environment: { ...process.env, KERNEL_CHECK_RAN: crashed.ran },
        reyloConfig: '/tmp/reylo.yaml',
        ownedFiles: ['src/owned.ts'],
        programs: crashed.programs,
        captureCommand: capture,
        productFailures: [crashedExtension],
        runTests: async () => {
          testsRan = true;
          return [];
        },
      }),
    ).rejects.toThrow(
      /Module migrations must not create extensions[\s\S]*tsc exited with status 2 without diagnostics/,
    );
    expect(testsRan).toBe(false);
    expect(readFileSync(crashed.ran, 'utf8')).not.toContain('lint');

    testsRan = false;
    await expect(
      runKernelCheckStages({
        plan: { files: ['src/owned.ts', 'src/owned.sql'], tests: [search.pass] },
        environment: { ...process.env, KERNEL_CHECK_RAN: search.ran },
        reyloConfig: '/tmp/reylo.yaml',
        ownedFiles: ['src/owned.ts', 'src/owned.sql'],
        programs: search.programs,
        captureCommand: capture,
        afterQuality: async () => {
          throw new Error('Could not determine the test search port: ');
        },
        runTests: async () => {
          testsRan = true;
          return [];
        },
      }),
    ).rejects.toThrow(/error TS2322[\s\S]*Could not determine the test search port/);
    expect(testsRan).toBe(false);
  } finally {
    typeOnly.dispose();
    testOnly.dispose();
    foreign.dispose();
    full.dispose();
    crashed.dispose();
    search.dispose();
  }
});
