import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  compilerConfigArgs,
  compilerEnvironment,
  parseTypecheckSelection,
  typecheck,
  typecheckSelectionArgument,
} from './typecheck.ts';
import { runOnCheckHost } from './stack-run.ts';
import { Aborted } from './remote-check.ts';
import { runKernelTypecheck } from '../services/kernel/scripts/typecheck.ts';
import { runAuthTypecheck } from '../services/auth/scripts/typecheck.ts';
import type { CheckHostRecognitionDisposition } from './check-placement.ts';

const repository = resolve(import.meta.dir, '..');
const admitted = (): CheckHostRecognitionDisposition => ({
  outcome: 'admitted',
  runId: 'fixture',
  scope: 'fixture.scope',
  supervisor: { pid: 1, started: '1', group: 1 },
});
const refused = (): CheckHostRecognitionDisposition => ({ outcome: 'refused', reason: 'cwd-outside-runs' });
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  mkdirSync(join(repository, '.temp'), { recursive: true });
  const root = mkdtempSync(join(repository, '.temp/root-compiler-placement-'));
  directories.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: `bun@${Bun.version}` }));
  // All executables in this fixture are inert; none starts a database, compiler or host.
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(process.execPath, join(root, 'node_modules/.bin/bun'));
  for (const [directory, mapped, dependencies] of [
    ['services/kernel', true, {}],
    ['services/auth', true, {}],
    ['packages/pure', false, {}],
    ['apps/dependent', false, { pure: 'workspace:*' }],
  ] as const) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(
      join(root, directory, 'package.json'),
      JSON.stringify({
        name: directory.split('/')[1],
        dependencies,
        scripts: { check: 'true', typecheck: 'bun consumer.ts' },
      }),
    );
    writeFileSync(join(root, directory, 'tsconfig.json'), JSON.stringify(mapped ? { contentMappers: [] } : {}));
    writeFileSync(
      join(root, directory, 'consumer.ts'),
      `
import { appendFileSync, existsSync } from 'node:fs';
if (${mapped} && !existsSync(${JSON.stringify(join(root, 'alive'))})) throw new Error('database removed early');
appendFileSync(${JSON.stringify(join(root, 'consumers'))}, JSON.stringify({ name: ${JSON.stringify(directory)}, url: process.env.DATABASE_URL }) + '\\n');
`,
    );
  }
  const events: string[] = [];
  return {
    root,
    events,
    stdout: { write(_chunk: string) {} },
    startDatabase: async () => {
      events.push('database');
      writeFileSync(join(root, 'alive'), 'owned');
      return {
        url: 'postgres://fixture/shared',
        remove() {
          events.push('cleanup');
          rmSync(join(root, 'alive'));
        },
      };
    },
  };
}

test.each([0, 23, 75, 130, 143])(
  'root and direct entrypoints never replay a placed status %i locally',
  async (status) => {
    const f = fixture();
    const place = async () => {
      f.events.push('placement');
      return status;
    };
    expect(await typecheck({ ...f, env: {}, recognize: refused, place })).toBe(status);
    const dependencies = {
      place,
      recognize: refused,
      withThrowawayDatabase: async () => {
        throw new Error('local database');
      },
      prepareCompilerDatabase: async () => {
        throw new Error('local database');
      },
      typecheck: async () => {
        throw new Error('local compiler');
      },
    };
    expect(await runKernelTypecheck({}, dependencies, [])).toBe(status);
    expect(await runAuthTypecheck({}, dependencies)).toBe(status);
    expect(f.events).toEqual(['placement', 'placement', 'placement']);
  },
);

test('placement exceptions and false null admissions cannot start root or direct SQL work', async () => {
  const f = fixture();
  const failure = new Error('cancelled transport');
  const fail = async () => {
    throw failure;
  };
  await expect(typecheck({ ...f, env: {}, recognize: refused, place: fail })).rejects.toBe(failure);
  await expect(runKernelTypecheck({}, { place: fail, recognize: refused }, [])).rejects.toBe(failure);
  await expect(runAuthTypecheck({}, { place: fail, recognize: refused })).rejects.toBe(failure);
  expect(await typecheck({ ...f, env: {}, recognize: refused, place: async () => null })).toBe(75);
  expect(await runKernelTypecheck({}, { recognize: refused, place: async () => null }, [])).toBe(75);
  expect(await runAuthTypecheck({}, { recognize: refused, place: async () => null })).toBe(75);
  expect(f.events).toEqual([]);
});

test('forged markers, opt-outs, caller root and explicit URLs never grant physical admission', async () => {
  const f = fixture();
  const forged = {
    KERNEL_CHECK_ON_REMOTE: '1',
    REZICS_STACK_REMOTE: 'off',
    REZICS_STACK_LEASE: 'off',
    REMOTE_CHECK_HOST: 'a',
    REZICS_CHECK_RUN: 'fixture',
    REZICS_CHECK_SLICE: 'fixture.scope',
  };
  let placements = 0;
  const place = async () => {
    placements++;
    return 75;
  };
  // Use the real physical recognizer, including for the caller-supplied root.
  expect(await typecheck({ ...f, env: forged, place })).toBe(75);
  expect(await runKernelTypecheck(forged, { place }, [])).toBe(75);
  expect(await runAuthTypecheck(forged, { place })).toBe(75);
  expect(placements).toBe(3);
  const explicit = { ...forged, DATABASE_URL: 'postgres://private.test/precise' };
  expect(await typecheck({ ...f, env: explicit, place })).toBe(75);
  expect(await runKernelTypecheck(explicit, { place }, [])).toBe(75);
  expect(await runAuthTypecheck(explicit, { place })).toBe(75);
  expect(placements).toBe(3);
  expect(f.events).toEqual([]);
});

test('root preserves changed-file selection in argv before any database or workspace child', async () => {
  const f = fixture();
  for (const changedFiles of [
    undefined,
    ['services/auth/src/x.ts'],
    ['packages/pure/src/x.ts', 'services/kernel/x.ts'],
  ]) {
    let command: string[] = [];
    expect(
      await typecheck({
        ...f,
        env: {},
        ...(changedFiles === undefined ? {} : { changedFiles }),
        recognize: refused,
        place: async (run) => {
          command = run.command;
          return 23;
        },
      }),
    ).toBe(23);
    expect(command.slice(0, 2)).toEqual(['bun', 'scripts/typecheck.ts']);
    expect(JSON.parse(command[2]!.slice('--selection='.length))).toEqual({
      version: 1,
      changedFiles: changedFiles ?? null,
    });
  }
  expect(f.events).toEqual([]);
});

test('selected pure typing, dependent closure and empty selection stay local without placement or DB', async () => {
  const f = fixture();
  const forbidden = async (): Promise<never> => {
    throw new Error('pure work requested host or database');
  };
  expect(
    await typecheck({
      ...f,
      env: {},
      changedFiles: ['packages/pure/src/x.ts'],
      startDatabase: forbidden,
      place: forbidden,
      recognize: () => {
        throw new Error('pure recognition');
      },
    }),
  ).toBe(0);
  const consumers = readFileSync(join(f.root, 'consumers'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).name)
    .sort();
  expect(consumers).toEqual(['apps/dependent', 'packages/pure']);
  expect(await typecheck({ ...f, env: {}, changedFiles: [], startDatabase: forbidden, place: forbidden })).toBe(0);
  expect(
    await typecheck({ ...f, env: {}, changedFiles: ['docs/only.md'], startDatabase: forbidden, place: forbidden }),
  ).toBe(0);
  expect(f.events).toEqual([]);
});

test('admitted root shares one database with all selected SQL consumers and cleans it exactly once', async () => {
  const f = fixture();
  expect(
    await typecheck({
      ...f,
      env: {},
      changedFiles: ['services/auth/src/x.ts', 'services/kernel/src/x.ts'],
      recognize: admitted,
      place: async () => {
        throw new Error('nested admission');
      },
    }),
  ).toBe(0);
  expect(f.events).toEqual(['database', 'cleanup']);
  const consumers = readFileSync(join(f.root, 'consumers'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(consumers.map((c) => c.name).sort()).toEqual(['services/auth', 'services/kernel']);
  expect(consumers.every((c) => c.url === 'postgres://fixture/shared')).toBe(true);
});

test('admitted root DB startup failures preserve the original error without compiler execution', async () => {
  const f = fixture();
  const failure = new Error('migration failed: exact diagnostic');
  await expect(
    typecheck({
      ...f,
      env: {},
      recognize: admitted,
      startDatabase: async () => {
        throw failure;
      },
      place: async () => {
        throw new Error('nested admission');
      },
    }),
  ).rejects.toBe(failure);
  expect(f.events).toEqual([]);
});

test('root default database branch composes placement before loading any compiler database', () => {
  const f = fixture();
  const script = join(f.root, 'default-branch.ts');
  writeFileSync(
    script,
    `
import { mock } from 'bun:test';
import assert from 'node:assert/strict';
const events = [];
mock.module(${JSON.stringify(join(repository, 'scripts/compiler-database.ts'))}, () => ({
  prepareCompilerDatabase: async () => { events.push('database'); throw new Error('local database'); },
}));
const { typecheck } = await import(${JSON.stringify(join(repository, 'scripts/typecheck.ts'))});
assert.equal(await typecheck({ root: ${JSON.stringify(f.root)}, env: {},
  place: async () => { events.push('placement'); return 23; }, stdout: { write() {} },
}), 23);
assert.deepEqual(events, ['placement']);
`,
  );
  const result = spawnSync(process.execPath, [script], { cwd: repository, encoding: 'utf8', timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
});

test('root failures retain exact compiler diagnostics in their workspace block and clean the shared DB', async () => {
  const f = fixture();
  const stdout = 'src/query.sql(1,1): error reylo1: column "missing" does not exist';
  const stderr = 'compiler connection diagnostic';
  writeFileSync(
    join(f.root, 'services/auth/consumer.ts'),
    `console.log(${JSON.stringify(stdout)}); console.error(${JSON.stringify(stderr)}); process.exit(23);`,
  );
  let output = '';
  expect(
    await typecheck({
      ...f,
      env: {},
      recognize: admitted,
      changedFiles: ['services/auth/x.ts'],
      stdout: {
        write(chunk) {
          output += chunk;
        },
      },
      place: async () => {
        throw new Error('nested admission');
      },
    }),
  ).toBe(1);
  expect(output.replace(/finished in \d+\.\d{2}s/, 'finished in <duration>')).toBe(
    `Checking 1 of 4 workspaces the change can affect.\nWorkspace auth finished in <duration>\n` +
      `$ bun run typecheck  (services/auth)\n${stdout}\n$ bun consumer.ts\n${stderr}\n` +
      'error: script "typecheck" exited with code 23\n\n',
  );
  expect(f.events).toEqual(['database', 'cleanup']);
});

test('root composes both real direct wrappers and their SQL/construct commands against one admitted DB', async () => {
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  for (const executable of ['tsc', 'bun']) {
    const path = join(bin, executable);
    writeFileSync(
      path,
      `#!${process.execPath}
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
assert.equal(existsSync(${JSON.stringify(join(f.root, 'alive'))}), true);
assert.equal(process.env.DATABASE_URL, 'postgres://fixture/shared');
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(
        executable === 'tsc' ? ['--noEmit', '--runExternalCode', '-p', 'tsconfig.json'] : ['run', 'construct'],
      )});
appendFileSync(${JSON.stringify(join(f.root, 'commands'))}, ${JSON.stringify(executable)} + '\\n');
`,
    );
    chmodSync(path, 0o755);
  }
  for (const workspace of ['kernel', 'auth']) {
    const workspaceDirectory = join(f.root, 'services', workspace);
    writeFileSync(
      join(workspaceDirectory, 'package.json'),
      JSON.stringify({ name: workspace, scripts: { check: 'true', typecheck: `${process.execPath} consumer.ts` } }),
    );
    writeFileSync(
      join(workspaceDirectory, 'consumer.ts'),
      `
import { run${workspace === 'kernel' ? 'Kernel' : 'Auth'}Typecheck } from ${JSON.stringify(join(repository, `services/${workspace}/scripts/typecheck.ts`))};
// Bun's package-script launcher prepends ancestor node_modules bins. Confine both lookup paths to inert executables.
process.env.PATH = ${JSON.stringify(bin)};
process.exitCode = await run${workspace === 'kernel' ? 'Kernel' : 'Auth'}Typecheck(process.env, {
  recognize: () => (${JSON.stringify(admitted())}),
  place: async () => { throw new Error('nested placement'); },
});
`,
    );
  }
  expect(
    await typecheck({
      ...f,
      env: { PATH: `${bin}:${process.env.PATH}` },
      recognize: admitted,
      changedFiles: ['services/kernel/x.ts', 'services/auth/x.ts'],
      place: async () => {
        throw new Error('nested placement');
      },
    }),
  ).toBe(0);
  expect(f.events).toEqual(['database', 'cleanup']);
  expect(readFileSync(join(f.root, 'commands'), 'utf8').trim().split('\n').sort()).toEqual(['bun', 'tsc', 'tsc']);
});

test('real placement composes configured performance hosts, selected argv, native refusal and cancellation without replay', async () => {
  const f = fixture();
  const hosts = join(f.root, 'hosts.json');
  writeFileSync(
    hosts,
    JSON.stringify({
      hosts: ['a', 'b', 'c', 'unflagged'].map((name) => ({
        name,
        performance: name !== 'unflagged',
        address: `ops@${name}.test`,
        identity: '/inert/key',
        memoryMaxGiB: 16,
        cpuQuotaPercent: 800,
        slots: 2,
      })),
    }),
  );
  for (const outcome of [23, 75, 'cancelled'] as const) {
    const place: typeof runOnCheckHost = (run, env) =>
      runOnCheckHost(
        run,
        env,
        async (options) => {
          expect(options.allowedHosts).toEqual(['a', 'b', 'c']);
          expect(options.hosts.map((h) => h.name)).toEqual(['a', 'b', 'c']);
          expect(options.workspace).toBe(run.root);
          expect(options.command).toEqual(run.command);
          if (outcome === 'cancelled') throw new Aborted();
          return outcome;
        },
        refused,
      );
    const env = { KERNEL_CHECK_REMOTE: hosts, REZICS_STACK_REMOTE: 'off' };
    const expected = outcome === 'cancelled' ? 143 : outcome;
    expect(await typecheck({ ...f, env, recognize: refused, place, changedFiles: ['services/auth/x.ts'] })).toBe(
      expected,
    );
    expect(await runKernelTypecheck(env, { recognize: refused, place }, [])).toBe(expected);
    expect(await runAuthTypecheck(env, { recognize: refused, place }, [])).toBe(expected);
  }
  expect(f.events).toEqual([]);
});

test('selection descriptor round trips empty, all, Unicode, shell literals and TYPECHECK_CHANGED without broadening', async () => {
  for (const changedFiles of [[], ['services/auth/編譯.ts', 'packages/pure/$(literal)`name.ts']]) {
    expect(parseTypecheckSelection([typecheckSelectionArgument(changedFiles)])).toEqual({ changedFiles });
  }
  expect(parseTypecheckSelection([typecheckSelectionArgument(undefined)])).toEqual({});
  const f = fixture();
  const changedFiles = ['services/auth/src/selected.ts'];
  let relocated: readonly string[] | undefined;
  expect(
    await typecheck({
      ...f,
      env: { TYPECHECK_CHANGED: changedFiles.join('\n') },
      recognize: refused,
      place: async (run) => {
        relocated = parseTypecheckSelection(run.command.slice(2)).changedFiles;
        return 23;
      },
    }),
  ).toBe(23);
  expect(relocated).toEqual(changedFiles);
  expect(f.events).toEqual([]);
});

test('malformed or unbounded selection/config descriptors cannot select code, absolute paths or external projects', () => {
  for (const changedFiles of [['../escape'], ['/absolute'], ['a\nb'], ['x'.repeat(4097)], Array(4097).fill('x')])
    expect(() => typecheckSelectionArgument(changedFiles)).toThrow();
  expect(() => typecheckSelectionArgument(Array(32).fill('x'.repeat(4096)))).toThrow('65536');
  for (const descriptor of [
    'null',
    '{}',
    '{"version":2,"changedFiles":[]}',
    '{"version":1,"changedFiles":[],"code":"x"}',
    '{"version":1,"changedFiles":["../x"]}',
    'x'.repeat(65_537),
  ])
    expect(() => parseTypecheckSelection([`--selection=${descriptor}`])).toThrow();
  expect(() => parseTypecheckSelection(['--selection={}', '--selection={}'])).toThrow();
  expect(() => parseTypecheckSelection(['--eval=code'])).toThrow();
  for (const REYLO_CONFIG of ['/external/.reylo.yaml', '../../../external/.reylo.yaml', '', 'x\ny', 'x'.repeat(4097)])
    expect(() => compilerConfigArgs({ REYLO_CONFIG }, repository, [join(repository, 'services/kernel')])).toThrow(
      'Unsupported REYLO_CONFIG',
    );
  expect(
    compilerConfigArgs({ REYLO_CONFIG: '../../.temp/project/.reylo.yaml' }, repository, [
      join(repository, 'services/kernel'),
    ]),
  ).toEqual(['--reylo-config=../../.temp/project/.reylo.yaml']);
  expect(compilerEnvironment({}, ['--reylo-config=.reylo.yaml'])).toEqual({ REYLO_CONFIG: '.reylo.yaml' });
  expect(() => compilerEnvironment({}, ['--reylo-config=a', '--reylo-config=b'])).toThrow('Duplicate');
});
