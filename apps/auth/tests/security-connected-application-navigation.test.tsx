import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Root } from 'react-dom/client';
import type { InventoryPage, InventoryRows, InventoryView } from '../src/security-inventory';
import type { InventorySource } from '../src/security-inventory-view';
import type { SecurityLoadResult } from '../src/security';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/security' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  PublicKeyCredential: class {},
  getComputedStyle: dom.getComputedStyle.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const original = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { SecurityPage } = await import('../src/routes/security');
const { ConnectedApplicationReview } = await import('../src/connected-application-review-view');
const { m } = await import('../src/paraglide/messages.js');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

const accountId = 'navigation-viewer';
const initial: SecurityLoadResult = {
  kind: 'ready',
  accountId,
  sessions: [],
  passkeys: { kind: 'ready', passkeys: [] },
  page: {
    viewer: { account_id: accountId, session_id: 'current', client_id: 'login' },
    actions: { change_password: 'allowed', register_passkey: 'allowed' },
    sessions: { kind: 'ready', rows: [], limit: 64, truncated: false },
    passkeys: { kind: 'ready', rows: [], limit: 32, truncated: false },
  },
};
const identitySource = async () => ({ kind: 'ready' as const, accountId, email: null });
const securitySource = {
  load: async () => initial,
  act: async () => ({ kind: 'unknown' as const }),
  read: async () => ({ kind: 'unavailable' as const }),
};
const nextCursor = ' opaque/next?key=one+two%3A読書 ';
type ReadCall = { cursor?: string };
type FetchCall = { path: string; method: string; body: unknown };
type Read = (cursor?: string) => InventoryPage<'consents'> | Promise<InventoryPage<'consents'>>;
let host: HTMLDivElement;
let root: Root;
let readCalls: ReadCall[];
let fetchCalls: FetchCall[];
let fetchHandler: (path: string, method: string, body: unknown) => Promise<Response>;
const flush = (fn: () => void) => act(async () => fn());

const consent = (
  client_id: string,
  display_name: string,
  granted: string[],
  status: InventoryRows['consents']['status'] = 'current',
): InventoryRows['consents'] => ({
  client_id,
  display_name,
  granted,
  status,
  reducible: status === 'current' && granted.length > 0,
  pending_reduction: false,
});
const ready = (rows: InventoryRows['consents'][], next: string | null = null): InventoryPage<'consents'> => ({
  kind: 'ready',
  rows,
  next,
});
const sourceFor = (read: Read): InventorySource =>
  async <V extends InventoryView>(view: V, cursor?: string): Promise<InventoryPage<V>> => {
    if (view === 'clients') return { kind: 'ready', rows: [], next: null } as InventoryPage<V>;
    readCalls.push(cursor === undefined ? {} : { cursor });
    return (await read(cursor)) as InventoryPage<V>;
  };

function securityPage(source: InventorySource) {
  return (
    <SecurityPage
      initial={initial}
      identitySource={identitySource}
      securitySource={securitySource}
      inventorySource={source}
    />
  );
}
function consentSection(): HTMLElement | null {
  return host.querySelector<HTMLElement>('#inventory-consents-heading')?.parentElement ?? null;
}
function findButton(label: string): HTMLButtonElement | null {
  return (
    [...(consentSection()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null
  );
}
function click(label: string) {
  const target = findButton(label);
  if (!target) throw new Error(`Missing connected-application button: ${label}`);
  target.click();
}
async function waitReady(count?: number) {
  await waitFor(() => {
    const status = consentSection()?.querySelector<HTMLElement>('p[role="status"]')?.textContent;
    const counts = Array.from({ length: 21 }, (_, value) => m.auth_connected_page_count({ count: value }));
    return status && counts.includes(status) && (count === undefined || status === m.auth_connected_page_count({ count }))
      ? status
      : null;
  });
}
async function waitText(value: string) {
  await waitFor(() => (consentSection()?.textContent?.includes(value) ? value : null));
}
function installFetch() {
  fetchCalls = [];
  fetchHandler = async () => Response.json({ error: 'unavailable' }, { status: 503 });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    fetchCalls.push({ path: url.pathname, method, body });
    return fetchHandler(url.pathname, method, body);
  }) as typeof fetch;
}
async function mount(source: InventorySource) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  readCalls = [];
  installFetch();
  await flush(() => root.render(securityPage(source)));
  await waitReady();
}
async function waitFor<T>(read: () => T | null | undefined | false): Promise<T> {
  let value: T | null | undefined | false;
  for (let attempt = 0; attempt < 60; attempt++) {
    value = read();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Connected application did not reach the expected mounted state');
}

afterEach(async () => {
  await flush(() => root?.unmount());
  host?.remove();
});
afterAll(async () => {
  for (const [key, descriptor] of original)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  await dom.happyDOM.close();
});

test('current reload keeps accepted history and backward navigation uses exact cursor targets', async () => {
  const first = consent('first', 'First observation', ['subject:read']);
  const middle = consent('middle', 'Middle observation', ['profile:write']);
  await mount(
    sourceFor((cursor) => (cursor === undefined ? ready([first], nextCursor) : ready([middle]))),
  );

  await flush(() => click(m.auth_inventory_next()));
  await waitText('Middle observation');
  expect(document.activeElement?.id).toBe('inventory-consents-heading');
  await flush(() => click(m.auth_connected_reload_current()));
  await waitText('Middle observation');
  await flush(() => click(m.auth_inventory_previous()));
  await waitText('First observation');

  expect(readCalls.map(({ cursor }) => cursor)).toEqual([undefined, nextCursor, nextCursor, undefined]);
  expect(findButton(m.auth_inventory_previous())).toBeNull();
  expect(fetchCalls.filter(({ path, method }) => path === '/consent' && method === 'POST')).toEqual([]);
});

test('failed Next and Previous keep exact targets for one deliberate retry', async () => {
  const first = consent('first', 'First observation', ['subject:read']);
  const second = consent('second', 'Second observation', ['profile:write']);
  let firstReads = 0;
  let nextReads = 0;
  await mount(
    sourceFor((cursor) => {
      if (cursor === undefined) {
        firstReads++;
        return firstReads === 2 ? { kind: 'unavailable' } : ready([first], nextCursor);
      }
      nextReads++;
      return nextReads === 1 || nextReads === 3 ? { kind: 'unavailable' } : ready([second]);
    }),
  );

  await flush(() => click(m.auth_inventory_next()));
  await waitText(m.auth_connected_retry_page());
  expect(consentSection()?.textContent).not.toContain('First observation');
  expect(document.activeElement?.textContent?.trim()).toBe(m.auth_connected_retry_page());
  const retry = findButton(m.auth_connected_retry_page())!;
  await flush(() => {
    retry.click();
    retry.click();
  });
  await waitText('Second observation');
  await flush(() => click(m.auth_connected_reload_current()));
  await waitText(m.auth_connected_retry_page());
  expect(readCalls.at(-1)?.cursor).toBe(nextCursor);
  await flush(() => click(m.auth_connected_retry_page()));
  await waitText('Second observation');
  await flush(() => click(m.auth_inventory_previous()));
  await waitText(m.auth_connected_retry_page());
  await flush(() => {
    click(m.auth_connected_retry_page());
    click(m.auth_connected_retry_page());
  });
  await waitText('First observation');

  expect(readCalls.map(({ cursor }) => cursor)).toEqual([
    undefined,
    nextCursor,
    nextCursor,
    nextCursor,
    nextCursor,
    undefined,
    undefined,
  ]);
  expect(findButton(m.auth_inventory_previous())).toBeNull();
  expect(fetchCalls.filter(({ path, method }) => path === '/consent' && method === 'POST')).toEqual([]);
});

test('failed first-page navigation preserves accepted history until a later success', async () => {
  const first = consent('first', 'First observation', ['subject:read']);
  const middle = consent('middle', 'Middle observation', ['profile:write']);
  let firstReads = 0;
  await mount(
    sourceFor((cursor) => {
      if (cursor === nextCursor) return ready([middle]);
      firstReads++;
      if (firstReads === 2) return { kind: 'unavailable' };
      return ready([first], nextCursor);
    }),
  );

  await flush(() => click(m.auth_inventory_next()));
  await waitText('Middle observation');
  await flush(() => click(m.auth_connected_first_page()));
  await waitText(m.auth_connected_retry_page());
  expect(findButton(m.auth_connected_reload_current())).not.toBeNull();
  await flush(() => click(m.auth_connected_reload_current()));
  await waitText('Middle observation');
  expect(findButton(m.auth_inventory_previous())).not.toBeNull();
  await flush(() => click(m.auth_inventory_previous()));
  await waitText('First observation');
  await flush(() => click(m.auth_inventory_next()));
  await waitText('Middle observation');
  await flush(() => click(m.auth_connected_first_page()));
  await waitText('First observation');

  expect(readCalls.map(({ cursor }) => cursor)).toEqual([
    undefined,
    nextCursor,
    undefined,
    nextCursor,
    undefined,
    nextCursor,
    undefined,
  ]);
  expect(findButton(m.auth_inventory_previous())).toBeNull();
  expect(fetchCalls.filter(({ path, method }) => path === '/consent' && method === 'POST')).toEqual([]);
});

test('empty bounded page with a next cursor remains navigable and makes no account-wide claim', async () => {
  const next = consent('later', 'Later observation', ['subject:read']);
  await mount(sourceFor((cursor) => (cursor === undefined ? ready([], nextCursor) : ready([next]))));

  expect(consentSection()?.textContent).toContain(m.auth_connected_page_count({ count: 0 }));
  expect(consentSection()?.textContent).toContain(m.auth_inventory_consents_empty());
  expect(consentSection()?.textContent).not.toContain('any application');
  expect(findButton(m.auth_inventory_next())).not.toBeNull();
  await flush(() => click(m.auth_inventory_next()));
  await waitText('Later observation');
  expect(readCalls.map(({ cursor }) => cursor)).toEqual([undefined, nextCursor]);
});

test('mounted history retains only 32 previous targets and leaves first-page restart explicit', async () => {
  await mount(
    sourceFor((cursor) => {
      const current = cursor === undefined ? 0 : Number(cursor.slice('page-'.length));
      return ready([consent(`client-${current}`, `Page ${current}`, ['subject:read'])], current < 40 ? `page-${current + 1}` : null);
    }),
  );

  for (let current = 1; current <= 33; current++) {
    await flush(() => click(m.auth_inventory_next()));
    await waitText(`Page ${current}`);
  }
  for (let current = 32; current >= 1; current--) {
    await flush(() => click(m.auth_inventory_previous()));
    await waitText(`Page ${current}`);
  }

  expect(findButton(m.auth_inventory_previous())).toBeNull();
  expect(findButton(m.auth_connected_first_page())).not.toBeNull();
  expect(readCalls.at(-1)?.cursor).toBe('page-1');
});

test('a selection after backward navigation rechecks and submits the accepted row snapshot', async () => {
  const accepted = consent('backward-client', 'Reading companion', ['subject:read', 'offline_access']);
  const later = consent('backward-client', 'Reading companion', ['profile:write']);
  await mount(sourceFor((cursor) => (cursor === nextCursor ? ready([later]) : ready([accepted], nextCursor))));

  await flush(() => click(m.auth_inventory_next()));
  await waitText('profile:write');
  await flush(() => click(m.auth_inventory_previous()));
  await waitText('offline_access');
  await flush(() => click(m.auth_inventory_review_named({ name: 'Reading companion' })));
  const removeOfflineAccess = [...(consentSection()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((candidate) => {
    const description = candidate.getAttribute('aria-describedby');
    return !!description && document.getElementById(description)?.textContent?.includes('offline_access');
  })!;
  await flush(() => removeOfflineAccess.click());
  await flush(() => click(m.auth_inventory_review_removal()));

  fetchHandler = async (path, method) => {
    if (path === '/consent/backward-client' && method === 'GET')
      return Response.json({
        acting_account: { account_id: accountId, email: null },
        client_id: 'backward-client',
        decisions: { allow: true, decline: true, switch_account: true },
        display_name: 'Reading companion',
        granted: ['subject:read', 'offline_access'],
        pending_reduction: false,
        requested: [],
        scopes: ['subject:read', 'offline_access'],
      });
    if (path === '/consent' && method === 'POST')
      return Response.json({ account_id: accountId, client_id: 'backward-client', requested: [], scope: ['subject:read'] });
    return Response.json({ error: 'unavailable' }, { status: 503 });
  };
  await flush(() => click(m.auth_inventory_reduce()));
  await waitFor(() => fetchCalls.find(({ path, method }) => path === '/consent' && method === 'POST'));

  expect(readCalls.map(({ cursor }) => cursor)).toEqual([undefined, nextCursor, undefined, undefined]);
  expect(fetchCalls.find(({ path, method }) => path === '/consent' && method === 'POST')?.body).toEqual({
    client_id: 'backward-client',
    scope: ['subject:read'],
    reviewed_scopes: ['subject:read', 'offline_access'],
  });
});

test('a delayed old-source page cannot replace a new source observation', async () => {
  const delayed = Promise.withResolvers<InventoryPage<'consents'>>();
  const oldSource = sourceFor((cursor) =>
    cursor === undefined
      ? ready([consent('old-first', 'Old first page', ['subject:read'])], nextCursor)
      : delayed.promise,
  );
  await mount(oldSource);
  await flush(() => click(m.auth_inventory_next()));
  await waitText(m.auth_inventory_loading());
  expect(consentSection()?.textContent).not.toContain('Old first page');

  const replacement = sourceFor(() => ready([consent('replacement', 'Replacement source page', ['profile:write'])]));
  await flush(() => root.render(securityPage(replacement)));
  await waitText('Replacement source page');
  delayed.resolve(ready([consent('stale', 'Stale old page', ['offline_access'])]));
  await flush(() => Promise.resolve());

  expect(consentSection()?.textContent).toContain('Replacement source page');
  expect(consentSection()?.textContent).not.toContain('Stale old page');
  expect(readCalls.at(-1)?.cursor).toBeUndefined();
});

test('a delayed navigation cannot restore rows after the Security lifetime retires and returns', async () => {
  const delayed = Promise.withResolvers<InventoryPage<'consents'>>();
  const source = sourceFor((cursor) =>
    cursor === undefined
      ? ready([consent('current', 'Current after return', ['subject:read'])], nextCursor)
      : delayed.promise,
  );
  await mount(source);
  await flush(() => click(m.auth_inventory_next()));
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  await flush(() => window.dispatchEvent(new dom.Event('pageshow') as unknown as Event));
  await waitText('Current after return');

  delayed.resolve(ready([consent('stale', 'Stale retired page', ['offline_access'])]));
  await flush(() => Promise.resolve());
  expect(host.textContent).toContain('Current after return');
  expect(host.textContent).not.toContain('Stale retired page');
});

test('an already aborted connected-review lifetime starts no inventory read', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  readCalls = [];
  installFetch();
  const lifetime = new AbortController();
  lifetime.abort();
  const source = sourceFor(() => ready([consent('never', 'Never read', ['subject:read'])]));
  await flush(() => root.render(<ConnectedApplicationReview source={source} lifetime={lifetime.signal} />));

  expect(readCalls).toEqual([]);
});
