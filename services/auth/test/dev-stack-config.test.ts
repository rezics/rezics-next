import { expect, test } from 'bun:test';
// The full scope composition imports Kernel SQL, so run its existing assertions in the native database lane.
import '../scripts/dev-stack.test.ts';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  developmentKeys,
  authSecurityScopeConfiguration,
  developmentAuthPageBindings,
  developmentWebsiteScopeConfiguration,
  developmentWebsiteBindings,
  developmentJwksFetch,
  developmentKernelBindings,
  issuerPublicJwksUrl,
  retireStaleSeedJournals,
  root,
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
  localShowcaseClientRegistration,
  importerScopes,
  stackProcessCommands,
  walkSetupScripts,
} from '../scripts/dev-stack.ts';
import { localJwksTransport, readMembershipWorkConfig } from '../../kernel/src/access/membership-work-config.ts';
import { developmentEnv } from '../../kernel/scripts/database.ts';
import { rateLimitBudgets } from '../../kernel/src/access/write-rate-budgets.ts';
import { readPoolAcquireTimeoutMillis } from '../../kernel/src/database/pool.ts';

test('walk host Kernel Access authenticates a seeded persona against issuer JWKS', async () => {
  const source = await readFile(resolve(import.meta.dir, '../scripts/dev-stack.ts'), 'utf8');
  expect(source).toContain('jwksUrl = issuerPublicJwksUrl(origins.issuer)');
  expect(source).toContain('access: (mounted) => createAccess({ ...mounted, auth: kernelAuth })');
  expect(source).toContain('const actor = await access.authenticate(bearer, context)');
  expect(source).toContain("if (actor.kind !== 'account') throw new Error('Local persona is not an account')");
});

test('seeded frontends wait for useful /en HTML through waitUntilWalkReady', async () => {
  const source = await readFile(resolve(import.meta.dir, '../scripts/dev-stack.ts'), 'utf8');
  expect(source).toContain('SEEDED_WEB_READY_PATH');
  expect(source).toContain('waitUntilWalkReady');
  expect(source).not.toContain("code: 'ECONNREFUSED'");
  expect(source).toContain('${origins.web}${SEEDED_WEB_READY_PATH}');
});

test('isolated Kernel bindings verify the selected Auth issuer and bind the selected API port', () => {
  expect(
    developmentKernelBindings({
      issuer: 'http://127.0.0.1:20021',
      audience: 'https://api.rezics.test',
      kernel: 'http://127.0.0.1:20023',
      native: 'http://127.0.0.1:20022',
    }),
  ).toEqual({
    AUTH_ISSUER: 'http://127.0.0.1:20021',
    AUTH_AUDIENCE: 'https://api.rezics.test',
    AUTH_JWKS_URL: 'http://127.0.0.1:20021/.well-known/jwks.json',
    REZICS_LOCAL_STACK_NATIVE_ORIGIN: 'http://127.0.0.1:20022',
    KERNEL_HOSTNAME: '127.0.0.1',
    KERNEL_PORT: '20023',
  });
});

test('every walk-stack process names AUTH_JWKS_URL on the issuer origin that signs tokens', () => {
  const walk = developmentKernelBindings({
    issuer: 'http://127.0.0.1:20011',
    audience: 'https://api.rezics.test',
    kernel: 'http://127.0.0.1:20013',
    native: 'http://127.0.0.1:20012',
  });
  expect(new URL(walk.AUTH_JWKS_URL).origin).toBe(new URL(walk.AUTH_ISSUER).origin);
  expect(walk.AUTH_JWKS_URL).toBe(issuerPublicJwksUrl(walk.AUTH_ISSUER));
  expect(walk.AUTH_JWKS_URL).not.toContain(':20012');
  const keys = {
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
  };
  const config = readMembershipWorkConfig({ ...keys, ...walk });
  expect(config.auth.issuer).toBe(walk.AUTH_ISSUER);
  expect(config.auth.jwksUrl).toBe(walk.AUTH_JWKS_URL);
  expect(config.auth.fetch).toBeTypeOf('function');
  expect(() =>
    readMembershipWorkConfig({
      ...keys,
      AUTH_ISSUER: walk.AUTH_ISSUER,
      AUTH_AUDIENCE: walk.AUTH_AUDIENCE,
      AUTH_JWKS_URL: 'http://127.0.0.1:20012/.well-known/jwks.json',
      REZICS_LOCAL_STACK_NATIVE_ORIGIN: walk.REZICS_LOCAL_STACK_NATIVE_ORIGIN,
    }),
  ).toThrow('AUTH_JWKS_URL');
});

test('isolated stacks keep issuer, JWKS and audience consistent with each other', () => {
  const first = developmentKernelBindings({
    issuer: 'http://127.0.0.1:20021',
    audience: 'https://api.rezics.test',
    kernel: 'http://127.0.0.1:20023',
    native: 'http://127.0.0.1:20022',
  });
  const second = developmentKernelBindings({
    issuer: 'http://127.0.0.1:20031',
    audience: 'https://api.rezics.test',
    kernel: 'http://127.0.0.1:20033',
    native: 'http://127.0.0.1:20032',
  });
  const keys = {
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
  };
  for (const bindings of [first, second]) {
    expect(new URL(bindings.AUTH_JWKS_URL).origin).toBe(new URL(bindings.AUTH_ISSUER).origin);
    expect(bindings.AUTH_AUDIENCE).toBe('https://api.rezics.test');
    expect(bindings.REZICS_LOCAL_STACK_NATIVE_ORIGIN).not.toBe(bindings.AUTH_ISSUER);
    const config = readMembershipWorkConfig({ ...keys, ...bindings });
    expect(config.auth.issuer).toBe(bindings.AUTH_ISSUER);
    expect(config.auth.jwksUrl).toBe(bindings.AUTH_JWKS_URL);
    expect(config.auth.fetch).toBeTypeOf('function');
  }
  expect(first.AUTH_ISSUER).not.toBe(second.AUTH_ISSUER);
  expect(first.AUTH_JWKS_URL).not.toBe(second.AUTH_JWKS_URL);
  expect(first.REZICS_LOCAL_STACK_NATIVE_ORIGIN).not.toBe(second.REZICS_LOCAL_STACK_NATIVE_ORIGIN);
});

test('local JWKS transport fetches only the issuer JWKS URL from native Auth', async () => {
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== '/.well-known/jwks.json') return new Response('not jwks', { status: 404 });
      return Response.json({ keys: [{ kty: 'EC', kid: 'walk' }] });
    },
  });
  try {
    const issuer = 'http://127.0.0.1:20011';
    const nativeOrigin = `http://127.0.0.1:${native.port}`;
    const jwksUrl = issuerPublicJwksUrl(issuer);
    const fetch = developmentJwksFetch(jwksUrl, nativeOrigin);
    const jwksGet = {
      headers: new Headers(),
      method: 'GET' as const,
      redirect: 'manual' as const,
      signal: new AbortController().signal,
    };
    const response = await fetch(jwksUrl, jwksGet);
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ keys: [{ kty: 'EC', kid: 'walk' }] });
    await expect(fetch(`${issuer}/signin`, jwksGet)).rejects.toThrow('only the configured issuer JWKS URL');
    expect(
      localJwksTransport({}, { issuer, audience: 'https://api.rezics.test', jwksUrl: 'https://other.test/jwks' }).fetch,
    ).toBeUndefined();
  } finally {
    await native.stop(true);
  }
});

test('Auth page scope configuration carries trusted siteActions and records native fallback explicitly', () => {
  const letters = (index: number) => {
    let value = '';
    do {
      value = String.fromCharCode(97 + (index % 26)) + value;
      index = Math.floor(index / 26) - 1;
    } while (index >= 0);
    return value;
  };
  const siteActions = new Map<string, { anonymous: boolean }>([
    ...Array.from({ length: 1200 }, (_, index) => [`action_${letters(index)}:read`, { anonymous: true }] as const),
    ['openid', { anonymous: true }] as const,
    ['offline_access', { anonymous: true }] as const,
    ['media:complete', { anonymous: true }] as const,
  ]);
  const configuration = authSecurityScopeConfiguration([...siteActions.keys(), 'openid', 'action_a:read']);
  expect(configuration).toBe('catalogue:1203');
  expect(authSecurityScopeConfiguration(undefined)).toBe('native-no-catalogue');
  expect(developmentAuthPageBindings({ AUTH_SECURITY_SCOPE_CONFIGURATION: configuration })).toEqual({
    AUTH_SECURITY_SCOPE_CONFIGURATION: configuration,
  });
});

test('persona creator capabilities are registered separately from ordinary importer scopes', () => {
  const creator = ['collection:create', 'collection:read', 'collection:update', 'library_entry:update'];
  expect(localShowcaseClientRegistration().scopes).toEqual(expect.arrayContaining(creator));
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

test('seed journals that name another database are archived before the current identity is written', async () => {
  const repository = await mkdtemp(resolve(import.meta.dir, '../../../.temp/stale-seed-'));
  try {
    await mkdir(resolve(repository, '.temp/cross-media-seed'), { recursive: true });
    await writeFile(resolve(repository, '.temp/cross-media-seed/database-identity'), '127.0.0.1:54329/rezics\n');
    await writeFile(resolve(repository, '.temp/cross-media-seed/showcase.sqlite'), 'other-db');
    const archived = await retireStaleSeedJournals(repository, 'postgres://rezics:rezics@127.0.0.1:20024/rezics');
    expect(archived).toBeDefined();
    expect(await readFile(resolve(archived!, 'showcase.sqlite'), 'utf8')).toBe('other-db');
    expect(await readFile(resolve(repository, '.temp/cross-media-seed/database-identity'), 'utf8')).toBe(
      '127.0.0.1:20024/rezics\n',
    );
    expect(
      await retireStaleSeedJournals(repository, 'postgres://rezics:rezics@127.0.0.1:20024/rezics'),
    ).toBeUndefined();
  } finally {
    await rm(repository, { recursive: true, force: true });
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

test('generated Web bindings preserve literal JWK JSON and the selected deployment scope artifact', async () => {
  const directory = await mkdtemp(resolve(import.meta.dir, '../../../.temp/web-bindings-'));
  try {
    const key = { kty: 'EC', crv: 'P-256', kid: 'fixture', d: 'fixture' };
    await writeFile(resolve(directory, '.env'), developmentBindings({ WEBSITE_CLIENT_KEY: JSON.stringify(key) }));
    const require = createRequire(resolve(import.meta.dir, '../../../apps/web/package.json'));
    const { loadEnv } = await import(require.resolve('vite'));
    const bindings = loadEnv('development', directory, 'WEBSITE_');
    expect(JSON.parse(bindings.WEBSITE_CLIENT_KEY!)).toEqual(key);
    const file = resolve(directory, 'website.json');
    const WEBSITE_SCOPES = 'openid offline_access exposure:manage_read';
    await writeFile(file, JSON.stringify({ WEBSITE_SCOPES }));
    const mounted = { scopes: ['openid', 'offline_access', 'exposure:open'], WEBSITE_SCOPES: 'mounted' };
    expect(developmentWebsiteScopeConfiguration(mounted, {})).toBe(mounted);
    const selected = developmentWebsiteScopeConfiguration(mounted, {
      WEBSITE_CONFIGURATION_FILE: relative(root, file),
    });
    expect(selected).toEqual({
      scopes: WEBSITE_SCOPES.split(' '),
      WEBSITE_SCOPES,
      WEBSITE_CONFIGURATION_FILE: file,
    });
    expect(developmentWebsiteBindings({ website: key }, selected).WEBSITE_CONFIGURATION_FILE).toBe(file);
    const routes = JSON.stringify([
      '/account/rename',
      '/organizations/members',
      '/operators/transfer',
      '/organizations/delete',
    ]);
    expect(developmentWebsiteBindings({ website: key }, selected, {}).AUTH_MANAGEMENT_PAGE_ROUTES).toBe(routes);
    expect(
      developmentWebsiteBindings({ website: key }, selected, { AUTH_MANAGEMENT_PAGE_ROUTES: '[]' })
        .AUTH_MANAGEMENT_PAGE_ROUTES,
    ).toBe('[]');
    expect(await readFile(file, 'utf8')).toBe(JSON.stringify({ WEBSITE_SCOPES }));
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

test('walk stacks start Kernel without a watcher and can omit Vite until mounted pages', () => {
  expect(stackProcessCommands({}).some((command) => command.includes('dev'))).toBe(true);
  expect(stackProcessCommands({ REZICS_WALK_STACK_SLOT: '1' }).some((command) => command.at(-1) === 'start')).toBe(
    true,
  );
  const deferred = stackProcessCommands({ REZICS_WALK_STACK_SLOT: '1', REZICS_WALK_DEFER_FRONTENDS: '1' });
  expect(deferred).toEqual([['bun', 'services/auth/scripts/dev-stack.ts', 'host']]);
  expect(walkSetupScripts({ REZICS_WALK_DEFER_FRONTENDS: '1' })).toEqual([
    ['services/kernel/scripts/database.ts', 'up'],
    ['services/auth/scripts/dev-stack.ts', 'setup'],
  ]);
  expect(walkSetupScripts({})).toEqual([
    ['services/kernel/scripts/database.ts', 'up'],
    ['services/kernel/scripts/search.ts', 'up'],
    ['services/auth/scripts/dev-stack.ts', 'setup'],
  ]);
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

test('installed host receives management operations and independent reads from its native account binding', async () => {
  const source = await readFile(resolve(import.meta.dir, '../scripts/dev-stack.ts'), 'utf8');
  const assembly = source.slice(
    source.indexOf('export async function assemble('),
    source.indexOf('export async function provisionPersona('),
  );
  expect(assembly).toContain('accountOperations: bindings.accountOperations');
  expect(assembly).toContain('accountManagementReads: bindings.accountManagementReads');
  expect(assembly).toContain('workflow: proofs');
  expect(assembly).toContain('referenceKeys: config.tokens');
  expect(assembly).toContain('await host.stop()');
  expect(assembly).toContain('await kernelPool.end()');
});
