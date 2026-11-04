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
const rules = { minLength: 3, maxLength: 64, normalization: 'lowercase', pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]' };
const page = (readiness = 'review', selected: unknown = operator) => ({
  viewer: { accountId: human },
  readiness,
  operator: selected,
  handleRules: rules,
  action: readiness === 'review' ? 'confirm' : readiness === 'authentication-needed' ? 'authenticate' : 'none',
});
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
    return Response.json(path === '/session' ? proof() : page());
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
    expect(parseAutomatedCreationOperator(value, operatorAccountId, human)).toEqual({ kind: 'unavailable' });
});
test('operator loader refuses foreign initiating humans, transport refusal and unknown native source', async () => {
  for (const session of [{ ...proof(), account_id: foreign }]) {
    const paths: string[] = [];
    globalThis.fetch = (async (url) => {
      paths.push(String(url));
      return Response.json(session);
    }) as typeof fetch;
    expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: 'refused' });
    expect(paths).toEqual(['/session']);
  }
  for (const status of [403, 503, 200]) {
    globalThis.fetch = (async (url) =>
      String(url) === '/session'
        ? Response.json(proof())
        : Response.json(status === 200 ? null : { error: 'denied' }, { status })) as typeof fetch;
    expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({
      kind: status === 403 ? 'refused' : 'unavailable',
    });
  }
  let sessions = 0;
  globalThis.fetch = (async (url) =>
    Response.json(
      String(url) === '/session' ? (++sessions === 1 ? proof() : { ...proof(), account_id: foreign }) : page(),
    )) as typeof fetch;
  expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: 'unavailable' });
});

test('ordinary callers reach native continuation advice without disclosing selected identity; native refusal is distinct', async () => {
  for (const [body, expected] of [
    [page('authentication-needed', null), 'step-up'],
    [page('refused', null), 'refused'],
    [page('authentication-needed'), 'unavailable'],
  ]) {
    const calls: string[] = [];
    globalThis.fetch = (async (url) => {
      calls.push(String(url));
      return Response.json(String(url) === '/session' ? { ...proof(), client_id: 'login', scope: [] } : body);
    }) as typeof fetch;
    expect(await loadAutomatedOperator(human, operatorAccountId)).toEqual({ kind: expected });
    expect(calls).toEqual(['/session', '/account-management/automated/operator', '/session']);
  }
});
