import { CONSENT_PAGE_MAX_RESPONSE_BYTES as limit, CONSENT_PAGE_MAX_ERROR_BYTES } from '@rezics/auth-contract';
import { projectConsentPage } from '../../../services/auth/src/consent-page';
import { reduceConsent } from '../src/security-inventory';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { approvedScopes, createConsentReview, readConsent, type Consent, type ConsentReview } from '../src/consent';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const consent: Consent = {
  client_id: 'reader+client',
  display_name: 'Reader',
  scopes: ['openid', 'read'],
  requested: ['read', 'admin:manual'],
  granted: ['openid'],
  pending_reduction: false,
  acting_account: { account_id: 'person-1', email: null },
  decisions: { allow: true, decline: true, switch_account: true },
};

test('private consent read binds the exact request and approval excludes unsupported names but retains grants', async () => {
  let requestedUrl = '';
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return Response.json(consent, { headers: { 'cache-control': 'private, no-store' } });
  }) as typeof fetch;
  const result = await readConsent(consent.client_id, undefined, consent.requested.join(' '));
  expect(result).toEqual({ ok: true, body: consent });
  expect(requestedUrl).toContain('/consent/reader%2Bclient?scope=read+admin%3Amanual');
  expect(approvedScopes(consent)).toEqual(['openid', 'read']);
});

test('a mismatched requested set is unavailable rather than an empty review', async () => {
  globalThis.fetch = (async () => Response.json({ ...consent, requested: [] })) as typeof fetch;
  expect(await readConsent(consent.client_id, undefined, 'admin:manual')).toMatchObject({
    ok: false,
    status: 503,
    code: 'unavailable',
  });
});

const unavailable = { ok: false, status: 503, code: 'unavailable', retryAfter: null };
const encoder = new TextEncoder();
function stream(bytes: Uint8Array, headers?: HeadersInit) {
  const split = bytes.indexOf(0xc3) + 1;
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(bytes.slice(0, split));
        c.enqueue(bytes.slice(split));
        c.close();
      },
    }),
    { headers },
  );
}

test('native maximal escaped projection and split UTF-8 survive byte admission without length metadata', async () => {
  const scopes = Array.from({ length: 1000 }, (_, i) => String(i).padStart(128, 'x'));
  const requested = Array.from({ length: 1000 }, (_, i) => `q${i}`);
  const page = projectConsentPage({
    client: { client_id: '\0'.repeat(1023) + 'é', display_name: '\0'.repeat(100), first_party: false, scopes },
    identity: { account_id: '\0'.repeat(1024), email: '\0'.repeat(250) + '@x.y' },
    requested,
    consent: { scopes, pending_scopes: null },
  })!;
  expect(page).not.toBeNull();
  const bytes = encoder.encode(JSON.stringify(page));
  expect(bytes.length).toBeLessThanOrEqual(limit);
  for (const headers of [undefined, { 'content-length': '1' }]) {
    globalThis.fetch = (async () => stream(bytes, headers)) as typeof fetch;
    expect(await readConsent(page.client_id, undefined, requested.join(' '))).toEqual({ ok: true, body: page });
  }
});

test('exact byte ceiling is admitted; overflow, malformed JSON and UTF-8 cannot dispatch a reduction', async () => {
  const json = JSON.stringify({ ...consent, requested: [] });
  const exact = json.padEnd(limit, ' ');
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return stream(encoder.encode(exact));
  }) as typeof fetch;
  expect((await readConsent(consent.client_id)).ok).toBe(true);
  const target = { ...consent, status: 'current' as const, reducible: true, granted: ['openid', 'read'] };
  for (const bytes of [encoder.encode(exact + ' '), encoder.encode('{'), new Uint8Array([0xff])]) {
    calls = 0;
    globalThis.fetch = (async (_url, init) => {
      calls++;
      expect(init?.method ?? 'GET').toBe('GET');
      return stream(bytes, { 'content-length': '0' });
    }) as typeof fetch;
    expect(await readConsent(consent.client_id)).toEqual(unavailable);
    expect(await reduceConsent(target, ['openid'])).toEqual({ kind: 'unavailable' });
    expect(calls).toBe(2);
  }
  calls = 0;
  expect(await readConsent('x'.repeat(1025))).toEqual(unavailable);
  expect(calls).toBe(0);
});

test('bounded errors preserve native recovery and Retry-After, and overflowing errors are unavailable', async () => {
  for (const status of [401, 404, 409, 429]) {
    const body = { error: 'authentication_denied', ...(status === 409 ? { code: 'stale_review' } : {}) };
    globalThis.fetch = (async () => Response.json(body, { status, headers: { 'retry-after': '37' } })) as typeof fetch;
    expect(await readConsent(consent.client_id)).toEqual({
      ok: false,
      status,
      code: status === 409 ? 'stale_review' : '',
      retryAfter: '37',
    });
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body).padEnd(CONSENT_PAGE_MAX_ERROR_BYTES + 1), { status })) as typeof fetch;
    expect(await readConsent(consent.client_id)).toEqual(unavailable);
  }
});

test('whole-call timeout and caller retirement bound stalled bodies; late old-account bytes stay retired', async () => {
  const timeout = globalThis.setTimeout;
  const clock = spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: TimerHandler,
    ms?: number,
    ...args: unknown[]
  ) => timeout(fn, ms === 5000 ? 5 : ms, ...args)) as typeof setTimeout);
  try {
    globalThis.fetch = (async () => new Response(new ReadableStream())) as typeof fetch;
    expect(await readConsent(consent.client_id)).toEqual(unavailable);
  } finally {
    clock.mockRestore();
  }
  globalThis.fetch = (async () => new Response(new ReadableStream())) as typeof fetch;
  const caller = new AbortController();
  const stalled = readConsent(consent.client_id, caller.signal);
  await Promise.resolve();
  caller.abort();
  expect(await stalled).toEqual(unavailable);
  const late = Promise.withResolvers<Response>();
  globalThis.fetch = (() => late.promise) as typeof fetch;
  const states: ConsentReview[] = [];
  const old = createConsentReview(consent.client_id, '', (value) => states.push(value));
  const pending = old.load();
  await Promise.resolve();
  old.dispose();
  await pending;
  globalThis.fetch = (async () =>
    Response.json({ ...consent, requested: [], acting_account: { account_id: 'new', email: null } })) as typeof fetch;
  await createConsentReview(consent.client_id, '', (value) => states.push(value)).load();
  late.resolve(Response.json({ ...consent, requested: [] }));
  await Promise.resolve();
  await Promise.resolve();
  expect(states.at(-1)).toMatchObject({ state: 'ready', consent: { acting_account: { account_id: 'new' } } });
});
