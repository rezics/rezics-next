import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState, type ComponentProps } from 'react';
import type { CollectionRuleEditor } from '../src/library/collection-rule-editor';
import type { RuleWrite } from '../src/library/collection-rule-actions';
import type { CollectionWriteResult } from '../src/library/collection-records';
import { unavailableRuleChoices } from '../src/library/collection-rule-read';

test('new and saved rule drafts protect navigation, preserve originals and retire with authority', async () => {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://site.test/rule' });
  const globals = {
    window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement, HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLFormElement: window.HTMLFormElement, Element: window.Element, Node: window.Node, Document: window.Document,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window), matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { CollectionRuleEditor } = await import('../src/library/collection-rule-editor');
  const { ruleDraftSnapshot } = await import('../src/library/collection-rule-draft-navigation');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import('@tanstack/react-router');
  const choices = unavailableRuleChoices();
  choices.labels = { state: 'ready', next: 'next', values: [{ id: 'a', name: 'First' }, { id: 'b', name: 'Second' }] };
  const initial = { owner: { label: { id: 'a' } } } as const;
  expect(ruleDraftSnapshot({ and: [initial, { type: { in: ['x', 'y'] } }] })).not.toBe(ruleDraftSnapshot({ and: [{ type: { in: ['x', 'y'] } }, initial] }));
  expect(ruleDraftSnapshot({ type: { in: ['x', 'y'] } })).not.toBe(ruleDraftSnapshot({ type: { in: ['y', 'x'] } }));
  expect(ruleDraftSnapshot({ title: 'a', filter: initial })).toBe(ruleDraftSnapshot({ filter: initial, title: 'a' }));
  let current = true;
  let credential = 'original-csrf';
  const calls: { value: RuleWrite; csrf: string }[] = [];
  let finish!: (value: CollectionWriteResult) => void;
  let rerender!: () => void;
  let navigatedClean = false;
  type Props = ComponentProps<typeof CollectionRuleEditor>;
  let props: Props = {
    page: { state: 'new', viewerId: 'alice', intent: crypto.randomUUID(), choices },
    viewerId: 'alice', collectionId: null, csrfToken: credential,
    admitted: ['collection.create', 'collection_rule.get', 'collection_rule.update', 'library_label.list'],
    isCurrent: () => current, currentCsrf: () => credential,
    labels: async () => ({ viewerId: 'alice', choices }),
    save: (value, csrf) => { calls.push({ value, csrf }); return new Promise((resolve) => { finish = resolve; }); },
    reload: async () => props.page,
    navigate: () => { navigatedClean = !unload(); },
  };
  function Fixture() {
    const [, update] = useState(0);
    rerender = () => update((n) => n + 1);
    return createElement(CollectionRuleEditor, props);
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/rule', component: Fixture });
  const away = createRoute({ getParentRoute: () => rootRoute, path: '/away', component: () => 'Away' });
  const router = createRouter({ routeTree: rootRoute.addChildren([route, away]), history: createMemoryHistory({ initialEntries: ['/rule'] }) });
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 100 && !ready(); count++) await act(async () => { await Bun.sleep(10); });
    expect(ready()).toBe(true);
  };
  const alert = () => window.document.querySelector('[role="alertdialog"]');
  const click = async (name: string) => { await act(async () => { [...(alert() ?? window.document).querySelectorAll('button')].find((button) => button.textContent === name)!.click(); }); };
  const inputs = () => [...host.querySelectorAll('input')];
  const edit = async (index: number, value: string) => { await act(async () => {
    const input = inputs()[index]!; input.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  }); };
  function unload() { const event = new window.Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }
  const submit = async () => { await act(async () => { host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); }); };
  const depart = async () => { await act(async () => { void router.navigate({ href: '/away' }); }); await settle(() => !!alert()); };
  const selectLabel = async (id: string) => { await act(async () => {
    const select = [...host.querySelectorAll('select')].find((node) => node.value === 'a' || node.value === 'b')!;
    select.value = id; select.dispatchEvent(new window.Event('change', { bubbles: true }));
  }); };
  try {
    await act(async () => { await router.load(); root.render(createElement(RouterProvider, { router })); });
    await settle(() => inputs().length >= 3);
    await edit(2, 'choice search'); await click(m.search_apply());
    host.querySelector('details')!.open = true;
    expect(unload()).toBe(false);
    await edit(0, '  Exact e\u0301  '); await edit(1, 'Description\u0301 ');
    await depart(); await click(m.library_rule_draft_navigation_stay());
    expect(inputs()[0]!.value).toBe('  Exact e\u0301  '); expect(inputs()[1]!.value).toBe('Description\u0301 ');
    expect(calls).toHaveLength(0);
    await edit(0, ''); expect(unload()).toBe(true);
    await edit(1, ''); expect(unload()).toBe(false);
    await edit(0, 'Sent'); await submit(); await submit();
    expect(calls).toHaveLength(1); expect(unload()).toBe(true);
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    credential = 'renewed-csrf';
    props = { ...props, save: async () => { throw new Error('replacement sender'); } };
    await act(async () => rerender());
    await click(m.library_collection_reload()); await submit();
    expect(calls).toHaveLength(2); expect(calls[1]).toEqual(calls[0]);
    await act(async () => finish({ ok: true, id: 'saved' }));
    expect(unload()).toBe(false); expect(navigatedClean).toBe(true);
    props = { ...props, collectionId: 'saved', page: {
      state: 'ready', viewerId: 'alice', id: 'saved', title: 'Saved', intent: crypto.randomUUID(), choices,
      rule: { filter: initial, sort: 'id', revision: 1, collectionRevision: 1, releaseDigest: 'release', sourceGeneration: '1' },
    }, save: (value, csrf) => { calls.push({ value, csrf }); return new Promise((resolve) => { finish = resolve; }); } };
    await act(async () => rerender());
    expect(unload()).toBe(false);
    await selectLabel('b'); await depart(); await click(m.library_rule_draft_navigation_stay());
    expect([...host.querySelectorAll('select')].some((node) => node.value === 'b')).toBe(true);
    await submit(); await act(async () => finish({ ok: false, reason: 'conflict' }));
    expect(unload()).toBe(true);
    await click(m.library_collection_reload()); expect(unload()).toBe(true);
    await selectLabel('a'); expect(unload()).toBe(false);
    await selectLabel('b'); await depart(); await click(m.library_rule_draft_navigation_leave());
    await settle(() => router.state.location.pathname === '/away');
    await act(async () => { await router.navigate({ href: '/rule' }); });
    await selectLabel('b'); await depart();
    current = false; await act(async () => rerender());
    await settle(() => router.state.location.pathname === '/away');
    expect(alert()).toBeNull(); expect(unload()).toBe(false);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    await window.happyDOM.close();
  }
});
