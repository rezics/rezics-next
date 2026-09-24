import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appEnvironment, ensureSecrets, parseOptions, projectName, stackDirectory } from './config.ts';

const roots: string[] = [];
mkdirSync('.temp', { recursive: true });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('P0.1 rejects ambiguous or unsafe stack project names', () => {
  expect(projectName(parseOptions(['--profile', 'dev']))).toBe('rezics-dev');
  expect(projectName(parseOptions(['--profile', 'qa', '--run-id', 'batch-42']))).toBe('rezics-qa-batch-42');
  expect(() => projectName(parseOptions(['--profile', 'qa']))).toThrow('requires --run-id');
  expect(() => parseOptions(['--profile', 'qa', '--run-id', '../escape'])).toThrow();
  expect(() => parseOptions(['--profile', 'dev', '--run-id', 'x'])).toThrow();
});

test('P0.1 stack credentials and lineage persist across starts and remain private', () => {
  const root = mkdtempSync('.temp/p01-config-test-'); roots.push(root);
  const options = { profile: 'dev' as const };
  const first = ensureSecrets(root, options);
  const second = ensureSecrets(root, options);
  expect(second).toEqual(first);
  expect(first.POSTGRES_PASSWORD).toHaveLength(64);
  expect(first.MAIN_DATA_EPOCH).toBeTruthy();
  expect(first.MAIN_ROUTING_EPOCH).toBeTruthy();
  const dir = stackDirectory(root, options);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'compose.env')).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(dir, 'compose.env'), 'utf8')).toContain('REZICS_ACCESS_PASSWORD=');
  const apps = appEnvironment(first, dir);
  expect(apps.ACCESS_DATABASE_URL).toContain(`:${first.REZICS_ACCESS_PASSWORD}@127.0.0.1:5432/access`);
  expect(apps.MAIN_OBJECT_DIRECTORY).toBe(join(dir, 'objects'));
  expect(apps.MAIN_S3_ENDPOINT).toBe(`http://127.0.0.1:${first.RUSTFS_PORT}`);
  expect(apps.MAIN_S3_ACCESS_KEY).toBe(first.RUSTFS_ACCESS_KEY);
  expect(apps.MAIN_S3_SECRET_KEY).toBe(first.RUSTFS_SECRET_KEY);
  expect(apps.MAIN_DATA_EPOCH).toBe(first.MAIN_DATA_EPOCH);
  expect(apps.MAIN_ORIGIN).toBe('http://127.0.0.1:3001');
  expect(apps.ACCOUNT_ORIGIN).toBe('http://127.0.0.1:3002');
  expect(apps.MAIN_RESOURCE).toBe(apps.ACCOUNT_MAIN_RESOURCE);
});

test('P0.1 QA projects keep independent credentials and endpoints', () => {
  const root = mkdtempSync('.temp/p01-config-test-'); roots.push(root);
  const a = ensureSecrets(root, { profile: 'qa', runId: 'a' }, { MAIN_PORT: 14001, ACCOUNT_PORT: 14002,
    POSTGRES_PORT: 15401, FUSEKI_PORT: 13001 });
  const b = ensureSecrets(root, { profile: 'qa', runId: 'b' }, { MAIN_PORT: 14011, ACCOUNT_PORT: 14012,
    POSTGRES_PORT: 15402, FUSEKI_PORT: 13002 });
  expect(a.POSTGRES_PASSWORD).not.toBe(b.POSTGRES_PASSWORD);
  expect(a.MAIN_DATA_EPOCH).not.toBe(b.MAIN_DATA_EPOCH);
  expect(appEnvironment(a, root).FUSEKI_URL).toContain(':13001/');
  expect(appEnvironment(b, root).FUSEKI_URL).toContain(':13002/');
  expect(appEnvironment(a, root).MAIN_ORIGIN).toContain(`:${a.MAIN_PORT}`);
});
