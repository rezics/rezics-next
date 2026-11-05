import { afterEach, expect, test } from 'bun:test';
import { RENAME_PAGE_MAX_RESPONSE_BYTES, RENAME_PAGE_MAX_ID_LENGTH, type SessionProof } from '@rezics/auth-contract';
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
  saveRenameContinuation,
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
  const state = {
    proof: human,
    handle: null as string | null,
    available: true,
    revalidate: true,
    selected: accountId,
    unrelated: false,
    count: 1,
    route: 1,
    actionsAvailable: true,
    sessionStatus: 0,
    nativeStatus: 0,
  };
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
        if (state.sessionStatus) throw Object.assign(new Error('session denied'), { status: state.sessionStatus });
        return work(state.proof);
      },
      hasCurrentAuthSession: async () => false,
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
      if (state.nativeStatus) throw Object.assign(new Error('native denied'), { status: state.nativeStatus });
      if (!state.available) throw new Error('native page unavailable');
      return {
        viewer: { accountId: state.selected, kind: 'actor' },
        profile: { id: state.selected, kind: 'actor', handle: state.handle },
        authActions: !state.actionsAvailable
          ? { state: 'unavailable' }
          : {
              state: 'ready',
              operations: Array.from({ length: state.count }, (_, index) => ({
                operationId: state.unrelated && index === 0 ? 'unrelated' : 'auth.account.rename',
                action: 'account:update',
                resource: { route: state.route, id: state.selected },
              })),
            },
      };
    },
  };
  const profileHandler = accountProfileReadTransport(service, async () => new Response(null, { status: 404 }), access);
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
    kind: 'unknown',
  });
  expect(f.commands).toHaveLength(3);
  expect(f.commands[2]?.body).toEqual(f.commands[1]?.body);
  const next = createRenameAttempt({ ...current.target, handle: 'after' }, 'next')!;
  expect(await nativeRenameSource.stepUp(next)).toBe(false);
  expect(f.navigations).toEqual([]);
  expect(await nativeRenameSource.stepUp(attempt)).toBe(true);
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

test('native projection and production reader retain maximal identities, eight actions and every union branch', async () => {
  const f = fixture();
  f.state.handle = 'A'.repeat(64);
  f.state.proof = { ...human, authn_epoch: Number.MAX_SAFE_INTEGER, auth_time: Number.MAX_SAFE_INTEGER, amr: ['pop'] };
  f.state.count = 8;
  f.state.route = Number.MIN_SAFE_INTEGER;
  expect(await nativeRenameSource.readCurrent()).toMatchObject({ kind: 'ready', target: { handle: f.state.handle } });
  const emitted = await f.handler(pageRequest());
  expect((await emitted.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(RENAME_PAGE_MAX_RESPONSE_BYTES);
  expect((await emitted.json()).authActions.operations).toHaveLength(8);
  f.state.unrelated = true;
  expect((await (await f.handler(pageRequest())).json()).authActions.operations).toHaveLength(7);
  f.state.unrelated = false;
  f.state.route = Number.MAX_SAFE_INTEGER;
  expect((await nativeRenameSource.readCurrent()).kind).toBe('ready');
  f.state.actionsAvailable = false;
  expect(await nativeRenameSource.readCurrent()).toMatchObject({ kind: 'unavailable', target: { accountId } });
  f.state.actionsAvailable = true;
  f.state.count = 0;
  // Opaque historical identity copies may contain maximal JSON escapes or UTF-8.
  for (const id of ['\u0000'.repeat(RENAME_PAGE_MAX_ID_LENGTH), 'é'.repeat(RENAME_PAGE_MAX_ID_LENGTH)]) {
    f.state.selected = id;
    f.state.proof = { ...f.state.proof, account_id: id };
    const response = await f.handler(pageRequest());
    expect((await response.clone().arrayBuffer()).byteLength).toBeLessThanOrEqual(RENAME_PAGE_MAX_RESPONSE_BYTES);
    expect((await response.json()).viewer.accountId).toBe(id);
    expect(await nativeRenameSource.readCurrent()).toMatchObject({ kind: 'refused', target: { accountId: id } });
  }
  f.state.selected += 'x';
  f.state.proof = { ...human, account_id: f.state.selected };
  expect(await nativeRenameSource.readCurrent()).toEqual({ kind: 'unavailable' });
  f.state.selected = accountId;
  f.state.proof = { ...human, client_id: 'login' };
  expect(await nativeRenameSource.readCurrent()).toEqual({ kind: 'management-auth-required', accountId });
  f.state.proof = human;
  f.state.nativeStatus = 403;
  expect(await nativeRenameSource.readCurrent()).toEqual({ kind: 'refused' });
  f.state.nativeStatus = 0;
  f.state.sessionStatus = 401;
  expect(await nativeRenameSource.readCurrent()).toEqual({ kind: 'signed-out' });
  expect(f.commands).toHaveLength(0);
});

test('production byte admission ignores header allowances, decodes split UTF-8, and preserves unresolved commands', async () => {
  const f = fixture();
  const transport = globalThis.fetch;
  const legal = await (await f.handler(pageRequest())).text();
  const attempt = createRenameAttempt({ accountId, handle: null }, 'next')!;
  attempt.submitted = true;
  expect(saveRenameContinuation(attempt)).toBe(true);
  const retained = [...f.stored];
  let bytes = new TextEncoder().encode(legal);
  let headers: Record<string, string> = {};
  globalThis.fetch = (async (path, init) =>
    path !== '/account-management/rename-page'
      ? transport(path, init)
      : new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
              controller.close();
            },
          }),
          { headers },
        )) as typeof fetch;
  // Whitespace pads a legal DTO to the exact allowance; the first extra byte fails.
  for (const length of [RENAME_PAGE_MAX_RESPONSE_BYTES, RENAME_PAGE_MAX_RESPONSE_BYTES + 1]) {
    bytes = new TextEncoder().encode(legal.padEnd(length));
    for (const announced of [undefined, '1', String(length)]) {
      headers = announced === undefined ? {} : { 'content-length': announced, 'x-response-budget': '999999999' };
      expect((await nativeRenameSource.readCurrent()).kind).toBe(
        length === RENAME_PAGE_MAX_RESPONSE_BYTES ? 'ready' : 'unavailable',
      );
    }
  }
  for (const invalid of [new Uint8Array([0xff]), new TextEncoder().encode('{')]) {
    bytes = invalid;
    headers = {};
    expect(await nativeRenameSource.run(attempt)).toEqual({ kind: 'unknown', current: { kind: 'unavailable' } });
  }
  f.state.count = 0;
  f.state.selected = 'é';
  f.state.proof = { ...human, account_id: 'é' };
  bytes = new TextEncoder().encode(await (await f.handler(pageRequest())).text());
  expect((await nativeRenameSource.readCurrent()).kind).toBe('refused');
  expect(f.commands).toHaveLength(0);
  expect([...f.stored]).toEqual(retained);
});

test('stalled bodies and caller retirement cancel production receiving without dispatch or stale advice', async () => {
  const f = fixture();
  const transport = globalThis.fetch;
  let started!: () => void;
  let cancelled = 0;
  globalThis.fetch = (async (path, init) =>
    path !== '/account-management/rename-page'
      ? transport(path, init)
      : new Response(
          new ReadableStream({
            start() {
              started();
            },
            cancel() {
              cancelled++;
            },
          }),
        )) as typeof fetch;
  const caller = new AbortController();
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const retired = nativeRenameSource.readCurrent(caller.signal);
  await entered;
  f.state.proof = { ...human, account_id: otherId };
  caller.abort();
  expect(await retired).toEqual({ kind: 'unavailable' });
  started = () => {};
  expect(await nativeRenameSource.readCurrent()).toEqual({ kind: 'unavailable' });
  expect(cancelled).toBe(2);
  expect(f.commands).toHaveLength(0);
}, 10000);
