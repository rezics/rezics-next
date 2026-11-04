import { afterEach, expect, test } from 'bun:test';
import type { SessionProof } from '@rezics/auth-contract';
import type { AuthService } from '../../../services/auth/src/index.ts';
import {
  accountProfileReadTransport,
  type AccountProfileAccess,
} from '../../../services/auth/src/account-profile-read-transport.ts';
import {
  accountRenamePageTransport,
  type AccountRenamePageAccess,
} from '../../../services/auth/src/account-rename-page.ts';
import {
  clearRenameContinuation,
  createRenameAttempt,
  nativeRenameSource,
  RENAME_PROFILE,
  type RenameOperation,
} from '../src/account-rename';
import { pendingManagementOperationStepUpState } from '../src/management-operation-step-up';

const issuer = 'https://rename.auth.test';
const accountId = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const human: SessionProof = {
  account_id: accountId,
  client_id: RENAME_PROFILE.client_id,
  scope: ['account:update'],
  authn_epoch: 1,
  auth_time: 1,
  amr: ['pwd'],
};
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function fixture() {
  const state = { proof: human, handle: null as string | null, available: true, revalidate: true, selected: accountId };
  const reads: unknown[] = [],
    pageReads: unknown[] = [],
    commands: { path: string; body: { operationKey: string; operation: RenameOperation; reference?: string } }[] = [],
    navigations: string[] = [];
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
      location: { assign: (url: string) => navigations.push(url) },
    },
  });
  const service = {
    verifier: { issuer },
    internal: {
      withFreshHuman: async (input: { fresh?: boolean }, work: (proof: SessionProof) => Promise<unknown>) => {
        expect(input.fresh).toBe(false);
        return work(state.proof);
      },
      accessTokenForProof: async (proof: SessionProof) => {
        expect(proof).toBe(state.proof);
        if (!state.revalidate) throw new Error('session changed');
        return 'server-only';
      },
    },
  } as unknown as AuthService;
  const access: AccountProfileAccess = {
    readRenameAccountProfile: async (input) => {
      reads.push(input);
      if (!state.available) throw new Error('native read unavailable');
      return { profile: { id: state.selected, kind: 'actor', handle: state.handle, email: 'private' } } as Awaited<
        ReturnType<AccountProfileAccess['readRenameAccountProfile']>
      >;
    },
  };
  const pageAccess: AccountRenamePageAccess = {
    readRenameAccountPage: async (input) => {
      pageReads.push(input);
      if (!state.available) throw new Error('native page unavailable');
      return {
        viewer: { accountId: state.selected, kind: 'actor' },
        profile: { id: state.selected, kind: 'actor', handle: state.handle },
        authActions: {
          state: 'ready',
          operations: [
            {
              operationId: 'auth.account.rename',
              action: 'account:update',
              resource: { route: 1, id: state.selected },
            },
          ],
        },
      };
    },
  };
  const profileHandler = accountProfileReadTransport(
    service,
    async () => new Response(null, { status: 404 }),
    access,
  );
  const handler = accountRenamePageTransport(service, profileHandler, pageAccess);
  globalThis.fetch = (async (path, init) => {
    expect(init?.credentials).toBe('same-origin');
    expect(init?.redirect).toBe('error');
    if (path === '/session') return Response.json(state.proof);
    if (path === '/account-management/rename-page')
      return handler(
        new Request(`${issuer}${path}`, {
          ...init,
          headers: { ...init?.headers, origin: issuer },
        }),
      );
    if (path === '/account-management/profile')
      return handler(
        new Request(`${issuer}${path}`, {
          ...init,
          headers: { ...init?.headers, origin: issuer },
        }),
      );
    const body = JSON.parse(String(init?.body));
    commands.push({ path: String(path), body });
    if (path === '/account-operations/approve')
      return Response.json({ reference: 'original-reference', expiresAt: new Date(Date.now() + 60000).toISOString() });
    state.handle = body.operation.handle;
    return new Response(null, { status: 503 }); // The native mutation committed; its response was lost.
  }) as typeof fetch;
  return { state, reads, pageReads, commands, navigations, stored, handler, service };
}
function request(body: unknown = { accountId }, headers = {}, query = '') {
  return new Request(`${issuer}/account-management/profile${query}`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
function pageRequest(body: unknown = {}, headers = {}, query = '') {
  return new Request(`${issuer}/account-management/rename-page${query}`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
test('the default source reads a handleless human and reconciles a lost rename response with the original command', async () => {
  const f = fixture();
  const current = await nativeRenameSource.readCurrent();
  expect(current).toMatchObject({
    kind: 'ready',
    target: { accountId, handle: null, clientId: human.client_id, scopes: human.scope },
  });
  expect(f.pageReads[0]).toMatchObject({ human, accountId });
  expect(f.commands).toHaveLength(0);
  const response = await f.handler(request());
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ profile: { id: accountId, kind: 'actor', handle: null } });
  if (current.kind !== 'ready') throw new Error('missing review');
  const attempt = createRenameAttempt(current.target, 'AFTER')!;
  expect(await nativeRenameSource.run(attempt)).toEqual({ kind: 'unknown' });
  expect(f.commands.map(({ body }) => body)).toEqual([
    {
      operationKey: attempt.operationKey,
      operation: { kind: 'rename', accountId, handle: 'after', expectedHandle: null },
    },
    { operationKey: attempt.operationKey, operation: attempt.operation, reference: 'original-reference' },
  ]);
  expect(await nativeRenameSource.run(attempt)).toMatchObject({
    kind: 'renamed',
    target: { handle: 'after', accountId },
  });
  expect(f.commands).toHaveLength(2);
  const next = createRenameAttempt({ ...current.target, handle: 'after' }, 'next')!;
  expect(await nativeRenameSource.stepUp(next)).toBe(true);
  expect(f.navigations).toEqual(['/step-up?management_operation=rename&return_to=%2Faccount%2Frename']);
  expect([...f.stored.values()].join('')).not.toContain('original-reference');
  clearRenameContinuation();
  expect(pendingManagementOperationStepUpState()).toEqual({ kind: 'absent' });
});
test('native read failure, substituted profiles and session changes stay unavailable and recover without issuing commands', async () => {
  const f = fixture();
  for (const update of [
    { available: false },
    { available: true, selected: otherId },
    { selected: accountId, revalidate: false },
  ]) {
    Object.assign(f.state, update);
    expect(await nativeRenameSource.readCurrent()).toEqual({ kind: 'unavailable' });
  }
  expect(f.commands).toHaveLength(0);
  Object.assign(f.state, { revalidate: true, handle: 'Current_Handle' });
  expect(await nativeRenameSource.readCurrent()).toMatchObject({ kind: 'ready', target: { handle: 'Current_Handle' } });
});
test('the issuer rejects browser authority, other accounts and widened profiles before private reads', async () => {
  const f = fixture();
  for (const body of [{ accountId: otherId }, { accountId, human }, { accountId, token: 'browser' }, {}])
    expect((await f.handler(request(body))).status).toBe(body.accountId === otherId ? 403 : 400);
  for (const headers of [
    { authorization: 'Bearer website' },
    { origin: 'https://other.test' },
    { 'sec-fetch-site': 'cross-site' },
  ])
    expect((await f.handler(request({ accountId }, headers))).status).toBe(400);
  expect((await f.handler(request({ accountId }, {}, '?accountId=other'))).status).toBe(400);
  for (const proof of [
    { ...human, client_id: 'login' },
    { ...human, scope: ['account:update', 'account:read'] },
    { ...human, amr: ['operator'] },
  ]) {
    f.state.proof = proof;
    expect((await f.handler(request())).status).toBe(403);
  }
  expect(f.reads).toHaveLength(0);
  expect(f.pageReads).toHaveLength(0);
  const missing = accountProfileReadTransport(f.service, async () => new Response(), undefined);
  expect((await missing(request())).status).toBe(503);
});
