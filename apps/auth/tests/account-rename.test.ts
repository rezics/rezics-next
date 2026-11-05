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

const renameKey = 'rezics.account-rename.pending';
const {
  RENAME_CONTINUATION_MAX_ID_CODE_UNITS: maxId,
  RENAME_CONTINUATION_MAX_CODE_UNITS: maxRaw,
  createRenameAttempt,
  readRenameContinuationState,
  saveRenameContinuation,
  clearRenameContinuation,
  nativeRenameSource,
  runRenameAttempt,
} = await import('../src/account-rename');

test('the canonical writer round-trips maximum escaped IDs and ASCII handles at the raw UTF-16 boundary', () => {
  const selected = createRenameAttempt({ accountId: '\0'.repeat(maxId), handle: 'b'.repeat(64) }, 'a'.repeat(64))!;
  expect(saveRenameContinuation({ ...selected, reference: 'secret' } as typeof selected)).toBe(true);
  const raw = storage.get(renameKey)!;
  expect(raw.length).toBe(maxRaw);
  expect(raw).not.toContain('secret');
  expect(readRenameContinuationState()).toEqual({ kind: 'valid', value: selected });
  selected.submitted = true;
  expect(saveRenameContinuation(selected)).toBe(true);
  expect(storage.get(renameKey)!.length).toBe(maxRaw - 1);
  expect(readRenameContinuationState()).toEqual({ kind: 'valid', value: selected });
  storage.clear();
  expect(saveRenameContinuation({ ...selected, accountId: 'x'.repeat(maxId + 1) })).toBe(false);
  expect(storage.has(renameKey)).toBe(false);
});

test('excess raw text never reaches JSON.parse; all refused bytes survive writes and unconditional cleanup', async () => {
  const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
  for (const raw of [' '.repeat(maxRaw + 1), '{', 'null', JSON.stringify({ ...selected, extra: true })]) {
    storage.set(renameKey, raw);
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
      parses++;
      return parse(...args);
    };
    try {
      expect(readRenameContinuationState()).toEqual({ kind: 'refused' });
      if (raw.length > maxRaw) expect(parses).toBe(0);
    } finally {
      JSON.parse = parse;
    }
    expect(saveRenameContinuation(selected)).toBe(false);
    clearRenameContinuation();
    clearRenameContinuation(selected);
    expect(await nativeRenameSource.stepUp(selected)).toBe(false);
    expect(await nativeRenameSource.stepUpForReview!(accountId)).toBe(false);
    expect(storage.get(renameKey)).toBe(raw);
    expect(storage.size).toBe(1);
  }
});

test('unreadable storage refuses dispatch; a write failure retains the exact live submitted command', async () => {
  const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
  const slot = window.sessionStorage,
    get = slot.getItem,
    set = slot.setItem;
  const ready = async () => ({
    kind: 'ready' as const,
    target: { accountId, handle: null, clientId: RENAME_PROFILE.client_id, scopes: ['account:update'] },
  });
  let posts = 0;
  globalThis.fetch = (async () => {
    posts++;
    return posts === 1
      ? Response.json({ reference: 'secret', expiresAt: new Date(Date.now() + 60000).toISOString() })
      : new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    slot.getItem = () => {
      throw Error('blocked');
    };
    expect(readRenameContinuationState()).toEqual({ kind: 'refused' });
    expect((await runRenameAttempt(selected, ready)).kind).toBe('unavailable');
    clearRenameContinuation(selected);
    expect(posts).toBe(0);
    slot.getItem = get;
    slot.setItem = () => {
      throw Error('quota');
    };
    expect((await runRenameAttempt(selected, ready)).kind).toBe('unknown');
    expect(selected.submitted).toBe(true);
    expect(readRenameContinuationState()).toEqual({ kind: 'absent' });
    expect(await nativeRenameSource.stepUp(selected)).toBe(false);
    expect((await runRenameAttempt(selected, ready)).kind).toBe('unknown');
    expect(posts).toBe(3); // exact replay reuses the live reference
  } finally {
    slot.getItem = get;
    slot.setItem = set;
  }
});

for (const phase of ['entry', 'read', 'approval'] as const)
  test(`storage refusal at ${phase} stops the next native stage without removing replacement bytes`, async () => {
    const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
    let posts = 0;
    if (phase === 'entry') storage.set(renameKey, '{');
    globalThis.fetch = (async () => {
      posts++;
      storage.set(renameKey, '{');
      return Response.json({ reference: 'secret', expiresAt: new Date(Date.now() + 60000).toISOString() });
    }) as typeof fetch;
    await runRenameAttempt(selected, async () => {
      if (phase === 'read') storage.set(renameKey, '{');
      return {
        kind: 'ready',
        target: { accountId, handle: null, clientId: RENAME_PROFILE.client_id, scopes: ['account:update'] },
      };
    });
    expect(posts).toBe(phase === 'approval' ? 1 : 0);
    expect(selected.submitted).toBe(false);
    expect(storage.get(renameKey)).toBe('{');
  });
