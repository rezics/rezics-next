import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RealmBanOutcome, RealmBansControl } from '../src/community/realm-bans-control';
import { loadRealmBans, writeRealmBan, type BanWriteInput } from '../src/community/realm-bans';

const realmId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b6';
const accountId = '01a17a3b-70ea-712a-9ff7-81fc6a9381b7';
const laterAccount = '01a17a3b-70ea-712a-9ff7-81fc6a9381b8';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const authorization = 'Bearer current-moderator';
const request = (method = 'GET') =>
  new Request('https://site.example.test/action', { method, headers: { authorization } });
const ban = {
  realmId,
  accountId,
  reason: 'Repeated disruption',
  actor: laterAccount,
  at: '2026-10-31T10:00:00Z',
  workflowId: 'removal-pending',
};
const input: BanWriteInput = { realmId, accountId, action: 'ban', reason: ban.reason, idempotencyKey };

test('ban and unban show immediate admission denial, pending removal and later admission without restoring membership or following', async () => {
  const requests: Request[] = [];
  let banned = false;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (url, init) => {
      const next = new Request(url, init);
      requests.push(next);
      expect(next.headers.get('authorization')).toBe(authorization);
      const path = new URL(next.url);
      if (next.method === 'GET') {
        expect(path.pathname).toBe(`/v1/realms/${realmId}/bans`);
        expect(path.searchParams.get('limit')).toBe('20');
        const current = { accountId, reason: ban.reason, actor: ban.actor, at: ban.at };
        return Response.json(
          path.searchParams.has('cursor')
            ? { items: [{ ...current, accountId: laterAccount }], next: null }
            : { items: banned ? [current] : [], next: banned ? 'opaque-next' : null },
        );
      }
      expect(path.pathname).toBe(`/v1/realms/${realmId}/bans/${accountId}`);
      expect(next.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
      if (next.method === 'PUT') {
        expect(await next.json()).toEqual({ reason: ban.reason });
        banned = true;
        return Response.json({ ban });
      }
      expect(next.method).toBe('DELETE');
      banned = false;
      return new Response(null, { status: 204 });
    },
  });
  const empty = await loadRealmBans(client, request(), {}, { realmId });
  expect(empty).toEqual({ state: 'ready', page: { items: [], next: null } });
  const accepted = await writeRealmBan(client, request('POST'), {}, { ...input, accountId: accountId.toUpperCase() });
  expect(accepted).toEqual({ ok: true, action: 'ban', ban });
  if (!accepted.ok) throw new Error('Ban was not accepted');
  const pending = renderToStaticMarkup(createElement(RealmBanOutcome, { result: accepted }));
  expect(pending).toContain('Joining, participation and protected material are denied now');
  expect(pending).toContain('Membership removal queued');
  expect(pending).toContain('Completion has not been confirmed');
  expect(pending).toContain('Public material remains available as for an anonymous reader');
  const first = await loadRealmBans(client, request(), {}, { realmId });
  expect(first.state).toBe('ready');
  if (first.state !== 'ready') throw new Error('Current list unavailable');
  const html = renderToStaticMarkup(
    createElement(RealmBansControl, {
      realmId,
      initial: first,
      ready: true,
      read: async () => first,
      write: async () => accepted,
    }),
  );
  expect(html).toContain('Unban');
  expect(html).toContain('Next page of bans');
  expect(html).toContain(ban.reason);
  const later = await loadRealmBans(client, request(), {}, { realmId, cursor: first.page.next! });
  expect(later.state === 'ready' && later.page.items[0]?.accountId).toBe(laterAccount);
  const lifted = await writeRealmBan(client, request('POST'), {}, { ...input, action: 'unban', reason: '' });
  expect(lifted).toEqual({ ok: true, action: 'unban', accountId });
  if (!lifted.ok) throw new Error('Unban was not accepted');
  const admission = renderToStaticMarkup(createElement(RealmBanOutcome, { result: lifted }));
  expect(admission).toContain('Admission is allowed again under the Realm');
  expect(admission).toContain('Membership is not restored and following is unchanged');
  expect(admission).toContain('Existing removal may still be pending');
  expect(await loadRealmBans(client, request(), {}, { realmId })).toEqual(empty);
  expect(requests.map((item) => item.method)).toEqual(['GET', 'PUT', 'GET', 'GET', 'DELETE', 'GET']);
});

test('current authority failures, role removal, cursor refusal and lost responses never become success or an invented empty list', async () => {
  let status = 503;
  let code = 'partition_unavailable';
  let detail = '';
  let calls = 0;
  const keys: (string | null)[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (url, init) => {
      calls++;
      keys.push(new Request(url, init).headers.get('idempotency-key'));
      return Response.json({ code, detail }, { status });
    },
  });
  for (const failure of [
    { status: 503, code: 'partition_unavailable', state: 'unavailable', reason: 'unavailable' },
    { status: 401, code: 'authentication_required', state: 'signed-out', reason: 'signed-out' },
    { status: 403, code: 'forbidden', state: 'forbidden', reason: 'forbidden' },
    { status: 403, code: 'platform_closed', state: 'closed', reason: 'closed' },
    { status: 404, code: 'not_found', state: 'forbidden', reason: 'forbidden' },
    { status: 400, code: 'invalid_request', state: 'invalid-cursor', reason: 'invalid' },
  ]) {
    ({ status, code } = failure);
    const denied = await loadRealmBans(client, request(), {}, { realmId });
    expect(denied).toEqual({ state: failure.state });
    const html = renderToStaticMarkup(
      createElement(RealmBansControl, {
        realmId,
        initial: denied,
        ready: true,
        read: async () => denied,
        write: async () => ({ ok: false, reason: 'forbidden' }),
      }),
    );
    expect(html).not.toContain(ban.reason);
    expect(html).not.toContain('No current bans on this page');
    expect(html).not.toContain('Ban account');
    expect(await writeRealmBan(client, request('POST'), {}, input)).toEqual({ ok: false, reason: failure.reason });
  }
  status = 409;
  code = 'conflict';
  detail = 'Remove the Realm owner or moderator role first';
  expect(await writeRealmBan(client, request('POST'), {}, input)).toEqual({ ok: false, reason: 'role-required' });
  status = 422;
  code = 'idempotency_conflict';
  expect(await writeRealmBan(client, request('POST'), {}, input)).toEqual({ ok: false, reason: 'conflict' });
  const before = calls;
  expect(await loadRealmBans(client, new Request('https://site.example.test/'), {}, { realmId })).toEqual({
    state: 'signed-out',
  });
  const csrf = new Request('https://site.example.test/action', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://other.example.test',
    },
  });
  expect(await writeRealmBan(client, csrf, { SITE_ORIGINS: 'https://site.example.test' }, input)).toEqual({
    ok: false,
    reason: 'forbidden',
  });
  expect(calls).toBe(before);
  let attempt = 0;
  const lost = createKernelClient('https://kernel.example.test', {
    fetch: async (url, init) => {
      keys.push(new Request(url, init).headers.get('idempotency-key'));
      if (++attempt === 1) throw new TypeError('Response lost');
      return Response.json({ ban });
    },
  });
  expect(await writeRealmBan(lost, request('POST'), {}, input)).toEqual({ ok: false, reason: 'unavailable' });
  expect(await writeRealmBan(lost, request('POST'), {}, input)).toEqual({ ok: true, action: 'ban', ban });
  expect(keys.slice(-2)).toEqual([JSON.stringify(idempotencyKey), JSON.stringify(idempotencyKey)]);
});
