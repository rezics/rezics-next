import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from 'bun:test';
import {
  migrationFingerprint,
  openApiCacheMatches,
  openApiSourceFingerprint,
  reusableDerivedDatabase,
  throwawayDatabaseRunArgs,
} from './derived.ts';
import { cleanupStale } from './check.ts';
import { dockerNetworkArgs } from '../../../scripts/compiler-database.ts';

const repository = resolve(import.meta.dir, '../../..');

test('derived caches invalidate on migration, source, output, and container changes', () => {
  mkdirSync(resolve(repository, '.temp'), { recursive: true });
  const fixture = mkdtempSync(resolve(repository, '.temp', 'kernel-derived-test-'));
  const kernel = resolve(fixture, 'services/kernel');
  try {
    mkdirSync(resolve(kernel, 'db/migrations'), { recursive: true });
    mkdirSync(resolve(kernel, 'src/http'), { recursive: true });
    mkdirSync(resolve(kernel, 'scripts'), { recursive: true });
    mkdirSync(resolve(kernel, 'test/support'), { recursive: true });
    mkdirSync(resolve(fixture, 'packages/example/src'), { recursive: true });
    const migration = 'db/migrations/1_initial.sql';
    writeFileSync(resolve(kernel, migration), 'CREATE TABLE example (id integer);\n');
    writeFileSync(resolve(kernel, 'src/http/route.ts'), 'export const route = 1;\n');
    writeFileSync(resolve(kernel, 'scripts/openapi.ts'), 'export const generator = 1;\n');
    writeFileSync(resolve(kernel, 'test/support/receipt-keys.ts'), 'export const keys = [];\n');
    const packageSource = resolve(fixture, 'packages/example/src/schema.ts');
    writeFileSync(packageSource, 'export const schema = 1;\n');

    const firstMigrationFingerprint = migrationFingerprint([migration], kernel);
    expect(migrationFingerprint([migration], kernel)).toBe(firstMigrationFingerprint);
    writeFileSync(resolve(kernel, migration), 'CREATE TABLE example (id bigint);\n');
    expect(migrationFingerprint([migration], kernel)).not.toBe(firstMigrationFingerprint);

    const sources = openApiSourceFingerprint(kernel, fixture);
    writeFileSync(packageSource, 'export const schema = 2;\n');
    expect(openApiSourceFingerprint(kernel, fixture)).not.toBe(sources);
    const contract = 'contract-hash';
    expect(openApiCacheMatches({ version: 1, sources, output: contract }, sources, contract)).toBe(true);
    expect(openApiCacheMatches({ version: 1, sources, output: contract }, sources, 'edited-contract')).toBe(false);
    expect(openApiCacheMatches({ version: 1, sources, output: contract }, 'changed-source', contract)).toBe(false);

    const state = { version: 1 as const, checkout: 'checkout', migrations: 'migration', container: 'container-id' };
    const container = { id: 'container-id', running: true, checkout: 'checkout' };
    expect(reusableDerivedDatabase(state, container, 'checkout', 'migration')).toBe(true);
    expect(reusableDerivedDatabase(state, container, 'checkout', 'changed-migration')).toBe(false);
    expect(reusableDerivedDatabase(state, { ...container, running: false }, 'checkout', 'migration')).toBe(false);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test('throwaway databases use --rm and refuse Linux namespace paths as Docker networks', () => {
  const args = throwawayDatabaseRunArgs(7);
  expect(args[0]).toBe('run');
  expect(args).toContain('--rm');
  expect(args).toContain('rezics.kernel.derived.pid=7');
  expect(args).not.toContain('--network');
  expect(args).toContain('-p');
  expect(() => dockerNetworkArgs({ REZICS_DOCKER_NETWORK: 'ns:/proc/9/ns/net' })).toThrow(
    'Docker treats ns:/proc/... as a network name',
  );
  expect(dockerNetworkArgs({ REZICS_ISOLATED_STACK_CONTAINER: 'isolated-pause' })).toEqual([
    '--network',
    'container:isolated-pause',
  ]);
  const previous = process.env.REZICS_ISOLATED_STACK_CONTAINER;
  process.env.REZICS_ISOLATED_STACK_CONTAINER = 'isolated-pause';
  try {
    const isolated = throwawayDatabaseRunArgs(7);
    expect(isolated).toContain('--network');
    expect(isolated).toContain('container:isolated-pause');
    expect(isolated).toContain(`/tmp/rzpg-7:/var/run/postgresql`);
    expect(isolated).not.toContain('-p');
  } finally {
    if (previous === undefined) delete process.env.REZICS_ISOLATED_STACK_CONTAINER;
    else process.env.REZICS_ISOLATED_STACK_CONTAINER = previous;
  }
});

test('stale derived databases whose owner pid is gone are removed with their volumes', () => {
  const calls: string[][] = [];
  const docker = (args: string[]): string => {
    calls.push(args);
    return args[0] === 'ps' ? 'dead-derived 2147483647' : '';
  };
  cleanupStale('derived', docker);
  expect(calls[0]).toEqual([
    'ps',
    '-a',
    '--filter',
    'label=rezics.kernel.derived.pid',
    '--format',
    '{{.ID}} {{.Label "rezics.kernel.derived.pid"}}',
  ]);
  expect(calls[1]).toEqual(['rm', '-f', '-v', 'dead-derived']);
});
