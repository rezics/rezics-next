import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runKernelTypecheck } from '../services/kernel/scripts/typecheck.ts';

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
  });

  expect(result.status).toBe(19);
  expect(readFileSync(join(directory, 'bun.log'), 'utf8')).toBe('run construct\n');
});
