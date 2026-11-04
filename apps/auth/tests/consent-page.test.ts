import { afterEach, expect, test } from 'bun:test';
import { approvedScopes, readConsent, type Consent } from '../src/consent';

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
