import { expect, spyOn, test } from 'bun:test';
import pg from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { accessClock } from '../../src/access/access-clock.ts';
import { resourceRoleCatalogue } from '../../src/access/resource-roles.ts';
import roles from '../../src/access/resource-roles.json';
import { AccessUnavailableError, classifyUnavailability } from '../../src/access/unavailable.ts';
import { ConfigError } from '../../src/commerce/config.ts';
import { receiptKeysFor } from '../../src/command/receipt-key.ts';
import { mountedContentEditionConsent } from '../../src/content/edition-sale-consent.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createWorkerAuthorization } from '../../src/work/authorization.ts';
import type { WorkClient } from '../../src/work/client.ts';

function dependencies() {
  const pool = new pg.Pool();
  const noIO = () => {
    throw new Error('Authorization composition must not perform I/O');
  };
  const connect = spyOn(pool, 'connect').mockImplementation(noIO);
  const query = spyOn(pool, 'query').mockImplementation(noIO);
  const launch = spyOn(DBOS, 'launch').mockImplementation(async () => noIO());
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(async () => noIO(), { preconnect: globalThis.fetch.preconnect }),
  );
  return {
    pool,
    // Any access to this enqueue port during construction is a defect.
    client: new Proxy({} as WorkClient, { get: noIO }),
    env: {
      KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
      KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 2).toString('base64url')}`,
      AUTH_ISSUER: 'https://worker-auth.test',
      AUTH_AUDIENCE: 'https://worker-api.test',
      AUTH_JWKS_URL: 'https://worker-auth.test/jwks',
    },
    receiptKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
    clock: () => new Date('2030-01-02T03:04:05Z'),
    fetch,
    async close() {
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      connect.mockRestore();
      query.mockRestore();
      launch.mockRestore();
      fetch.mockRestore();
      await pool.end();
    },
  };
}

test('default worker authorization mounts native edition/post actions and real resource roles without I/O', async () => {
  const deps = dependencies();
  try {
    const { access, readConsent } = createWorkerAuthorization(deps);
    const catalogue = resourceRoleCatalogue(access)!;
    expect(catalogue.types.get('content.edition')?.owner).toBe('content.edition.owner');
    expect(catalogue.roles.get('content.edition.owner')).toEqual(roles.roles['content.edition.owner']);
    expect(catalogue.roles.get('content.post.owner')).toEqual(roles.roles['content.post.owner']);
    expect(catalogue.roles.get('community.realm.owner')).toEqual(roles.roles['community.realm.owner']);
    expect(accessClock(access)()).toEqual(deps.clock());
    expect(receiptKeysFor(deps.pool)).toEqual(deps.receiptKeys);
    expect(mountedContentEditionConsent(deps.pool)).toBe(readConsent);
    const id = newId(0x1234);
    const resource = { route: routeOf(id)!, id };
    for (const action of ['edition:sell', 'post:revise']) {
      const evidence = await access.prepare!({ kind: 'anonymous' }, action, resource, {
        pool: deps.pool,
        deadline: Date.now() + 1000,
      });
      expect(await access.authorize(deps.pool, { kind: 'anonymous' }, action, resource, evidence)).toBe(false);
    }
    expect(deps.fetch).not.toHaveBeenCalled();
  } finally {
    await deps.close();
  }
});

test('worker and mounted Content share one Auth reader that reads fresh current consent', async () => {
  const deps = dependencies();
  const consentEnv = {
    KERNEL_AUTH_CONSENT_URL: 'https://consent.test/internal/v1/consents:read',
    CF_ACCESS_CLIENT_ID: 'worker-service',
    CF_ACCESS_CLIENT_SECRET: 'worker-secret',
  };
  const env = { ...deps.env, ...consentEnv };
  try {
    const { readConsent } = createWorkerAuthorization({ ...deps, env });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(mountedContentEditionConsent(deps.pool)).toBe(readConsent);
    // Configuration is captured once; facts are fetched again on every call.
    env.CF_ACCESS_CLIENT_SECRET = 'changed-after-composition';
    let currentScopes = ['edition:sell', 'post:revise'];
    deps.fetch.mockImplementation(
      Object.assign(
        async (target: RequestInfo | URL, init?: RequestInit) => {
          expect(String(target)).toBe(consentEnv.KERNEL_AUTH_CONSENT_URL);
          expect(new Headers(init?.headers).get('CF-Access-Client-Id')).toBe(consentEnv.CF_ACCESS_CLIENT_ID);
          expect(new Headers(init?.headers).get('CF-Access-Client-Secret')).toBe(consentEnv.CF_ACCESS_CLIENT_SECRET);
          expect(init?.redirect).toBe('error');
          expect(init?.cache).toBe('no-store');
          expect(init?.method).toBe('POST');
          expect(JSON.parse(init?.body as string)).toEqual({ actorAccountId: 'seller', clientId: 'client' });
          return Response.json({ actorAccountId: 'seller', clientId: 'client', scopes: currentScopes });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    const input = { actorAccountId: 'seller', clientId: 'client', deadline: Date.now() + 1000 };
    expect((await readConsent(input))?.scopes).toEqual(currentScopes);
    currentScopes = [];
    expect((await mountedContentEditionConsent(deps.pool)!(input))?.scopes).toEqual([]);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  } finally {
    await deps.close();
  }
});

test('absent worker consent is retryably unavailable and partial consent retains ConfigError', async () => {
  const deps = dependencies();
  try {
    const { readConsent } = createWorkerAuthorization(deps);
    const failure = await readConsent({
      actorAccountId: 'seller',
      clientId: 'client',
      deadline: Date.now() + 1000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AccessUnavailableError);
    expect(classifyUnavailability(failure)).toBe('overloaded');
    expect(() =>
      createWorkerAuthorization({
        ...deps,
        env: { ...deps.env, CF_ACCESS_CLIENT_ID: 'partial-service' },
      }),
    ).toThrow(ConfigError);
    expect(deps.fetch).not.toHaveBeenCalled();
  } finally {
    await deps.close();
  }
});
