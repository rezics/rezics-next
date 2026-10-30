import { expect, mock, spyOn, test } from 'bun:test';
import pg from 'pg';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { ConfigError } from '../../src/commerce/config.ts';
import { receiptKeysFor } from '../../src/command/receipt-key.ts';
import { mountedContentEditionConsent } from '../../src/content/edition-sale-consent.ts';
import { createContentWorkAccess, registerContent } from '../../src/content/register.ts';
import * as relays from '../../src/content/relays.ts';
import * as work from '../../src/content/work.ts';
import { createWorkerAuthorization, type WorkerAuthorization } from '../../src/work/authorization.ts';
import type { WorkClient } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import type { WorkContext } from '../../src/work/registry.ts';

/** Capture only the registration boundary; the authorization port mounts the real kernel. */
function composition(extraEnv: Readonly<Record<string, string>> = {}) {
  const pool = new pg.Pool();
  const forbidden = mock((): never => {
    throw new Error('Content authorization composition must not perform I/O or start services');
  });
  const connect = spyOn(pool, 'connect').mockImplementation(forbidden);
  const query = spyOn(pool, 'query').mockImplementation(forbidden);
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => forbidden(), { preconnect: globalThis.fetch.preconnect }),
  );
  const register = mock(async () => {});
  const factory = spyOn(work, 'createContentWork').mockImplementation(() => ({ name: 'content', register }));
  const notices = spyOn(relays, 'contentNoticeEffects');
  const info = spyOn(console, 'info').mockImplementation(() => {});
  const receiptKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) };
  const env = {
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
    AUTH_ISSUER: 'https://worker-auth.test',
    AUTH_AUDIENCE: 'https://worker-api.test',
    AUTH_JWKS_URL: 'https://worker-auth.test/jwks',
    ...extraEnv,
  };
  const client = new Proxy({} as WorkClient, { get: forbidden });
  const clock = () => new Date('2030-01-02T03:04:05Z');
  let authorization: WorkerAuthorization | undefined;
  const getAuthorization = mock(
    () => (authorization ??= createWorkerAuthorization({ pool, client, env, clock, receiptKeys })),
  );
  const context: WorkContext = {
    pool,
    client,
    env,
    clock,
    queues: WORK_QUEUES,
    getAuthorization,
    addEffects: mock(() => {}),
    addService: forbidden,
  };
  return {
    context,
    factory,
    notices,
    register,
    fetch,
    receiptKeys,
    async close() {
      factory.mockRestore();
      notices.mockRestore();
      info.mockRestore();
      fetch.mockRestore();
      connect.mockRestore();
      query.mockRestore();
      await pool.end();
      expect(forbidden).not.toHaveBeenCalled();
    },
  };
}

test('default Content work and notice disclosure receive the actual fully mounted worker Access', async () => {
  const f = composition();
  try {
    expect(f.context.getAuthorization).not.toHaveBeenCalled();
    await registerContent.register(f.context);
    expect(f.context.getAuthorization).toHaveBeenCalledTimes(1);
    const authorization = f.context.getAuthorization();
    const options = f.factory.mock.calls[0]![0];
    expect(options.access).toBe(authorization.access);
    expect(options.readConsent).toBe(authorization.readConsent);
    expect(f.notices).toHaveBeenCalledWith(f.context.pool, authorization.access);
    expect(f.register).toHaveBeenCalledWith(f.context);
    expect(mountedContentEditionConsent(f.context.pool)).toBe(options.readConsent);
    expect(receiptKeysFor(f.context.pool)).toEqual(f.receiptKeys);
    const catalogue = resourceRoleCatalogue(options.access)!;
    expect(catalogue.types.get('content.post')?.owner).toBe('content.post.owner');
    expect(catalogue.declaredTypes?.get('thread:create')).toContain('content.thread');
    expect(catalogue.roles.get('content.edition.owner')).toContain('edition:sell');
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

test('default Content restores through the same canonical reader and observes current Auth consent', async () => {
  const f = composition({
    KERNEL_AUTH_CONSENT_URL: 'https://consent.test/internal/v1/consents:read',
    CF_ACCESS_CLIENT_ID: 'worker-service',
    CF_ACCESS_CLIENT_SECRET: 'worker-secret',
  });
  try {
    await registerContent.register(f.context);
    const options = f.factory.mock.calls[0]![0];
    let scopes = ['post:erase'];
    f.fetch.mockImplementation(
      Object.assign(
        async (target: RequestInfo | URL, init?: RequestInit) => {
          expect(String(target)).toBe(f.context.env.KERNEL_AUTH_CONSENT_URL!);
          expect(new Headers(init?.headers).get('CF-Access-Client-Id')).toBe('worker-service');
          expect(init?.cache).toBe('no-store');
          expect(JSON.parse(init?.body as string)).toEqual({ actorAccountId: 'author', clientId: 'client' });
          return Response.json({ actorAccountId: 'author', clientId: 'client', scopes });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const input = { actorAccountId: 'author', clientId: 'client', deadline: Date.now() + 1000 };
    expect((await options.readConsent(input))?.scopes).toEqual(['post:erase']);
    scopes = [];
    expect((await mountedContentEditionConsent(f.context.pool)!(input))?.scopes).toEqual([]);
    expect(options.readConsent).toBe(f.context.getAuthorization().readConsent);
    expect(f.fetch).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

test('default Content retains typed unavailable consent and rejects unsupported worker configuration', async () => {
  const f = composition();
  try {
    await registerContent.register(f.context);
    const options = f.factory.mock.calls[0]![0];
    await expect(
      options.readConsent({ actorAccountId: 'author', clientId: 'client', deadline: Date.now() + 1000 }),
    ).rejects.toBeInstanceOf(AccessUnavailableError);
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }

  const invalid = composition({ AUTH_JWKS_URL: 'https://other.test/jwks' });
  try {
    await expect(registerContent.register(invalid.context)).rejects.toBeInstanceOf(ConfigError);
    expect(invalid.factory).not.toHaveBeenCalled();
    expect(invalid.notices).not.toHaveBeenCalled();
    expect(invalid.fetch).not.toHaveBeenCalled();
  } finally {
    await invalid.close();
  }
});

test('explicit Content work ports and mechanical pipelines keep their existing composition boundaries', async () => {
  // The default root changes only in register.ts; native callers still supply their own ports.
  const source = await Bun.file(new URL('../../src/content/work.ts', import.meta.url)).text();
  expect(source).not.toContain('getAuthorization');
  expect(source).not.toContain('restoreInitiator');
  expect(source).toContain('access: options.access');
  expect(source).toContain('readConsent: options.readConsent');
  expect(source).toContain('createImageJob(context.pool, imageStorage).process(input.mediaId)');
  expect(source).toContain('createErasureJob(context.pool, storage).purgeObject(input.mediaId)');
  expect(source).toContain('createCollectionJob(context.pool, storage, { clock: context.clock })');
  // The standalone factory remains callable without worker authorization or runtime composition.
  const access = createContentWorkAccess(() => new Date());
  expect(typeof access.authorize).toBe('function');
});
