import { expect, test } from 'bun:test';
import { ConfigError } from '../../src/commerce/config.ts';
import { createKernelRuntimeDefaults } from '../../src/composition/runtime-defaults.ts';
import { localJwksTransport, readMembershipWorkConfig } from '../../src/access/membership-work-config.ts';

const session = `1:${Buffer.alloc(32, 2).toString('base64url')}`;
const receipt = `1:${Buffer.alloc(32, 3).toString('base64url')}`;
const keys = {
  KERNEL_ROUTE_KEY: Buffer.alloc(32, 1).toString('base64url'),
  KERNEL_SESSION_KEYS: session,
  KERNEL_RECEIPT_KEYS: receipt,
};

test('worker and Kernel HTTP admit issuer-origin JWKS and fetch it from native Auth', async () => {
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ keys: [{ kty: 'EC', kid: 'native' }] }),
  });
  try {
    const issuer = 'http://127.0.0.1:20011';
    const nativeOrigin = `http://127.0.0.1:${native.port}`;
    const env = {
      ...keys,
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: 'https://api.rezics.test',
      AUTH_JWKS_URL: `${issuer}/.well-known/jwks.json`,
      REZICS_LOCAL_STACK_NATIVE_ORIGIN: nativeOrigin,
    };
    const membership = readMembershipWorkConfig(env);
    expect(membership.auth.jwksUrl).toBe(env.AUTH_JWKS_URL);
    expect(new URL(membership.auth.jwksUrl).origin).toBe(issuer);
    const jwks = await membership.auth.fetch!(env.AUTH_JWKS_URL);
    expect(await jwks.json()).toEqual({ keys: [{ kty: 'EC', kid: 'native' }] });
    await expect(membership.auth.fetch!(`${issuer}/signin`)).rejects.toThrow('only the configured issuer JWKS URL');

    const defaults = createKernelRuntimeDefaults({ env });
    expect(defaults.auth?.jwksUrl).toBe(env.AUTH_JWKS_URL);
    expect(await (await defaults.auth!.fetch!(env.AUTH_JWKS_URL)).json()).toEqual({
      keys: [{ kty: 'EC', kid: 'native' }],
    });
  } finally {
    await native.stop(true);
  }
});

test('HTTPS issuers keep production JWKS identity and ignore a leftover native origin', () => {
  const auth = {
    issuer: 'https://auth.rezics.test',
    audience: 'https://api.rezics.test',
    jwksUrl: 'https://auth.rezics.test/.well-known/jwks.json',
  };
  expect(localJwksTransport({ REZICS_LOCAL_STACK_NATIVE_ORIGIN: 'http://127.0.0.1:20012' }, auth)).toEqual(auth);
  expect(() =>
    readMembershipWorkConfig({
      ...keys,
      AUTH_ISSUER: 'https://auth.rezics.test',
      AUTH_AUDIENCE: 'https://api.rezics.test',
      AUTH_JWKS_URL: 'https://other.test/.well-known/jwks.json',
    }),
  ).toThrow(ConfigError);
});

test('a malformed native origin is refused before any JWKS request', () => {
  expect(() =>
    localJwksTransport(
      { REZICS_LOCAL_STACK_NATIVE_ORIGIN: 'https://example.test' },
      {
        issuer: 'http://127.0.0.1:20011',
        audience: 'https://api.rezics.test',
        jwksUrl: 'http://127.0.0.1:20011/.well-known/jwks.json',
      },
    ),
  ).toThrow(ConfigError);
});
