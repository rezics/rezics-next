import { expect, test, mock } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { act, createElement } from 'react';
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

test('Realm ban lists and intents are scoped to the current signed-in subject', async () => {
  const panel = await Bun.file(new URL('../src/community/realm-bans-panel.tsx', import.meta.url)).text();
  const control = await Bun.file(new URL('../src/community/realm-bans-control.tsx', import.meta.url)).text();

  expect(panel).toContain('const { state, csrfToken, subject } = useSession();');
  expect(panel).toContain("if (state !== 'signed-in' || !subject) return null;");
  expect(panel).toContain('key={`${realmId}:${subject}`}');
  expect(control).toContain('const [confirm, setConfirm] = useState<string | null>(null);');
  expect(control).toContain('const [retry, setRetry] = useState<BanWriteInput | null>(null);');
  expect(control).toContain('if (generation.current !== current) return;');
});

test('A Realm moderator selects a current account by exact handle or same-site profile URL and reviews its current identity before the original native ban command', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example.test/en/@moderator' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request(), setResponseHeader() {} }));
  mock.module('cloudflare:workers', () => ({ env: { KERNEL_ORIGIN: 'https://kernel.example.test' } }));
  const calls: Request[] = [];
  const identity = {
    id: accountId,
    kind: 'actor',
    state: 'active',
    handle: 'river',
    displayName: 'River 林',
    automated: false,
    operatorId: null,
    movedTo: 'river',
    subject: null,
    verified: false,
  };
  let current = { ...identity };
  let lookupStatus = 200;
  let loseResponse = false;
  let banned = false;
  let late: ((response: Response) => void) | null = null;
  let deferLookup = false;
  globalThis.fetch = (async (url, init) => {
    const next = new Request(url, init);
    calls.push(next);
    expect(next.headers.get('authorization')).toBe(authorization);
    const path = new URL(next.url);
    if (path.pathname === '/v1/accounts') {
      expect([...path.searchParams.keys()]).toEqual(['handle']);
      expect(path.searchParams.get('handle')).toBe('former');
      if (deferLookup)
        return new Promise<Response>((resolve) => {
          late = resolve;
        });
      return lookupStatus === 200
        ? Response.json({ accounts: [current] })
        : Response.json({ code: 'forbidden' }, { status: lookupStatus });
    }
    if (next.method === 'GET') {
      expect(path.pathname).toBe(`/v1/realms/${realmId}/bans`);
      return Response.json({
        items: banned ? [{ accountId, reason: ban.reason, actor: laterAccount, at: ban.at }] : [],
        next: null,
      });
    }
    expect(path.pathname).toBe(`/v1/realms/${realmId}/bans/${accountId}`);
    if (next.method === 'DELETE') {
      banned = false;
      return new Response(null, { status: 204 });
    }
    expect(next.method).toBe('PUT');
    expect(await next.clone().json()).toEqual({ reason: ban.reason });
    banned = true;
    if (loseResponse) {
      loseResponse = false;
      throw new TypeError('Response lost');
    }
    return Response.json({ ban });
  }) as typeof fetch;
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { RealmBansPanel } = await import('../src/community/realm-bans-panel');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'current-token', subject: laterAccount });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(RealmBansPanel, { realmId })));
  const settle = () =>
    act(async () => {
      await Bun.sleep(5);
    });
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const click = async (label: string) => {
    await act(async () => {
      button(label).click();
    });
    await settle();
  };
  const enter = async (value: string, selector = 'input') => {
    const field = host.querySelector(selector)!;
    const prototype = selector === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const lookUp = async (value = '@FORMER') => {
    await enter(value);
    await click(m.realm_bans_target_lookup());
  };
  const review = async () => {
    await click(m.realm_bans_target_select());
    await enter(ban.reason, 'textarea');
    await click(m.realm_bans_ban());
  };
  const writes = () => calls.filter((call) => call.method === 'PUT');
  try {
    await act(async () => {
      render();
    });
    await settle();
    for (const value of [
      accountId,
      'https://outside.test/en/@former',
      '/accounts/' + accountId + '/profile',
      '/en/@former/posts',
      '@名字',
    ]) {
      const before = calls.length;
      await lookUp(value);
      expect(host.textContent).toContain(m.realm_bans_target_invalid());
      expect(calls).toHaveLength(before);
    }
    await lookUp('https://site.example.test/en/@FORMER');
    expect(host.textContent).toContain('River 林');
    expect(host.textContent).toContain('@river');
    expect(host.textContent).toContain(m.realm_bans_target_moved({ former: 'former', current: 'river' }));
    expect(button(m.realm_bans_ban()).disabled).toBe(true); // No automatic first-result selection.
    await review();
    current = { ...identity, handle: 'elsewhere', movedTo: 'elsewhere' };
    await click(m.realm_bans_confirm_ban());
    expect(host.textContent).toContain(m.realm_bans_target_changed());
    expect(writes()).toHaveLength(0);
    for (const changed of [
      { ...identity, id: laterAccount },
      { ...identity, displayName: 'Changed name' },
    ]) {
      current = { ...identity };
      await lookUp();
      await review();
      current = changed;
      await click(m.realm_bans_confirm_ban());
      expect(host.textContent).toContain(m.realm_bans_target_changed());
      expect(writes()).toHaveLength(0);
    }
    current = { ...identity };
    await lookUp();
    await review();
    lookupStatus = 403;
    await click(m.realm_bans_confirm_ban());
    expect(host.textContent).toContain(m.realm_bans_target_refused());
    expect(writes()).toHaveLength(0);
    lookupStatus = 200;
    deferLookup = true;
    await lookUp();
    expect(host.textContent).toContain(m.realm_bans_target_pending());
    await enter('@another');
    deferLookup = false;
    await act(async () => {
      late!(Response.json({ accounts: [identity] }));
    });
    expect(host.textContent).not.toContain('River 林');
    await lookUp();
    await review();
    loseResponse = true;
    await click(m.realm_bans_confirm_ban());
    expect(host.textContent).toContain(m.realm_bans_write_unavailable());
    const lookups = calls.filter((call) => new URL(call.url).pathname === '/v1/accounts').length;
    current = { ...identity, id: laterAccount };
    await click(m.realm_bans_retry());
    expect(calls.filter((call) => new URL(call.url).pathname === '/v1/accounts')).toHaveLength(lookups);
    expect(writes()).toHaveLength(2);
    expect(writes()[0]!.headers.get('idempotency-key')).toBe(writes()[1]!.headers.get('idempotency-key'));
    expect(await writes()[1]!.clone().json()).toEqual({ reason: ban.reason });
    expect(host.textContent).toContain(m.realm_bans_active());
    // Unban still addresses the returned native row, without a public identity read.
    await click(m.realm_bans_unban());
    await click(m.realm_bans_confirm());
    expect(calls.filter((call) => new URL(call.url).pathname === '/v1/accounts')).toHaveLength(lookups);
    expect(host.textContent).toContain(m.realm_bans_lifted());
    await lookUp();
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'new-token', subject: accountId });
    });
    await settle();
    expect(host.textContent).not.toContain('River 林');
    expect(host.querySelector('input')!.value).toBe('');
  } finally {
    await act(async () => {
      root.unmount();
    });
    client.clear();
    globalThis.fetch = originalFetch;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
    await window.happyDOM.close();
  }
});
