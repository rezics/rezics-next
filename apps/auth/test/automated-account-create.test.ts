import { afterEach, expect, test } from 'bun:test';
import {
  AUTOMATED_PROFILE,
  createAutomatedAttempt,
  parseAutomatedAttempt,
  parseAutomatedOperator,
  reauthenticateAutomated,
  restoreAutomatedAttempt,
  saveAutomatedAttempt,
  submitAutomatedAttempt,
  type AutomatedAttempt,
} from '../src/automated-account-create';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const human = '11111111-1111-4111-8111-111111111111';
const operatorId = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const operator = {
  id: operatorId,
  kind: 'organization' as const,
  handle: 'native_operator',
  displayName: 'Native operator',
};
function setup() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    },
  });
  return values;
}
const proof = () => ({
  account_id: human,
  ...AUTOMATED_PROFILE,
  authn_epoch: 1,
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
});
function respond(reply?: (path: string, body: Record<string, unknown>) => Response) {
  const calls: { path: string; body: Record<string, unknown>; init: RequestInit }[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path, body, init });
    return reply
      ? reply(path, body)
      : path === '/session'
        ? Response.json(proof())
        : path.endsWith('/approve')
          ? Response.json({ reference: 'native-approval', expiresAt: '2030-01-01T00:00:00Z' })
          : Response.json({ accountId: actor });
  }) as typeof fetch;
  return calls;
}
const attempt = () => createAutomatedAttempt(human, operator, 'new_actor')!;

test('exact operator and handle confirmation saves one immutable native descriptor and never creates on restore', async () => {
  setup();
  const calls = respond();
  const input = attempt();
  expect(saveAutomatedAttempt(input)).toBe(true);
  expect(restoreAutomatedAttempt()).toEqual(input);
  expect(calls).toHaveLength(0);
  expect(input.operation).toEqual({
    kind: 'automated',
    registrationId: '',
    operationKey: input.operationKey,
    operatorAccountId: operatorId,
    handle: 'new_actor',
  });
  expect(Object.isFrozen(input.operation)).toBe(true);
  expect(await submitAutomatedAttempt(input)).toEqual({ kind: 'complete', accountId: actor });
  const mutations = calls.filter((call) => call.path.startsWith('/account-operations/'));
  expect(mutations.map((call) => call.path)).toEqual(['/account-operations/approve', '/account-operations/execute']);
  expect(mutations[1]!.body).toEqual({
    operationKey: input.operationKey,
    accountId: human,
    operation: input.operation,
    reference: 'native-approval',
  });
  expect(mutations.every((call) => call.init.credentials === 'same-origin' && call.init.cache === 'no-store')).toBe(
    true,
  );
  expect(JSON.stringify(mutations)).not.toContain('ownerActor');
  expect(JSON.stringify(mutations.map(({ body }) => body))).not.toContain('credential');
});

test('lost response retries the same initiating human operator handle and key and rejects operation substitution', async () => {
  setup();
  const input = attempt();
  let lose = true;
  const calls = respond((path) => {
    if (path === '/session') return Response.json(proof());
    if (path.endsWith('/approve'))
      return Response.json({ reference: 'native-approval', expiresAt: '2030-01-01T00:00:00Z' });
    if (lose) throw new TypeError('Response lost');
    return Response.json({ accountId: actor });
  });
  expect(await submitAutomatedAttempt(input)).toEqual({ kind: 'unknown' });
  const saved = restoreAutomatedAttempt() as AutomatedAttempt;
  expect(saveAutomatedAttempt({ ...saved, operation: { ...saved.operation, handle: 'other_handle' } })).toBe(false);
  expect(saveAutomatedAttempt({ ...saved, accountId: actor })).toBe(false);
  expect(
    saveAutomatedAttempt({
      ...saved,
      operationKey: 'replacement',
      operation: { ...saved.operation, operationKey: 'replacement' },
    }),
  ).toBe(false);
  lose = false;
  expect(await submitAutomatedAttempt(saved)).toEqual({ kind: 'complete', accountId: actor });
  const executions = calls.filter((call) => call.path.endsWith('/execute'));
  expect(executions).toHaveLength(2);
  expect(executions[0]!.body).toEqual(executions[1]!.body);
});

test('foreign human and uninstalled or wrong management profile never approve or execute; step-up requires a second explicit submit', async () => {
  setup();
  const input = attempt();
  let session = { ...proof(), account_id: actor };
  const calls = respond((path) => (path === '/session' ? Response.json(session) : Response.json({})));
  expect(await submitAutomatedAttempt(input)).toEqual({ kind: 'refused' });
  session = { ...proof(), client_id: 'login', scope: [] };
  expect(await submitAutomatedAttempt(input)).toEqual({ kind: 'step-up' });
  expect(calls.filter((call) => call.path.includes('/account-operations/'))).toHaveLength(0);
  const reauthCalls = respond((path) => {
    if (path === '/session') return Response.json(proof());
    if (path === '/signin') return Response.json({});
    throw new Error('Sign-in must not approve or execute');
  });
  expect(await reauthenticateAutomated(human, 'human@example.test', 'transient-password')).toBeNull();
  expect(reauthCalls.filter((call) => call.path === '/signin')[0]!.body).toEqual({
    email: 'human@example.test',
    password: 'transient-password',
    ...AUTOMATED_PROFILE,
  });
  expect(JSON.stringify(restoreAutomatedAttempt())).not.toContain('transient-password');
});

test('pending registration unexpected result and forged operator identity are never completion', async () => {
  setup();
  const input = attempt();
  respond((path) =>
    path === '/session'
      ? Response.json(proof())
      : path.endsWith('/approve')
        ? Response.json({ reference: 'native-approval', expiresAt: '2030-01-01T00:00:00Z' })
        : Response.json({ accountId: actor, registrationId: 'pending-source' }),
  );
  expect(await submitAutomatedAttempt(input)).toEqual({ kind: 'unknown' });
  expect(parseAutomatedAttempt({ ...input, operation: { ...input.operation, registrationId: 'invented' } })).toBeNull();
  expect(parseAutomatedAttempt({ ...input, credential: { password: 'not-stored' } })).toBeNull();
  expect(parseAutomatedOperator({ id: operatorId, kind: 'organization', handle: 'public' }, operatorId)).toEqual({
    kind: 'unavailable',
  });
  const native = {
    account: operator,
    self: false,
    role: 'owner',
    operator: null,
    relation: null,
    members: { state: 'ready', items: [], next: null },
    responsibilities: null,
  };
  expect(parseAutomatedOperator(native, operatorId)).toEqual({ kind: 'ready', operator });
  expect(parseAutomatedOperator(native, actor)).toEqual({ kind: 'unavailable' });
  expect(parseAutomatedOperator({ ...native, operator: { ...operator, id: human } }, operatorId)).toEqual({
    kind: 'unavailable',
  });
});

test('refusal after a lost submission remains unknown and cannot replace its immutable recovery', async () => {
  setup();
  const input = attempt();
  respond((path) => {
    if (path === '/session') return Response.json(proof());
    throw new TypeError('Approval acknowledgement lost');
  });
  expect(await submitAutomatedAttempt(input)).toEqual({ kind: 'unknown' });
  const saved = restoreAutomatedAttempt() as AutomatedAttempt;
  expect(saved.submitted).toBe(true);
  expect(saveAutomatedAttempt(input)).toBe(true);
  expect(restoreAutomatedAttempt()).toEqual(saved);
  respond((path) =>
    path === '/session' ? Response.json(proof()) : Response.json({ error: 'denied' }, { status: 403 }),
  );
  expect(await submitAutomatedAttempt(saved)).toEqual({ kind: 'unknown' });
  expect(restoreAutomatedAttempt()).toEqual(saved);
});
