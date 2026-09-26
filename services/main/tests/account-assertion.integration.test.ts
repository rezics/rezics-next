import { test, expect } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import {
  AccountAssertionDenied, AccountAssertionUnavailable, AccountAssertionVerifier,
} from '../src/modules/account/verify-assertion.ts';

test('IAM02/IAM10 partial: signed Account token needs current enforcement', async () => {
  const issuer = 'https://account.rezics.test';
  const audience = 'rezics-main';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let active = true;
  let introspectionStatus = 200;
  let subject = 'private-account-1';
  let scope = 'work:create';
  let calls = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/jwks') return Response.json({ keys: [jwk] });
      if (path === '/bad-jwks') return new Response('unavailable', { status: 503 });
      if (path === '/introspect') {
        calls++;
        const body = new URLSearchParams(await request.text());
        if (body.get('client_id') !== 'main-resource' || body.get('client_secret') !== 'private-test-secret'
          || !body.get('token')) return new Response('unauthorized', { status: 401 });
        if (introspectionStatus !== 200) return new Response('unavailable', { status: introspectionStatus });
        return Response.json({ active, iss: issuer, sub: subject, aud: audience, scope,
          exp: Math.floor(Date.now() / 1000) + 300 });
      }
      return new Response('missing', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const config = { issuer, audience, jwksUrl: `${base}/jwks`, introspectUrl: `${base}/introspect`,
    clientId: 'main-resource', clientSecret: 'private-test-secret' };
  const verifier = new AccountAssertionVerifier(config);
  const token = async (claims: Record<string, string> = {}) => new SignJWT({ scope: 'work:create', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer).setAudience(audience).setSubject('private-account-1')
    .setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const request = (assertion: string, dpop?: string) => new Request('https://main.rezics.test/works', {
    method: 'POST', headers: { authorization: assertion, ...(dpop ? { dpop } : {}) },
  });
  try {
    const signed = await token();
    expect(await verifier.verify(request(`Bearer ${signed}`), ['work:create']))
      .toEqual({ issuer, subject: 'private-account-1' });
    expect(calls).toBe(1);
    await expect(verifier.verify(request('Bearer malformed'), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verifier.verify(request(`DPoP ${signed}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verifier.verify(request(`Bearer ${signed}`, 'proof'), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verifier.verify(request(`Bearer ${signed.slice(0, -2)}xx`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const wrongAudience = await new SignJWT({ scope: 'work:create' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer)
      .setAudience('other-service').setSubject('private-account-1')
      .setExpirationTime('5m').sign(privateKey);
    await expect(verifier.verify(request(`Bearer ${wrongAudience}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const wrongIssuer = await new SignJWT({ scope: 'work:create' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://wrong.invalid')
      .setAudience(audience).setSubject('private-account-1')
      .setExpirationTime('5m').sign(privateKey);
    await expect(verifier.verify(request(`Bearer ${wrongIssuer}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const noExpiry = await new SignJWT({ scope: 'work:create' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer)
      .setAudience(audience).setSubject('private-account-1').sign(privateKey);
    await expect(verifier.verify(request(`Bearer ${noExpiry}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const expired = await new SignJWT({ scope: 'work:create' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(issuer)
      .setAudience(audience).setSubject('private-account-1')
      .setExpirationTime('1s').sign(privateKey);
    await Bun.sleep(1200);
    await expect(verifier.verify(request(`Bearer ${expired}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    active = false;
    await expect(verifier.verify(request(`Bearer ${signed}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    active = true;
    scope = 'profile:read';
    await expect(verifier.verify(request(`Bearer ${signed}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    scope = 'work:create';
    subject = 'different-account';
    await expect(verifier.verify(request(`Bearer ${signed}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    subject = 'private-account-1';
    introspectionStatus = 503;
    await expect(verifier.verify(request(`Bearer ${signed}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionUnavailable);
    await expect(new AccountAssertionVerifier({ ...config, jwksUrl: `${base}/bad-jwks` })
      .verify(request(`Bearer ${signed}`), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionUnavailable);
  } finally {
    await server.stop(true);
  }
}, 30_000);
