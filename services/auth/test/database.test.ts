import { expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RUN_TIMEOUT, migrate, POSTGRES_IMAGE, run, schemaDump, ownDatabase } from '../scripts/database.ts';

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const timeout = 60_000;

test('run keeps its 120-second default and reports ETIMEDOUT for a child exceeding a per-call timeout', () => {
  expect(DEFAULT_RUN_TIMEOUT).toBe(120_000);
  expect(run(process.execPath, ['--eval', 'console.log("completed")'])).toBe('completed');
  let failure: unknown;
  try {
    run(process.execPath, ['--eval', 'setTimeout(() => {}, 10_000)'], process.env, { timeout: 50 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toHaveProperty('code', 'ETIMEDOUT');
});

function traceDocker(action: (commands: () => string[][], temporary: string) => void): void {
  const docker = Bun.which('docker');
  if (!docker) throw new Error('Docker is required for the database regression');
  const root = resolve(directory, '../../.temp');
  mkdirSync(root, { recursive: true });
  const temporary = mkdtempSync(join(root, 'auth-database-'));
  const log = join(temporary, 'docker.jsonl');
  const wrapper = join(temporary, 'docker');
  writeFileSync(log, '');
  writeFileSync(
    wrapper,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(docker)}, args, { stdio: 'inherit', timeout: ${timeout} });
if (result.error) throw result.error;
if (args.includes('pg_dump') && process.env.AUTH_DUMP_TRACE_STOP === '1' && result.status === 0) {
  console.error('Stopped after real check dump');
  process.exit(79);
}
process.exit(result.status ?? 1);
`,
  );
  chmodSync(wrapper, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${temporary}:${path}`;
  try {
    action(
      () =>
        readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string[]),
      temporary,
    );
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    rmSync(temporary, { recursive: true, force: true });
  }
}

test(
  'Auth check runs pg_dump in its existing PostgreSQL container and cleans up on failure',
  () => {
    traceDocker((commands) => {
      // Stop after the real dump so this child check cannot recursively run this test suite.
      const result = Bun.spawnSync([process.execPath, 'scripts/check.ts'], {
        cwd: directory,
        // The check must run here, where docker is traced, and without queueing for a local slot.
        env: { ...process.env, AUTH_DUMP_TRACE_STOP: '1', REZICS_STACK_LEASE: 'off' },
        timeout: 30_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain('Stopped after real check dump');
      const deadline = Date.now() + 20_000;
      let calls = commands();
      const container = calls.find((args) => args[0] === 'port')?.[1];
      if (!container) throw new Error('Check did not create a PostgreSQL fixture');
      while (Date.now() < deadline && calls.at(-1)?.[0] !== 'rm') {
        Bun.sleepSync(50);
        calls = commands();
      }
      const dumps = calls.filter((args) => args.includes('pg_dump'));
      expect(dumps.map((args) => args.slice(0, 3))).toEqual([['exec', container, 'pg_dump']]);
      expect(calls.filter((args) => args[0] === 'run')).toHaveLength(1);
      expect(calls.at(-1)).toEqual(['rm', '-f', '-v', container]);
    });
  },
  timeout,
);

test(
  'check-time dumps execute pg_dump in their own server fixture and preserve exact schema bytes',
  () => {
    traceDocker((commands) => {
      const database = ownDatabase();
      try {
        migrate(database.url);
        const start = commands().length;
        const dump = schemaDump(database.url, database);
        expect(dump).toBe(readFileSync(resolve(directory, 'db/schema.sql'), 'utf8'));
        expect(schemaDump(database.url, database)).toBe(dump);
        const dumps = commands().slice(start);
        expect(dumps.map((args) => args[0])).toEqual(['exec', 'exec']);
        const local = new URL(database.url);
        local.port = '5432';
        expect(dumps).toEqual(
          Array.from({ length: 2 }, () => [
            'exec',
            database.container,
            'pg_dump',
            '--schema-only',
            '--no-owner',
            '--no-privileges',
            '--exclude-schema=auth_dbos',
            local.href,
          ]),
        );
      } finally {
        database.close();
      }
    });
  },
  timeout,
);

test(
  'fixture contexts cannot dump another database or change its lifecycle',
  () => {
    traceDocker((commands) => {
      const first = ownDatabase();
      try {
        const second = ownDatabase();
        try {
          run('docker', [
            'exec',
            second.container,
            'psql',
            '-U',
            'rezics',
            '-d',
            'rezics_auth_test',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            'CREATE TABLE fixture_marker (id integer PRIMARY KEY)',
          ]);
          const start = commands().length;
          expect(() => schemaDump(second.url, first)).toThrow(/fixture/i);
          expect(() => schemaDump(first.url, second)).toThrow(/fixture/i);
          expect(commands().slice(start)).toEqual([]);
          expect(schemaDump(first.url, first)).toBe(readFileSync(resolve(directory, 'db/schema.sql'), 'utf8'));
          expect(schemaDump(second.url, second)).toContain('CREATE TABLE public.fixture_marker');
          first.close();
          first.close();
          const removalDeadline = Date.now() + 20_000;
          while (
            Date.now() < removalDeadline &&
            !commands().some((args) => args[0] === 'rm' && args[2] === first.container)
          )
            Bun.sleepSync(50);
          const afterClose = commands().length;
          expect(schemaDump(second.url, second)).toContain('CREATE TABLE public.fixture_marker');
          expect(
            commands()
              .slice(afterClose)
              .map((args) => args.slice(0, 2)),
          ).toEqual([['exec', second.container]]);
        } finally {
          second.close();
        }
      } finally {
        first.close();
      }
    });
  },
  timeout,
);

test(
  'the dump CLI uses the pinned standalone image for an explicit URL without fixture context',
  () => {
    traceDocker((commands, temporary) => {
      const database = ownDatabase();
      try {
        mkdirSync(join(temporary, 'scripts'));
        mkdirSync(join(temporary, 'db'));
        copyFileSync(resolve(directory, 'scripts/database.ts'), join(temporary, 'scripts/database.ts'));
        const start = commands().length;
        const result = Bun.spawnSync([process.execPath, join(temporary, 'scripts/database.ts'), 'dump'], {
          env: {
            ...process.env,
            AUTH_DATABASE_URL: database.url,
            AUTH_DATABASE_CONTAINER: 'must-not-be-inferred',
            KERNEL_DATABASE_CONTAINER: 'must-not-be-inferred',
          },
          timeout,
        });
        expect(result.stderr.toString()).toBe('');
        expect(result.exitCode).toBe(0);
        expect(readFileSync(join(temporary, 'db/schema.sql'), 'utf8')).toBe(
          readFileSync(resolve(directory, 'db/schema.sql'), 'utf8'),
        );
        expect(commands().slice(start)).toEqual([
          [
            'run',
            '--rm',
            '--network',
            'host',
            POSTGRES_IMAGE,
            'pg_dump',
            '--schema-only',
            '--no-owner',
            '--no-privileges',
            '--exclude-schema=auth_dbos',
            database.url,
          ],
        ]);
      } finally {
        database.close();
      }
    });
  },
  timeout,
);
