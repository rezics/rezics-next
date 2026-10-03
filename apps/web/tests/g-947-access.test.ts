import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { uiLocales } from '../i18n/define.ts';
import { accessMessages } from '../features/manage/settings-messages.ts';
import { listingApi, readManagementAccess, readPrivateSpaceJoinPage, readRequestsAtAddress, sameSpaceSettings, spaceAccessApi } from '../features/manage/settings-api.ts';
import { accessActor, accessInitial, requestFixture } from '../features/manage/settings-fixtures.ts';
import { spaceDiscoveryHeaders } from '../features/space-access/discovery.tsx';

interface Call { path: string; query: URLSearchParams; method: string; body: Record<string, unknown>; key: string | null }
function client(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(String(input));
    const call = { path: url.pathname, query: url.searchParams, method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {},
      key: new Headers(options?.headers).get('idempotency-key') };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { main: treaty<MainApp>('http://main.test', { fetcher }), calls };
}
const ok = (data: unknown) => Response.json(data);
const denied = () => Response.json({ code: 'realm_management_denied' }, { status: 403 });

test('G-947: one settings command carries all four independent choices and its revision', async () => {
  const { main, calls } = client(() => ok(accessInitial));
  const api = spaceAccessApi(() => main, accessInitial.space, accessInitial.realm, accessActor);
  const command = { actingSubject: accessActor, expectedGeneration: '12', reason: 'Members only',
    settings: { visibility: 'private' as const, listing: 'unlisted' as const, history: 'from-admission' as const, admission: 'request' as const } };
  expect((await api.save(command, 'settings-intent')).ok).toBe(true);
  expect(calls[0]).toMatchObject({ path: `/v1/spaces/${accessInitial.space.slice(-36)}/settings`,
    method: 'PUT', body: command, key: 'settings-intent' });
  for (const [field, value] of Object.entries(command.settings)) {
    expect(sameSpaceSettings(accessInitial.settings, { ...accessInitial.settings, [field]: value })).toBe(field === 'admission');
  }
});

test('G-947: pending requests use the owner continuation and decisions cite its generations', async () => {
  const { main, calls } = client(call => call.method === 'GET'
    ? ok({ generation: '12', items: [requestFixture], nextCursor: requestFixture.id, complete: false })
    : ok({ receiptId: 'receipt', replayed: false }));
  const api = spaceAccessApi(() => main, accessInitial.space, accessInitial.realm, accessActor);
  await api.requests(requestFixture.id);
  expect(calls[0]!.query.get('cursor')).toBe(requestFixture.id);
  expect(calls[0]!.query.get('actingSubject')).toBe(accessActor);
  await api.decide(requestFixture.id, { actingSubject: accessActor, expectedGeneration: '12',
    expectedRequestGeneration: requestFixture.requestGeneration, decision: 'accepted', reason: 'Welcome' }, 'approval-intent');
  expect(calls[1]).toMatchObject({ path: `/v1/realms/${accessInitial.realm.slice(-36)}/join-requests/${requestFixture.id}/decisions`,
    method: 'POST', key: 'approval-intent', body: { decision: 'accepted', expectedRequestGeneration: '0', expectedGeneration: '12' } });
  expect(calls.some(call => call.path.endsWith('/members') || call.path.endsWith('/settings'))).toBe(false);
});

test('G-947: listing is separate from profile content and reports version conflicts', async () => {
  const { main, calls } = client(call => call.method === 'GET' ? ok({ listing: 'listed', version: 7, changedAt: null })
    : Response.json({ code: 'stale_agent_listing' }, { status: 409 }));
  const api = listingApi(() => main, accessActor);
  expect(await api.read()).toMatchObject({ ok: true, data: { version: 7 } });
  expect(await api.save('unlisted', 7, 'listing-intent')).toMatchObject({ ok: false, failure: 'stale' });
  expect(calls[1]).toMatchObject({ method: 'PUT', body: { listing: 'unlisted', expectedVersion: 7 }, key: 'listing-intent' });
  expect(calls[1]!.path).toBe(`/v1/agents/${accessActor.slice(-36)}/listing`);
});

test('G-947: a legacy settings address resolves the Realm to its distinct Space', async () => {
  const { main, calls } = client(call => {
    if (call.path === `/v1/realms/${accessInitial.realm.slice(-36)}`) return ok({ space: accessInitial.space });
    return call.path.includes(accessInitial.space.slice(-36)) ? ok(accessInitial) : denied();
  });
  const result = await readManagementAccess(main, accessInitial.realm, accessActor);
  expect(result).toMatchObject({ ok: true, data: { space: accessInitial.space } });
  expect(calls[1]!.query.get('actingSubject')).toBe(accessActor);
  expect(calls.at(-1)!.path).toBe(`/v1/spaces/${accessInitial.space.slice(-36)}/settings`);
});

test('G-947: a request-only manager can open the legacy inbox without a settings grant', async () => {
  const { main, calls } = client(call => call.path.endsWith('/join-requests') ? ok({ items: [], nextCursor: null, complete: true }) : denied());
  expect(await readRequestsAtAddress(main, accessInitial.realm, accessActor)).toMatchObject({ ok: true, data: { page: { items: [] } } });
  expect(calls.some(call => call.path.endsWith('/settings'))).toBe(false);
});

test('G-947: join submission preserves policy, membership and terms revisions', async () => {
  const { main, calls } = client(() => ok({ requestId: requestFixture.id, state: 'pending', requestGeneration: '0', replayed: false }));
  const api = spaceAccessApi(() => main, accessInitial.space, accessInitial.realm, accessActor);
  const command = { actingSubject: accessActor, expectedMembershipGeneration: '4', expectedPolicyRevision: '12',
    termsRevision: 'rules-3', reason: 'I agree to the rules.' };
  expect((await api.request(command, 'join-intent')).ok).toBe(true);
  expect(calls[0]).toMatchObject({ body: command, key: 'join-intent', method: 'POST' });
});

test('G-947: the outsider router reads Main’s join page without requiring an identity', async () => {
  const { main, calls } = client(() => ok({ profile: 'realm-join-page-v1' }));
  expect((await readPrivateSpaceJoinPage(main, accessInitial.realm)).ok).toBe(true);
  expect(calls[0]!.path).toBe(`/v1/realms/${accessInitial.realm.slice(-36)}/join-page`);
  expect(calls[0]!.query.has('actingSubject')).toBe(false);
});

test('G-947: router response policies follow Main and all eight locales carry every consequence', () => {
  expect(spaceDiscoveryHeaders({ indexable: false, robots: 'noindex', referrerPolicy: 'no-referrer' }))
    .toEqual({ 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  expect(spaceDiscoveryHeaders({ indexable: true, robots: 'index', referrerPolicy: null })).toEqual({});
  const keys = Object.keys(accessMessages.en).sort();
  for (const locale of uiLocales) {
    expect(Object.keys(accessMessages[locale]).sort()).toEqual(keys);
    for (const value of Object.values(accessMessages[locale])) expect(value.trim().length).toBeGreaterThan(0);
    if (locale !== 'en') expect(accessMessages[locale].privateHelp).not.toBe(accessMessages.en.privateHelp);
  }
});
