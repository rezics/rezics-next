import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { InstalledRealmBanPage } from '../src/community/realm-bans';
import { admitRealmBanCurrent, observeRealmBanCurrent } from '../src/community/realm-ban-current';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/spaces/one' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const realmId = id(100),
  selectedId = id(999),
  moderatorId = id(200);
type Ban = InstalledRealmBanPage['items'][number];
const identity = (accountId: string, handle: string): Ban['account'] => ({
  state: 'available',
  accountId,
  displayName: handle,
  handle,
  label: `Disclosed ${handle}`,
  destination: `/@${handle}`,
});
const episode = (accountId: string, n = 0): Ban => ({
  accountId,
  actor: n % 3 === 2 ? null : moderatorId,
  reason: `Actual reason ${n}`,
  at: '2026-11-02T14:05:00Z',
  account:
    n % 3 === 1 ? { state: 'concealed', accountId, label: 'Account', destination: null } : identity(accountId, 'river'),
  moderator:
    n % 3 === 2
      ? null
      : n % 3 === 1
        ? { state: 'concealed', accountId: moderatorId, label: 'Account', destination: null }
        : identity(moderatorId, 'moderator'),
  unban: { state: 'permitted', realmId, accountId, observedAt: '2026-11-02T14:05:00Z', membershipRestored: false },
  removal: { state: 'unavailable' },
});
let rows: Ban[] = [],
  current: Ban | null = null,
  selectionStatus = 200,
  ambiguous = true;
let delayed: Promise<Response> | undefined;
const requests: Request[] = [];
const boundaries: { headers?: Record<string, string> }[] = [];
const native = createKernelClient('https://kernel.test', {
  fetch: async (url, init) => {
    const request = new Request(url, init);
    requests.push(request);
    expect(request.headers.get('authorization')).toBe('Bearer original-reader');
    const path = new URL(request.url);
    if (request.method === 'GET' && path.pathname.endsWith('/bans')) {
      expect(path.searchParams.get('limit')).toBe('20');
      const selected = path.searchParams.get('selectedAccountId');
      if (selected && delayed) {
        const response = delayed;
        delayed = undefined;
        return response;
      }
      if (selected && selectionStatus !== 200) return Response.json({}, { status: selectionStatus });
      return Response.json({
        items: rows,
        next: 'opaque-next',
        context: { state: 'available', realmTitle: 'Native Realm', spaceId: id(101), spaceTitle: 'Native Space' },
        viewer: {
          accountId: moderatorId,
          clientId: 'web',
          requestedBy: null,
          authnEpoch: 1,
          unban: {
            state: 'permitted',
            operationId: 'realm.unban',
            action: 'realm:ban',
            resource: { route: 1, id: realmId },
            reauthorizes: true,
          },
        },
        selected: selected
          ? current
            ? { state: 'current', ban: current }
            : { state: 'absent', accountId: selected, account: identity(selected, 'river') }
          : { state: 'not-requested' },
      } satisfies InstalledRealmBanPage);
    }
    if (request.method === 'GET' && path.pathname === '/v1/accounts') {
      expect(path.searchParams.get('handle')).toBe('river');
      return Response.json({
        accounts: [
          {
            id: selectedId,
            kind: 'actor',
            state: 'active',
            handle: 'river',
            displayName: 'Disclosed river',
            automated: false,
            operatorId: null,
          },
        ],
      });
    }
    expect(path.pathname).toBe(`/v1/realms/${realmId}/bans/${selectedId}`);
    if (request.method === 'DELETE') {
      if (ambiguous) {
        ambiguous = false;
        return Response.json({}, { status: 503 });
      }
      current = null;
      return new Response(null, { status: 204 });
    }
    expect(request.method).toBe('PUT');
    const body = await request.json();
    current = {
      ...episode(selectedId),
      reason: body.reason,
      at: '2026-11-04T15:00:00Z',
      unban: { ...episode(selectedId).unban, observedAt: '2026-11-04T15:00:00Z' },
    };
    return Response.json({
      ban: {
        accountId: selectedId,
        reason: current.reason,
        actor: moderatorId,
        at: current.at,
        realmId,
        workflowId: id(777),
      },
    });
  },
});
// Keep original validators/handlers; replace only the server transport and native HTTP responses.
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    const original = start.createServerFn();
    const chain = {
      validator(next: (input: unknown) => unknown) {
        original.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const invoke = original.handler(handler);
        return ((input: unknown) => {
          boundaries.push(input as (typeof boundaries)[number]);
          return invoke(input as never);
        }) as unknown as T;
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://site.test/action', { headers: { authorization: 'Bearer original-reader' } }),
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const originalKernel = { ...(await import('../src/kernel/client')) };
mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => native }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { RealmBansPanel } = await import('../src/community/realm-bans-panel');
const { m } = await import('../src/paraglide/messages.js');
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined, cache: InstanceType<typeof QueryClient>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function close() {
  if (root)
    await act(async () => {
      root!.unmount();
      await tick();
    });
  root = undefined;
  cache?.clear();
}
async function mount() {
  await close();
  requests.length = 0;
  boundaries.length = 0;
  cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: moderatorId, csrfToken: 'original-csrf' });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={cache}>
        <RealmBansPanel realmId={realmId} />
      </QueryClientProvider>,
    );
    await tick();
  });
}
function button(label: string) {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(node).toBeDefined();
  return node!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await tick();
  });
}
async function edit(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      node.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function select() {
  await edit(host.querySelectorAll('input')[1]!, selectedId);
  await click(m.realm_bans_inspect_action());
}
afterAll(async () => {
  await close();
  host.remove();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.close();
});

test('1/10/20 installed composition retains every row, exact retry/frontier and independent unban/reban receipts without row lookups', async () => {
  let lastBytes = 0;
  for (const count of [1, 10, 20]) {
    rows = Array.from({ length: count }, (_, n) => episode(id(n + 1), n));
    current = episode(selectedId);
    selectionStatus = 503;
    ambiguous = true;
    const bytes = new TextEncoder().encode(JSON.stringify(rows)).byteLength;
    expect(bytes).toBeGreaterThan(lastBytes);
    expect(bytes).toBeLessThan(count * 1500);
    lastBytes = bytes;
    await mount();
    expect(requests.length).toBe(1);
    expect(host.querySelectorAll('li').length).toBe(count);
    expect(host.textContent).toContain('Native Space / Native Realm');
    expect(host.textContent).toContain('Disclosed river');
    expect(host.textContent).toContain('Disclosed moderator');
    expect(host.querySelector('a[href$="/@river"]')).not.toBeNull();
    expect(host.textContent).toContain('Actual reason 0');
    expect(host.textContent).toContain('2026-11-02 14:05:00 UTC');
    expect(host.textContent).toContain(m.realm_bans_native_advice());
    if (count > 1) {
      const concealed = host.querySelectorAll('li')[1]!;
      expect(concealed.textContent).toContain(id(2));
      expect(concealed.querySelector('a')).toBeNull();
      expect(host.querySelectorAll('li')[2]!.textContent).toContain(m.realm_bans_moderator_erased());
    }
    await click(m.realm_bans_next());
    await select();
    expect(host.textContent).toContain(m.realm_bans_inspect_unavailable());
    selectionStatus = 403;
    await click(m.realm_bans_inspect_retry());
    expect(host.textContent).toContain(m.realm_bans_forbidden());
    expect(host.textContent).not.toContain(m.realm_bans_inspect_absent());
    selectionStatus = 200;
    await click(m.realm_bans_inspect_retry());
    expect(requests.length).toBe(5);
    for (const request of requests.slice(2))
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        limit: '20',
        cursor: 'opaque-next',
        selectedAccountId: selectedId,
      });
    expect(host.querySelectorAll('li').length).toBe(count);
    await click(m.realm_bans_unban());
    await act(async () => {
      const confirm = button(m.realm_bans_confirm());
      confirm.focus();
      confirm.click();
      confirm.click();
      await tick();
    });
    expect(requests.filter((r) => r.method === 'DELETE').length).toBe(1);
    const originalKey = requests.at(-1)!.headers.get('idempotency-key');
    await click(m.realm_bans_retry());
    const deletes = requests.filter((r) => r.method === 'DELETE');
    expect(deletes.length).toBe(2);
    expect(deletes[1]!.headers.get('idempotency-key')).toBe(originalKey);
    expect(host.querySelectorAll('[data-slot="realm-ban-outcome"]').length).toBe(1);
    await select();
    expect(host.textContent).toContain(m.realm_bans_inspect_absent());
    expect(host.querySelectorAll('[data-slot="realm-ban-outcome"]').length).toBe(1);
    await edit(host.querySelector('input')!, '@river');
    await click(m.realm_bans_target_lookup());
    await click(m.realm_bans_target_select());
    await edit(host.querySelector('textarea')!, 'Deliberate new episode');
    await click(m.realm_bans_ban());
    await click(m.realm_bans_confirm_ban());
    const put = requests.find((r) => r.method === 'PUT')!;
    expect(put.headers.get('idempotency-key')).not.toBe(originalKey);
    expect(host.querySelectorAll('[data-slot="realm-ban-outcome"]').length).toBe(2);
    expect(host.textContent).toContain(m.realm_bans_removal_pending());
    await select();
    expect(host.textContent).toContain('Deliberate new episode');
    expect(host.textContent).toContain('2026-11-04 15:00:00 UTC');
    expect(host.querySelectorAll('[data-slot="realm-ban-outcome"]').length).toBe(2);
    expect(requests.filter((r) => new URL(r.url).pathname === '/v1/accounts').length).toBe(2);
    expect(boundaries.filter((b) => b.headers).every((b) => b.headers!['X-CSRF-Token'] === 'original-csrf')).toBe(true);
    // Fixed consumer work at each size; identity and authority arrive in the page, never per row.
    expect(requests.length).toBe(14);
    await act(async () => {
      cache.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
      await tick();
    });
    expect(host.textContent).not.toContain('Actual reason');
    expect(host.textContent).not.toContain('Deliberate new episode');
    expect(host.querySelectorAll('[data-slot="realm-ban-outcome"]').length).toBe(0);
  }
});

test('installed exact results are fenced by caller retirement; admitted snapshots freeze nested episode facts', async () => {
  rows = [episode(id(1))];
  current = episode(selectedId);
  selectionStatus = 200;
  await mount();
  let finish!: (response: Response) => void;
  delayed = new Promise((resolve) => {
    finish = resolve;
  });
  await select();
  await act(async () => {
    cache.setQueryData(sessionQuery.queryKey, { state: 'signed-out' });
    await tick();
    finish(Response.json({ items: [], next: null, selected: { state: 'current', ban: current } }));
    await tick();
  });
  expect(host.textContent).not.toContain(selectedId);
  const input = { realmId, accountId: selectedId, cursor: 'frozen' };
  const snapshot = admitRealmBanCurrent(input, { state: 'current', input, ban: current! });
  current!.account.label = 'Replaced identity';
  current!.unban.observedAt = 'later';
  if (snapshot.state !== 'current') throw new Error('Expected current');
  expect(snapshot.ban.account!.label).toBe('Disclosed river');
  expect(snapshot.ban.unban!.observedAt).toBe(snapshot.ban.at);
  expect(Object.isFrozen(snapshot.ban.account)).toBe(true);
  expect(observeRealmBanCurrent(input, { state: 'ready', page: { items: [], next: null } })).toEqual({
    state: 'unavailable',
  });
});
