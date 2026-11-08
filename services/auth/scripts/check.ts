import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { capture, runLaneSuite } from '../../../scripts/test-lanes.ts';
import { betterAuthSchemaOptions } from '../src/better-auth.ts';
import {
  databaseCheck,
  KERNEL_TEMPLATE_DATABASE,
  migrate,
  migrateKernelTemplate,
  ownDatabase,
  run,
  schemaDump,
  TEMPLATE_DATABASE,
  withCompilerSchema,
} from './database.ts';

type CheckPlan = { files: string[] | null; tests: string[]; testArguments?: string[] };

const bunFlagsWithValue = new Set([
  '--timeout',
  '--preload',
  '--rerun-each',
  '--retry',
  '--coverage-reporter',
  '--coverage-dir',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--changed',
  '--seed',
  '--shard',
  '--timings',
  '--parallel-delay',
  '--parallel',
  '-t',
]);

function checkArguments(args: readonly string[]): { paths: string[]; testArguments: string[] } {
  const paths: string[] = [];
  const testArguments: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') {
      testArguments.push(argument, ...args.slice(index + 1));
      break;
    }
    if (argument.startsWith('-')) {
      testArguments.push(argument);
      if (bunFlagsWithValue.has(argument) && index + 1 < args.length) testArguments.push(args[++index]!);
      continue;
    }
    paths.push(argument);
  }
  return { paths, testArguments };
}

function moduleTests(moduleDirectory: string): string[] {
  return Array.from(new Bun.Glob('test/**/*.test.ts').scanSync({ cwd: moduleDirectory })).sort();
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function checkPlan(args: string[], moduleDirectory: string, options: { testsOnly?: boolean } = {}): CheckPlan {
  const root = resolve(moduleDirectory);
  const allTests = moduleTests(root);
  if (args.length === 0) {
    if (options.testsOnly) throw new Error('Auth tests-only mode requires explicit test files');
    return { files: null, tests: allTests };
  }
  const { paths: selections, testArguments } = checkArguments(args);
  if (!selections.length) {
    if (options.testsOnly) throw new Error('Auth tests-only mode requires explicit test files');
    return { files: null, tests: allTests, ...(testArguments.length ? { testArguments } : {}) };
  }

  let rootRealPath: string | null;
  try {
    rootRealPath = realpathSync(root);
  } catch {
    rootRealPath = null;
  }
  const files = new Set<string>();
  for (const argument of selections) {
    const normalized = resolve(root, argument.startsWith('./') ? argument.slice(2) : argument);
    if (!rootRealPath || !pathIsWithin(root, normalized)) {
      throw new Error(`Check path must name an existing file inside ${moduleDirectory}: ${argument}`);
    }

    try {
      if (!statSync(normalized).isFile() || !pathIsWithin(rootRealPath, realpathSync(normalized))) {
        throw new Error();
      }
    } catch {
      throw new Error(`Check path must name an existing file inside ${moduleDirectory}: ${argument}`);
    }

    files.add(relative(root, normalized).split(sep).join('/'));
  }

  const sortedFiles = Array.from(files).sort();
  const testFiles = new Set(allTests);
  const plan = {
    files: sortedFiles,
    tests: sortedFiles.filter((file) => testFiles.has(file)),
    ...(testArguments.length ? { testArguments } : {}),
  };
  if (options.testsOnly && (plan.tests.length === 0 || plan.tests.length !== plan.files.length))
    throw new Error('Auth tests-only mode requires explicit test files');
  return plan;
}

if (import.meta.main) {
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const originalArgs = process.argv.slice(2);
  const testsOnly = originalArgs[0] === '--tests-only';
  const args = testsOnly ? originalArgs.slice(1) : originalArgs;
  // A bad path is reported here, before any stack is started or a host is asked.
  const plan = checkPlan(args, directory, { testsOnly });
  process.exitCode = await databaseCheck(['bun', 'scripts/check.ts', ...originalArgs], async () => {
    const database = ownDatabase();
    try {
      migrate(database.url);
      if (schemaDump(database.url, database) !== (await Bun.file('db/schema.sql').text())) {
        throw new Error('Auth schema dump differs; run db dump against a freshly migrated separate database');
      }
      const pool = new Pool({ connectionString: database.url });
      try {
        const plan = await getMigrations(
          betterAuthSchemaOptions(pool, 'https://auth.invalid', 'schema-verification-only-secret-32-bytes'),
        );
        if (
          plan.toBeCreated.length ||
          plan.toBeAdded.length ||
          plan.toBeAddedIndexes.length ||
          plan.unsafeChanges.length ||
          plan.schemaProblems.length
        ) {
          throw new Error('Committed schema differs from the installed Better Auth schema');
        }
      } finally {
        await pool.end();
      }
      const env = { ...process.env, AUTH_TEST_DATABASE_URL: database.url };
      if (!testsOnly) {
        await withCompilerSchema(database, async (compilerUrl) => {
          run(
            resolve('../../node_modules/.bin/tsc'),
            ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
            { ...env, DATABASE_URL: compilerUrl },
            { timeout: 600_000 },
          );
        });
        run(process.execPath, ['lint', '--no-script', '--config', '../../.oxlintrc.json', ...(plan.files ?? ['.'])], env);
        run(resolve('../../node_modules/.bin/oxfmt'), ['--check', ...(plan.files ?? ['.'])], env);
      }
      if (plan.tests.length > 0) {
        const psql = async (sql: string): Promise<void> => {
          const result = await capture(
            'docker',
            ['exec', database.container, 'psql', '-U', 'rezics', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql],
            process.env,
            directory,
          );
          if (result.status !== 0) throw new Error(`psql -c ${sql} failed:\n${result.output}`);
        };
        // The template is migrated and dump-checked and never used by a test; each file runs on its own copy.
        // Native fixtures copy this kernel template; migrating it here replaces one replay per fixture.
        migrateKernelTemplate(database.url);
        const { failed } = await runLaneSuite({
          service: 'auth',
          directory,
          files: plan.tests,
          ...(plan.testArguments ? { testArguments: plan.testArguments } : {}),
          partial: plan.files !== null,
          createDatabase: (name) => psql(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DATABASE}`),
          dropDatabase: (name) => psql(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
          environment: (name) => {
            const url = database.url.replace(`/${TEMPLATE_DATABASE}?`, `/${name}?`);
            return {
              ...env,
              AUTH_CHECK_CONTAINER: database.container,
              AUTH_CHECK_LANE_OWNER: String(process.pid),
              AUTH_CHECK_KERNEL_TEMPLATE: KERNEL_TEMPLATE_DATABASE,
              DATABASE_URL: url,
              AUTH_TEST_DATABASE_URL: url,
            };
          },
        });
        if (failed.length) throw new Error(`Auth tests failed for ${failed.length} file(s):\n${failed.join('\n')}`);
      }
    } finally {
      database.close();
    }
    return 0;
  });
}
