import { afterEach, expect, test } from 'bun:test';
import { nativeSignInProof } from '../tests/sign-in-fixture';
import {
  AUTH_MANAGEMENT_CLIENT_ID,
  type ManagementOperation,
  type ManagementOperationInput,
} from '@rezics/auth-contract';
import {
  executeManagementOperation,
  loadManagementSession,
  managementOperationProfile,
} from '../src/management-operations';
import {
  clearPendingManagementOperationStepUp,
  managementOperationStepUpUrl,
  pendingManagementOperationStepUpState,
  selectManagementOperationStepUp,
  storePendingManagementOperationStepUp,
} from '../src/management-operation-step-up';
import { confirmStepUp } from '../src/step-up';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function storage() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    },
  });
}
const rename: ManagementOperation = {
  kind: 'rename',
  accountId: 'managed',
  handle: 'new-name',
  expectedHandle: 'old-name',
};
const previous = { operatorAccountId: 'source', subjectAccountId: 'managed', reservationId: 'reserved-source' };
const input: ManagementOperationInput = {
  operationKey: 'one-immutable-key',
  accountId: 'initiating-human',
  operation: rename,
};
const proof = (kind: ManagementOperation['kind'] = 'rename') => ({
  account_id: input.accountId,
  ...managementOperationProfile(kind),
  authn_epoch: 4,
  auth_time: Math.floor(Date.now() / 1000),
  amr: ['pwd'],
});
const approval = () => ({
  reference: 'genuine-native-reference',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
type Call = { path: string; init: RequestInit; body: Record<string, unknown> };
function respond(reply: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (path: RequestInfo | URL, init: RequestInit = {}) => {
    const call = {
      path: String(path),
      init,
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

test('Least-scope Auth account management composition and typed transport preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  storage();
  expect(managementOperationProfile('rename')).toEqual({
    client_id: AUTH_MANAGEMENT_CLIENT_ID,
    scope: ['account:update'],
  });
  expect(managementOperationProfile('membership').scope).toEqual(['organization:membership']);
  expect(managementOperationProfile('transfer').scope).toEqual(['account:manage']);
  expect(managementOperationProfile('transfer-acceptance').scope).toEqual(['account:manage']);
  let session = proof();
  const calls = respond((call) => {
    if (call.path === '/session') return Response.json(session);
    if (call.path === '/signin')
      return Response.json(
        nativeSignInProof(call.body as { client_id: string; scope: string[] }, 'pwd', input.accountId),
      );
    if (call.path.endsWith('/approve')) return Response.json(approval());
    return Response.json({ accountId: 'managed' });
  });
  expect(storePendingManagementOperationStepUp(input)).toBe(true);
  const query = managementOperationStepUpUrl('rename').split('?')[1]!;
  expect(selectManagementOperationStepUp(`?${query}&return_to=https://attacker.test`).kind).toBe('invalid');
  expect(selectManagementOperationStepUp('?return_to=/account/rename').kind).toBe('invalid');
  expect(selectManagementOperationStepUp(`?${query}&account_operation=delete`).kind).toBe('invalid');
  expect(await executeManagementOperation(input)).toEqual({ kind: 'refused' });
  expect(calls).toHaveLength(0);
  session = { ...proof(), account_id: 'different-human' };
  expect((await confirmStepUp('human@example.test', 'password', `?${query}`, 'https://auth.test')).ok).toBe(false);
  session = proof();
  expect(await confirmStepUp('human@example.test', 'password', `?${query}`, 'https://auth.test')).toEqual({
    ok: true,
    target: 'https://auth.test/account/rename',
  });
  expect(calls.filter((call) => call.path.includes('/account-operations/'))).toHaveLength(0);
  expect(calls.filter((call) => call.path === '/signin').at(-1)?.body).toEqual({
    email: 'human@example.test',
    password: 'password',
    ...managementOperationProfile('rename'),
  });
  expect(pendingManagementOperationStepUpState().kind).toBe('pending');
  expect(await executeManagementOperation({ ...input, operationKey: 'substituted' })).toEqual({ kind: 'refused' });
  expect(await executeManagementOperation({ ...input, operation: { ...rename, handle: 'substituted' } })).toEqual({
    kind: 'refused',
  });
  expect(await executeManagementOperation(input)).toEqual({
    kind: 'complete',
    operationKind: 'rename',
    accountId: 'managed',
  });
  expect(
    calls.filter((call) => call.path.includes('/account-operations/')).map(({ path, body }) => ({ path, body })),
  ).toEqual([
    { path: '/account-operations/approve', body: input },
    { path: '/account-operations/execute', body: { ...input, reference: 'genuine-native-reference' } },
  ]);
  expect(calls.find((call) => call.path === '/session')?.init.cache).toBe('no-store');
  expect(
    calls
      .filter((call) => call.path.includes('/account-operations/'))
      .every(
        ({ init }) =>
          init.method === 'POST' &&
          init.credentials === 'same-origin' &&
          init.redirect === 'error' &&
          !new Headers(init.headers).has('authorization'),
      ),
  ).toBe(true);
});

test('transfer acceptance keeps its genuine reference and never executes; uncertain execution retries the identical body', async () => {
  storage();
  const operation: ManagementOperation = {
    kind: 'transfer-acceptance',
    previous,
    expectedVersion: 'native-version',
    operatorAccountId: input.accountId,
    sourceOperationKey: 'source-key',
  };
  const accepted = approval();
  const acceptanceCalls = respond((call) =>
    call.path === '/session' ? Response.json(proof(operation.kind)) : Response.json(accepted),
  );
  expect(await executeManagementOperation({ ...input, operation })).toEqual({
    kind: 'complete',
    operationKind: 'transfer-acceptance',
    ...accepted,
  });
  expect(acceptanceCalls.map((call) => call.path)).toEqual(['/session', '/account-operations/approve']);
  const transfer: ManagementOperation = {
    kind: 'transfer',
    previous,
    expectedVersion: 'native-version',
    operatorAccountId: input.accountId,
    acceptance: accepted.reference,
  };
  const calls = respond((call) => {
    if (call.path === '/session') return Response.json(proof('transfer'));
    if (call.path.endsWith('/approve')) return Response.json(approval());
    throw new Error('lost response');
  });
  expect(await executeManagementOperation({ ...input, operation: transfer })).toEqual({ kind: 'unknown' });
  const executions = calls.filter((call) => call.path.endsWith('/execute'));
  expect(executions).toHaveLength(2);
  expect(executions[0]?.body).toEqual(executions[1]?.body);
  expect(executions[0]?.body.operation).toEqual(transfer);
});

test('current-account, stale authentication, malformed results and absent ports never fabricate completion', async () => {
  storage();
  respond(() => Response.json({ ...proof(), account_id: 'substitute' }));
  expect(await executeManagementOperation(input)).toEqual({ kind: 'refused' });
  respond(() => Response.json({ ...proof(), scope: ['account:update', 'account:manage'] }));
  expect(await executeManagementOperation(input)).toEqual({ kind: 'step-up' });
  respond(() => Response.json({ ...proof(), auth_time: Math.floor(Date.now() / 1000) - 601 }));
  expect(await executeManagementOperation(input)).toEqual({ kind: 'step-up' });
  respond(() => Response.json({ ...proof(), amr: ['operator'] }));
  expect(await loadManagementSession()).toEqual({ kind: 'unavailable' });
  respond(() => Response.json({}));
  expect(await loadManagementSession()).toEqual({ kind: 'unavailable' });
  const cases: [Response, Response | undefined, string][] = [
    [Response.json({ error: 'account_operation_denied' }, { status: 503 }), undefined, 'unavailable'],
    [Response.json({ error: 'account_operation_denied' }, { status: 403 }), undefined, 'refused'],
    [Response.json({ error: 'step_up_required' }, { status: 401 }), undefined, 'step-up'],
    [Response.json({ ...approval(), expiresAt: new Date(0).toISOString() }), undefined, 'unavailable'],
    [Response.json(approval()), Response.json({ accountId: 'substituted' }), 'unknown'],
    [Response.json(approval()), new Response(null, { status: 500 }), 'unknown'],
    [Response.json(approval()), Response.json({ accountId: 'managed', receipt: 'not-readback' }), 'unknown'],
  ];
  for (const [approved, executed, kind] of cases) {
    respond((call) =>
      call.path === '/session' ? Response.json(proof()) : call.path.endsWith('/approve') ? approved : executed!,
    );
    expect(await executeManagementOperation(input)).toEqual({ kind });
  }
  clearPendingManagementOperationStepUp();
});
