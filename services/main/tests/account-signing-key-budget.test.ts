import { expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ACCOUNT_KEY_CACHE_MS, ACCOUNT_KEY_RETRY_MS, AccountAssertionDenied,
  AccountAssertionUnavailable, AccountAssertionVerifier } from '../src/modules/account/verify-assertion.ts';

test('forged key IDs share one cold exchange, no warm exchanges, and bounded failure retries', async () => {
  const issuer = 'https://account.test', audience = 'https://main.test';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'active', alg: 'RS256', use: 'sig' };
  let keys = [jwk], keyCalls = 0, introspections = 0, status = 200;
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/jwks') {
      keyCalls++;
      return Response.json({ keys }, { status });
    }
    introspections++;
    return Response.json({ active: true, iss: issuer, sub: 'reader', aud: audience,
      scope: 'work:read', exp: Math.floor(now / 1000) + 300 });
  } });
  const base = `http://127.0.0.1:${server.port}`;
  const verifier = new AccountAssertionVerifier({ issuer, audience, jwksUrl: `${base}/jwks`,
    introspectUrl: `${base}/introspect`, clientId: 'main', clientSecret: 'secret' });
  const token = (kid: string) => new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer).setAudience(audience).setSubject('reader').setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + 300).sign(privateKey);
  const verify = (bearer: string) => verifier.verify(new Request(`${audience}/v1/works`, {
    headers: { authorization: `Bearer ${bearer}` },
  }), ['work:read']);
  // Reuse a signature: key selection must refuse before introspection, whatever
  // untrusted kid is named. No per-kid negative-cache population can grow.
  const signed = await token('active');
  const forged = (kid?: string) => [Buffer.from(JSON.stringify({ alg: 'RS256', ...(kid ? { kid } : {}) }))
    .toString('base64url'), signed.split('.')[1], 'Zm9yZ2Vk'].join('.');
  const storm = async (failure: typeof AccountAssertionDenied | typeof AccountAssertionUnavailable) => {
    await Promise.all(Array.from({ length: 128 }, async (_, index) => {
      await expect(verify(forged(`unknown-${index}`))).rejects.toBeInstanceOf(failure);
    }));
  };
  try {
    await storm(AccountAssertionDenied);
    expect(keyCalls).toBe(1);
    expect(introspections).toBe(0);
    expect(await verify(signed)).toMatchObject({ issuer, subject: 'reader' });
    await storm(AccountAssertionDenied);
    await expect(verify(forged())).rejects.toBeInstanceOf(AccountAssertionDenied);
    expect(keyCalls).toBe(1);
    expect(introspections).toBe(1);
    now += ACCOUNT_KEY_CACHE_MS - 1;
    await storm(AccountAssertionDenied);
    expect(keyCalls).toBe(1);
    // A timed refresh discovers the staged successor without kid-driven I/O.
    keys = [{ ...jwk, kid: 'successor' }];
    now++;
    expect(await verify(await token('successor'))).toMatchObject({ subject: 'reader' });
    expect(keyCalls).toBe(2);
    expect(introspections).toBe(2);
    now += ACCOUNT_KEY_CACHE_MS;
    status = 503;
    await storm(AccountAssertionUnavailable);
    await storm(AccountAssertionUnavailable);
    expect(keyCalls).toBe(3);
    now += ACCOUNT_KEY_RETRY_MS - 1;
    await storm(AccountAssertionUnavailable);
    expect(keyCalls).toBe(3);
    now++;
    status = 200;
    expect(await verify(await token('successor'))).toMatchObject({ subject: 'reader' });
    expect(keyCalls).toBe(4);
    expect(introspections).toBe(3);
  } finally {
    clock.mockRestore();
    await server.stop(true);
  }
});
