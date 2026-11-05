const nativeReference = 'AQ.' + 'a'.repeat(43);
import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
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
    const parse = spyOn(JSON, 'parse');
    try {
      expect(readRenameContinuationState()).toEqual({ kind: 'refused' });
      if (raw.length > maxRaw) expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
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

test('unreadable storage refuses dispatch and cleanup', async () => {
  const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
  const slot = window.sessionStorage,
    get = slot.getItem;
  slot.getItem = () => {
    throw Error('blocked');
  };
  try {
    expect(readRenameContinuationState()).toEqual({ kind: 'refused' });
    expect(
      (
        await runRenameAttempt(selected, async () => {
          throw Error('unexpected read');
        })
      ).kind,
    ).toBe('unavailable');
    expect(saveRenameContinuation(selected)).toBe(false);
    clearRenameContinuation(selected);
  } finally {
    slot.getItem = get;
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
      return Response.json({ reference: nativeReference, expiresAt: new Date(Date.now() + 60000).toISOString() });
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

const current =
  (id = accountId, handle: string | null = null) =>
  async () => ({
    kind: 'ready' as const,
    target: { accountId: id, handle, clientId: RENAME_PROFILE.client_id, scopes: ['account:update'] },
  });
const approvalReply = () => ({ reference: nativeReference, expiresAt: new Date(Date.now() + 60000).toISOString() });

test('closed approval and original-bound acknowledgement reject incompatible output without clearing submitted work', async () => {
  for (const body of [
    {},
    { accountId, extra: true },
    { accountId: 'other' },
    { accountId, expired: true },
    { accountId, error: 'denied' },
  ]) {
    const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
    globalThis.fetch = (async (path) =>
      Response.json(String(path).endsWith('/approve') ? approvalReply() : body)) as typeof fetch;
    expect((await runRenameAttempt(selected, current())).kind).toBe('unknown');
    expect(readRenameContinuationState()).toMatchObject({ kind: 'valid', value: { submitted: true } });
    storage.clear();
  }
  for (const body of [
    { ...approvalReply(), extra: true },
    { ...approvalReply(), reference: 'arbitrary' },
    { ...approvalReply(), expiresAt: 'tomorrow' },
    { ...approvalReply(), expiresAt: new Date(0).toISOString() },
  ]) {
    const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
    let sends = 0;
    globalThis.fetch = (async () => {
      sends++;
      return Response.json(body);
    }) as typeof fetch;
    expect((await runRenameAttempt(selected, current())).kind).toBe('unavailable');
    expect(sends).toBe(1);
    expect(selected.submitted).toBe(false);
  }
});

test('bare and malformed 4xx preserve uncertainty; admitted refusal cannot erase an earlier unknown send', async () => {
  const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
  selected.reference = nativeReference;
  for (const status of [401, 403, 409]) {
    globalThis.fetch = (async () => new Response('{', { status })) as typeof fetch;
    expect((await runRenameAttempt(selected, current())).kind).toBe('unknown');
    expect(selected.submitted).toBe(true);
    globalThis.fetch = (async () =>
      Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status })) as typeof fetch;
    await runRenameAttempt(selected, current(accountId, 'after'));
    expect(selected.submitted).toBe(true);
    expect(readRenameContinuationState()).toMatchObject({
      kind: 'valid',
      value: { operationKey: selected.operationKey, submitted: true },
    });
  }
});

test('actual byte limits precede parsing with absent/lying lengths, split UTF-8 and maximal opaque IDs/references', async () => {
  const { RENAME_APPROVAL_MAX_RESPONSE_BYTES, RENAME_EXECUTION_MAX_RESPONSE_BYTES } =
    await import('@rezics/auth-contract');
  const id = '\0'.repeat(maxId),
    selected = createRenameAttempt({ accountId: id, handle: null }, 'after')!;
  const reference = 'A'.repeat(4096 - 44) + '.' + 'a'.repeat(43);
  const bytes = new TextEncoder().encode(JSON.stringify({ accountId: id }));
  expect(bytes.length).toBe(RENAME_EXECUTION_MAX_RESPONSE_BYTES);
  globalThis.fetch = (async (path) =>
    String(path).endsWith('/approve')
      ? Response.json({ reference, expiresAt: new Date(Date.now() + 60000).toISOString() })
      : new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(bytes.slice(0, 20));
              c.enqueue(bytes.slice(20));
              c.close();
            },
          }),
        )) as typeof fetch;
  expect((await runRenameAttempt(selected, current(id))).kind).toBe('acknowledged');
  expect(selected.reference).toBe(reference);
  storage.clear();
  for (const headers of [{}, { 'Content-Length': '1' }]) {
    const draft = createRenameAttempt({ accountId, handle: null }, 'after')!;
    globalThis.fetch = (async () =>
      new Response(' '.repeat(RENAME_APPROVAL_MAX_RESPONSE_BYTES + 1), { headers })) as typeof fetch;
    const parse = spyOn(JSON, 'parse');
    try {
      expect((await runRenameAttempt(draft, current())).kind).toBe('unavailable');
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  }
  const unicode = createRenameAttempt({ accountId: '雪', handle: null }, 'after')!;
  unicode.reference = reference;
  const utf8 = new TextEncoder().encode(JSON.stringify({ accountId: '雪' }));
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(utf8.slice(0, 15));
          c.enqueue(utf8.slice(15));
          c.close();
        },
      }),
    )) as typeof fetch;
  expect((await runRenameAttempt(unicode, current('雪'))).kind).toBe('acknowledged');
});

test('retirement releases abort-ignoring approval/execute and late replies cannot install or settle replacement work', async () => {
  for (const phase of ['approve', 'execute', 'replacement']) {
    const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
    if (phase !== 'approve') selected.reference = nativeReference;
    const controller = new AbortController(),
      started = Promise.withResolvers<void>(),
      reply = Promise.withResolvers<Response>();
    globalThis.fetch = (async () => {
      started.resolve();
      return reply.promise;
    }) as typeof fetch;
    const pending = runRenameAttempt(selected, current(), () => true, controller.signal);
    await started.promise;
    const replacement = createRenameAttempt({ accountId: 'replacement', handle: null }, 'other')!;
    if (phase !== 'replacement') {
      controller.abort();
      expect((await pending).kind).toBe(phase === 'execute' ? 'unknown' : 'unavailable');
    }
    storage.clear();
    saveRenameContinuation(replacement);
    reply.resolve(Response.json(phase === 'approve' ? approvalReply() : { accountId }));
    if (phase === 'replacement') expect((await pending).kind).toBe('unknown');
    await Promise.resolve();
    expect(selected.acknowledged).toBeUndefined();
    if (phase === 'approve') expect(selected.reference).toBeUndefined();
    expect(readRenameContinuationState()).toEqual({ kind: 'valid', value: replacement });
    storage.clear();
  }
});

test('each POST has its own single five-second deadline across headers and a stalled body', async () => {
  const timers: (() => void)[] = [],
    timeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, delay: number) => {
    expect(delay).toBe(5000);
    timers.push(fn);
    return timeout(() => {}, 60000);
  }) as typeof setTimeout);
  try {
    const selected = createRenameAttempt({ accountId, handle: null }, 'after')!;
    const started = Promise.withResolvers<void>();
    globalThis.fetch = (async (path) => {
      if (String(path).endsWith('/approve')) return Response.json(approvalReply());
      started.resolve();
      return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
    }) as typeof fetch;
    const pending = runRenameAttempt(selected, current());
    await started.promise;
    expect(timers).toHaveLength(2);
    timers[1]!();
    expect((await pending).kind).toBe('unknown');
    expect(selected.submitted).toBe(true);
  } finally {
    timer.mockRestore();
  }
});
