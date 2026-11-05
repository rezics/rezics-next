import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  developmentKeys,
  developmentBindings,
  developmentRegistrationPassword,
  developmentContentBindings,
  issuerRequest,
  localDatabase,
  openLocalShowcase,
  publicKey,
  privateFile,
  retireDevelopmentSeedState,
  resetLocalContentMedia,
  developmentPersonaScopes,
  importerScopes,
} from '../scripts/dev-stack.ts';
import { developmentEnv } from '../../kernel/scripts/database.ts';
import { rateLimitBudgets } from '../../kernel/src/access/write-rate-budgets.ts';
import { readPoolAcquireTimeoutMillis } from '../../kernel/src/database/pool.ts';

test('persona creator capabilities are registered separately from ordinary importer scopes', () => {
  const creator = ['collection:create', 'collection:read', 'collection:update'];
  expect(developmentPersonaScopes).toEqual(expect.arrayContaining(creator));
  expect(importerScopes.some((scope) => creator.includes(scope))).toBe(false);
});

test('a fresh local database gets a new search namespace while ordinary setup preserves it', () => {
  const prefix = (env: string) => env.split('\n').find((line) => line.startsWith('KERNEL_SEARCH_PREFIX='));
  const url = 'postgres://127.0.0.1/rezics';
  const existing = 'KERNEL_SEARCH_PREFIX=doctor-old-\n';
  const reset = developmentEnv(existing, url, true);
  expect(prefix(reset)).toMatch(/^KERNEL_SEARCH_PREFIX=local-[a-f0-9]{24}-$/);
  expect(prefix(reset)).not.toBe(prefix(existing));
  expect(prefix(developmentEnv(reset, url))).toBe(prefix(reset));
  expect(prefix(developmentEnv(reset, url, true))).not.toBe(prefix(reset));
  expect(prefix(developmentEnv('', url))).toMatch(/^KERNEL_SEARCH_PREFIX=local-[a-f0-9]{24}-$/);
});

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

test('local content setup selects exact Bangumi media hosts and preserves complete R2 configuration', () => {
  const repository = '/tmp/rezics-local-content';
  expect(developmentContentBindings({}, repository)).toEqual({
    CONTENT_SOURCE_HOSTS: 'lain.bgm.tv',
    NODE_ENV: 'development',
    CONTENT_LOCAL_MEDIA_ROOT: resolve(repository, '.temp/local-stack/content-media'),
  });
  expect(
    developmentContentBindings({ CONTENT_SOURCE_HOSTS: 'covers.example.test' }, repository).CONTENT_SOURCE_HOSTS,
  ).toBe('covers.example.test,lain.bgm.tv');
  const r2 = {
    CONTENT_R2_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    CONTENT_R2_BUCKET: 'content-media',
    CONTENT_R2_ACCESS_KEY_ID: 'private-access',
    CONTENT_R2_SECRET_ACCESS_KEY: 'private-secret',
    CONTENT_SOURCE_HOSTS: 'lain.bgm.tv,operator.example.test',
  };
  expect(developmentContentBindings(r2, repository)).toEqual({
    CONTENT_SOURCE_HOSTS: r2.CONTENT_SOURCE_HOSTS,
  });
  expect(() => developmentContentBindings({ CONTENT_R2_BUCKET: 'content-media' }, repository)).toThrow(
    'CONTENT_R2_ENDPOINT',
  );
  expect(() => developmentContentBindings({ NODE_ENV: 'production' }, repository)).toThrow('NODE_ENV');
});

test('local content reset removes only its configured media root', async () => {
  const repository = await mkdtemp(resolve(import.meta.dir, '../../../.temp/reset-local-media-'));
  const stack = resolve(repository, '.temp/local-stack');
  const media = resolve(stack, 'content-media');
  try {
    await mkdir(media, { recursive: true });
    await writeFile(resolve(media, 'owned-object'), 'local media');
    await writeFile(resolve(stack, 'keys.json'), 'retained keys');
    await resetLocalContentMedia(repository, {
      NODE_ENV: 'development',
      CONTENT_LOCAL_MEDIA_ROOT: media,
    });
    expect(await readFile(resolve(stack, 'keys.json'), 'utf8')).toBe('retained keys');
    expect(await readdir(stack)).toEqual(['keys.json']);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
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
  expect([...receipts.values()]).toEqual(['search', 'search_advanced', 'personal_library', 'subjects']);
  expect(attempts.slice(4)).toEqual(attempts.slice(0, 4));
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

test('repeated setup leaves identical private configuration untouched for live dev watchers', async () => {
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../.temp/stable-config-'));
  const file = resolve(directory, '.dev.vars');
  try {
    await privateFile(file, 'LOCAL=value');
    await utimes(file, new Date('2000-01-01'), new Date('2000-01-01'));
    const before = (await stat(file)).mtimeMs;
    await privateFile(file, 'LOCAL=value');
    expect((await stat(file)).mtimeMs).toBe(before);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await privateFile(file, 'LOCAL=updated');
    expect(await readFile(file, 'utf8')).toBe('LOCAL=updated');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parallel local startup has a configured connection allowance while the ordinary default stays strict', () => {
  const generated = developmentEnv('', 'postgres://127.0.0.1/rezics');
  const env = Object.fromEntries(
    generated
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  expect(readPoolAcquireTimeoutMillis(env)).toBe(10000);
  expect(readPoolAcquireTimeoutMillis({})).toBe(200);
  expect(developmentEnv('KERNEL_POOL_ACQUIRE_TIMEOUT_MS=500\n', 'postgres://127.0.0.1/rezics')).toContain(
    'KERNEL_POOL_ACQUIRE_TIMEOUT_MS=500\n',
  );
});

test('an authorized password rotation retains the original registration input', async () => {
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../.temp/rotated-registration-'));
  try {
    const keys = await developmentKeys(directory);
    expect(
      developmentRegistrationPassword({ ...keys, password: 'current-fixture', bootstrapPassword: 'original-fixture' }),
    ).toBe('original-fixture');
    expect(developmentRegistrationPassword({ ...keys, password: 'current-fixture' })).toBe('current-fixture');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
