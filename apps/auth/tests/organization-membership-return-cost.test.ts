import { expect, test } from 'bun:test';

test('fresh submit and exact retry charge native preparations without reapproval or payload replacement', async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
import { expect, mock } from 'bun:test';
mock.module('@tanstack/react-start', () => ({ createServerOnlyFn: fn => fn, createServerFn: () => {
  const builder = { validator() { return builder; }, handler(fn) { return () => fn(); } }; return builder;
} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://auth.test/bff', { headers: { origin: 'https://auth.test' } }),
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({ env: { AUTH_SECURITY_SCOPE_CONFIGURATION: 'native-no-catalogue' } }));
const { membershipProfile, newMembershipCommand, submitMembership, saveMembershipCommand, readMembershipCommand } = await import('./apps/auth/src/organization-membership');
  const [accountId, organizationId, memberAccountId] = [1, 2, 3].map((n) => \`00000000-0000-4000-8000-00000000000\${n}\`);
  const command = newMembershipCommand(accountId!, {
    kind: 'membership',
    organizationId: organizationId!,
    memberAccountId: memberAccountId!,
    role: 'owner',
    reservationId: '00000000-0000-4000-8000-000000000004',
  });
  const profile = membershipProfile()!;
  const storage = new Map<string, string>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const calls: { path: string; body: unknown }[] = [];
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    },
  });
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input), 'https://auth.test').pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (path === '/session')
      return Response.json({ account_id: accountId, client_id: profile.client_id, scope: profile.scope });
    if (path.endsWith('/member'))
      return Response.json({
        organizationId,
        memberAccountId,
        membership: { role: 'member', reservationId: '00000000-0000-4000-8000-000000000004' },
      });
    if (path.endsWith('/approve'))
      return Response.json({ reference: 'native-reference', expiresAt: new Date(Date.now() + 60000).toISOString() });
    return Response.json({}, { status: 503 });
  }) as typeof fetch;
  try {
    expect(saveMembershipCommand(command)).toBe(true);
    expect(await submitMembership(command)).toBe('unknown');
    expect(calls.map((call) => call.path)).toEqual([
      '/session',
      '/account-management/organizations/member',
      '/account-operations/approve',
      '/account-operations/execute',
    ]);
    const submitted = calls.at(-1)!.body;
    calls.length = 0;
    expect(await submitMembership(command)).toBe('unknown');
    expect(calls.map((call) => call.path)).toEqual([
      '/session',
      '/account-management/organizations/member',
      '/account-operations/execute',
    ]);
    expect(calls.at(-1)!.body).toEqual(submitted);
    const ordinaryFetch = globalThis.fetch;
    for (const [response, expected, unresolved] of [
      [() => Response.json({ accountId: memberAccountId }), 'acknowledged', true],
      [() => Response.json({ accountId }), 'unknown', true],
      [() => new Response('{'), 'unknown', true],
      [() => Response.json({ accountId: 'x'.repeat(25000) }), 'unknown', true],
      [() => Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status: 409 }), 'conflict', false],
      [() => Response.json({ error: 'step_up_required', effect_status: 'not_applied' }, { status: 401 }), 'step-up', false],
      [() => Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status: 503 }), 'unavailable', false],
      [() => Response.json({ error: 'account_operation_denied' }, { status: 409 }), 'unknown', true],
    ] as const) {
      const attempt = newMembershipCommand(accountId!, command.operation);
      saveMembershipCommand(attempt);
      globalThis.fetch = ((input, init) => String(input).endsWith('/execute') ? response() : ordinaryFetch(input, init)) as typeof fetch;
      expect(await submitMembership(attempt)).toBe(expected);
      expect(readMembershipCommand()).toMatchObject({ unresolved });
    }
    const refused = newMembershipCommand(accountId!, command.operation);
    refused.reference = command.reference;
    saveMembershipCommand(refused);
    const executionsBeforeChangedReservation = calls.filter(c => c.path.endsWith('/execute')).length;
    globalThis.fetch = ((input, init) => String(input).endsWith('/member')
      ? Response.json({ organizationId, memberAccountId, membership: { role: 'member', reservationId: accountId } })
      : ordinaryFetch(input, init)) as typeof fetch;
    expect(await submitMembership(refused)).toBe('conflict');
    expect(calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(executionsBeforeChangedReservation);
    globalThis.fetch = ((input, init) => String(input).endsWith('/approve')
      ? Response.json({ reference: 'x'.repeat(4097), expiresAt: new Date(Date.now() + 60000).toISOString() })
      : ordinaryFetch(input, init)) as typeof fetch;
    const excess = newMembershipCommand(accountId!, command.operation);
    saveMembershipCommand(excess);
    const before = calls.filter(c => c.path.endsWith('/execute')).length;
    expect(await submitMembership(excess)).toBe('unavailable');
    expect(calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(before);

    const displaced = newMembershipCommand(accountId!, command.operation);
    const replacement = newMembershipCommand(accountId!, command.operation);
    saveMembershipCommand(displaced);
    globalThis.fetch = ((input, init) => {
      if (String(input).endsWith('/approve')) saveMembershipCommand(replacement);
      return ordinaryFetch(input, init);
    }) as typeof fetch;
    expect(await submitMembership(displaced)).toBe('unavailable');
    expect(readMembershipCommand()).toEqual(replacement);
    expect(calls.filter(c => c.path.endsWith('/execute'))).toHaveLength(before);

    // Shared stream tests cover the byte matrix. Here pin the membership POST's
    // lifetime through a stalled body and ignored-abort headers, without waiting five seconds.
    const timer = globalThis.setTimeout;
    let expire!: () => void;
    globalThis.setTimeout = ((callback, delay) => {
      if (delay === 5000) expire = callback as () => void;
      return timer(() => {}, 60000);
    }) as typeof setTimeout;
    try {
      for (const stalledBody of [true, false]) {
        let reachedExecute!: () => void;
        const dispatch = new Promise<void>(resolve => { reachedExecute = resolve; });
        let release!: (r: Response) => void;
        const late = new Promise<Response>(resolve => { release = resolve; });
        globalThis.fetch = ((input, init) => {
          if (!String(input).endsWith('/execute')) return ordinaryFetch(input, init);
          if (!stalledBody) { reachedExecute(); return late; }
          return new Response(new ReadableStream({
            pull() { reachedExecute(); return new Promise(() => {}); }, cancel() {},
          }, { highWaterMark: 0 }));
        }) as typeof fetch;
        const attempt = newMembershipCommand(accountId!, command.operation);
        saveMembershipCommand(attempt);
        const pending = submitMembership(attempt);
        await dispatch;
        expire();
        expect(await pending).toBe('unknown');
        const saved = readMembershipCommand();
        release(Response.json({ accountId: memberAccountId }));
        await Promise.resolve();
        expect(readMembershipCommand()).toEqual(saved);
      }
    } finally { globalThis.setTimeout = timer; }

  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  `,
    ],
    { cwd: `${import.meta.dir}/../../..`, stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, out + err).toBe(0);
});
