import { afterEach, expect, test } from 'bun:test';
import { createRenameAttempt, nativeRenameSource, RENAME_PROFILE, readRenameContinuation } from '../src/account-rename';

const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function fixture() {
  const storage = new Map<string, string>(),
    calls: string[] = [];
  const viewer = {
    accountId: 'account',
    kind: 'actor',
    clientId: RENAME_PROFILE.client_id,
    scopes: ['account:update'],
    authnEpoch: 1,
    authTime: 1,
    amr: ['pwd'],
  };
  const state = { handle: 'before', malformed: false, acknowledged: false, expired: false };
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
  globalThis.fetch = (async (path, init) => {
    calls.push(String(path));
    if (path === '/session') return Response.json({ account_id: viewer.accountId });
    if (path === '/account-management/rename-page')
      return Response.json(
        state.malformed
          ? { state: 'ready' }
          : {
              state: 'ready',
              viewer,
              profile: { id: viewer.accountId, kind: 'actor', handle: state.handle },
              authActions: {
                state: 'ready',
                operations: [
                  {
                    operationId: 'auth.account.rename',
                    action: 'account:update',
                    resource: { route: 1, id: viewer.accountId },
                  },
                ],
              },
            },
      );
    const body = JSON.parse(String(init?.body));
    expect(body.operationKey).toBe(selected.operationKey);
    expect(body.operation).toEqual(selected.operation);
    if (String(path).endsWith('/approve'))
      return Response.json({ reference: 'reference', expiresAt: new Date(Date.now() + 60000).toISOString() });
    if (state.expired) return Response.json({ accountId: viewer.accountId, expired: true });
    state.handle = 'after';
    return state.acknowledged ? Response.json({ accountId: viewer.accountId }) : new Response(null, { status: 503 });
  }) as typeof fetch;
  const selected = createRenameAttempt({ accountId: 'account', handle: 'before' }, 'after')!;
  return { state, calls, selected };
}

test('installed source bounds review, unknown retry and acknowledged readback without attributing matching observations', async () => {
  const f = fixture();
  expect((await nativeRenameSource.readCurrent()).kind).toBe('ready');
  expect(f.calls.splice(0)).toEqual(['/session', '/account-management/rename-page']);
  expect((await nativeRenameSource.run(f.selected)).kind).toBe('unknown');
  expect(f.calls.splice(0)).toHaveLength(4);
  expect((await nativeRenameSource.run(f.selected)).kind).toBe('unknown');
  expect(f.calls.splice(0)).toHaveLength(3);
  expect(readRenameContinuation()?.submitted).toBe(true);
  f.state.acknowledged = true;
  expect((await nativeRenameSource.run(f.selected)).kind).toBe('renamed');
  expect(f.calls.splice(0)).toHaveLength(5);
  f.state.malformed = true;
  expect((await nativeRenameSource.readCurrent()).kind).toBe('unavailable');
  expect(f.calls).toEqual(['/session', '/account-management/rename-page']);
});

test('a complete acknowledged turn has six calls; aborting a released session read starts no profile read', async () => {
  const f = fixture();
  f.state.acknowledged = true;
  expect((await nativeRenameSource.run(f.selected)).kind).toBe('renamed');
  expect(f.calls).toHaveLength(6);
  const abort = new AbortController();
  let release!: (response: Response) => void;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      release = resolve;
    })) as typeof fetch;
  const pending = nativeRenameSource.readCurrent(abort.signal);
  await Promise.resolve();
  await Promise.resolve();
  abort.abort();
  release(Response.json({ account_id: 'account' }));
  expect(await pending).toEqual({ kind: 'unavailable' });
});

test('expired approval discards only its reference and exact retry obtains native approval with the same key', async () => {
  const f = fixture();
  f.selected.reference = 'expired';
  f.state.expired = true;
  expect((await nativeRenameSource.run(f.selected)).kind).toBe('unknown');
  expect(f.selected.reference).toBeUndefined();
  expect(readRenameContinuation()?.operationKey).toBe(f.selected.operationKey);
  f.calls.length = 0;
  f.state.expired = false;
  f.state.acknowledged = true;
  expect((await nativeRenameSource.run(f.selected)).kind).toBe('renamed');
  expect(f.calls).toHaveLength(6);
});
