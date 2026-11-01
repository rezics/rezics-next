import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { typecheck } from './typecheck.ts';
import { runKernelTypecheck } from '../services/kernel/scripts/typecheck.ts';
import { runAuthTypecheck } from '../services/auth/scripts/typecheck.ts';
import type { CheckHostRecognitionDisposition } from './check-placement.ts';

const repository = resolve(import.meta.dir, '..');
const admitted = (): CheckHostRecognitionDisposition => ({
  outcome: 'admitted', runId: 'fixture', scope: 'fixture.scope',
  supervisor: { pid: 1, started: '1', group: 1 },
});
const refused = (): CheckHostRecognitionDisposition => ({ outcome: 'refused', reason: 'outside-run-root' });
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
    ['services/kernel', true, {}], ['services/auth', true, {}],
    ['packages/pure', false, {}], ['apps/dependent', false, { pure: 'workspace:*' }],
  ] as const) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'package.json'), JSON.stringify({
      name: directory.split('/')[1], dependencies,
      scripts: { check: 'true', typecheck: 'bun consumer.ts' },
    }));
    writeFileSync(join(root, directory, 'tsconfig.json'), JSON.stringify(mapped ? { contentMappers: [] } : {}));
    writeFileSync(join(root, directory, 'consumer.ts'), `
import { appendFileSync, existsSync } from 'node:fs';
if (${mapped} && !existsSync(${JSON.stringify(join(root, 'alive'))})) throw new Error('database removed early');
appendFileSync(${JSON.stringify(join(root, 'consumers'))}, JSON.stringify({ name: ${JSON.stringify(directory)}, url: process.env.DATABASE_URL }) + '\\n');
`);
  }
  const events: string[] = [];
  return {
    root, events,
    stdout: { write(_chunk: string) {} },
    startDatabase: async () => {
      events.push('database');
      writeFileSync(join(root, 'alive'), 'owned');
      return { url: 'postgres://fixture/shared', remove() {
        events.push('cleanup'); rmSync(join(root, 'alive'));
      } };
    },
  };
}

test.each([0, 23, 75, 130, 143])('root and direct entrypoints never replay a placed status %i locally', async (status) => {
  const f = fixture();
  const place = async () => { f.events.push('placement'); return status; };
  expect(await typecheck({ ...f, env: {}, recognize: refused, place })).toBe(status);
  const dependencies = {
    place, recognize: refused,
    withThrowawayDatabase: async () => { throw new Error('local database'); },
    prepareCompilerDatabase: async () => { throw new Error('local database'); },
    typecheck: async () => { throw new Error('local compiler'); },
  };
  expect(await runKernelTypecheck({}, dependencies, [])).toBe(status);
  expect(await runAuthTypecheck({}, dependencies)).toBe(status);
  expect(f.events).toEqual(['placement', 'placement', 'placement']);
});

test('placement exceptions and false null admissions cannot start root or direct SQL work', async () => {
  const f = fixture();
  const failure = new Error('cancelled transport');
  const fail = async () => { throw failure; };
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
    KERNEL_CHECK_ON_REMOTE: '1', REZICS_STACK_REMOTE: 'off', REZICS_STACK_LEASE: 'off',
    REMOTE_CHECK_HOST: 'a', REZICS_CHECK_RUN: 'fixture', REZICS_CHECK_SLICE: 'fixture.scope',
  };
  let placements = 0;
  const place = async () => { placements++; return 75; };
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
  for (const changedFiles of [undefined, ['services/auth/src/x.ts'], ['packages/pure/src/x.ts', 'services/kernel/x.ts']]) {
    let command: string[] = [];
    expect(await typecheck({ ...f, env: {}, ...(changedFiles === undefined ? {} : { changedFiles }),
      recognize: refused, place: async (run) => { command = run.command; return 23; },
    })).toBe(23);
    expect(command.slice(0, 2)).toEqual(['bun', 'scripts/typecheck.ts']);
    expect(JSON.parse(command[2]!.slice('--selection='.length))).toEqual({ version: 1, changedFiles: changedFiles ?? null });
  }
  expect(f.events).toEqual([]);
});

test('selected pure typing, dependent closure and empty selection stay local without placement or DB', async () => {
  const f = fixture();
  const forbidden = async (): Promise<never> => { throw new Error('pure work requested host or database'); };
  expect(await typecheck({ ...f, env: {}, changedFiles: ['packages/pure/src/x.ts'],
    startDatabase: forbidden, place: forbidden, recognize: () => { throw new Error('pure recognition'); },
  })).toBe(0);
  const consumers = readFileSync(join(f.root, 'consumers'), 'utf8').trim().split('\n').map(line => JSON.parse(line).name).sort();
  expect(consumers).toEqual(['apps/dependent', 'packages/pure']);
  expect(await typecheck({ ...f, env: {}, changedFiles: [], startDatabase: forbidden, place: forbidden })).toBe(0);
  expect(await typecheck({ ...f, env: {}, changedFiles: ['docs/only.md'], startDatabase: forbidden, place: forbidden })).toBe(0);
  expect(f.events).toEqual([]);
});

test('admitted root shares one database with all selected SQL consumers and cleans it exactly once', async () => {
  const f = fixture();
  expect(await typecheck({ ...f, env: {}, changedFiles: ['services/auth/src/x.ts', 'services/kernel/src/x.ts'],
    recognize: admitted, place: async () => { throw new Error('nested admission'); },
  })).toBe(0);
  expect(f.events).toEqual(['database', 'cleanup']);
  const consumers = readFileSync(join(f.root, 'consumers'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(consumers.map(c => c.name).sort()).toEqual(['services/auth', 'services/kernel']);
  expect(consumers.every(c => c.url === 'postgres://fixture/shared')).toBe(true);
});

test('admitted root DB startup failures preserve the original error without compiler execution', async () => {
  const f = fixture();
  const failure = new Error('migration failed: exact diagnostic');
  await expect(typecheck({ ...f, env: {}, recognize: admitted, startDatabase: async () => { throw failure; },
    place: async () => { throw new Error('nested admission'); },
  })).rejects.toBe(failure);
  expect(f.events).toEqual([]);
});
