import { expect, test } from 'bun:test';
import { membershipProfile, newMembershipCommand, submitMembership } from '../src/organization-membership';

test('fresh submit and exact retry charge native preparations without reapproval or payload replacement', async () => {
  const [accountId, organizationId, memberAccountId] = [1, 2, 3].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
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
    const path = String(input);
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
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
