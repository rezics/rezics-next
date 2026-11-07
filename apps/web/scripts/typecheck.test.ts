import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareReyloAnalysisCache } from '../../../services/kernel/scripts/reylo-cache.ts';
import { compileWebPrograms, compileWebProgramsWithSqlAnalysis, WEB_COMPILER_PROGRAMS } from './typecheck.ts';

test('official typecheck and the check gate share both Web compiler programs', () => {
  expect(WEB_COMPILER_PROGRAMS).toEqual([
    ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
    ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.scripts.json'],
  ]);
  expect(readFileSync(join(import.meta.dir, 'check.ts'), 'utf8')).toContain('compileWebPrograms');
  expect(readFileSync(join(import.meta.dir, 'check.ts'), 'utf8')).not.toContain(
    "['check', '--no-script', '-p', 'tsconfig.json']",
  );
});

test('the scripts program still runs after a red web program', async () => {
  const ran: string[] = [];
  expect(
    await compileWebPrograms(async (args) => {
      ran.push(args.at(-1)!);
      return args.at(-1) === 'tsconfig.json' ? 2 : 0;
    }),
  ).toBe(2);
  expect(ran).toEqual(['tsconfig.json', 'tsconfig.scripts.json']);
});

test('Web caches SQL types per schema and times both compiler programs', async () => {
  const fixture = mkdtempSync(join(resolve(import.meta.dir, '../../..'), '.temp/web-typecheck-cache-'));
  const workspace = join(fixture, 'services/kernel');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src/example.sql'), 'select 1;\n');
  let schema = 'create table example (id integer);';
  const generated: number[] = [];
  const output: string[] = [];
  let compilerView = '';
  const env = { DATABASE_URL: 'postgres://rezics:rezics@127.0.0.1:5432/rezics', KERNEL_DATABASE_CONTAINER: 'fixture' };
  const dependencies = {
    prepareSqlAnalysis: (source: NodeJS.ProcessEnv) =>
      prepareReyloAnalysisCache(source, {
        repository: fixture,
        workspace,
        cacheRoot: join(fixture, 'cache'),
        identity: () => 'web-toolchain',
        schemaDumps: () => ({ 'db/schema.sql': schema }),
        generate: async (files: readonly string[], config: string) => {
          generated.push(files.length);
          const queries = join(dirname(config), '.reylo/queries');
          mkdirSync(queries, { recursive: true });
          writeFileSync(join(queries, 'example.json'), '{"sql":"select 1"}\n');
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
    write: (chunk: string) => output.push(chunk),
    run: async (args: readonly string[], compilerEnv: NodeJS.ProcessEnv) => {
      const config = compilerEnv.REYLO_CONFIG!;
      if (args.at(-1) === 'tsconfig.json') compilerView = config;
      else expect(config).toBe(compilerView);
      expect(compilerEnv.DATABASE_URL).toBeUndefined();
      expect(readFileSync(config, 'utf8')).toContain('direct_url: ""');
      expect(readFileSync(join(dirname(config), '.reylo/queries/example.json'), 'utf8')).toContain('select 1');
      return args.at(-1) === 'tsconfig.json' ? 2 : 0;
    },
  };

  try {
    expect(await compileWebProgramsWithSqlAnalysis(env, dependencies)).toBe(2);
    expect(await compileWebProgramsWithSqlAnalysis(env, dependencies)).toBe(2);
    expect(generated).toEqual([1]);
    schema = 'create table example (id bigint);';
    expect(await compileWebProgramsWithSqlAnalysis(env, dependencies)).toBe(2);
    expect(generated).toEqual([1, 1]);
    const timings = output
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('Web typecheck phase '));
    for (const phase of ['SQL type analysis', 'tsconfig.json', 'tsconfig.scripts.json']) {
      const lines = timings.filter((line) => line.includes(`phase ${phase} finished`));
      expect(lines).toHaveLength(3);
      for (const line of lines) expect(line).toMatch(/finished \d+\.\d{2}s\.$/);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

const appRoot = join(import.meta.dir, '..');

test('Web owns the Reylo mapper and imports the shared analysis utility, not Kernel typecheck', () => {
  const tsconfig = JSON.parse(readFileSync(join(appRoot, 'tsconfig.json'), 'utf8')) as {
    contentMappers: Array<{ package: string; extensions: string[] }>;
  };
  expect(tsconfig.contentMappers).toEqual([{ package: 'reylo', extensions: ['.sql'] }]);
  const scripts = JSON.parse(readFileSync(join(appRoot, 'tsconfig.scripts.json'), 'utf8')) as {
    exclude: string[];
    compilerOptions: { types: string[] };
  };
  expect(scripts.exclude).toEqual([]);
  expect(scripts.compilerOptions.types).toEqual(['bun']);
  const manifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  expect(manifest.dependencies?.reylo).toBeUndefined();
  expect(manifest.devDependencies?.reylo).toBe('0.7.0');
  const source = readFileSync(join(import.meta.dir, 'typecheck.ts'), 'utf8');
  expect(source).toContain('services/kernel/scripts/reylo-cache.ts');
  expect(source).not.toContain('services/kernel/scripts/typecheck.ts');
  expect(source).not.toContain('services/kernel/node_modules/reylo');
});

test('the ratings walk imports rating IDs without Worker session modules', () => {
  const source = readFileSync(join(import.meta.dir, 'seeded-content-ratings-reviews-walk.ts'), 'utf8');
  expect(source).not.toContain('features/pages/subject-ratings.ts');
  expect(source).toContain('subject-ratings-ids');
});

test('the owning compiler includes executable scripts without Worker ambient types', () => {
  const cwd = resolve(import.meta.dir, '..');
  const result = Bun.spawnSync(
    [resolve(cwd, '../../node_modules/.bin/tsc'), '--showConfig', '-p', 'tsconfig.scripts.json'],
    { cwd },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const config = JSON.parse(result.stdout.toString()) as {
    files: string[];
    compilerOptions: { types: string[] };
  };
  for (const file of ['check', 'record', 'seeded-content-ratings-reviews-walk', 'seeded-question-management-walk'])
    expect(config.files).toContain(`./scripts/${file}.ts`);
  expect(config.compilerOptions.types).toEqual(['bun']);
});
