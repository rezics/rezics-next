import { expect, test } from 'bun:test';
import type { AuthService } from '../src/index.ts';
import { accountManagementReadTransport, OPERATOR_RELATION_PATH } from '../src/account-management-read-transport.ts';

const issuer = 'https://management.auth.test';
// These transport-only cases cannot reach proof or Access. Native successful and
// denied reads run through the real Auth host in Kernel's management-source test.
const service = { verifier: { issuer } } as AuthService;
const fallback = async () => new Response('fallback', { status: 418 });
const handler = accountManagementReadTransport(service, fallback, undefined);
const subjectAccountId = '00000000-0000-8000-8000-123400000001';
function request(body: unknown = { subjectAccountId }, init: RequestInit = {}, query = '') {
  return new Request(`${issuer}${OPERATOR_RELATION_PATH}${query}`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

test('the exact private POST read refuses malformed bodies and transport before any proof or binding', async () => {
  const attempts = [
    request({}),
    request([]),
    request({ subjectAccountId: '' }),
    request({ subjectAccountId: 'not-an-account' }),
    request({ subjectAccountId, previous: {} }),
    request({ subjectAccountId, token: 'forged' }),
    request({ subjectAccountId }, {}, '?subjectAccountId=other'),
    request(undefined, { method: 'GET', body: null }),
    request(undefined, { headers: { 'content-type': 'application/json' } }),
    request(undefined, { headers: { origin: 'https://foreign.test', 'content-type': 'application/json' } }),
    request(undefined, { headers: { origin: issuer, 'content-type': 'text/plain' } }),
    request(undefined, {
      headers: { origin: issuer, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    }),
    request(undefined, {
      headers: { origin: issuer, 'content-type': 'application/json', authorization: 'Bearer forged' },
    }),
    request(undefined, { body: '{' }),
  ];
  for (const input of attempts) {
    const response = await handler(input);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ error: 'account_management_read_denied' });
  }
  const oversized = await handler(request({ subjectAccountId, padding: 'x'.repeat(16384) }));
  expect(oversized.status).toBe(413);
  expect(await oversized.json()).toEqual({ error: 'account_management_read_denied' });
});

test('absent native wiring is typed unavailable and adjacent routes retain their handler', async () => {
  const missing = await handler(request());
  expect(missing.status).toBe(503);
  expect(missing.headers.get('cache-control')).toBe('private, no-store');
  expect(await missing.json()).toEqual({ error: 'account_management_read_unavailable' });
  const adjacent = await handler(new Request(`${issuer}${OPERATOR_RELATION_PATH}/`));
  expect(adjacent.status).toBe(418);
  expect(await adjacent.text()).toBe('fallback');
});
