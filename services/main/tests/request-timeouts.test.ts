import { expect, test } from 'bun:test';
import type { Elysia } from 'elysia';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createMainApp } from '../src/app.ts';
import { FusekiClient, fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';
import { createAccountApp } from '../../account/src/app.ts';
import type { createAccountAuth } from '../../account/src/auth.ts';

const listen = { hostname: '127.0.0.1', port: 0 };

function mainApp(fuseki = new FusekiClient('http://127.0.0.1:1/rezics/', '')) {
  // Test-only routes do not consume the union of Main's mounted API types.
  return createMainApp(fuseki) as unknown as Elysia;
}

function accountApp(pool: Pool) {
  // These transport routes never authenticate. Leave provider/database startup
  // out of the fixture while using the real Account server and error hooks.
  const auth = { options: { baseURL: 'http://127.0.0.1',
    secret: 'request-timeout-test-secret-at-least-32-characters' } } as ReturnType<typeof createAccountAuth>;
  return createAccountApp(auth, pool);
}

test('Main and Accounts answer handlers that outlast Bun\'s default socket idle timeout', async () => {
  // Both real composition roots listen with their production server options.
  // Fifteen seconds crosses the default even with Bun's coarse socket timer.
  const slow = async () => { await Bun.sleep(15_000); return { status: 'complete' }; };
  const pool = new Pool();
  const main = mainApp().post('/timeout-test/slow', slow).listen(listen);
  const account = accountApp(pool).post('/timeout-test/slow', slow).listen(listen);
  try {
    // Settle both requests so one reset cannot hide the other service's result.
    const results = await Promise.allSettled([main, account].map(async app => {
      const response = await fetch(new URL('/timeout-test/slow', app.server!.url), { method: 'POST' });
      return { status: response.status, body: await response.json() };
    }));
    expect(results).toEqual([main, account].map(() => ({ status: 'fulfilled',
      value: { status: 200, body: { status: 'complete' } } })));
  } finally {
    await Promise.all([main.stop(true), account.stop(true), pool.end()]);
  }
});

/** A dependency can stall before headers or after starting its JSON body. */
async function delayedJson(phase: 'headers' | 'body', value: unknown): Promise<Response> {
  const json = JSON.stringify(value);
  if (phase === 'headers') {
    await Bun.sleep(250);
    return Response.json(value);
  }
  let timer: ReturnType<typeof setTimeout>;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(json.slice(0, 1)));
      timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(json.slice(1)));
        controller.close();
      }, 250);
    },
    cancel() { clearTimeout(timer); },
  }), { headers: { 'content-type': 'application/json' } });
}

for (const phase of ['headers', 'body'] as const) {
  test(`expired dependency ${phase} deadlines return each service's documented HTTP error`, async () => {
    const dependency = Bun.serve({ ...listen, idleTimeout: 0,
      fetch: () => delayedJson(phase, { boolean: true }) });
    const pool = new Pool();
    const fuseki = new FusekiClient(dependency.url.toString(), '');
    const main = mainApp(fuseki).get('/timeout-test/deadline', () => fusekiReadBudget.run({
      signal: AbortSignal.timeout(50), callsLeft: 1, bytesLeft: 1024,
    }, () => fuseki.query('ASK {}'))).listen(listen);
    const account = accountApp(pool).get('/timeout-test/deadline', async () => {
      const response = await fetch(dependency.url, { signal: AbortSignal.timeout(50) });
      return response.json();
    }).listen(listen);
    try {
      const started = performance.now();
      const [mainResponse, accountResponse] = await Promise.all([main, account].map(app =>
        fetch(new URL('/timeout-test/deadline', app.server!.url))));
      expect(mainResponse.status).toBe(503);
      expect(await mainResponse.json()).toMatchObject({ status: 503, code: 'dependency_unavailable' });
      expect(mainResponse.headers.get('retry-after')).toBe('1');
      expect(accountResponse.status).toBe(503);
      expect(await accountResponse.json()).toEqual({ error: 'temporarily_unavailable' });
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await Promise.all([main.stop(true), account.stop(true), dependency.stop(true), pool.end()]);
    }
  });

  for (const exchange of ['jwks', 'introspect'] as const) {
    test(`Main's Account client maps an expired ${exchange} ${phase} deadline to HTTP 503`, async () => {
      const issuer = 'https://account.test', audience = 'https://main.test';
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = { ...await exportJWK(publicKey), kid: 'active', alg: 'RS256', use: 'sig' };
      const token = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'active' })
        .setIssuer(issuer).setAudience(audience).setSubject('reader')
        .setIssuedAt().setExpirationTime('5m').sign(privateKey);
      const calls: string[] = [];
      const pool = new Pool();
      const account = accountApp(pool).get('/timeout-test/jwks', () => {
        calls.push('jwks');
        return exchange === 'jwks' ? delayedJson(phase, { keys: [jwk] }) : Response.json({ keys: [jwk] });
      }).post('/timeout-test/introspect', () => {
        calls.push('introspect');
        return delayedJson(phase, {
          active: true, iss: issuer, sub: 'reader', aud: audience,
          scope: 'work:read', exp: Math.floor(Date.now() / 1000) + 300,
        });
      }).listen(listen);
      const verifier = new AccountAssertionVerifier({ issuer, audience,
        jwksUrl: new URL('/timeout-test/jwks', account.server!.url).toString(),
        introspectUrl: new URL('/timeout-test/introspect', account.server!.url).toString(),
        clientId: 'main', clientSecret: 'test-secret', timeoutMs: 50 });
      const main = mainApp()
        .get('/timeout-test/protected', ({ request }) => verifier.verify(request, ['work:read'])).listen(listen);
      try {
        const started = performance.now();
        const response = await fetch(new URL('/timeout-test/protected', main.server!.url), {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ status: 503, code: 'dependency_unavailable' });
        expect(response.headers.get('retry-after')).toBe('1');
        expect(calls).toEqual(exchange === 'jwks' ? ['jwks'] : ['jwks', 'introspect']);
        expect(performance.now() - started).toBeLessThan(1000);
      } finally {
        await Promise.all([main.stop(true), account.stop(true), pool.end()]);
      }
    });
  }
}
