import { expect, test } from 'bun:test';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { developmentEnv } from '../../kernel/scripts/database.ts';
import { withThrowawayDatabase } from '../../kernel/scripts/derived.ts';
import {
  developmentWebsiteBindings,
  developmentFrontendProcess,
  type developmentWebsiteConfiguration,
  type DevelopmentKeys,
  developmentMediaBindings,
  origins,
  outputMarker,
  startDevelopmentServices,
  importerScopes,
  readLocalDeveloperAccountId,
  reusableCompletedExpiredPersonaId,
  root,
  reconcilePageDataDefinitions,
  pageDataDefinitionsEnvironment,
} from './dev-stack.ts';
import { StackFixtureLifetime } from './dev-stack-lifetime.ts';
import { websiteRequestedScopes } from '../../../apps/web/src/session/website-scopes.ts';

test('Worker readiness survives split writes and a coalesced trailing log chunk', () => {
  const receive = outputMarker('Worker ready');
  expect(receive('earlier log\nWor')).toBe(false);
  expect(receive('ker ready\n' + 'next log\n'.repeat(1000))).toBe(true);
  expect(receive('')).toBe(true);
});

test('cold Web starts before native readiness while every dependency gate still precedes final readiness', async () => {
  const events: string[] = [];
  let releaseIdentity!: () => void;
  const identityReady = new Promise<void>((resolve) => {
    releaseIdentity = resolve;
  });
  const started = startDevelopmentServices('complete', {
    launch(service) {
      events.push(`launch:${service}`);
      return service;
    },
    async ready(service, children) {
      expect(children[0]).toBe(service);
      expect(children).toContain('identity');
      expect(children).toContain('web');
      if (service === 'identity') await identityReady;
      events.push(`ready:${service}`);
    },
    stopping: () => false,
  });
  expect(events).toEqual(['launch:identity', 'launch:web']);
  releaseIdentity();
  await started;
  expect(events).toEqual([
    'launch:identity',
    'launch:web',
    'ready:identity',
    'launch:kernel',
    'ready:kernel',
    'launch:worker',
    'ready:worker',
    'launch:pages',
    'ready:pages',
    'ready:web',
  ]);
});

test('deferred walks omit Web and cancellation prevents further native launches', async () => {
  for (const mode of ['walk', 'native'] as const) {
    const launched: string[] = [];
    await startDevelopmentServices(mode, {
      launch(service) {
        launched.push(service);
        return service;
      },
      async ready() {},
      stopping: () => false,
    });
    expect(launched).toEqual(mode === 'walk' ? ['identity', 'pages', 'kernel', 'worker'] : ['identity']);
  }
  const launched: string[] = [];
  await expect(
    startDevelopmentServices('complete', {
      launch(service) {
        launched.push(service);
        return service;
      },
      async ready() {
        throw new Error('native boot failed');
      },
      stopping: () => false,
    }),
  ).rejects.toThrow('native boot failed');
  expect(launched).toEqual(['identity', 'web']);
  launched.length = 0;
  await startDevelopmentServices('complete', {
    launch(service) {
      launched.push(service);
      return service;
    },
    async ready() {},
    stopping: () => true,
  });
  expect(launched).toEqual(['identity', 'web']);
});

test('the local importer can request subject merging required by showcase seeding', () => {
  expect(importerScopes).toContain('subject:merge');
});

test('only a matching completed and expired local developer registration can be reused', () => {
  const accountId = '00000000-0000-7000-8000-000000000099';
  const now = Date.parse('2026-11-09T00:00:00.000Z');
  const expired = {
    account_id: accountId,
    handle: 'developer',
    completed_at: new Date(now - 60_000),
    expired_at: null,
    expires_at: new Date(now - 1),
  };
  expect(reusableCompletedExpiredPersonaId(expired, accountId, now)).toBe(accountId);
  expect(reusableCompletedExpiredPersonaId(expired, '00000000-0000-7000-8000-000000000098', now)).toBeUndefined();
  expect(reusableCompletedExpiredPersonaId({ ...expired, handle: 'other' }, accountId, now)).toBeUndefined();
  expect(reusableCompletedExpiredPersonaId({ ...expired, completed_at: null }, accountId, now)).toBeUndefined();
  expect(
    reusableCompletedExpiredPersonaId({ ...expired, expires_at: new Date(now + 1) }, accountId, now),
  ).toBeUndefined();
});

test('the local persona account comes from the persisted seed file without runtime account injection', async () => {
  const temporaryRoot = join(root, '.temp');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'local-persona-seed-'));
  const accountId = '00000000-0000-7000-8000-000000000099';
  try {
    writeFileSync(join(directory, 'seed.env'), `REZICS_DEV_PERSONA_ACCOUNT=${accountId}\n`, { mode: 0o600 });
    expect(await readLocalDeveloperAccountId(directory)).toBe(accountId);
    expect(await readLocalDeveloperAccountId(join(directory, 'missing'))).toBeUndefined();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('local setup and launch carry the complete real mounted host scope composition', async () => {
  const website = await withThrowawayDatabase(
    async ({ DATABASE_URL }) => {
      const env = Object.fromEntries(
        developmentEnv('', DATABASE_URL!)
          .trim()
          .split('\n')
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      // A cold process must register Reylo itself and use the supplied database,
      // even when its ambient URL points at an unavailable, unrelated database.
      const lifetime = new StackFixtureLifetime(270_000);
      try {
        const child = lifetime.start(
          'supplied-catalogue',
          [
            process.execPath,
            '--eval',
            `
          import assert from 'node:assert/strict';
          const original = process.env.DATABASE_URL;
          const { Elysia } = await import(Bun.resolveSync('elysia', process.cwd() + '/services/kernel'));
          const compile = Elysia.prototype.compile;
          let compiled = 0;
          Elysia.prototype.compile = function(...args) { compiled++; return compile.apply(this, args); };
          const { developmentWebsiteConfiguration } = await import('./services/auth/scripts/dev-stack.ts');
          const website = await developmentWebsiteConfiguration(JSON.parse(process.env.SUPPLIED_KERNEL_ENV));
          assert.equal(process.env.DATABASE_URL, original);
          const repeated = await developmentWebsiteConfiguration(JSON.parse(process.env.SUPPLIED_KERNEL_ENV));
          assert.deepEqual(repeated, website);
          assert.equal(process.env.DATABASE_URL, original);
          assert.equal(compiled, 0, 'catalogue composition must not compile HTTP handlers');
          console.log(JSON.stringify(website));
        `,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              DATABASE_URL: 'postgres://127.0.0.1:1/foreign',
              REYLO_CONFIG: undefined,
              SUPPLIED_KERNEL_ENV: JSON.stringify(env),
            },
          },
        );
        const code = await child.child.exited;
        await lifetime.stop(child);
        const { stdout, stderr } = await child.output;
        lifetime.signal.throwIfAborted();
        if (code !== 0) throw new Error(stderr);
        expect(stderr).toContain('stack: native-registration starting');
        expect(stderr).toContain('stack: native-imports ready');
        expect(stderr).not.toContain(env.DATABASE_URL!);
        expect(stderr).toMatch(/catalogue-native-mount ready utc=\S+ elapsedMs=\d+/);
        expect(stderr).toMatch(/catalogue-pool-settlement ready utc=\S+ elapsedMs=\d+/);
        return JSON.parse(stdout) as Awaited<ReturnType<typeof developmentWebsiteConfiguration>>;
      } finally {
        await lifetime.close();
      }
    },
    { analysis: false },
  );
  const bindings = developmentWebsiteBindings({ website: {} } as DevelopmentKeys, website);
  expect(bindings.WEBSITE_SCOPES).toBe(website.scopes.join(' '));
  for (const action of ['pages', 'web'] as const) {
    const launch = developmentFrontendProcess(action, ['--clearScreen', 'false'], {
      environment: { REZICS_TEST_RUNTIME: '1' },
      kernelEnvironment: {},
      website,
      keys: { website: {} } as DevelopmentKeys,
    });
    expect(launch.command).toEqual([
      'bun',
      'run',
      '--cwd',
      action === 'pages' ? 'apps/auth' : 'apps/web',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      new URL(action === 'pages' ? origins.issuer : origins.web).port,
      '--strictPort',
      '--clearScreen',
      'false',
    ]);
    expect(launch.environment.WEBSITE_SCOPES).toBe(bindings.WEBSITE_SCOPES);
    expect(launch.environment.AUTH_ORIGIN).toBe(origins.native);
    if (action === 'pages')
      expect(launch.environment.AUTH_SECURITY_SCOPE_CONFIGURATION).toBe(website.AUTH_SECURITY_SCOPE_CONFIGURATION);
    else expect(launch.environment.REZICS_TEST_RUNTIME).toBeUndefined();
  }

  expect(websiteRequestedScopes(bindings.WEBSITE_SCOPES)).toBe(bindings.WEBSITE_SCOPES);
  expect(website.scopes).toEqual(
    expect.arrayContaining([
      'feed_item:list',
      'library_entry:list',
      'library_entry:read',
      'library_entry:update',
      'library_pin:list',
      'progress_session:list',
      'progress_session:create',
      'progress_session:update',
      'rating:vote',
      'follow:list',
      'recent_search:read',
      'offer:list',
      'offer:create',
      'commerce_sale:list',
      'collection:read',
      'collection:create',
      'collection:update',
      'media:complete',
      'post:create',
      'presentation:publish',
      'presentation:activate',
      'order:reconcile',
      'organization:create',
      'account:manage',
      'account:delete',
    ]),
  );
  expect(website.scopes).not.toContain('*');
  expect(website.scopes).not.toContain('gate:any');
}, 300_000);

test('only explicit local storage receives a stable private native object binding', () => {
  const keys = { secret: 'development-media-binding-test-secret' };
  expect(developmentMediaBindings({}, keys)).toEqual({});
  const binding = developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, keys);
  expect(binding.LOCAL_MEDIA_ORIGIN).toBe(origins.native);
  expect(binding.LOCAL_MEDIA_TOKEN).toMatch(/^[a-f0-9]{64}$/);
  expect(developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, keys)).toEqual(
    binding,
  );
  expect(
    developmentMediaBindings({ CONTENT_LOCAL_MEDIA_ROOT: '.temp/local-stack/content-media' }, { secret: 'rotated' })
      .LOCAL_MEDIA_TOKEN,
  ).not.toBe(binding.LOCAL_MEDIA_TOKEN);
});

test('the native Semantic walk client has explicit journey scopes and leaves importer registration narrow', async () => {
  const { semanticWalkClientRegistration, importerScopes, localClientIds } = await import('./dev-stack.ts');
  const client = semanticWalkClientRegistration();
  expect(client.clientId).toBe(localClientIds.semanticWalk);
  expect(client.firstParty).toBe(true);
  expect(client.scopes).toEqual(
    expect.arrayContaining([
      'context:create',
      'context:accept',
      'context:adopt',
      'statement:delete',
      'statement:restore',
      'zone:create',
      'zone:configure',
      'zone:publish',
      'zone:delete',
      'zone:restore',
      'moderation:takedown',
    ]),
  );
  expect(new Set(client.scopes).size).toBe(client.scopes.length);
  expect(client.scopes).not.toContain('*');
  expect(client.scopes).not.toContain('gate:any');
  expect(importerScopes).not.toContain('zone:configure');
});

test('page-data Definitions mismatch stops seed, reconciles the exact head, then becomes a read-only no-op', async () => {
  const before = { digest: `sha256:${'d'.repeat(64)}`, head: 1 };
  let active = before;
  const requests: Request[] = [];
  let credentials = 0;
  const options = {
    activate: false,
    bearer: async () => {
      credentials++;
      return 'operator';
    },
    async handle(request: Request) {
      requests.push(request);
      if (request.method === 'GET') return Response.json(active);
      expect(request.headers.get('authorization')).toBe('Bearer operator');
      if (request.url.endsWith(':activate')) {
        expect(await request.json()).toEqual({ expected_head: before.head });
        active = { digest: bundledDigest, head: before.head + 1 };
        return Response.json(active);
      }
      expect(await request.json()).toEqual({ release: bundledRelease });
      return Response.json({ digest: bundledDigest }, { status: 201 });
    },
  };
  await expect(reconcilePageDataDefinitions(options)).rejects.toThrow('reconcile-definitions before resuming seed');
  expect(credentials).toBe(0);
  expect(requests.map((r) => r.method)).toEqual(['GET']);
  requests.length = 0;
  expect(await reconcilePageDataDefinitions({ ...options, activate: true })).toEqual({
    digest: bundledDigest,
    head: 2,
  });
  expect(requests.map((r) => r.method)).toEqual(['GET', 'POST', 'POST', 'GET']);
  requests.length = 0;
  expect(await reconcilePageDataDefinitions({ ...options, activate: true })).toEqual(active);
  expect(credentials).toBe(1);
  expect(requests.map((r) => r.method)).toEqual(['GET']);
});

test('page-data Definitions leaves a concurrent activation conflict to the native owner', async () => {
  let calls = 0;
  await expect(
    reconcilePageDataDefinitions({
      activate: true,
      bearer: async () => 'operator',
      async handle() {
        calls++;
        return calls === 1
          ? Response.json({ digest: 'old', head: 3 })
          : calls === 2
            ? Response.json({ digest: bundledDigest })
            : new Response(null, { status: 409 });
      },
    }),
  ).rejects.toThrow('HTTP 409');
  expect(calls).toBe(3);
});

test('page-data Definitions rejects production, ordinary local stacks and a different database port', () => {
  const env = {
    NODE_ENV: 'development',
    KERNEL_DATABASE_CONTAINER: 'rezics-pagecheck-0123456789',
    REZICS_PAGE_DATA_STACK: 'rezics-pagecheck-0123456789',
    KERNEL_DATABASE_PORT: '5433',
  };
  const url = 'postgres://127.0.0.1:5433/rezics';
  expect(() => pageDataDefinitionsEnvironment(env, url)).not.toThrow();
  for (const change of [{ NODE_ENV: 'production' }, { REZICS_PAGE_DATA_STACK: '' }, { KERNEL_DATABASE_PORT: '5434' }])
    expect(() => pageDataDefinitionsEnvironment({ ...env, ...change }, url)).toThrow('dedicated development');
});
