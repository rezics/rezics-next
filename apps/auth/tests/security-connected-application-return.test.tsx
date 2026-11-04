import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
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

const oldConsent: InventoryRows['consents'] = {
  client_id: 'former-client',
  display_name: 'Reading companion',
  granted: ['subject:read', 'offline_access'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
};
const replacementConsent: InventoryRows['consents'] = {
  client_id: 'new-client',
  display_name: 'Different application',
  granted: ['profile:write'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
};
const readyLoad = (accountId: string): SecurityLoadResult => ({
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
});
let identityAccount = 'first-viewer';
const identitySource: AccountIdentitySource = async () => ({ kind: 'ready', accountId: identityAccount, email: null });
const inventoryPage = (view: InventoryView, consent: InventoryRows['consents']): InventoryPage<InventoryView> =>
  view === 'clients' ? { kind: 'ready', rows: [], next: null } : { kind: 'ready', rows: [consent], next: null };

let host: HTMLDivElement;
let root: Root;
let fetchCalls: { path: string; method: string }[];
let inventoryCalls: { view: InventoryView; cursor?: string }[];
let replacementViewer: boolean;
let releasePreflight: ReturnType<typeof Promise.withResolvers<InventoryPage<'consents'>>> | null;
let releaseNativeRead: ReturnType<typeof Promise.withResolvers<Response>> | null;
let releaseWrite: ReturnType<typeof Promise.withResolvers<Response>> | null;
const flush = (fn: () => void) => act(async () => fn());
const findButton = (label: string, section?: string) => {
  const scope = section ? host.querySelector<HTMLElement>(section) : host;
  return button(scope!, label)!;
};
const dispatch = (type: 'pagehide' | 'pageshow') => window.dispatchEvent(new dom.Event(type) as unknown as Event);

afterEach(async () => {
  await flush(() => root.unmount());
  host.remove();
  releasePreflight = null;
  releaseNativeRead = null;
  releaseWrite = null;
});
afterAll(async () => {
  for (const [key, descriptor] of original)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  await dom.happyDOM.close();
});

async function mount(options: { holdPreflight?: boolean; holdRead?: boolean; holdWrite?: boolean } = {}) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  fetchCalls = [];
  inventoryCalls = [];
  replacementViewer = false;
  identityAccount = 'first-viewer';
  releasePreflight = options.holdPreflight ? Promise.withResolvers<InventoryPage<'consents'>>() : null;
  releaseNativeRead = options.holdRead ? Promise.withResolvers<Response>() : null;
  releaseWrite = options.holdWrite ? Promise.withResolvers<Response>() : null;
  let consentPages = 0;
  const source: InventorySource = async <V extends InventoryView>(
    view: V,
    cursor?: string,
  ): Promise<InventoryPage<V>> => {
    inventoryCalls.push({ view, ...(cursor ? { cursor } : {}) });
    if (view === 'consents') {
      consentPages++;
      if (releasePreflight && consentPages === 2) return releasePreflight.promise as Promise<InventoryPage<V>>;
      return inventoryPage(view, replacementViewer ? replacementConsent : oldConsent) as InventoryPage<V>;
    }
    return inventoryPage(view, replacementConsent) as InventoryPage<V>;
  };
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const method = init?.method ?? 'GET';
    fetchCalls.push({ path: url.pathname, method });
    if (url.pathname === '/consent/former-client' && releaseNativeRead) return releaseNativeRead.promise;
    if (url.pathname === '/consent' && method === 'POST') {
      if (releaseWrite) return releaseWrite.promise;
      return Response.json({ error: 'unavailable' }, { status: 503 });
    }
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }) as typeof fetch;
  await flush(() =>
    root.render(
      <SecurityPage
        initial={readyLoad('first-viewer')}
        identitySource={identitySource}
        inventorySource={source}
        securitySource={{
          load: async () => readyLoad('replacement-viewer'),
          act: async () => ({ kind: 'unknown' }),
          read: async () => ({ kind: 'unavailable' }),
        }}
      />,
    ),
  );
  await waitFor(() => button(host, m.auth_inventory_remove_named({ name: 'Reading companion' })));
  return { source };
}

test('a retired fresh inventory read stays unsent and the next viewer sees generic history only', async () => {
  await mount({ holdPreflight: true });
  await flush(() => findButton(m.auth_inventory_remove_named({ name: 'Reading companion' })).click());
  await flush(() => findButton(m.auth_inventory_remove()).click());
  expect(inventoryCalls.filter(({ view }) => view === 'consents')).toHaveLength(2);

  await flush(() => dispatch('pagehide'));
  expect(host.textContent).toContain(m.auth_connected_operation_unsent());
  expect(host.textContent).not.toContain('Reading companion');
  expect(host.textContent).not.toContain('subject:read');

  releasePreflight!.resolve({ kind: 'ready', rows: [oldConsent], next: null });
  await flush(() => Promise.resolve());
  expect(fetchCalls.filter(({ path }) => path === '/consent')).toHaveLength(0);

  replacementViewer = true;
  identityAccount = 'replacement-viewer';
  await flush(() => dispatch('pageshow'));
  await waitFor(() => host.textContent?.includes('Different application'));
  expect(host.textContent).toContain(m.auth_connected_operation_unsent());
  expect(host.textContent).not.toContain('Reading companion');
  expect(host.textContent).not.toContain('subject:read');
});

test('a retired exact native read cannot cross the final consent send boundary', async () => {
  await mount({ holdRead: true });
  await flush(() => findButton(m.auth_inventory_review_named({ name: 'Reading companion' })).click());
  const removeScope = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => {
      const describedBy = candidate.getAttribute('aria-describedby');
      return !!describedBy && !!document.getElementById(describedBy)?.textContent?.includes('subject:read');
    })!;
  await flush(() => removeScope().click());
  await flush(() => findButton(m.auth_inventory_review_removal()).click());
  await flush(() => findButton(m.auth_inventory_reduce()).click());
  await waitFor(() => fetchCalls.some(({ path }) => path === '/consent/former-client'));

  await flush(() => dispatch('pagehide'));
  expect(host.textContent).toContain(m.auth_connected_operation_unsent());
  expect(host.textContent).not.toContain('Reading companion');
  expect(host.textContent).not.toContain('offline_access');

  releaseNativeRead!.resolve(
    Response.json({
      acting_account: { account_id: 'first-viewer', email: null },
      client_id: 'former-client',
      decisions: { allow: true, decline: true, switch_account: true },
      display_name: 'Reading companion',
      granted: ['subject:read', 'offline_access'],
      pending_reduction: false,
      requested: [],
      scopes: ['subject:read', 'offline_access'],
    }),
  );
  await flush(() => Promise.resolve());
  expect(fetchCalls.filter(({ path, method }) => path === '/consent' && method === 'POST')).toHaveLength(0);
});

test('an unknown write remains separate from the replacement viewer inventory and read retry', async () => {
  await mount({ holdWrite: true });
  await flush(() => findButton(m.auth_inventory_remove_named({ name: 'Reading companion' })).click());
  await flush(() => findButton(m.auth_inventory_remove()).click());
  await waitFor(() => fetchCalls.some(({ path, method }) => path === '/consent' && method === 'POST'));
  expect(host.textContent).toContain(m.auth_connected_operation_dispatched());

  await flush(() => dispatch('pagehide'));
  expect(host.textContent).toContain(m.auth_connected_operation_unknown());
  expect(host.textContent).not.toContain('Reading companion');
  expect(host.textContent).not.toContain('offline_access');
  releaseWrite!.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
  await flush(() => Promise.resolve());

  replacementViewer = true;
  identityAccount = 'replacement-viewer';
  await flush(() => dispatch('pageshow'));
  await waitFor(() => host.textContent?.includes('Different application'));
  expect(host.textContent).toContain(m.auth_connected_operation_unknown());
  expect(host.textContent).not.toContain('Reading companion');
  expect(host.textContent).not.toContain('offline_access');
  const consentSection = '#inventory-consents-heading';
  const reload = host.querySelector<HTMLElement>(consentSection)?.parentElement;
  await flush(() => button(reload!, m.auth_inventory_reload())!.click());
  await waitFor(() => inventoryCalls.filter(({ view }) => view === 'consents').length >= 4);
  expect(fetchCalls.filter(({ path, method }) => path === '/consent' && method === 'POST')).toHaveLength(1);
  expect(host.textContent).toContain(m.auth_connected_operation_unknown());
});
