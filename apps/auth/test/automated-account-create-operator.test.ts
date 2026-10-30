import { afterEach, expect, test } from 'bun:test';
import {
  AUTOMATED_PROFILE,
  loadAutomatedOperator,
  parseAutomatedCreationOperator,
} from '../src/automated-account-create';
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const human = '11111111-1111-4111-8111-111111111111';
const operatorAccountId = '22222222-2222-4222-8222-222222222222';
const foreign = '33333333-3333-4333-8333-333333333333';
const operator = { id: operatorAccountId, kind: 'organization', handle: null, displayName: 'Native operator' };
const proof = () => ({
  account_id: human,
  ...AUTOMATED_PROFILE,
  authn_epoch: 1,
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
});
test('operator loader uses only same-origin trusted Auth selection and closes the exact native response', async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    const path = String(url);
    calls.push({ path, init });
    return Response.json(path === '/session' ? proof() : operator);
  }) as typeof fetch;
  expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: 'ready', operator });
  expect(calls.map((c) => c.path)).toEqual(['/session', '/account-management/automated/operator', '/session']);
  const point = calls[1]!;
  expect(JSON.parse(String(point.init.body))).toEqual({ operatorAccountId });
  expect(point.init.credentials).toBe('same-origin');
  expect(point.init.cache).toBe('no-store');
  expect(point.init.redirect).toBe('error');
  expect(JSON.stringify(calls)).not.toContain('Bearer');
  for (const value of [
    null,
    { ...operator, id: foreign },
    { ...operator, email: 'private' },
    { ...operator, members: [] },
    {
      account: operator,
      self: false,
      role: 'owner',
      operator: null,
      relation: null,
      members: {},
      responsibilities: null,
    },
  ])
    expect(parseAutomatedCreationOperator(value, operatorAccountId)).toEqual({ kind: 'unavailable' });
});
test('operator loader refuses a foreign initiating human, profile changes, denial and unknown native source', async () => {
  for (const session of [
    { ...proof(), account_id: foreign },
    { ...proof(), client_id: 'login', scope: [] },
    { ...proof(), scope: ['account:manage', 'account:read'] },
  ]) {
    const paths: string[] = [];
    globalThis.fetch = (async (url) => {
      paths.push(String(url));
      return Response.json(session);
    }) as typeof fetch;
    expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: 'unavailable' });
    expect(paths).toEqual(['/session']);
  }
  for (const status of [403, 503, 200]) {
    globalThis.fetch = (async (url) =>
      String(url) === '/session'
        ? Response.json(proof())
        : Response.json(status === 200 ? null : { error: 'denied' }, { status })) as typeof fetch;
    expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: 'unavailable' });
  }
  let sessions = 0;
  globalThis.fetch = (async (url) =>
    Response.json(
      String(url) === '/session' ? (++sessions === 1 ? proof() : { ...proof(), account_id: foreign }) : operator,
    )) as typeof fetch;
  expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: 'unavailable' });
});
