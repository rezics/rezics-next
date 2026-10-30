import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runKernelTypecheck } from '../services/kernel/scripts/typecheck.ts';
import { runAuthTypecheck } from '../services/auth/scripts/typecheck.ts';

const repository = resolve(import.meta.dir, '..');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rezics-typecheck-placement-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('without DATABASE_URL, a reachable check host receives the typecheck and returns its status', async () => {
  let invocation: { label: string; command: string[] } | undefined;
  let localDatabaseStarted = false;
  const status = await runKernelTypecheck(
    { PATH: process.env.PATH },
    {
      place: async (run) => {
        invocation = { label: run.label, command: run.command };
        return 23;
      },
      withThrowawayDatabase: async () => {
        localDatabaseStarted = true;
        throw new Error('should not start locally');
      },
    },
  );

  expect(invocation).toEqual({ label: 'kernel typecheck', command: ['bun', 'scripts/typecheck.ts'] });
  expect(status).toBe(23);
  expect(localDatabaseStarted).toBe(false);
});

test('without DATABASE_URL and no answering host, typecheck and construct share the local throwaway database', async () => {
  let receivedUrl: string | undefined;
  const status = await runKernelTypecheck(
    {},
    {
      place: async () => null,
      withThrowawayDatabase: async (work) => work({ DATABASE_URL: 'postgres://throwaway.test/db' }),
      typecheck: async (_env) => {
        receivedUrl = _env.DATABASE_URL;
        return 0;
      },
    },
  );

  expect(status).toBe(0);
  expect(receivedUrl).toBe('postgres://throwaway.test/db');
});

test('with DATABASE_URL, the command stays here and starts no throwaway database', async () => {
  let placed = false;
  let databaseStarted = false;
  let receivedUrl: string | undefined;
  const status = await runKernelTypecheck(
    { DATABASE_URL: 'postgres://developer.test/db' },
    {
      place: async () => {
        placed = true;
        return 0;
      },
      withThrowawayDatabase: async () => {
        databaseStarted = true;
        return 0;
      },
      typecheck: async (env) => {
        receivedUrl = env.DATABASE_URL;
        return 0;
      },
    },
  );

  expect(status).toBe(0);
  expect(placed).toBe(false);
  expect(databaseStarted).toBe(false);
  expect(receivedUrl).toBe('postgres://developer.test/db');
});

test('a tsc failure returns its status and diagnostics without running construct', () => {
  const directory = temporaryDirectory();
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const tsc = join(bin, 'tsc');
  writeFileSync(
    tsc,
    '#!/bin/sh\nprintf "%s\\n" "src/example.ts(2,3): error TS2322: diagnostic stays exact" >&2\nexit 23\n',
  );
  chmodSync(tsc, 0o755);
  const bun = join(bin, 'bun');
  writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(directory, 'bun.log'))}\nexit 19\n`);
  chmodSync(bun, 0o755);
  const result = spawnSync(process.execPath, [join(repository, 'services/kernel/scripts/typecheck.ts')], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://existing.test/db', PATH: `${bin}:${process.env.PATH}` },
    timeout: 60_000,
  });

  expect(result.status).toBe(23);
  expect(result.stderr).toBe('src/example.ts(2,3): error TS2322: diagnostic stays exact\n');
  expect(existsSync(join(directory, 'bun.log'))).toBe(false);
});

test('construct failure is returned after a successful tsc', () => {
  const directory = temporaryDirectory();
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const tsc = join(bin, 'tsc');
  writeFileSync(tsc, '#!/bin/sh\nexit 0\n');
  chmodSync(tsc, 0o755);
  const bun = join(bin, 'bun');
  writeFileSync(bun, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(join(directory, 'bun.log'))}\nexit 19\n`);
  chmodSync(bun, 0o755);
  const result = spawnSync(process.execPath, [join(repository, 'services/kernel/scripts/typecheck.ts')], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://existing.test/db', PATH: `${bin}:${process.env.PATH}` },
    timeout: 60_000,
  });

  expect(result.status).toBe(19);
  expect(readFileSync(join(directory, 'bun.log'), 'utf8')).toBe('run construct\n');
});

test('without DATABASE_URL, auth uses kernel placement and the host owns its migrated Auth database', async () => {
  const events: string[] = [];
  const env = { PATH: process.env.PATH };
  const status = await runAuthTypecheck(env, {
    place: async (run, receivedEnv) => {
      expect(run).toEqual({
        label: 'auth typecheck',
        root: repository,
        cwd: join(repository, 'services/auth'),
        command: ['bun', 'scripts/typecheck.ts'],
      });
      expect(receivedEnv).toBe(env);
      return runAuthTypecheck(env, {
        place: async () => null, // The shared helper recognizes the host's run directory.
        prepareCompilerDatabase: async () => {
          events.push('host database');
          return {
            url: 'postgres://host.test/auth',
            remove: () => {
              events.push('close');
            },
          };
        },
        typecheck: async (databaseEnv) => {
          expect(databaseEnv.DATABASE_URL).toBe('postgres://host.test/auth');
          events.push('host tsc');
          return 23;
        },
      });
    },
    prepareCompilerDatabase: async () => {
      throw new Error('must not start a database on the worker');
    },
  });

  expect(status).toBe(23);
  expect(events).toEqual(['host database', 'host tsc', 'close']);
});

test('without DATABASE_URL and no answering host, auth uses and closes its local throwaway database', async () => {
  const events: string[] = [];
  const status = await runAuthTypecheck(
    { PATH: process.env.PATH },
    {
      place: async () => null,
      prepareCompilerDatabase: async () => {
        events.push('database');
        return {
          url: 'postgres://local.test/auth',
          remove: () => {
            events.push('close');
          },
        };
      },
      typecheck: async (env) => {
        expect(env.DATABASE_URL).toBe('postgres://local.test/auth');
        expect(env.PATH).toBe(process.env.PATH);
        events.push('tsc');
        return 0;
      },
    },
  );

  expect(status).toBe(0);
  expect(events).toEqual(['database', 'tsc', 'close']);
});

test('with DATABASE_URL, auth runs here against that database without placement or provisioning', async () => {
  const env = { DATABASE_URL: 'postgres://developer.test/auth' };
  const status = await runAuthTypecheck(env, {
    place: async () => {
      throw new Error('must not place an existing database remotely');
    },
    prepareCompilerDatabase: async () => {
      throw new Error('must not start a database');
    },
    typecheck: async (receivedEnv) => {
      expect(receivedEnv).toBe(env);
      return 0;
    },
  });

  expect(status).toBe(0);
});

test('auth preserves tsc failure status and diagnostic lines with an existing, local or host database', () => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/auth-typecheck-'));
  temporaryDirectories.push(directory);
  const tsc = join(directory, 'tsc');
  const diagnostic = 'src/example.ts(2,3): error TS2322: diagnostic stays exact\n';
  writeFileSync(
    tsc,
    `#!/bin/sh\nprintf '%s\\n' '${diagnostic.trimEnd()}'\nprintf '%s\\n' 'compiler stderr' >&2\nexit 23\n`,
  );
  chmodSync(tsc, 0o755);
  const fixture = join(directory, 'run.ts');
  writeFileSync(
    fixture,
    `import { runAuthTypecheck } from ${JSON.stringify(join(repository, 'services/auth/scripts/typecheck.ts'))};
const prepareCompilerDatabase = async () => ({ url: 'postgres://fixture.test/auth', remove() {} });
process.exitCode = await runAuthTypecheck(process.env, {
  prepareCompilerDatabase,
  place: async (_run, env) => process.argv[2] === 'host'
    ? runAuthTypecheck(env, { prepareCompilerDatabase, place: async () => null })
    : null,
});
`,
  );
  for (const placement of ['existing', 'local', 'host']) {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    if (placement === 'existing') env.DATABASE_URL = 'postgres://existing.test/auth';
    const result = spawnSync(
      process.execPath,
      placement === 'existing' ? [join(repository, 'services/auth/scripts/typecheck.ts')] : [fixture, placement],
      { cwd: repository, encoding: 'utf8', env, timeout: 60_000 },
    );

    expect(result.status).toBe(23);
    expect(result.stdout).toBe(diagnostic);
    expect(result.stderr).toBe('compiler stderr\n');
  }
});

test('a successful auth typecheck on a check host never starts another compiler locally', async () => {
  const status = await runAuthTypecheck(
    {},
    {
      place: async () => 0,
      prepareCompilerDatabase: async () => {
        throw new Error('must not start a database after remote success');
      },
      typecheck: async () => {
        throw new Error('must not run tsc locally after remote success');
      },
    },
  );

  expect(status).toBe(0);
});

test('auth removes its compiler database when starting tsc fails', async () => {
  const events: string[] = [];
  const failure = new Error('tsc executable unavailable');
  const result = runAuthTypecheck(
    {},
    {
      place: async () => null,
      prepareCompilerDatabase: async () => ({
        url: 'postgres://throwaway.test/auth',
        remove: async () => {
          events.push('removed');
        },
      }),
      typecheck: async () => {
        events.push('tsc');
        throw failure;
      },
    },
  );

  await expect(result).rejects.toBe(failure);
  expect(events).toEqual(['tsc', 'removed']);
});

test('A compiler database remains reachable from the actual selected typecheck process until the compiler and kernel construct finish', () => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/compiler-consumers-'));
  temporaryDirectories.push(directory);
  const alive = join(directory, 'database-alive');
  const record = join(directory, 'consumers');
  const consumer = join(directory, 'consumer.ts');
  writeFileSync(
    consumer,
    `
import { appendFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(existsSync(${JSON.stringify(alive)}), true);
assert.equal(process.env.DATABASE_URL, 'postgres://rezics:rezics@127.0.0.1:34646/rezics?sslmode=disable');
await Bun.sleep(20);
assert.equal(existsSync(${JSON.stringify(alive)}), true);
appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`,
  );
  for (const executable of ['tsc', 'bun']) {
    const path = join(directory, executable);
    writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${consumer}' "$@"\n`);
    chmodSync(path, 0o755);
  }
  const fixture = join(directory, 'run.ts');
  writeFileSync(
    fixture,
    `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
const inherited = { url: process.env.DATABASE_URL, container: process.env.KERNEL_DATABASE_CONTAINER };
const starts = [];
mock.module(${JSON.stringify(join(repository, 'services/kernel/scripts/database.ts'))}, () => ({
  POSTGRES_IMAGE: 'postgres:fixture',
  migrate(url) { assert.equal(existsSync(${JSON.stringify(alive)}), true); },
  schemaDumps() { throw new Error('unexpected schema dump'); },
  validateMigrationVersions() {},
}));
mock.module(${JSON.stringify(join(repository, 'services/kernel/scripts/check.ts'))}, () => ({
  docker(args) {
    if (args[0] === 'run') {
      starts.push(args);
      writeFileSync(${JSON.stringify(alive)}, 'owned');
      return 'owned-compiler-container';
    }
    assert.deepEqual(args, ['port', 'owned-compiler-container', '5432/tcp']);
    return '127.0.0.1:34646';
  },
  cleanup(ids) {
    assert.deepEqual(ids, ['owned-compiler-container']);
    rmSync(${JSON.stringify(alive)});
  },
  run() { throw new Error('unexpected generator'); },
}));
const { runKernelTypecheck } = await import(${JSON.stringify(join(repository, 'services/kernel/scripts/typecheck.ts'))});
const { withThrowawayDatabase } = await import(${JSON.stringify(join(repository, 'services/kernel/scripts/derived.ts'))});
assert.equal(await runKernelTypecheck({ ...process.env, DATABASE_URL: undefined }, {
  place: async (_run, env) => {
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(existsSync(${JSON.stringify(alive)}), false);
    return null;
  },
}), 0);
assert.equal(existsSync(${JSON.stringify(alive)}), false);
assert.equal(process.env.DATABASE_URL, inherited.url);
assert.equal(process.env.KERNEL_DATABASE_CONTAINER, inherited.container);
const failure = new Error('consumer failed');
await assert.rejects(withThrowawayDatabase(async () => {
  await Promise.resolve();
  throw failure;
}), error => error === failure);
assert.equal(process.env.DATABASE_URL, inherited.url);
assert.equal(process.env.KERNEL_DATABASE_CONTAINER, inherited.container);
// These PostgreSQL helpers write only their tmpfs, never a root-owned bind-mounted checkout.
assert.equal(starts.length, 2);
for (const args of starts) {
  assert.equal(args.includes('--tmpfs'), true);
  for (const flag of ['-v', '--volume', '--mount', '--user']) assert.equal(args.includes(flag), false);
}
`,
  );
  for (const inherited of [false, true]) {
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
    delete env.DATABASE_URL;
    delete env.KERNEL_DATABASE_CONTAINER;
    if (inherited) {
      env.DATABASE_URL = 'postgres://developer.test/untouched';
      env.KERNEL_DATABASE_CONTAINER = 'developer-container';
    }
    const result = spawnSync(process.execPath, [fixture], { cwd: repository, env, encoding: 'utf8', timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  }
  expect(
    readFileSync(record, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
    ['run', 'construct'],
    ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
    ['run', 'construct'],
  ]);
});

test('Compiler connection and SQL analysis failures keep their real diagnostics and status without disabling analysis', () => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/compiler-diagnostics-'));
  temporaryDirectories.push(directory);
  const tsc = join(directory, 'tsc');
  writeFileSync(
    tsc,
    `#!/bin/sh
test "$*" = '--noEmit --runExternalCode -p tsconfig.json' || exit 99
printf '%s\\n' "$COMPILER_DIAGNOSTIC"
printf '%s\\n' 'compiler stderr' >&2
exit 23
`,
  );
  chmodSync(tsc, 0o755);
  const construct = join(directory, 'bun');
  writeFileSync(construct, '#!/bin/sh\nprintf "%s\\n" "unexpected construct" >&2\nexit 99\n');
  chmodSync(construct, 0o755);
  for (const workspace of ['kernel', 'auth']) {
    for (const diagnostic of [
      'src/access/account-agent-active-page.sql(1,1): error reylo5: CONNECTION_CLOSED at 127.0.0.1:34646/rezics',
      'src/example.sql(1,1): error reylo1: column "missing" does not exist',
    ]) {
      const result = spawnSync(process.execPath, [join(repository, `services/${workspace}/scripts/typecheck.ts`)], {
        cwd: repository,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          DATABASE_URL: 'postgres://developer.test/explicit',
          COMPILER_DIAGNOSTIC: diagnostic,
        },
      });
      expect(result.status).toBe(23);
      expect(result.stdout).toBe(`${diagnostic}\n`);
      expect(result.stderr).toBe('compiler stderr\n');
    }
  }
});

test('A worktree-writing compiler helper container preserves invoking user ownership or uses a disposable volume without writing root-owned files into the checkout', () => {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/compiler-storage-'));
  temporaryDirectories.push(directory);
  const fixture = join(directory, 'run.ts');
  writeFileSync(
    fixture,
    `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
const commands = [];
const migrations = [];
mock.module('node:child_process', () => ({ spawnSync(program, args, options) {
  assert.equal(program, 'docker');
  assert.equal(options.timeout, 10_000);
  commands.push(args);
  return { status: 0, stdout: args[0] === 'run' ? 'owned-container' : '127.0.0.1:34646', stderr: '' };
} }));
mock.module(${JSON.stringify(join(repository, 'services/kernel/scripts/database.ts'))}, () => ({
  POSTGRES_IMAGE: 'postgres:fixture', migrate(url) { migrations.push(['kernel', url]); },
}));
mock.module(${JSON.stringify(join(repository, 'services/auth/scripts/database.ts'))}, () => ({
  migrate(url) { migrations.push(['auth', url]); },
}));
const { prepareCompilerDatabase } = await import(${JSON.stringify(join(repository, 'scripts/compiler-database.ts'))});
const database = await prepareCompilerDatabase();
const start = commands[0];
// The server's writes are disposable and never reach a host-mounted checkout.
assert.equal(start[start.indexOf('--tmpfs') + 1], '/var/lib/postgresql:rw,size=1g');
for (const flag of ['-v', '--volume', '--mount', '--user']) assert.equal(start.includes(flag), false);
assert.equal(start.includes('--rm'), true);
assert.deepEqual(migrations, [['kernel', database.url], ['auth', database.url]]);
await Promise.resolve();
assert.equal(commands.length, 2);
await database.remove();
await database.remove();
assert.deepEqual(commands.slice(2), [['rm', '-f', '-v', 'owned-container']]);
`,
  );
  const result = spawnSync(process.execPath, [fixture], { cwd: repository, encoding: 'utf8', timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});
