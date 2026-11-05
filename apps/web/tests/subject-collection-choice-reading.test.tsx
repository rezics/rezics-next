import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ComponentProps } from 'react';
import type { ChooserCollectionRow } from '../src/library/subject-collection-journey/model';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/reader', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
const { CollectionChooserPanel } = await import('../src/library/subject-collection-journey/chooser');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const originalLocale = getLocale();
type Props = ComponentProps<typeof CollectionChooserPanel>;
const subject = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000001', type: 'schema:Book', label: 'Reader' };
const row = (id: string, extra: Partial<ChooserCollectionRow> = {}): ChooserCollectionRow => ({
  id,
  title: 'Same name',
  curatorAccountId: 'owner',
  curator: null,
  memberCount: 0,
  membershipKind: 'curated',
  ...extra,
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let props: Props;
let update: (props: Props) => void;
function Panel() {
  const [value, setValue] = useState(props);
  update = setValue;
  return <CollectionChooserPanel {...value} />;
}
async function paint(change: Partial<Props> = {}) {
  props = { ...props, ...change };
  await act(async () => update(props));
}
function button(text: string, within: ParentNode = host): HTMLButtonElement {
  const node = [...within.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
  expect(node).toBeDefined();
  return node!;
}
async function click(node: HTMLButtonElement) {
  await act(async () => node.click());
}
async function inspect(index = 0) {
  const trigger = host.querySelectorAll<HTMLButtonElement>('button[data-collection-inspect]')[index]!;
  await click(trigger);
  return trigger;
}
function details() {
  return host.querySelector<HTMLElement>('[data-collection-inspection]')!;
}
// Keep the original React callback so retirement is tested even if an event was already queued.
function callback(node: HTMLButtonElement): () => void {
  const key = Object.keys(node).find((key) => key.startsWith('__reactProps'))!;
  return Reflect.get(node, key).onClick;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  setLocale('en', { reload: false });
  props = {
    subject,
    locale: 'en',
    action: '/en/subjects/reader',
    readerHref: '/en/subjects/reader?node=cast',
    csrfToken: 'csrf-A',
    admitted: true,
    hydrated: true,
    loaded: true,
    collections: [
      row('one'),
      row('two', { visibility: 'unlisted', curator: { id: 'another', displayName: 'Curator', handle: 'curator' } }),
    ],
    next: 'next',
    problem: null,
    pending: false,
    addedId: null,
    current: () => true,
    readPage: mock(async () => ({ collections: [row('later')], next: null, state: 'loaded' as const })),
    onSelect: mock(() => {}),
    onConfirm: mock(() => {}),
  };
  const router = createRouter({
    routeTree: createRootRoute({ component: Panel }),
    history: createMemoryHistory({ initialEntries: ['/en/subjects/reader'] }),
  });
  await router.load();
  root = createRoot(host);
  await act(async () => root.render(<RouterProvider router={router} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
});
afterAll(async () => {
  setLocale(originalLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('received destination: exact supplied facts, missing projections and deliberate selection without extra work', async () => {
  const first = await inspect();
  expect(details().textContent).toContain(m.library_destination_curator_unavailable());
  expect(details().textContent).toContain(m.library_destination_visibility_unknown());
  expect(details().textContent).toContain(m.library_destination_member_count({ count: 0 }));
  expect(details().textContent).not.toContain('owner');
  expect(window.document.activeElement?.textContent).toBe('Same name');
  await click(button(m.library_destination_close(), details()));
  expect(window.document.activeElement).toBe(first);
  await inspect(1);
  expect(host.querySelectorAll('[data-collection-inspection]')).toHaveLength(1);
  expect(details().textContent).toContain('Curator');
  expect(details().textContent).toContain('@curator');
  expect(details().textContent).toContain(m.library_destination_unlisted_meaning());
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(props.onConfirm).not.toHaveBeenCalled();
  expect(props.readPage).not.toHaveBeenCalled();
  await paint({ admitted: false, csrfToken: null });
  expect(details()).not.toBeNull();
  expect(button(m.library_destination_choose(), details()).disabled).toBe(true);
  await click(button(m.library_destination_choose(), details()));
  expect(props.onSelect).not.toHaveBeenCalled();
  await paint({ admitted: true, csrfToken: 'csrf-A' });
  await click(button(m.library_destination_choose(), details()));
  expect(props.onSelect).toHaveBeenCalledWith({ id: 'two', title: 'Same name' });
  expect(props.onConfirm).not.toHaveBeenCalled();
  await click(button(m.library_subject_add_confirm()));
  expect(props.onConfirm).toHaveBeenCalledWith('two');
  expect(props.readPage).not.toHaveBeenCalled();
  for (const visibility of ['public', 'private'] as const) {
    await paint({
      collections: [
        row(visibility, { visibility, curator: { id: 'exact', displayName: null, handle: 'only-handle' } }),
      ],
    });
    await inspect();
    expect(details().textContent).toContain('@only-handle');
    expect(details().textContent).toContain(
      visibility === 'public' ? m.library_destination_public_meaning() : m.library_destination_private_meaning(),
    );
  }
  const { membershipKind, ...legacy } = row('legacy');
  await paint({
    collections: [legacy, row('dynamic', { membershipKind: 'dynamic' }), row('builtin', { builtinKind: 'inbox' })],
  });
  expect(host.querySelectorAll('button[data-collection-inspect]')).toHaveLength(1);
});

test('lifetime: page-local inspection retires while captured add target survives paging and detached callbacks fail', async () => {
  await inspect();
  await click(button(m.library_destination_choose(), details()));
  await inspect(1);
  const detached = callback(button(m.library_destination_choose(), details()));
  const pending = deferred<Awaited<ReturnType<Props['readPage']>>>();
  await paint({ readPage: mock(() => pending.promise) });
  await click(button(m.library_subject_continuation_next()));
  expect(details()).toBeNull();
  expect(window.document.activeElement).toBe(host.querySelector('h3'));
  await act(async () => detached());
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  await click(button(m.library_subject_add_confirm()));
  expect(props.onConfirm).toHaveBeenLastCalledWith('one');
  await act(async () => pending.resolve({ state: 'loaded', collections: [row('replacement')], next: null }));
  expect(details()).toBeNull();
  await act(async () => detached());
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  await inspect();
  const beforeRefresh = callback(button(m.library_destination_choose(), details()));
  await paint({ collections: [row('same-name-refresh')] });
  expect(details()).toBeNull();
  await act(async () => beforeRefresh());
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  for (const problem of ['expired', 'closed', 'unavailable'] as const) {
    await inspect();
    const old = callback(button(m.library_destination_choose(), details()));
    await paint({ problem });
    expect(details()).toBeNull();
    await act(async () => old());
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    await paint({ problem: null, collections: [row(problem)] });
  }
  await inspect();
  const retired = callback(button(m.library_destination_choose(), details()));
  let current = true;
  await paint({ current: () => current });
  current = false;
  await act(async () => retired());
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  await paint();
  expect(details()).toBeNull();
});

test('presentation/outcome: explicit GET without scripts, localized compact reading and deterministic focus', async () => {
  await paint({ loaded: false, collections: null, next: null, hydrated: false });
  const fallback = host.querySelector('form')!;
  expect(fallback.method).toBe('get');
  expect(fallback.getAttribute('action')).toBe(props.action);
  expect(fallback.querySelector('input[name="slot"]')?.getAttribute('value')).toBe('collections');
  expect(host.querySelector('script')).toBeNull();
  expect(props.readPage).not.toHaveBeenCalled();
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
    setLocale(locale, { reload: false });
    for (const width of [390, 1280]) {
      window.happyDOM.setWindowSize({ width, height: 900 });
      const title = 'Long destination title '.repeat(24);
      await paint({
        locale,
        loaded: true,
        hydrated: true,
        collections: [row(locale, { title, visibility: 'public', memberCount: 17 })],
      });
      const trigger = await inspect();
      expect(details().querySelector('h4')?.textContent).toBe(title);
      expect(details().textContent).toContain(m.library_destination_member_count({ count: 17 }));
      expect(details().textContent).toContain(m.library_destination_public());
      expect(details().textContent).toContain(m.library_destination_choose());
      expect(window.document.activeElement).toBe(details().querySelector('h4'));
      await act(async () =>
        details().dispatchEvent(
          new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      );
      expect(details()).toBeNull();
      expect(window.document.activeElement).toBe(trigger);
    }
  }
  // Server output preserves the same explicit GET load before hydration.
  props = { ...props, loaded: false, collections: null, hydrated: false };
  const serverRouter = createRouter({
    routeTree: createRootRoute({ component: () => <CollectionChooserPanel {...props} /> }),
    history: createMemoryHistory({ initialEntries: ['/en/subjects/reader'] }),
  });
  await serverRouter.load();
  const html = renderToString(<RouterProvider router={serverRouter} />);
  expect(html).toContain('method="get"');
  expect(html).toContain('name="slot" value="collections"');
  expect(props.onConfirm).not.toHaveBeenCalled();
});
