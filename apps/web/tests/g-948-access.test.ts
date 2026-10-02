import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { spaceAccessApi, type JoinDecision, type JoinWithdraw } from '../features/manage/settings-api.ts';
import { accessActor, accessInitial, requestFixture } from '../features/manage/settings-fixtures.ts';
import { emptyRequestJournal, parseRequestJournal, requestStorageKey, type RequestJournal } from '../features/space-access/request-state.ts';

interface Call { path: string; method: string; body: unknown; key: string | null }
function client(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const call = { path: new URL(String(input)).pathname, method: options?.method ?? 'GET',
      body: options?.body ? JSON.parse(String(options.body)) as unknown : null,
      key: new Headers(options?.headers).get('idempotency-key') };
    calls.push(call); return handler(call);
  }) as typeof fetch;
  const main = treaty<MainApp>('http://main.test', { fetcher });
  return { calls, api: spaceAccessApi(() => main, accessInitial.space, accessInitial.realm, accessActor) };
}
const decision: JoinDecision = { actingSubject: accessActor, expectedGeneration: '12',
  expectedRequestGeneration: '0', decision: 'accepted', reason: 'Welcome' };
const withdraw: JoinWithdraw = { actingSubject: accessActor, expectedRequestGeneration: '0', reason: 'Plans changed' };

for (const state of ['accepted', 'declined'] as const) {
  test(`G-948: ${state} uses the decision command, never generic membership consent`, async () => {
    const { api, calls } = client(() => Response.json({ state, requestGeneration: '1', generation: '13' }));
    const command = { ...decision, decision: state };
    expect(await api.decide(requestFixture.id, command, 'decision-intent')).toMatchObject({ ok: true, data: { state } });
    expect(calls).toEqual([{ path: `/v1/realms/${accessInitial.realm.slice(-36)}/join-requests/${requestFixture.id}/decisions`,
      method: 'POST', body: command, key: 'decision-intent' }]);
    expect(calls[0]!.body).not.toHaveProperty('consent');
  });
}
test('G-948: lost decision responses retry the exact generations and key', async () => {
  let attempt = 0;
  const { api, calls } = client(() => {
    if (attempt++ === 0) throw new Error('Lost response');
    return Response.json({ state: 'accepted', replayed: true, generation: '13' });
  });
  expect(await api.decide(requestFixture.id, decision, 'lost-decision')).toEqual({ ok: false, failure: 'unavailable' });
  expect(await api.decide(requestFixture.id, decision, 'lost-decision')).toMatchObject({ ok: true, data: { replayed: true } });
  expect(calls[1]).toEqual(calls[0]);
});
test('G-948: a stale decision remains refused until the caller reviews a fresh generation', async () => {
  const { api, calls } = client(call => {
    const input = call.body as JoinDecision;
    return input.expectedGeneration === '12' ? Response.json({ code: 'stale_realm_management_basis' }, { status: 409 })
      : Response.json({ state: 'declined', generation: '14' });
  });
  expect(await api.decide(requestFixture.id, decision, 'stale-decision')).toMatchObject({ ok: false, failure: 'stale' });
  expect(calls).toHaveLength(1); // No adapter retry can approve against unseen authority.
  expect(await api.decide(requestFixture.id, { ...decision, expectedGeneration: '13', decision: 'declined' }, 'reviewed-decision'))
    .toMatchObject({ ok: true, data: { state: 'declined' } });
});
test('G-948: withdrawal cites the request generation without requiring manager or settings authority', async () => {
  const { api, calls } = client(() => Response.json({ state: 'withdrawn', requestGeneration: '1' }));
  expect(await api.withdraw(requestFixture.id, withdraw, 'withdraw-intent')).toMatchObject({ ok: true, data: { state: 'withdrawn' } });
  expect(calls).toEqual([{ path: `/v1/realms/${accessInitial.realm.slice(-36)}/join-requests/${requestFixture.id}/withdraw`,
    method: 'POST', body: withdraw, key: 'withdraw-intent' }]);
});
for (const [status, code, failure] of [[403, 'realm_management_denied', 'denied'],
  [409, 'stale_realm_management_basis', 'stale'], [409, 'idempotency_conflict', 'conflict'],
  [503, 'realm_management_unavailable', 'unavailable']] as const) {
  test(`G-948: withdrawal preserves ${failure} as a failed outcome`, async () => {
    const { api } = client(() => Response.json({ code }, { status }));
    expect(await api.withdraw(requestFixture.id, withdraw, 'withdraw-intent')).toEqual({ ok: false, failure, code });
  });
}
for (const state of ['pending', 'declined', 'withdrawn', 'accepted'] as const) {
  test(`G-948: the last confirmed ${state} receipt survives reload without being promoted to live status`, () => {
    const journal: RequestJournal = { ...emptyRequestJournal(), receipt: { requestId: requestFixture.id,
      requestGeneration: state === 'pending' ? '0' : '1', state } };
    expect(parseRequestJournal(JSON.stringify(journal), accessActor)).toEqual(journal);
    expect(journal.receipt).not.toHaveProperty('expiresAt');
  });
}
test('G-948: a reload retains exact request and withdrawal retry intents', () => {
  const journal: RequestJournal = { draftReason: 'I accept the rules', receipt: { requestId: requestFixture.id, state: 'pending', requestGeneration: '0' },
    requestIntent: { key: 'request-lost-response', command: { actingSubject: accessActor, expectedMembershipGeneration: '4',
      expectedPolicyRevision: '12', termsRevision: 'rules-3', reason: 'I accept the rules' } },
    withdrawIntent: { key: 'withdraw-lost-response', request: requestFixture.id, command: withdraw } };
  expect(parseRequestJournal(JSON.stringify(journal), accessActor)).toEqual(journal);
  expect(parseRequestJournal(JSON.stringify(journal), `${accessActor}-other`)).toEqual(emptyRequestJournal());
  expect(requestStorageKey(accessInitial.realm, accessActor)).not.toBe(requestStorageKey(accessInitial.space, accessActor));
  expect(requestStorageKey(accessInitial.realm, accessActor)).not.toBe(requestStorageKey(accessInitial.realm, `${accessActor}-other`));
});
test('G-948: malformed cache data cannot supply a request identity or retry intent', () => {
  for (const raw of ['{', 'null', '{}', JSON.stringify({ ...emptyRequestJournal(), receipt: { requestId: 'not-a-request',
    requestGeneration: '0', state: 'pending' } }), JSON.stringify({ ...emptyRequestJournal(), requestIntent: {
    key: 'intent', command: { ...decision, reason: '' } } })]) {
    expect(parseRequestJournal(raw, accessActor)).toEqual(emptyRequestJournal());
  }
});

test('G-948: refreshing changed admission rules retains the reason without retrying a stale command', () => {
  const journal: RequestJournal = { ...emptyRequestJournal(), draftReason: 'I accept the community rules. 文学' };
  expect(parseRequestJournal(JSON.stringify(journal), accessActor)).toEqual(journal);
  expect(parseRequestJournal(JSON.stringify({ ...journal, draftReason: 'x'.repeat(2001) }), accessActor)).toEqual(emptyRequestJournal());
});
