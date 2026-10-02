import { expect, test } from 'bun:test';
import { treaty } from '@elysia/eden';
import type { MainApp } from '@rezics/main/app';
import { spaceAccessApi, type JoinDecision, type JoinWithdraw, type OwnRequestPage } from '../features/manage/settings-api.ts';
import { accessActor, accessInitial, requestFixture, ownRequestFixture } from '../features/manage/settings-fixtures.ts';
import { emptyRequestJournal, journalAfterStatus, parseRequestJournal, readOwnRequest, requestStorageKey, type RequestJournal } from '../features/space-access/request-state.ts';

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
test('G-948: legacy cached receipts are discarded on reload', () => {
  for (const state of ['pending', 'declined', 'withdrawn', 'accepted']) {
    const cached = { ...emptyRequestJournal(), receipt: { requestId: requestFixture.id, requestGeneration: '0', state } };
    expect(parseRequestJournal(JSON.stringify(cached), accessActor)).toEqual(emptyRequestJournal());
  }
});
test('G-948: a reload retains exact request and withdrawal retry intents', () => {
  const journal: RequestJournal = { draftReason: 'I accept the rules',
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


test('G-948: inbox search sends q and the opaque cursor together, without the legacy after alias', async () => {
  const queries: URLSearchParams[] = [];
  const main = treaty<MainApp>('http://main.test', { fetcher: (async (input: RequestInfo | URL) => {
    queries.push(new URL(String(input)).searchParams);
    return Response.json({ generation: '12', items: [], nextCursor: null, complete: true });
  }) as typeof fetch });
  const api = spaceAccessApi(() => main, accessInitial.space, accessInitial.realm, accessActor);
  await api.requests(null, '林 梅');
  await api.requests('opaque-search-context', '林 梅');
  expect(queries[0]!.get('q')).toBe('林 梅');
  expect(queries[0]!.has('cursor')).toBe(false);
  expect(queries[1]!.get('cursor')).toBe('opaque-search-context');
  expect(queries[1]!.get('q')).toBe('林 梅');
  expect(queries[1]!.has('after')).toBe(false);
});

test('G-948: requester status uses mine and only the current acting subject', async () => {
  const queries: URLSearchParams[] = [];
  const main = treaty<MainApp>('http://main.test', { fetcher: (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/v1/realms/${accessInitial.realm.slice(-36)}/join-requests/mine`);
    queries.push(url.searchParams); return Response.json(ownRequestFixture('declined'));
  }) as typeof fetch });
  const api = spaceAccessApi(() => main, accessInitial.space, accessInitial.realm, accessActor);
  expect(await api.mine('opaque-own-context')).toMatchObject({ ok: true, data: { complete: true } });
  expect(queries[0]!.get('actingSubject')).toBe(accessActor);
  expect(queries[0]!.get('cursor')).toBe('opaque-own-context');
  expect(queries[0]!.has('q')).toBe(false);
});

for (const state of ['pending', 'accepted', 'declined', 'withdrawn'] as const) {
  test(`G-948: authoritative ${state} status replaces browser receipt state`, async () => {
    const { api } = client(() => Response.json(ownRequestFixture(state)));
    expect(await readOwnRequest(api)).toMatchObject({ ok: true, data: { state, id: requestFixture.id } });
  });
}

test('G-948: own history is fully traversed; UUID order cannot select an older terminal result', async () => {
  const cursors: (string | null)[] = [];
  const first = ownRequestFixture('withdrawn').items[0]!;
  const newest = { ...first, id: '00000000-0000-4000-8000-000000000022', state: 'declined' as const, createdAt: '2026-10-03T08:00:00Z' };
  const oldest = { ...first, id: '00000000-0000-4000-8000-000000000023', createdAt: '2026-10-01T08:00:00Z' };
  expect(await readOwnRequest({ mine: async cursor => {
    cursors.push(cursor);
    return { ok: true, data: cursor ? { items: [newest, oldest], nextCursor: null, complete: true }
      : { items: [first], nextCursor: 'next-own-page', complete: false } };
  } })).toEqual({ ok: true, data: newest });
  expect(cursors).toEqual([null, 'next-own-page']);
});

test('G-948: a pending request takes precedence over terminal history on another page', async () => {
  const pending = ownRequestFixture('pending').items[0]!;
  expect(await readOwnRequest({ mine: async cursor => ({ ok: true, data: cursor ? ownRequestFixture('pending')
    : { ...ownRequestFixture('declined'), nextCursor: 'next-own-page', complete: false } }) }))
    .toEqual({ ok: true, data: pending });
});

test('G-948: moved own-history cursors restart once without retaining a partial result', async () => {
  const cursors: (string | null)[] = [];
  expect(await readOwnRequest({ mine: async cursor => {
    cursors.push(cursor);
    if (cursors.length === 2) return { ok: false, failure: 'stale' };
    return { ok: true, data: cursors.length === 1 ? { ...ownRequestFixture('pending'), nextCursor: 'old-context', complete: false }
      : ownRequestFixture('declined') };
  } })).toMatchObject({ ok: true, data: { state: 'declined' } });
  expect(cursors).toEqual([null, 'old-context', null]);
  expect(await readOwnRequest({ mine: async () => ({ ok: false, failure: 'stale' }) })).toEqual({ ok: false, failure: 'stale' });
});

test('G-948: denied, unavailable and broken continuation reads never become cached pending status', async () => {
  for (const failure of ['denied', 'unavailable'] as const) {
    expect(await readOwnRequest({ mine: async () => ({ ok: false, failure }) })).toEqual({ ok: false, failure });
  }
  for (const nextCursor of [null, 'repeated-cursor']) {
    const data: OwnRequestPage = { ...ownRequestFixture('pending'), nextCursor, complete: false };
    expect(await readOwnRequest({ mine: async () => ({ ok: true, data }) })).toEqual({ ok: false, failure: 'unavailable' });
  }
  expect(await readOwnRequest({ mine: async cursor => cursor ? { ok: false, failure: 'missing' }
    : { ok: true, data: { ...ownRequestFixture('pending'), nextCursor: 'next', complete: false } } }))
    .toEqual({ ok: false, failure: 'missing' });
  expect(await readOwnRequest({ mine: async () => ({ ok: false, failure: 'missing' }) })).toEqual({ ok: true, data: null });
});

test('G-948: owner status resolves lost intents and clears withdrawal commands for already decided requests', () => {
  const pending = ownRequestFixture('pending').items[0]!;
  const saved: RequestJournal = { draftReason: 'I accept the rules', requestIntent: { key: 'request-intent', command: {
    actingSubject: accessActor, expectedMembershipGeneration: '4', expectedPolicyRevision: '12', termsRevision: 'rules-3', reason: pending.reason } },
    withdrawIntent: { key: 'withdraw-intent', request: pending.id, command: withdraw } };
  expect(journalAfterStatus(saved, pending)).toEqual({ ...saved, draftReason: '', requestIntent: null });
  expect(journalAfterStatus(saved, { ...pending, state: 'declined', requestGeneration: '1' })).toEqual({
    draftReason: saved.draftReason, requestIntent: null, withdrawIntent: null });
  expect(journalAfterStatus(saved, { ...pending, id: '00000000-0000-4000-8000-000000000022' }).withdrawIntent).toBeNull();
  expect(journalAfterStatus(saved, null).requestIntent).toEqual(saved.requestIntent);
});
