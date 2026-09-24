import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appEnvironment, assertSavedStackStorage, composeProcessEnvironment, ensureSecrets,
  parseOptions, projectName, stackDirectory } from './config.ts';

const roots: string[] = [];
mkdirSync('.temp', { recursive: true });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('P0.1 rejects ambiguous or unsafe stack project names', () => {
  expect(projectName(parseOptions(['--profile', 'dev']))).toBe('rezics-dev');
  expect(projectName(parseOptions(['--profile', 'qa', '--run-id', 'batch-42']))).toBe('rezics-qa-batch-42');
  expect(() => projectName(parseOptions(['--profile', 'qa']))).toThrow('requires --run-id');
  expect(() => parseOptions(['--profile', 'qa', '--run-id', '../escape'])).toThrow();
  expect(() => parseOptions(['--profile', 'dev', '--run-id', 'x'])).toThrow();
  expect(() => parseOptions(['--persistent'])).toThrow('--persistent requires --profile qa');
  expect(parseOptions(['--profile', 'qa', '--run-id', 'rebuild', '--persistent']).persistent).toBe(true);
});

test('P0.1 stack credentials and lineage persist across starts and remain private', () => {
  const root = mkdtempSync('.temp/p01-config-test-'); roots.push(root);
  const options = { profile: 'dev' as const };
  const first = ensureSecrets(root, options);
  const second = ensureSecrets(root, options);
  expect(second).toEqual(first);
  expect(first.POSTGRES_PASSWORD).toHaveLength(64);
  expect(first.FUSEKI_MAINTENANCE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(first.FUSEKI_COMMAND_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(first.FUSEKI_COMMAND_TOKEN).not.toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(first.MAIN_DATA_EPOCH).toBeTruthy();
  expect(first.MAIN_ROUTING_EPOCH).toBeTruthy();
  const dir = stackDirectory(root, options);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'compose.env')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'compose.env'), 'utf8')).toContain('REZICS_ACCESS_PASSWORD=');
  const apps = appEnvironment(first, dir);
  expect(apps.ACCESS_DATABASE_URL).toContain(`:${first.REZICS_ACCESS_PASSWORD}@127.0.0.1:5432/access`);
  expect(apps.CONTENT_DATABASE_URL).toContain(`:${first.REZICS_CONTENT_PASSWORD}@127.0.0.1:5432/content`);
  expect(apps.MAIN_OBJECT_DIRECTORY).toBe(join(dir, 'objects'));
  expect(apps.MAIN_S3_ENDPOINT).toBe(`http://127.0.0.1:${first.RUSTFS_PORT}`);
  expect(apps.MAIN_S3_ACCESS_KEY).toBe(first.RUSTFS_ACCESS_KEY);
  expect(apps.MAIN_S3_SECRET_KEY).toBe(first.RUSTFS_SECRET_KEY);
  expect(apps.FUSEKI_MAINTENANCE_TOKEN).toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(apps.FUSEKI_COMMAND_TOKEN).toBe(first.FUSEKI_COMMAND_TOKEN);
  expect(apps.MAIN_DATA_EPOCH).toBe(first.MAIN_DATA_EPOCH);
  expect(apps.MAIN_ORIGIN).toBe('http://127.0.0.1:3001');
  expect(apps.ACCOUNT_ORIGIN).toBe('http://127.0.0.1:3002');
  expect(apps.MAIN_RESOURCE).toBe(apps.ACCOUNT_MAIN_RESOURCE);
  const composePath = join(dir, 'compose.env');
  writeFileSync(composePath, readFileSync(composePath, 'utf8')
    .replace(/^FUSEKI_(?:MAINTENANCE|COMMAND)_TOKEN=.*\n/gm, ''), { mode: 0o600 });
  const upgraded = ensureSecrets(root, options);
  expect(upgraded.POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
  expect(upgraded.FUSEKI_MAINTENANCE_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(upgraded.FUSEKI_MAINTENANCE_TOKEN).not.toBe(first.FUSEKI_MAINTENANCE_TOKEN);
  expect(upgraded.FUSEKI_COMMAND_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(upgraded.FUSEKI_COMMAND_TOKEN).not.toBe(first.FUSEKI_COMMAND_TOKEN);
  expect(statSync(composePath).mode & 0o777).toBe(0o600);
});

test('P0.1 QA projects keep independent credentials and endpoints', () => {
  const root = mkdtempSync('.temp/p01-config-test-'); roots.push(root);
  const a = ensureSecrets(root, { profile: 'qa', runId: 'a' }, { MAIN_PORT: 14001, ACCOUNT_PORT: 14002,
    POSTGRES_PORT: 15401, FUSEKI_PORT: 13001 });
  const b = ensureSecrets(root, { profile: 'qa', runId: 'b' }, { MAIN_PORT: 14011, ACCOUNT_PORT: 14012,
    POSTGRES_PORT: 15402, FUSEKI_PORT: 13002 });
  expect(a.POSTGRES_PASSWORD).not.toBe(b.POSTGRES_PASSWORD);
  expect(a.FUSEKI_MAINTENANCE_TOKEN).not.toBe(b.FUSEKI_MAINTENANCE_TOKEN);
  expect(a.FUSEKI_COMMAND_TOKEN).not.toBe(b.FUSEKI_COMMAND_TOKEN);
  expect(a.MAIN_DATA_EPOCH).not.toBe(b.MAIN_DATA_EPOCH);
  expect(appEnvironment(a, root).FUSEKI_URL).toContain(':13001/');
  expect(appEnvironment(b, root).FUSEKI_URL).toContain(':13002/');
  expect(appEnvironment(a, root).MAIN_ORIGIN).toContain(`:${a.MAIN_PORT}`);
  const nested = composeProcessEnvironment({ ...a, DOCKER_HOST: 'unix:///run/podman.sock' }, b);
  expect(nested.FUSEKI_MAINTENANCE_TOKEN).toBe(b.FUSEKI_MAINTENANCE_TOKEN);
  expect(nested.FUSEKI_COMMAND_TOKEN).toBe(b.FUSEKI_COMMAND_TOKEN);
  expect(nested.POSTGRES_PASSWORD).toBe(b.POSTGRES_PASSWORD);
  expect(nested.FUSEKI_PORT).toBe(b.FUSEKI_PORT);
  expect(nested.DOCKER_HOST).toBe('unix:///run/podman.sock');
});

test('SEARCH20/OPS16 isolated QA project retains its chosen storage mode', () => {
  const root = mkdtempSync('.temp/p08-rebuild-config-'); roots.push(root);
  const persistent = { profile: 'qa' as const, runId: 'rebuild', persistent: true };
  const first = ensureSecrets(root, persistent, { FUSEKI_PORT: 13041 });
  expect(first.REZICS_STACK_STORAGE).toBe('persistent');
  expect(ensureSecrets(root, persistent).FUSEKI_PORT).toBe('13041');
  expect(() => ensureSecrets(root, { profile: 'qa', runId: 'rebuild' }))
    .toThrow('Saved stack storage mode differs');
  const disposable = ensureSecrets(root, { profile: 'qa', runId: 'disposable' });
  expect(disposable.REZICS_STACK_STORAGE).toBe('tmpfs');
  expect(() => ensureSecrets(root, { profile: 'qa', runId: 'disposable', persistent: true }))
    .toThrow('Saved stack storage mode differs');
  expect(() => assertSavedStackStorage({ profile: 'qa', runId: 'rebuild' }, first))
    .toThrow('Saved stack storage mode differs');
  expect(() => assertSavedStackStorage(persistent, first)).not.toThrow();
  expect(() => assertSavedStackStorage({ profile: 'qa', runId: 'old-tmpfs', persistent: true }, {}))
    .toThrow('Saved stack storage mode differs');
  expect(() => assertSavedStackStorage({ profile: 'dev' }, {})).not.toThrow();
});
