import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { Root } from 'react-dom/client';
import type { AccountIdentitySource } from '../src/account-identity';
import type { InventoryPage, InventoryRows, InventoryView } from '../src/security-inventory';
import type { SecurityLoadResult } from '../src/security';
import type { InventorySource } from '../src/security-inventory-view';

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
const { button, waitFor } = await import('../src/stories/accounts-operations/story');
const { m } = await import('../src/paraglide/messages.js');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

const consent: InventoryRows['consents'] = {
  client_id: 'measured-client',
  display_name: 'Paper reader',
  granted: ['subject:read', 'offline_access'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
};
const initial: SecurityLoadResult = {
  kind: 'ready',
  accountId: 'measured-viewer',
  sessions: [],
  passkeys: { kind: 'ready', passkeys: [] },
  page: {
    viewer: { account_id: 'measured-viewer', session_id: 'current', client_id: 'login' },
    actions: { change_password: 'allowed', register_passkey: 'allowed' },
    sessions: { kind: 'ready', rows: [], limit: 64, truncated: false },
    passkeys: { kind: 'ready', rows: [], limit: 32, truncated: false },
  },
};
const identitySource: AccountIdentitySource = async () => ({
  kind: 'ready',
  accountId: 'measured-viewer',
  email: null,
});
const pageFor = (view: InventoryView): InventoryPage<InventoryView> =>
  view === 'clients' ? { kind: 'ready', rows: [], next: null } : { kind: 'ready', rows: [consent], next: null };

let host: HTMLDivElement;
let root: Root;
let nativeCalls: { path: string; method: string; body: unknown }[];
let inventoryCalls: { view: InventoryView; cursor?: string }[];
const flush = (fn: () => void) => act(async () => fn());
function inSection(sectionId: string, label: string) {
  return button(host.querySelector<HTMLElement>(sectionId)!.parentElement!, label)!;
}

afterEach(async () => {
  await flush(() => root.unmount());
  host.remove();
});
afterAll(async () => {
  for (const [key, descriptor] of original)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  await dom.happyDOM.close();
});

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  nativeCalls = [];
  inventoryCalls = [];
  const source: InventorySource = async <V extends InventoryView>(
    view: V,
    cursor?: string,
  ): Promise<InventoryPage<V>> => {
    inventoryCalls.push({ view, ...(cursor ? { cursor } : {}) });
    return pageFor(view) as InventoryPage<V>;
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    nativeCalls.push({ path: url.pathname, method, body });
    if (url.pathname === '/consent/measured-client')
      return Response.json({
        acting_account: { account_id: 'measured-viewer', email: null },
        client_id: 'measured-client',
        decisions: { allow: true, decline: true, switch_account: true },
        display_name: 'Paper reader',
        granted: ['subject:read', 'offline_access'],
        pending_reduction: false,
        requested: [],
        scopes: ['subject:read', 'offline_access'],
      });
    if (url.pathname === '/consent' && method === 'POST')
      return Response.json({ client_id: 'measured-client', scope: (body as { scope: string[] }).scope });
    return Response.json({ error: 'unexpected' }, { status: 503 });
  }) as typeof fetch;
  await flush(() => root.render(createElement(SecurityPage, { initial, identitySource, inventorySource: source })));
  await waitFor(() => button(host, m.auth_inventory_remove_named({ name: 'Paper reader' })));
}

test('bounded page reads and a retained-scope reduction use one exact review and one command', async () => {
  await mount();
  expect(inventoryCalls).toEqual([{ view: 'clients' }, { view: 'consents' }]);

  await flush(() => inSection('#inventory-consents-heading', m.auth_inventory_reload()).click());
  await waitFor(() => inventoryCalls.filter(({ view }) => view === 'consents').length === 2);
  expect(nativeCalls).toHaveLength(0);

  await flush(() => button(host, m.auth_inventory_review_named({ name: 'Paper reader' }))!.click());
  const removeScope = [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => {
    const describedBy = candidate.getAttribute('aria-describedby');
    return !!describedBy && !!document.getElementById(describedBy)?.textContent?.includes('subject:read');
  })!;
  await flush(() => removeScope.click());
  await flush(() => button(host, m.auth_inventory_review_removal())!.click());
  await flush(() => button(host, m.auth_inventory_reduce())!.click());
  await waitFor(() => nativeCalls.some(({ path, method }) => path === '/consent' && method === 'POST'));

  expect(inventoryCalls.filter(({ view }) => view === 'consents')).toHaveLength(3);
  expect(nativeCalls.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'GET /consent/measured-client',
    'POST /consent',
  ]);
  expect(nativeCalls[1]!.body).toEqual({
    client_id: 'measured-client',
    scope: ['offline_access'],
    reviewed_scopes: ['subject:read', 'offline_access'],
  });
  await waitFor(() => host.textContent?.includes(m.auth_connected_operation_acknowledged()));
});

test('remove-all uses one bounded inventory preflight and one empty-scope command without a detail read', async () => {
  await mount();
  await flush(() => button(host, m.auth_inventory_remove_named({ name: 'Paper reader' }))!.click());
  await flush(() => button(host, m.auth_inventory_remove())!.click());
  await waitFor(() => nativeCalls.some(({ path, method }) => path === '/consent' && method === 'POST'));

  expect(inventoryCalls.filter(({ view }) => view === 'consents')).toHaveLength(2);
  expect(nativeCalls).toHaveLength(1);
  expect(nativeCalls[0]!.body).toEqual({ client_id: 'measured-client', scope: [] });
});
