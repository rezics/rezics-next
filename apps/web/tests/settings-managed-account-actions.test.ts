import { expect, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { MediaProblem } from '../src/media/kernel';
import {
  LOCAL_authManagementPageHref,
  ManagedAccountActionsRead,
  loadManagedAccountActions,
  managedAccountActionNames,
  type ManagedAccountActionsResult,
  type ManagedAccountActionsTarget,
} from '../src/settings/managed-account-actions-read';

const viewerId = '019a0000-0000-7000-8000-000000000001';
const accountId = '019a0000-0000-7000-8000-000000000002';
const target = { accountId, viewerId };
function native(actions: { action: string; operations: string[] }[], id = accountId) {
  return { resources: [{ type: 'access.account', id, viewerActions: actions }] };
}
function transport(body: unknown, status = 200, requests: Request[] = []) {
  return createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(init?.cache).toBe('no-store');
      return Response.json(body, { status });
    }) as typeof fetch,
  });
}

// Retained integration oracles. This delivery runs only the local Web typecheck.
test('Only installed deployed management destinations permitted by current native exact-target actions become links, and selection never conveys authority or an approval', async () => {
  const requests: Request[] = [];
  const admitted = await loadManagedAccountActions(
    transport(native([{ action: 'account:update', operations: ['account.update'] }]), 200, requests),
    'Bearer server-held-viewer',
    target,
  );
  expect(admitted.state).toBe('ready');
  if (admitted.state !== 'ready') throw new Error('Expected exact-target capabilities');
  expect(admitted.actions.profile.state).toBe('available');
  for (const name of ['rename', 'members', 'transfer', 'delete'] as const) {
    expect(admitted.actions[name].state).toBe('unavailable');
    expect(admitted.actions[name]).not.toHaveProperty('href');
    expect(admitted.actions[name]).toHaveProperty('owner');
  }
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get('authorization')).toBe('Bearer server-held-viewer');
  expect(requests[0]!.headers.get('cache-control')).toBe('no-store');
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/viewerActions');
  expect(await requests[0]!.json()).toEqual({ resources: [{ type: 'access.account', id: accountId }] });

  // The mounted catalogue has no exact Auth workflow bindings. Guessed aliases and broad scopes never fill the gap.
  const absent = await loadManagedAccountActions(
    transport(
      native([
        { action: 'account:update', operations: ['account.rename', 'account.read_editable_profile'] },
        { action: 'organization:membership', operations: ['organization.membership'] },
        { action: 'account:manage', operations: ['operator.transfer', 'organization.delete'] },
      ]),
    ),
    'Bearer viewer',
    target,
  );
  expect(absent.state === 'ready' && absent.actions.profile.state).toBe('denied');
  if (absent.state !== 'ready') throw new Error('Expected native capabilities');
  expect(Object.values(absent.actions).some((action) => action.state === 'available')).toBe(false);
  for (const declaration of [undefined, 'invalid', '[]', '["/account/rename","/operators/transfer"]']) {
    const env = {
      AUTH_ISSUER: 'https://auth.test',
      ...(declaration ? { AUTH_MANAGEMENT_PAGE_ROUTES: declaration } : {}),
    };
    expect(LOCAL_authManagementPageHref(env, '/account/rename')).toBeNull();
    expect(LOCAL_authManagementPageHref(env, '/organizations/members', accountId)).toBeNull();
    expect(LOCAL_authManagementPageHref(env, '/operators/transfer', accountId)).toBeNull();
    expect(LOCAL_authManagementPageHref(env, '/organizations/delete', accountId)).toBeNull();
  }
  const organization: ManagedAccountActionsTarget = {
    accountId,
    nativeAccountKind: 'organization',
    self: true,
    operated: true,
  };
  expect(managedAccountActionNames(organization, viewerId)).toEqual(['profile', 'members', 'delete']);
  expect(managedAccountActionNames({ ...organization, nativeAccountKind: 'actor', operated: false }, viewerId)).toEqual(
    ['profile'],
  );
  expect(
    managedAccountActionNames(
      { accountId: viewerId, nativeAccountKind: 'actor', self: true, operated: false },
      viewerId,
    ),
  ).toEqual(['profile', 'rename']);
});

test('native profile authority requires the exact operation, rejects another target and retains literal refusal', async () => {
  const operated = await loadManagedAccountActions(
    transport(native([{ action: 'account:manage', operations: ['account.update'] }])),
    'Bearer viewer',
    target,
  );
  expect(operated.state === 'ready' && operated.actions.profile.state).toBe('available');
  for (const body of [
    native([{ action: 'account:update', operations: ['account.update'] }], viewerId),
    { resources: [] },
    { ...native([]), approval: 'unexpected' },
  ])
    expect((await loadManagedAccountActions(transport(body), 'Bearer viewer', target)).state).toBe('unavailable');
  expect(
    await loadManagedAccountActions(
      transport({ resources: [{ type: 'access.account', id: accountId, error: 'not_found' }] }),
      'Bearer viewer',
      target,
    ),
  ).toEqual({ state: 'denied', status: 200, code: 'not_found' });
  expect(
    await loadManagedAccountActions(transport({ code: 'account_suspended' }, 403), 'Bearer viewer', target),
  ).toEqual({ state: 'denied', status: 403, code: 'account_suspended' });
  expect(
    await loadManagedAccountActions(transport({ code: 'dependency_unavailable' }, 503), 'Bearer viewer', target),
  ).toEqual({ state: 'unavailable', status: 503, code: 'dependency_unavailable' });
});

test('one selected viewer/target owns one capability read; stale and late other-viewer replies cannot supply links', async () => {
  const result = await loadManagedAccountActions(
    transport(native([{ action: 'account:update', operations: ['account.update'] }])),
    'Bearer viewer',
    target,
  );
  let finish: (value: ManagedAccountActionsResult) => void = () => {};
  let calls = 0;
  const read = new ManagedAccountActionsRead(target, () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const first = read.load();
  expect(read.load()).toBe(first);
  await Promise.resolve();
  expect(calls).toBe(1);
  finish(result);
  expect(await first).toEqual(result);
  expect(await read.load()).toEqual(result);
  expect(calls).toBe(1);
  const next = new ManagedAccountActionsRead({ accountId: viewerId, viewerId }, async () => result);
  expect((await next.load()).state).toBe('unavailable');
  if (result.state !== 'ready') throw new Error('Expected native capabilities');
  const anotherViewer = new ManagedAccountActionsRead(target, async () => ({ ...result, viewerId: accountId }));
  expect((await anotherViewer.load()).state).toBe('unavailable');
});

test('delivered Auth page deployment never substitutes for the missing exact native operation binding', async () => {
  const result = await loadManagedAccountActions(
    transport(native([{ action: 'account:update', operations: ['account.update'] }])),
    'Bearer viewer',
    target,
    {
      AUTH_ISSUER: 'https://auth.test',
      AUTH_MANAGEMENT_PAGE_ROUTES: JSON.stringify([
        '/account/rename',
        '/organizations/members',
        '/operators/transfer',
        '/organizations/delete',
      ]),
    },
  );
  if (result.state !== 'ready') throw new Error('Expected exact-target capabilities');
  expect(result.actions.profile.state).toBe('available');
  for (const name of ['rename', 'members', 'transfer', 'delete'] as const) {
    expect(result.actions[name].state).toBe('unavailable');
    expect(result.actions[name]).not.toHaveProperty('href');
    if (result.actions[name].state === 'unavailable')
      expect(result.actions[name].owner).not.toContain('session/auth-page-routes.ts');
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test('Recover failed management actions without leaving Settings with current native response and viewer isolation contracts', async () => {
  const ready = await loadManagedAccountActions(
    transport(native([{ action: 'account:update', operations: ['account.update'] }])),
    'Bearer viewer',
    target,
  );
  const reply = deferred<ManagedAccountActionsResult>();
  let calls = 0;
  const read = new ManagedAccountActionsRead(target, async (selection) => {
    expect(selection).toEqual(target);
    if (++calls === 1) throw new Error('Transient read failure');
    return reply.promise;
  });
  const first = read.load();
  expect(await first).toEqual({ state: 'unavailable', status: null, code: null });
  // Parent rendering and effect reattachment keep observing the failed read until a deliberate retry.
  expect(read.load()).toBe(first);
  expect(calls).toBe(1);
  const retry = read.retry();
  expect(read.snapshot().pending).toBe(true);
  expect(read.retry()).toBe(retry);
  expect(read.load()).toBe(retry);
  await Promise.resolve();
  expect(calls).toBe(2);
  reply.resolve(ready);
  expect(await retry).toEqual(ready);
  expect(read.snapshot()).toEqual({ result: ready, pending: false });
  expect(read.load()).toBe(retry);
  expect(read.retry()).toBe(retry);
  expect(calls).toBe(2);
});

test('repeated unavailable reads stay recoverable while a native denial never becomes a transient failure', async () => {
  let calls = 0;
  const read = new ManagedAccountActionsRead(target, async () => {
    calls++;
    throw new MediaProblem(
      { type: 'https://kernel.test/problems/busy', title: 'Busy', status: 503, code: 'busy' },
      { 'Retry-After': '0' },
    );
  });
  const failure = { state: 'unavailable', status: 503, code: 'busy', retryAfter: '0' };
  expect(await read.load()).toEqual(failure);
  expect(await read.retry()).toEqual(failure);
  expect(read.snapshot()).toEqual({ result: failure, pending: false });
  await read.load();
  expect(calls).toBe(2);
  expect(await read.retry()).toEqual(failure);
  expect(calls).toBe(3);

  let deniedCalls = 0;
  const denied = new ManagedAccountActionsRead(target, async () => {
    deniedCalls++;
    return { state: 'denied', status: 403, code: 'account_suspended' };
  });
  const refusal = denied.load();
  expect(await refusal).toEqual({ state: 'denied', status: 403, code: 'account_suspended' });
  expect(denied.retry()).toBe(refusal);
  expect(deniedCalls).toBe(1);
});

test('native Retry-After survives the capability transport and expires without issuing an automatic request', async () => {
  const client = createKernelClient('https://kernel.test', {
    fetch: (async () =>
      Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '2' } })) as typeof fetch,
  });
  const failure = await loadManagedAccountActions(client, 'Bearer viewer', target);
  expect(failure).toEqual({ state: 'unavailable', status: 429, code: 'rate_limited', retryAfter: '2' });
  const ready = await loadManagedAccountActions(transport(native([])), 'Bearer viewer', target);
  for (const retryAfter of ['2', 'Sat, 31 Oct 2026 00:00:02 GMT']) {
    let now = Date.parse('2026-10-31T00:00:00Z');
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    try {
      let calls = 0;
      const read = new ManagedAccountActionsRead(target, async () =>
        ++calls === 1 ? { state: 'unavailable', status: 429, code: 'rate_limited', retryAfter } : ready,
      );
      const first = read.load();
      await first;
      expect(read.retry()).toBe(first);
      now += 1_999;
      expect(read.retry()).toBe(first);
      expect(calls).toBe(1);
      now++;
      expect(read.load()).toBe(first);
      expect(calls).toBe(1);
      expect(await read.retry()).toEqual(ready);
      expect(calls).toBe(2);
    } finally {
      clock.mockRestore();
    }
  }
});

test('late retries cannot publish into a new viewer, target or CSRF lifetime', async () => {
  const ready = await loadManagedAccountActions(
    transport(native([{ action: 'account:update', operations: ['account.update'] }])),
    'Bearer viewer',
    target,
  );
  for (const selection of [target, { ...target, viewerId: accountId }, { ...target, accountId: viewerId }]) {
    const late = deferred<ManagedAccountActionsResult>();
    let calls = 0;
    const previous = new ManagedAccountActionsRead(target, async () =>
      ++calls === 1 ? { state: 'unavailable', status: 503, code: 'dependency_unavailable' } : late.promise,
    );
    await previous.load();
    const retry = previous.retry();
    const current = new ManagedAccountActionsRead(selection, async () => ({
      state: 'denied',
      status: 403,
      code: 'forbidden',
    }));
    expect(current.snapshot()).toEqual({ result: null, pending: false });
    await current.load();
    late.resolve(ready);
    await retry;
    expect(current.snapshot()).toEqual({
      result: { state: 'denied', status: 403, code: 'forbidden' },
      pending: false,
    });
    expect(calls).toBe(2);
  }
});
