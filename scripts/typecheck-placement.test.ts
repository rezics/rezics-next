import { afterEach, expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runKernelTypecheck } from '../services/kernel/scripts/typecheck.ts';
import { runAuthTypecheck } from '../services/auth/scripts/typecheck.ts';
import { runOnCheckHost } from './stack-run.ts';
import { KERNEL_CLIENT_OUTPUT } from './check-output-tree.ts';
import type { CheckHostRecognitionDisposition } from './check-placement.ts';
import { compilerDatabaseRunArgs, COMPILER_PID_LABEL } from './compiler-database.ts';

const repository = resolve(import.meta.dir, '..');
const temporaryDirectories: string[] = [];
const physicalAdmission = {
  outcome: 'admitted' as const,
  runId: 'fixture',
  scope: 'fixture.scope',
  supervisor: { pid: 1, started: '1', group: 1 },
};
const recognize = () => physicalAdmission;
const refused = (): CheckHostRecognitionDisposition => ({ outcome: 'refused', reason: 'cwd-outside-runs' });

function spawnEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.REZICS_CHECK_PHASES;
  return env;
}

// These children exercise real compiler command composition with inert executables,
// under explicitly injected physical evidence rather than an environment-only URL bypass.
/** Leftover mapper work still on the event loop after the compiler and owned cleanup return. */
function publishCompletedStatus(expression: string): string {
  return `const status = await ${expression};
queueMicrotask(() => { process.exitCode = 0; });
setTimeout(() => { process.exit(0); }, 0);
process.exit(status);`;
}

function admittedEntrypoint(workspace: string, directory: string): string {
  const fixture = join(directory, `${workspace}-admitted.ts`);
  writeFileSync(
    fixture,
    `
import { run${workspace === 'kernel' ? 'Kernel' : 'Auth'}Typecheck } from ${JSON.stringify(join(repository, `services/${workspace}/scripts/typecheck.ts`))};
${publishCompletedStatus(`run${workspace === 'kernel' ? 'Kernel' : 'Auth'}Typecheck(process.env, {
  recognize: () => (${JSON.stringify(physicalAdmission)}),
  place: async () => { throw new Error('nested host admission'); },
  ${workspace === 'kernel' ? `prepareSqlAnalysis: async (env) => ({ available: false, environment: env, analyzedFiles: 0, totalFiles: 0, writtenEntries: 0, dispose() {} }),` : ''}
})`)}
`,
  );
  return fixture;
}

function temporaryDirectory(): string {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(repository, '.temp/typecheck-placement-'));
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
      recognize: refused,
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

test.each([
  [['--emit-client'], ['bun', 'scripts/typecheck.ts', '--emit-client']],
  [['--emit-client=false'], ['bun', 'scripts/typecheck.ts']],
])('Kernel placement forwards only the exact supported emission mode: %j', async (args, command) => {
  const status = await runKernelTypecheck(
    { PATH: process.env.PATH },
    {
      recognize: refused,
      place: async (run) => {
        expect(run.command).toEqual(command);
        return 23;
      },
      withThrowawayDatabase: async () => {
        throw new Error('should not start locally');
      },
    },
    args,
  );

  expect(status).toBe(23);
});

test.each([
  [[], ['bun', 'scripts/typecheck.ts'], [], false],
  [['--emit-client'], ['bun', 'scripts/typecheck.ts', '--emit-client'], [KERNEL_CLIENT_OUTPUT.transport], true],
  [
    ['--emit-schema=semantic'],
    ['bun', 'scripts/typecheck.ts', '--emit-schema=semantic'],
    ['services/kernel/db/semantic/schema.sql'],
    true,
  ],
  [
    ['--emit-schema=semantic', '--emit-client'],
    ['bun', 'scripts/typecheck.ts', '--emit-client', '--emit-schema=semantic'],
    [KERNEL_CLIENT_OUTPUT.transport, 'services/kernel/db/semantic/schema.sql'],
    true,
  ],
])(
  'Kernel placement returns files written by the selected emission modes: %j',
  async (args, command, returns, keepsFiles) => {
    let descriptor: { keepsFiles: boolean | undefined; returns: string[] | undefined } | undefined;
    const status = await runKernelTypecheck(
      { PATH: process.env.PATH },
      {
        recognize: refused,
        place: async (run) => {
          expect(run.command).toEqual(command);
          descriptor = { keepsFiles: run.keepsFiles, returns: run.returns };
          return 23;
        },
        withThrowawayDatabase: async () => {
          throw new Error('should not start locally');
        },
      },
      args,
    );

    expect(descriptor?.keepsFiles).toBe(keepsFiles);
    expect(descriptor?.returns).toEqual(returns);
    expect(status).toBe(23);
  },
);

test('admitted Kernel client emission preserves output modes without nested host discovery', async () => {
  for (const schema of [undefined, 'semantic']) {
    let databaseStarts = 0;
    let compilerRuns = 0;
    let treeCaptures = 0;
    const databaseEnv = { DATABASE_URL: 'postgres://throwaway.test/db' };
    const status = await runKernelTypecheck(
      {
        PATH: process.env.PATH,
        GOAL_TASK_ID: 'worker',
        get KERNEL_CHECK_REMOTE(): string {
          throw new Error('admitted compiler must not rediscover hosts');
        },
      },
      {
        recognize,
        outputTree: async (root, work) => {
          expect(root).toBe(repository);
          treeCaptures++;
          return work();
        },
        place: async () => {
          throw new Error('nested host discovery');
        },
        withThrowawayDatabase: async (work) => {
          databaseStarts++;
          return work(databaseEnv);
        },
        typecheck: async (env, emitClient, emitSchema) => {
          compilerRuns++;
          expect(env).toBe(databaseEnv);
          expect(emitClient).toBe(true);
          expect(emitSchema).toBe(schema);
          return 23;
        },
      },
      ['--emit-client', ...(schema === undefined ? [] : [`--emit-schema=${schema}`])],
    );

    expect(databaseStarts).toBe(1);
    expect(compilerRuns).toBe(1);
    expect(treeCaptures).toBe(1);
    expect(status).toBe(23);
  }
});

test.each([false, true])('local opt-out still places the compiler with its emission mode: %j', async (emitClient) => {
  let placed = false;
  const status = await runKernelTypecheck(
    { REZICS_STACK_REMOTE: 'off', KERNEL_CHECK_REMOTE: 'configured-hosts.json' },
    {
      recognize: refused,
      place: async (run) => {
        placed = true;
        expect(run.command.includes('--emit-client')).toBe(emitClient);
        return 19;
      },
      withThrowawayDatabase: async () => {
        throw new Error('local database');
      },
      typecheck: async () => {
        throw new Error('local compiler');
      },
    },
    emitClient ? ['--emit-client'] : [],
  );
  expect(placed).toBe(true);
  expect(status).toBe(19);
});

test('Kernel compiler placement returns only its genuinely required bounded outputs and never recursively declares an unbounded disposable Reylo cache; native status, required generated outputs and all existing return validation limits stay truthful', async () => {
  const modes: { args: string[]; command: string[]; keepsFiles: boolean; returns: string[] | undefined }[] = [
    { args: [], command: [], keepsFiles: false, returns: [] },
    { args: ['--emit-client=false'], command: [], keepsFiles: false, returns: [] },
    {
      args: ['--emit-client'],
      command: ['--emit-client'],
      keepsFiles: true,
      returns: [KERNEL_CLIENT_OUTPUT.transport],
    },
    {
      args: ['--emit-schema=core'],
      command: ['--emit-schema=core'],
      keepsFiles: true,
      returns: ['services/kernel/db/schema.sql'],
    },
    {
      args: ['--emit-schema=semantic'],
      command: ['--emit-schema=semantic'],
      keepsFiles: true,
      returns: ['services/kernel/db/semantic/schema.sql'],
    },
    {
      args: ['--emit-schema=semantic', '--emit-client'],
      command: ['--emit-client', '--emit-schema=semantic'],
      keepsFiles: true,
      returns: [KERNEL_CLIENT_OUTPUT.transport, 'services/kernel/db/semantic/schema.sql'],
    },
  ];
  // In-workspace configuration is an explicit argv input; disposable caches are never returned.
  const projects: NodeJS.ProcessEnv[] = [
    {},
    { REYLO_CONFIG: '.reylo.yaml' },
    { REYLO_CONFIG: '../../.temp/compiler-project/.reylo.yaml' },
  ];
  for (const project of projects) {
    for (const mode of modes) {
      for (const compilerStatus of [0, 23]) {
        const env = { PATH: process.env.PATH, ...project };
        let placements = 0;
        const status = await runKernelTypecheck(
          env,
          {
            recognize: refused,
            place: async (run, receivedEnv) => {
              placements++;
              expect(receivedEnv).toBe(env);
              expect(run.command).toEqual([
                'bun',
                'scripts/typecheck.ts',
                ...mode.command,
                ...(project.REYLO_CONFIG ? [`--reylo-config=${project.REYLO_CONFIG}`] : []),
              ]);
              expect(run.keepsFiles).toBe(mode.keepsFiles);
              expect(run.returns).toEqual(mode.returns);
              return compilerStatus;
            },
            withThrowawayDatabase: async () => {
              throw new Error('must not start a database after a placed compiler result');
            },
            typecheck: async () => {
              throw new Error('must not compile locally after a placed compiler result');
            },
          },
          mode.args,
        );
        expect(placements).toBe(1);
        expect(status).toBe(compilerStatus);
      }
    }
  }
});

test('admitted typecheck and construct share the host throwaway database', async () => {
  let receivedUrl: string | undefined;
  const status = await runKernelTypecheck(
    {},
    {
      recognize,
      place: async () => {
        throw new Error('nested placement');
      },
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

test('admitted explicit DATABASE_URL retains its SQL semantics without provisioning', async () => {
  let placed = false;
  let databaseStarted = false;
  let receivedUrl: string | undefined;
  const status = await runKernelTypecheck(
    { DATABASE_URL: 'postgres://developer.test/db' },
    {
      recognize,
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

test('named client output is placed before SQL execution and external projects remain unavailable', async () => {
  const hosts = join(temporaryDirectory(), 'hosts.json');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: [
        {
          name: 'a',
          performance: true,
          address: 'ops@a.invalid',
          identity: '/key',
          memoryMaxGiB: 16,
          cpuQuotaPercent: 800,
          slots: 2,
        },
      ],
    }),
  );
  for (const args of [['--emit-client'], ['--emit-client', '--emit-schema=semantic']]) {
    let placements = 0;
    const status = await runKernelTypecheck(
      { KERNEL_CHECK_REMOTE: hosts },
      {
        recognize: refused,
        place: (run, env) =>
          runOnCheckHost(
            run,
            env,
            async (options) => {
              placements++;
              expect(options.command).toEqual(['bun', 'scripts/typecheck.ts', ...args]);
              expect(options.returns).toEqual([
                KERNEL_CLIENT_OUTPUT.transport,
                ...(args.length === 2 ? ['services/kernel/db/semantic/schema.sql'] : []),
              ]);
              return 23;
            },
            refused,
          ),
        withThrowawayDatabase: async () => {
          throw new Error('local database');
        },
        typecheck: async () => {
          throw new Error('local compiler');
        },
      },
      args,
    );
    expect(status).toBe(23);
    expect(placements).toBe(1);
  }
  for (const REYLO_CONFIG of ['/external/project/.reylo.yaml', '../../../external/.reylo.yaml']) {
    const dependencies = {
      place: async () => {
        throw new Error('unsupported project placement');
      },
      typecheck: async () => {
        throw new Error('unsupported project compiler');
      },
    };
    await expect(runKernelTypecheck({ REYLO_CONFIG }, dependencies, [])).rejects.toThrow('Unsupported REYLO_CONFIG');
    await expect(runAuthTypecheck({ REYLO_CONFIG }, dependencies, [])).rejects.toThrow('Unsupported REYLO_CONFIG');
  }
});

test('admitted argv project configuration survives database preparation without nested placement', async () => {
  let compiled = false;
  expect(
    await runKernelTypecheck(
      {},
      {
        recognize,
        place: async () => {
          throw new Error('nested placement');
        },
        withThrowawayDatabase: async (work) => work({ DATABASE_URL: 'postgres://fixture/config' }),
        typecheck: async (env) => {
          compiled = true;
          expect(env.REYLO_CONFIG).toBe('../../.temp/project/.reylo.yaml');
          expect(env.DATABASE_URL).toBe('postgres://fixture/config');
          return 0;
        },
      },
      ['--reylo-config=../../.temp/project/.reylo.yaml'],
    ),
  ).toBe(0);
  expect(compiled).toBe(true);
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
  const result = spawnSync(process.execPath, [admittedEntrypoint('kernel', directory)], {
    cwd: repository,
    encoding: 'utf8',
    env: spawnEnv({ DATABASE_URL: 'postgres://existing.test/db', PATH: `${bin}:${process.env.PATH}` }),
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
  const result = spawnSync(process.execPath, [admittedEntrypoint('kernel', directory)], {
    cwd: repository,
    encoding: 'utf8',
    env: spawnEnv({ DATABASE_URL: 'postgres://existing.test/db', PATH: `${bin}:${process.env.PATH}` }),
    timeout: 60_000,
  });

  expect(result.status).toBe(19);
  expect(readFileSync(join(directory, 'bun.log'), 'utf8')).toBe('run construct\n');
});

test('without DATABASE_URL, auth uses kernel placement and the host owns its migrated Auth database', async () => {
  const events: string[] = [];
  const env = { PATH: process.env.PATH };
  const status = await runAuthTypecheck(env, {
    recognize: refused,
    place: async (run, receivedEnv) => {
      expect(run).toEqual({
        label: 'auth typecheck',
        root: repository,
        cwd: join(repository, 'services/auth'),
        command: ['bun', 'scripts/typecheck.ts'],
      });
      expect(receivedEnv).toBe(env);
      return runAuthTypecheck(env, {
        recognize,
        place: async () => {
          throw new Error('nested placement');
        },
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

test('admitted auth uses and closes its throwaway database', async () => {
  const events: string[] = [];
  const status = await runAuthTypecheck(
    { PATH: process.env.PATH },
    {
      recognize,
      place: async () => {
        throw new Error('nested placement');
      },
      prepareCompilerDatabase: async () => {
        events.push('database');
        return {
          url: 'postgres://local.test/auth',
          container: 'auth-compiler-container',
          assertReady: () => {
            events.push('ready');
          },
          remove: () => {
            events.push('close');
          },
        };
      },
      prepareSqlAnalysis: async (env) => {
        expect(env.KERNEL_DATABASE_CONTAINER).toBe('auth-compiler-container');
        events.push('sql-analysis');
        return {
          available: true,
          environment: { ...env, REYLO_CONFIG: '/private/auth/.reylo.yaml' },
          analyzedFiles: 4,
          totalFiles: 2_033,
          writtenEntries: 4,
          dispose: () => events.push('dispose-analysis'),
        };
      },
      typecheck: async (env) => {
        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.REYLO_CONFIG).toBe('/private/auth/.reylo.yaml');
        expect(env.PATH).toBe(process.env.PATH);
        events.push('tsc');
        return 0;
      },
    },
  );

  expect(status).toBe(0);
  expect(events).toEqual(['database', 'ready', 'sql-analysis', 'tsc', 'dispose-analysis', 'close']);
});

test('admitted auth preserves its explicit database without nested placement or provisioning', async () => {
  const env = { DATABASE_URL: 'postgres://developer.test/auth' };
  const status = await runAuthTypecheck(env, {
    recognize,
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
  const settled = join(directory, 'cleanup-settled');
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
const settled = ${JSON.stringify(settled)};
const prepareCompilerDatabase = async () => ({
  url: 'postgres://fixture.test/auth',
  async remove() { await Bun.write(settled, 'settled'); },
});
${publishCompletedStatus(`runAuthTypecheck(process.env, {
  prepareCompilerDatabase,
  recognize: () => process.argv[2] === 'host'
    ? ({ outcome: 'refused', reason: 'cwd-outside-runs' }) : (${JSON.stringify(physicalAdmission)}),
  place: async (_run, env) => runAuthTypecheck(env, {
    prepareCompilerDatabase, recognize: () => (${JSON.stringify(physicalAdmission)}),
    place: async () => { throw new Error('nested placement'); },
  }),
})`)}
`,
  );
  for (const placement of ['existing', 'local', 'host']) {
    const env: NodeJS.ProcessEnv = spawnEnv({ PATH: `${directory}:${process.env.PATH}` });
    delete env.DATABASE_URL;
    if (placement === 'existing') env.DATABASE_URL = 'postgres://existing.test/auth';
    rmSync(settled, { force: true });
    const result = spawnSync(process.execPath, [fixture, placement], {
      cwd: repository,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });

    expect(result.status).toBe(23);
    expect(result.stdout).toBe(diagnostic);
    expect(result.stderr).toBe('compiler stderr\n');
    if (placement === 'existing') expect(existsSync(settled)).toBe(false);
    else expect(readFileSync(settled, 'utf8')).toBe('settled');
  }
});

test('a successful auth typecheck on a check host never starts another compiler locally', async () => {
  const status = await runAuthTypecheck(
    {},
    {
      recognize: refused,
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
      recognize,
      place: async () => {
        throw new Error('nested placement');
      },
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

  expect(await result).toBe(75);
  expect(events).toEqual(['tsc', 'removed']);
});

test('A compiler database remains reachable from the actual selected typecheck process until the compiler and kernel construct finish', async () => {
  for (const inherited of [false, true]) {
    const originalUrl = process.env.DATABASE_URL;
    const originalContainer = process.env.KERNEL_DATABASE_CONTAINER;
    let alive = false;
    let seenDuringCompile = false;
    const url = 'postgres://fixture.test/compiler';
    if (inherited) {
      process.env.DATABASE_URL = 'postgres://developer.test/untouched';
      process.env.KERNEL_DATABASE_CONTAINER = 'developer-container';
    } else {
      delete process.env.DATABASE_URL;
      delete process.env.KERNEL_DATABASE_CONTAINER;
    }
    try {
      const status = await runKernelTypecheck(
        { PATH: process.env.PATH },
        {
          recognize,
          place: async () => {
            throw new Error('nested placement');
          },
          withThrowawayDatabase: async (work) => {
            alive = true;
            try {
              return await work({ DATABASE_URL: url, KERNEL_DATABASE_CONTAINER: 'owned-compiler-container' });
            } finally {
              alive = false;
            }
          },
          typecheck: async (received) => {
            seenDuringCompile = alive && received.DATABASE_URL === url;
            await Bun.sleep(20);
            expect(alive).toBe(true);
            expect(received.DATABASE_URL).toBe(url);
            return 0;
          },
        },
      );
      expect(status).toBe(0);
      expect(seenDuringCompile).toBe(true);
      expect(alive).toBe(false);
      expect(process.env.DATABASE_URL).toBe(inherited ? 'postgres://developer.test/untouched' : originalUrl);
      expect(process.env.KERNEL_DATABASE_CONTAINER).toBe(inherited ? 'developer-container' : originalContainer);
    } finally {
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
      if (originalContainer === undefined) delete process.env.KERNEL_DATABASE_CONTAINER;
      else process.env.KERNEL_DATABASE_CONTAINER = originalContainer;
    }
  }
});

test('Compiler connection and SQL diagnostic fixtures retain exact output, argv and native status', () => {
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
      const result = spawnSync(process.execPath, [admittedEntrypoint(workspace, directory)], {
        cwd: repository,
        encoding: 'utf8',
        timeout: 10_000,
        env: spawnEnv({
          PATH: `${directory}:${process.env.PATH}`,
          DATABASE_URL: 'postgres://developer.test/explicit',
          COMPILER_DIAGNOSTIC: diagnostic,
        }),
      });
      expect(result.status).toBe(23);
      expect(result.stdout).toBe(`${diagnostic}\n`);
      expect(result.stderr).toBe('compiler stderr\n');
    }
  }
});

test('A worktree-writing compiler helper container preserves invoking user ownership or uses a disposable volume without writing root-owned files into the checkout', () => {
  const args = compilerDatabaseRunArgs(9, 'nonce-9', []);
  expect(args).toContain('--rm');
  expect(args).toContain('--mount');
  expect(args).toContain(`type=volume,destination=/var/lib/postgresql,volume-label=${COMPILER_PID_LABEL}=9`);
  expect(args).not.toContain('--tmpfs');
  expect(args).not.toContain('--user');
  expect(args.includes('-v') && args.some((arg) => arg.includes(repository))).toBe(false);
});

test('direct compiler placement retains native statuses and reports infrastructure status with the original phase', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const run of [runKernelTypecheck, runAuthTypecheck]) {
      for (const status of [0, 1, 2, 23, 75, 124, 130, 143]) {
        output.mockClear();
        expect(await run({}, { recognize: refused, place: async () => status }, [])).toBe(
          [75, 124, 130, 143].includes(status) ? 75 : status,
        );
        if ([75, 124, 130, 143].includes(status)) {
          expect(output.mock.calls.flat().join('\n')).toContain(
            `phase=placement: check-host execution ended with status ${status}`,
          );
        } else expect(output).not.toHaveBeenCalled();
      }
      output.mockClear();
      expect(
        await run(
          {},
          {
            recognize: refused,
            place: async () => {
              throw new Error('SSH master channel lost');
            },
          },
          [],
        ),
      ).toBe(75);
      expect(output.mock.calls.flat().join('\n')).toContain('phase=placement: SSH master channel lost');
    }
  } finally {
    output.mockRestore();
  }
});

test('direct compiler setup, launch and cleanup failures keep their cause, phase and owned cleanup', async () => {
  const output = spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const workspace of ['kernel', 'auth']) {
      for (const failedPhase of ['database-setup', 'compiler', 'database-cleanup']) {
        output.mockClear();
        let removed = 0;
        let compiled = 0;
        const prepare = async () => {
          if (failedPhase === 'database-setup') throw new Error('docker run ETIMEDOUT');
          return {
            url: 'postgres://fixture/typecheck',
            remove: async () => {
              removed++;
              if (failedPhase === 'database-cleanup') throw new Error('docker rm ETIMEDOUT');
            },
          };
        };
        const typecheck = async () => {
          compiled++;
          if (failedPhase === 'compiler') throw new Error('spawn tsc ENOENT');
          return 23;
        };
        const dependencies = { recognize, typecheck };
        const result =
          workspace === 'auth'
            ? await runAuthTypecheck({}, { ...dependencies, prepareCompilerDatabase: prepare }, [])
            : await runKernelTypecheck(
                {},
                {
                  ...dependencies,
                  withThrowawayDatabase: async (work) => {
                    const database = await prepare();
                    try {
                      return await work({ DATABASE_URL: database.url });
                    } finally {
                      await database.remove();
                    }
                  },
                },
                [],
              );
        expect(result).toBe(failedPhase === 'database-cleanup' ? 23 : 75);
        expect(removed).toBe(failedPhase === 'database-setup' ? 0 : 1);
        expect(compiled).toBe(failedPhase === 'database-setup' ? 0 : 1);
        const diagnostic = output.mock.calls.flat().join('\n');
        expect(diagnostic).toContain(`phase=${failedPhase}`);
        expect(diagnostic).toContain(
          failedPhase === 'compiler'
            ? 'spawn tsc ENOENT'
            : failedPhase === 'database-setup'
              ? 'docker run ETIMEDOUT'
              : 'docker rm ETIMEDOUT',
        );
        if (failedPhase === 'database-cleanup') expect(diagnostic).toContain('compiler status 23');
      }
    }
  } finally {
    output.mockRestore();
  }
});
