import { expect, test } from 'bun:test';

if (!process.env.RENAME_COST_CHILD) {
  test('installed rename transport costs with the admitted common session BFF', async () => {
    const child = Bun.spawn([process.execPath, 'test', import.meta.path], {
      env: { ...process.env, RENAME_COST_CHILD: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, out + err).toBe(0);
  });
} else {
  const nativeReference = 'AQ.' + 'a'.repeat(43);
  const { afterEach } = await import('bun:test');
  const { mock } = await import('bun:test');
  let currentSignal: AbortSignal | undefined;
  mock.module('@tanstack/react-start', () => ({
    createServerOnlyFn: (fn: unknown) => fn,
    createServerFn: () => ({
      handler: (fn: (input: unknown) => unknown) => (options?: { signal?: AbortSignal }) => {
        currentSignal = options?.signal;
        return fn({ signal: currentSignal });
      },
    }),
  }));
  mock.module('cloudflare:workers', () => ({ env: { AUTH_SECURITY_SCOPE_CONFIGURATION: 'catalogue:4' } }));
  mock.module('@tanstack/react-start/server', () => ({
    getRequest: () =>
      new Request('https://auth.test/session', {
        headers: { origin: 'https://auth.test' },
        signal: currentSignal,
      }),
    setResponseHeader() {},
  }));
  const { createRenameAttempt, nativeRenameSource, RENAME_PROFILE, readRenameContinuation } =
    await import('../src/account-rename');

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
      accountId: '00000000-0000-4000-8000-000000000001',
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
      path = new URL(String(path), 'https://auth.test').pathname;
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
        return Response.json({ reference: nativeReference, expiresAt: new Date(Date.now() + 60000).toISOString() });
      if (state.expired) return Response.json({ accountId: viewer.accountId, expired: true });
      state.handle = 'after';
      return state.acknowledged ? Response.json({ accountId: viewer.accountId }) : new Response(null, { status: 503 });
    }) as typeof fetch;
    const selected = createRenameAttempt(
      { accountId: '00000000-0000-4000-8000-000000000001', handle: 'before' },
      'after',
    )!;
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
    const started = Promise.withResolvers<void>();
    globalThis.fetch = (() =>
      new Promise<Response>((resolve) => {
        release = resolve;
        started.resolve();
      })) as typeof fetch;
    const pending = nativeRenameSource.readCurrent(abort.signal);
    await started.promise;
    abort.abort();
    release(Response.json({ account_id: '00000000-0000-4000-8000-000000000001' }));
    expect(await pending).toEqual({ kind: 'unavailable' });
  });

  test('incompatible terminal output stays unknown and expired live reference renews only on exact retry', async () => {
    const f = fixture();
    f.selected.reference = 'expired';
    f.state.expired = true;
    expect((await nativeRenameSource.run(f.selected)).kind).toBe('unknown');
    expect(f.selected.reference).toBe('expired');
    f.selected.referenceExpiresAt = new Date(Date.now() - 1).toISOString();
    expect(readRenameContinuation()?.operationKey).toBe(f.selected.operationKey);
    f.calls.length = 0;
    f.state.expired = false;
    f.state.acknowledged = true;
    expect((await nativeRenameSource.run(f.selected)).kind).toBe('renamed');
    expect(f.calls).toHaveLength(6);
  });
}
