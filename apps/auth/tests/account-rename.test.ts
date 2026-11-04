import { afterAll, afterEach, expect, test } from 'bun:test';
import { managementOperationProfile } from '@rezics/auth-contract';
import {
  clearPendingRenameReviewStepUp,
  consumeRenameReviewReturn,
  managementOperationStepUpUrl,
  markRenameReviewReturned,
  pendingRenameReviewStepUpState,
  selectManagementOperationStepUp,
  storePendingRenameReviewStepUp,
} from '../src/management-operation-step-up';
import { parseRenamePage, RENAME_PROFILE } from '../src/account-rename';
import { confirmStepUp } from '../src/step-up';

const accountId = '00000000-0000-4000-8000-000000000001';
const admitted = (handle: string | null) => ({
  state: 'ready',
  viewer: {
    accountId,
    kind: 'actor',
    clientId: RENAME_PROFILE.client_id,
    scopes: ['account:update'],
    authnEpoch: 1,
    authTime: 123,
    amr: ['pwd'],
  },
  profile: { id: accountId, kind: 'actor', handle },
  authActions: {
    state: 'ready',
    operations: [
      {
        operationId: 'auth.account.rename',
        action: 'account:update',
        resource: { route: 1, id: accountId },
      },
    ],
  },
});
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  },
});
afterEach(() => {
  storage.clear();
  globalThis.fetch = originalFetch;
});
test('rename page distinguishes advice, refusal, dependency loss and native action admission', () => {
  expect(
    parseRenamePage(
      {
        state: 'management-auth-required',
        continuation: { kind: 'management-operation-step-up', operation: 'rename' },
      },
      accountId,
    ),
  ).toEqual({ kind: 'management-auth-required', accountId });
  expect(parseRenamePage({ state: 'refused' }, accountId)).toEqual({ kind: 'refused' });
  expect(
    parseRenamePage({ ...admitted('private_handle'), authActions: { state: 'unavailable' } }, accountId),
  ).toMatchObject({ kind: 'unavailable', target: { handle: 'private_handle' } });
  expect(parseRenamePage(admitted(null), accountId)).toMatchObject({
    kind: 'ready',
    target: { accountId, handle: null, authnEpoch: 1, authTime: 123 },
  });
  const deniedAction = admitted('private_handle');
  deniedAction.authActions.operations = [];
  expect(parseRenamePage(deniedAction, accountId)).toMatchObject({
    kind: 'refused',
    target: { accountId, handle: 'private_handle' },
  });
  expect(parseRenamePage({ state: 'refused', profile: { id: accountId, handle: 'leak' } }, accountId)).toEqual({
    kind: 'unavailable',
  });
});

test('rename review step-up returns to the fixed page without storing or executing an operation', () => {
  const url = managementOperationStepUpUrl('rename');
  expect(url).toBe('/step-up?management_operation=rename&return_to=%2Faccount%2Frename');
  expect(storePendingRenameReviewStepUp(accountId)).toBe(true);
  expect(selectManagementOperationStepUp(url.split('?')[1]!)).toMatchObject({
    kind: 'review',
    pending: { kind: 'rename', accountId, returnTo: '/account/rename', phase: 'awaiting' },
  });
  const pending = pendingRenameReviewStepUpState();
  if (pending.kind !== 'pending') throw new Error('rename review continuation missing');
  expect(markRenameReviewReturned(pending.value)).toBe(true);
  expect(consumeRenameReviewReturn('00000000-0000-4000-8000-000000000002')).toBe(false);
  expect(storePendingRenameReviewStepUp(accountId)).toBe(true);
  const retry = pendingRenameReviewStepUpState();
  if (retry.kind !== 'pending') throw new Error('rename review continuation missing');
  expect(markRenameReviewReturned(retry.value)).toBe(true);
  expect(consumeRenameReviewReturn(accountId)).toBe(true);
  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'absent' });
  expect(storage.get('rezics.management-operation.step-up')).toBeUndefined();
});

test('password step-up verifies the exact rename session and returns without executing a rename', async () => {
  const url = managementOperationStepUpUrl('rename');
  expect(storePendingRenameReviewStepUp(accountId)).toBe(true);
  const requests: { path: string; body: unknown }[] = [];
  globalThis.fetch = (async (path, init) => {
    const name = String(path);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: name, body });
    if (name === '/signin') return Response.json({});
    if (name === '/session')
      return Response.json({
        account_id: accountId,
        client_id: RENAME_PROFILE.client_id,
        scope: ['account:update'],
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  expect(
    await confirmStepUp('person@example.test', 'password', url.slice(url.indexOf('?')), 'https://auth.test'),
  ).toEqual({
    ok: true,
    target: 'https://auth.test/account/rename',
  });
  expect(requests.map(({ path }) => path)).toEqual(['/signin', '/session']);
  expect(requests[0]?.body).toEqual({
    email: 'person@example.test',
    password: 'password',
    ...managementOperationProfile('rename'),
  });
  expect(pendingRenameReviewStepUpState()).toMatchObject({ kind: 'pending', value: { phase: 'returned' } });
  expect(consumeRenameReviewReturn(accountId)).toBe(true);
});

afterEach(() => clearPendingRenameReviewStepUp());
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
