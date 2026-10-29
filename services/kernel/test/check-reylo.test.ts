import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { fileEnvironment, invokeTypecheck, writeReyloProject } from '../scripts/check.ts';

const KERNEL_ROOT = resolve(import.meta.dir, '..');

test("the compiler and each test file's processes use the check's explicit analysis project", () => {
  const temporaryRoot = resolve(KERNEL_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'check-reylo-fixture-'));
  try {
    const url = 'postgres://rezics:rezics@127.0.0.1:5432/rezics?sslmode=disable';
    const analysisUrl = 'postgres://rezics:rezics@127.0.0.1:5432/kernel_analysis?sslmode=disable';
    const reyloConfig = writeReyloProject(directory, analysisUrl);
    // A stale value from the caller's shell must not decide where a file's processes analyse.
    const base = { PATH: '/usr/bin', DATABASE_URL: url, REYLO_CONFIG: '/elsewhere/.reylo.yaml' };
    const compilerInvocations: Array<{ program: string; args: string[]; environment: NodeJS.ProcessEnv }> = [];
    const recordCompilerInvocation = (program: string, args: string[], environment: NodeJS.ProcessEnv): void => {
      compilerInvocations.push({ program, args, environment });
    };
    invokeTypecheck('/kernel/node_modules/.bin/tsc', null, base, reyloConfig, recordCompilerInvocation);
    invokeTypecheck('/kernel/node_modules/.bin/tsc', ['test/a.test.ts'], base, reyloConfig, recordCompilerInvocation);
    const first = fileEnvironment(base, {
      url,
      database: 'kernel_test_1',
      searchUrl: 'http://127.0.0.1:9200',
      reyloConfig,
    });
    const second = fileEnvironment(base, {
      url,
      database: 'kernel_test_2',
      searchUrl: 'http://127.0.0.1:9200',
      reyloConfig,
    });

    expect(first.DATABASE_URL).toContain('/kernel_test_1?');
    expect(second.DATABASE_URL).toContain('/kernel_test_2?');
    expect(first.DATABASE_URL).not.toBe(second.DATABASE_URL);
    expect(first.REYLO_CONFIG).toBe(reyloConfig);
    expect(second.REYLO_CONFIG).toBe(reyloConfig);
    expect(compilerInvocations.map(({ args }) => args)).toEqual([
      ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
      ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json', '--pretty', 'false'],
    ]);
    expect(compilerInvocations.map(({ environment }) => environment.REYLO_CONFIG)).toEqual([reyloConfig, reyloConfig]);
    expect(compilerInvocations.map(({ environment }) => environment.DATABASE_URL)).toEqual([url, url]);
    expect(compilerInvocations.map(({ program }) => program)).toEqual([
      '/kernel/node_modules/.bin/tsc',
      '/kernel/node_modules/.bin/tsc',
    ]);

    expect(basename(reyloConfig)).toBe('.reylo.yaml');
    expect(dirname(reyloConfig).startsWith(`${temporaryRoot}/`)).toBe(true);
    const project = readFileSync(reyloConfig, 'utf8');
    expect(project).toContain(JSON.stringify(analysisUrl));
    for (const own of [url, first.DATABASE_URL!, second.DATABASE_URL!]) expect(project).not.toContain(own);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native Reylo analysis stays warm without losing diagnostics or runtime results', async () => {
  const inheritedConfig = process.env.REYLO_CONFIG;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!inheritedConfig || !runtimeUrl) throw new Error('Run through the kernel check with explicit database projects');
  const projectLine = readFileSync(inheritedConfig, 'utf8').match(/^direct_url:\s*(.+)$/m)?.[1];
  if (!projectLine) throw new Error(`Reylo analysis project has no direct_url: ${inheritedConfig}`);
  const analysisUrl = JSON.parse(projectLine) as string;
  expect(new URL(analysisUrl).pathname).toBe('/kernel_analysis');
  expect(new URL(runtimeUrl).pathname).not.toBe(new URL(analysisUrl).pathname);

  const temporaryRoot = resolve(KERNEL_ROOT, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(resolve(temporaryRoot, 'check-reylo-native-'));
  const config = writeReyloProject(directory, analysisUrl);
  const queryPath = resolve(directory, 'query.sql');
  const compilerPath = resolve(KERNEL_ROOT, '../../node_modules/.bin/tsc');
  const pool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
  try {
    writeFileSync(
      resolve(directory, 'tsconfig.json'),
      JSON.stringify({
        extends: resolve(KERNEL_ROOT, 'tsconfig.json'),
        compilerOptions: { noEmit: true },
        include: ['consumer.ts'],
      }),
    );
    writeFileSync(resolve(directory, 'consumer.ts'), "import query from './query.sql';\nexport default query;\n");

    const compile = () =>
      invokeTypecheck(
        compilerPath,
        ['consumer.ts'],
        { ...process.env, REYLO_CONFIG: '/inherited/stale/.reylo.yaml' },
        config,
        (program, args, environment) => {
          const result = spawnSync(program, args, {
            cwd: directory,
            encoding: 'utf8',
            env: environment,
            timeout: 90_000,
          });
          return {
            status: result.status,
            output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}`,
          };
        },
      );
    const entryCount = () => {
      const cache = resolve(dirname(config), '.reylo/queries');
      return existsSync(cache) ? readdirSync(cache).filter((file) => file.endsWith('.json')).length : 0;
    };

    writeFileSync(queryPath, 'SELECT 7::int AS answer;\n');
    const cold = compile();
    expect(cold.status, cold.output).toBe(0);
    const coldEntries = entryCount();
    expect(coldEntries).toBeGreaterThan(0);

    const { default: query } = (await import(pathToFileURL(resolve(directory, 'consumer.ts')).href)) as {
      default: { run: (client: pg.Pool, parameters: Record<string, never>) => Promise<unknown> };
    };
    expect(await query.run(pool, {})).toEqual({ answer: 7 });

    const warm = compile();
    expect(warm.status, warm.output).toBe(0);
    expect(entryCount()).toBe(coldEntries);
    expect(await query.run(pool, {})).toEqual({ answer: 7 });

    writeFileSync(queryPath, 'SELECT missing_native_reylo_column;\n');
    const invalidCold = compile();
    expect(invalidCold.status).not.toBe(0);
    expect(invalidCold.output).toContain('missing_native_reylo_column');
    const invalidWarm = compile();
    expect(invalidWarm.status).not.toBe(0);
    expect(invalidWarm.output).toBe(invalidCold.output);

    writeFileSync(queryPath, 'SELECT changed_native_reylo_column;\n');
    const changedInvalidWarm = compile();
    expect(changedInvalidWarm.status).not.toBe(0);
    expect(changedInvalidWarm.output).toContain('changed_native_reylo_column');
  } finally {
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
  }
}, 300_000);
