import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  developmentKeys,
  developmentBindings,
  issuerRequest,
  localDatabase,
  openLocalShowcase,
  publicKey,
  retireDevelopmentSeedState,
} from '../scripts/dev-stack.ts';
import { developmentEnv } from '../../kernel/scripts/database.ts';
import { rateLimitBudgets } from '../../kernel/src/access/write-rate-budgets.ts';

test('development setup gives finite dataset write capacity and preserves explicit deployment budgets', () => {
  const generated = developmentEnv('', 'postgres://127.0.0.1/rezics');
  const value = generated
    .split('\n')
    .find((line) => line.startsWith('KERNEL_WRITE_RATE_OVERRIDES='))!
    .split('=')
    .slice(1)
    .join('=');
  const budgets = rateLimitBudgets(value);
  expect(budgets['new-account'].write.maximum).toBe(100000);
  expect(budgets.member.write.maximum).toBe(100000);
  expect(budgets.anonymous.write.maximum).toBe(10);
  expect(developmentEnv('KERNEL_WRITE_RATE_OVERRIDES={}\n', 'postgres://127.0.0.1/rezics')).toContain(
    'KERNEL_WRITE_RATE_OVERRIDES={}\n',
  );
});

test('native loopback transport retains the public issuer and original request evidence', async () => {
  const request = new Request('http://127.0.0.1:3100/signin', {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:4200', 'content-type': 'application/json' },
    body: '{}',
  });
  const forwarded = issuerRequest(request);
  expect(forwarded.url).toBe('http://127.0.0.1:4200/signin');
  expect(forwarded.headers.get('origin')).toBe('http://127.0.0.1:4200');
  expect(forwarded.method).toBe('POST');
  expect(await forwarded.text()).toBe('{}');
});

test('first-run secrets remain private and stable across setup retries', async () => {
  await mkdir(resolve(import.meta.dir, '../../../.temp'), { recursive: true });
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../.temp/local-keys-'));
  try {
    const keys = await developmentKeys(directory);
    expect(await developmentKeys(directory)).toEqual(keys);
    expect((await stat(resolve(directory, 'keys.json'))).mode & 0o777).toBe(0o600);
    expect(new Set([keys.signing.kid, keys.website.kid, keys.importer.kid]).size).toBe(3);
    expect(publicKey(keys.importer).d).toBeUndefined();
    expect(keys.secret).not.toBe(keys.staging);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('database reset retires old native-ID journals and preserves the development keys', async () => {
  const repository = await mkdtemp(resolve(import.meta.dir, '../../../.temp/reset-seed-'));
  try {
    const keys = await developmentKeys(resolve(repository, '.temp/local-stack'));
    await mkdir(resolve(repository, '.temp/cross-media-seed'));
    await writeFile(resolve(repository, '.temp/cross-media-seed/state.sqlite'), 'old-native-ids');
    const archived = await retireDevelopmentSeedState(repository);
    expect(await readFile(resolve(archived!, 'state.sqlite'), 'utf8')).toBe('old-native-ids');
    expect(await retireDevelopmentSeedState(repository)).toBeUndefined();
    expect(await developmentKeys(resolve(repository, '.temp/local-stack'))).toEqual(keys);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('local setup refuses remote databases', () => {
  expect(() => localDatabase('postgres://rezics:rezics@production.example/rezics')).toThrow('127.0.0.1');
  expect(localDatabase('postgres://rezics:rezics@127.0.0.1:54329/rezics').hostname).toBe('127.0.0.1');
});

test('persona retries open mixed Search and POST facets alongside anonymous GET groups only', async () => {
  const route = (method: string, group: string, security = [{}]) => ({
    method,
    hooks: { detail: { 'x-exposure': `gate:${group}`, security } },
  });
  const routes = [
    route('GET', 'subjects'),
    route('GET', 'search'),
    route('POST', 'search_advanced'),
    route('POST', 'write_gate'),
    route('GET', 'private_gate', [{ bearerAuth: [] }]),
  ];
  const receipts = new Map<string, string>();
  const attempts: string[] = [];
  const open = async ({ group, key }: { group: string; key: string }) => {
    attempts.push(key);
    receipts.set(key, group);
  };
  await openLocalShowcase(routes, open);
  await openLocalShowcase(routes, open);
  expect([...receipts.values()]).toEqual(['search', 'search_advanced', 'subjects']);
  expect(attempts.slice(3)).toEqual(attempts.slice(0, 3));
});

test('a failed native opening stops persona setup and names the group, cause and retry', async () => {
  const attempted: string[] = [];
  await expect(
    openLocalShowcase([], async ({ group }) => {
      attempted.push(group);
      throw new Error('Exposure command denied');
    }),
  ).rejects.toThrow(
    'Local showcase opening search failed: Exposure command denied. ' +
      'Resolve the native command failure, then rerun task dev:persona (or task seed:dev).',
  );
  expect(attempted).toEqual(['search']);
});

test('generated Web bindings preserve literal JWK JSON through the actual Vite dotenv loader', async () => {
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../.temp/web-bindings-'));
  try {
    const key = { kty: 'EC', crv: 'P-256', kid: 'fixture', d: 'fixture' };
    await writeFile(resolve(directory, '.env'), developmentBindings({ WEBSITE_CLIENT_KEY: JSON.stringify(key) }));
    const require = createRequire(resolve(import.meta.dir, '../../../apps/web/package.json'));
    const { loadEnv } = await import(require.resolve('vite'));
    const bindings = loadEnv('development', directory, 'WEBSITE_');
    expect(JSON.parse(bindings.WEBSITE_CLIENT_KEY!)).toEqual(key);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
