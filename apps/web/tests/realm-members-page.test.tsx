import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { MemberPageRead, RealmMembersSource } from '../src/community/members/source';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const browser = new Window({ url: 'https://site.test/en/realms/realm/members' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator,
  HTMLElement: browser.HTMLElement, HTMLButtonElement: browser.HTMLButtonElement,
  Element: browser.Element, Node: browser.Node, Document: browser.Document, DocumentFragment: browser.DocumentFragment,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import('react-dom/client');
const { RealmMembersPage } = await import('../src/community/members/page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLElement;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
async function render(source: RealmMembersSource, realmId = 'realm', locale = 'en') {
  if (!root) { host = document.createElement('main'); document.body.append(host); root = createRoot(host); }
  await act(async () => { root!.render(createElement(RealmMembersPage, { realmId, source, locale })); await tick(); });
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;
  expect(button).toBeDefined();
  await act(async () => { button.focus(); button.click(); await tick(); });
  return button;
}
function source(read?: MemberPageRead): RealmMembersSource {
  return { pageBound: 20, readPage: async () => read ?? { kind: 'ready', page: {
    realm: { id: 'realm', label: 'Exact Realm' }, authority: 'grant', next: null,
    rows: [{ kind: 'disclosed', identity: { accountId: 'a', reference: 'account-a', label: 'Similar name' },
      episode: 'episode', membership: 'current' }],
  } }, readSelected: async (address) => ({ kind: 'ready', ...address,
    identity: { accountId: 'a', reference: 'account-a', label: 'Exact selected account' }, membership: 'pending' }) };
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); });
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('mounted roster inspects an exact current observation, keeps pending truthful and returns keyboard focus', async () => {
  await render(source());
  expect(host.textContent).toContain('Exact Realm');
  await click(m.realm_members_inspect());
  expect(host.textContent).toContain('Exact selected account');
  expect(host.textContent).toContain('account-a');
  expect(host.textContent).not.toContain('Similar name');
  expect(host.textContent).toContain(m.realm_members_pending());
  expect(document.activeElement?.textContent).toBe(m.realm_members_inspection());
  expect(host.querySelector('a')).toBeNull();
  await click(m.realm_members_back());
  expect(document.activeElement?.textContent).toBe(m.realm_members_inspect());
});

test('denial and sparse empty are distinct and a failed selected lookup has no retained person label', async () => {
  await render(source({ kind: 'denied' }));
  expect(host.textContent).toContain(m.realm_members_denied());
  expect(host.textContent).not.toContain(m.realm_members_empty());
  await render(source({ kind: 'ready', page: { realm: { id: 'realm', label: 'Realm' }, authority: 'grant', rows: [], next: 'opaque' } }));
  expect(host.textContent).toContain(m.realm_members_sparse());
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.realm_members_more())).toBe(true);
  const failed = { ...source(), readSelected: async () => ({ kind: 'failed' as const }) };
  await render(failed);
  await click(m.realm_members_inspect());
  expect(host.textContent).toContain(m.realm_members_selected_failed());
  expect(host.textContent).not.toContain('Similar name');
  expect(host.textContent).not.toContain('account-a');
});

test('Realm, locale and source replacement remove selected identity before delayed completion', async () => {
  for (const replacement of ['realm', 'locale', 'source']) {
    const deferred = Promise.withResolvers<Awaited<ReturnType<RealmMembersSource['readSelected']>>>();
    const original = { ...source(), readSelected: () => deferred.promise };
    await render(original);
    await click(m.realm_members_inspect());
    const next = source({ kind: 'unavailable' });
    await render(replacement === 'source' ? next : original, replacement === 'realm' ? 'other' : 'realm',
      replacement === 'locale' ? 'fr' : 'en');
    await act(async () => {
      deferred.resolve({ kind: 'ready', realmId: 'realm', authority: 'grant', episode: 'episode',
        identity: { accountId: 'a', reference: 'account-a', label: 'Delayed retired account' }, membership: 'current' });
      await tick();
    });
    expect(host.textContent).not.toContain('Delayed retired account');
    expect(host.textContent).not.toContain(m.realm_members_inspection());
  }
});
