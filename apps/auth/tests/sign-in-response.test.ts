import { afterEach, expect, test } from 'bun:test';
import {
  managementOperationProfile,
  parseSignInProof,
  signInProofBytes,
  signInResponseBytes,
  type SignInProfile,
} from '@rezics/auth-contract';
import { receiveSignInOptions, submitSignIn } from '../src/sign-in-transport';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
const ordinary = { client_id: 'login', scope: [] };
const proof = (profile: SignInProfile = ordinary, method = 'pwd') => ({
  account_id: '\u0000"秘密'.repeat(100),
  client_id: profile.client_id,
  scope: [...profile.scope].sort(),
  authn_epoch: 0,
  auth_time: 123,
  amr: [method],
});
const options = { rpId: 'rezics.com', challenge: 'A'.repeat(43), timeout: 60000, userVerification: 'required' };
function serve(value: unknown, status = 200) {
  globalThis.fetch = (async () => Response.json(value, { status })) as typeof fetch;
}
test('fixed profiles receive complete native proof with opaque escaped identity and path-specific methods', async () => {
  for (const profile of [ordinary, managementOperationProfile('transfer')]) {
    for (const method of ['pwd', 'pop']) {
      const body = proof(profile, method);
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(signInProofBytes(profile));
      serve(body);
      expect((await submitSignIn(method === 'pwd' ? '/signin' : '/signin/passkey', {}, profile)).ok).toBe(true);
      expect(parseSignInProof(body, ordinary, method === 'pwd' ? 'pop' : 'pwd')).toBeNull();
    }
  }
});
test('malformed and excess acknowledgements never confirm', async () => {
  for (const body of [
    {},
    { success: true },
    { ...proof(), extra: true },
    { ...proof(), scope: ['account:manage'] },
    { ...proof(), account_id: 'x'.repeat(1025) },
    { ...proof(), amr: ['pop'] },
    { ...proof(), auth_time: -1 },
  ]) {
    serve(body);
    expect(await submitSignIn('/signin', {}, ordinary)).toMatchObject({ ok: false, code: 'unavailable' });
  }
});
test('native throttle, suspension and denial envelopes remain bounded; ambiguous errors stay unavailable', async () => {
  for (const [status, body, code] of [
    [401, { error: 'authentication_denied' }, 'authentication_denied'],
    [429, { error: 'authentication_denied' }, 'authentication_denied'],
    [429, { code: 'rate_limited' }, 'rate_limited'],
    [403, { error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' }, 'ACCOUNT_SUSPENDED'],
    [401, { error: 'authentication_denied', extra: true }, 'unavailable'],
  ] as const) {
    globalThis.fetch = (async () => Response.json(body, { status, headers: { 'retry-after': '37' } })) as typeof fetch;
    expect(await submitSignIn('/signin', {}, ordinary)).toMatchObject({ ok: false, code });
  }
  globalThis.fetch = (async () =>
    Response.json(
      { error: 'authentication_denied' },
      { status: 429, headers: { 'retry-after': '37' } },
    )) as typeof fetch;
  expect(await submitSignIn('/signin', {}, ordinary)).toMatchObject({
    ok: false,
    status: 429,
    code: 'authentication_denied',
    retryAfter: '37',
  });
});
test('actual bytes, split UTF-8, absent and lying lengths are admitted before JSON decoding', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(proof()));
  for (const length of [undefined, '1']) {
    globalThis.fetch = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
            c.close();
          },
        }),
        { headers: length ? { 'content-length': length } : {} },
      )) as typeof fetch;
    expect((await submitSignIn('/signin', {}, ordinary)).ok).toBe(true);
  }
  for (const bytes of [
    new Uint8Array([0xff]),
    new TextEncoder().encode('{'),
    new Uint8Array(signInProofBytes(ordinary) + 1),
  ]) {
    globalThis.fetch = (async () => new Response(bytes, { headers: { 'content-length': '1' } })) as typeof fetch;
    expect((await submitSignIn('/signin', {}, ordinary)).ok).toBe(false);
  }
});
test('options admit only configured discoverable output, with no retry', async () => {
  for (const body of [options, { ...options, allowCredentials: [] }, { ...options, challenge: 'x'.repeat(44) }]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json(body);
    }) as typeof fetch;
    expect((await receiveSignInOptions()).ok).toBe(body === options);
    expect(calls).toBe(1);
  }
  expect(JSON.stringify(options).length).toBe(signInResponseBytes.options);
});
test('one five-second lifetime settles abort-ignoring fetch and body without a resend', async () => {
  for (const stalledBody of [false, true]) {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return stalledBody
        ? new Response(new ReadableStream({ pull: () => new Promise(() => {}) }))
        : new Promise<Response>(() => {});
    }) as typeof fetch;
    const start = Date.now();
    expect((await submitSignIn('/signin', {}, ordinary)).ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(6000);
    expect(calls).toBe(1);
  }
}, 12000);
