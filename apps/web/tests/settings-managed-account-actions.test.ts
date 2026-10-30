import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
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
