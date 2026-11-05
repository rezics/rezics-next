import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import {
  browseCollectionTitle,
  CollectionBrowseList,
  CollectionCopyMenu,
  type CollectionBrowseRecord,
} from '../src/library/collection-browser';
import recordedMembers from '../src/kernel/recorded/library-collection-members.json';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { subjectHref } from '../src/subject/subject-href';

// UNRUN: composed assertions for integration; DOM interaction is not browser or native proof.
test('Collection browser shares item anatomy with honest preview states exact destinations and independent copy controls', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.example/en' });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    NodeFilter: window.NodeFilter,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const show = (node: ReactNode) =>
    act(async () => root.render(<RouterContextProvider router={router}>{node}</RouterContextProvider>));
  const destinations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as HTMLElement).closest('a');
    if (anchor) {
      destinations.push(anchor.getAttribute('href')!);
      event.preventDefault();
    }
  });
  const collection: CollectionBrowseRecord = {
    id: 'reading-list',
    title: 'A real Collection',
    curator: null,
    visibility: 'private',
    memberCount: 40,
    preview: { state: 'loaded', members: recordedMembers.members.map(({ subject }) => subject) },
  };
  const copied: string[] = [];
  const menuFor = (record: CollectionBrowseRecord) => (
    <CollectionCopyMenu
      title={browseCollectionTitle(record)}
      onCopy={() => {
        copied.push(record.id);
      }}
    />
  );

  try {
    setLocale('en', { reload: false });
    await show(<CollectionBrowseList collections={[collection]} layout="rows" menuFor={menuFor} />);
    const row = host.querySelector('[data-collection-row]')!;
    const heading = row.querySelector('h2[data-content-item-slot="title"]')!;
    const primary = row.querySelector('a[data-slot="list-row-link"]')!;
    expect(row.parentElement?.tagName).toBe('UL');
    expect(heading.textContent).toBe(collection.title);
    expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(primary.getAttribute('href')).toBe('/collections/reading-list');
    const open = [...row.querySelectorAll('a')].find((link) => link.textContent === m.library_collection_open())!;
    expect(open.getAttribute('href')).toBe(primary.getAttribute('href'));
    expect(row.querySelectorAll('[data-collection-member-count="40"]')).toHaveLength(1);
    expect(row.querySelectorAll('[data-collection-visibility="private"]')).toHaveLength(1);
    const trigger = row.querySelector('button')!;
    expect(trigger.getAttribute('aria-label')).toBe(`${m.library_collection_actions()}: ${collection.title}`);
    expect(trigger.closest('[data-content-item-slot="actions"]')).not.toBeNull();
    expect(trigger.closest('a')).toBeNull();
    trigger.focus();
    await act(async () => user.keyboard('{Enter}'));
    const copy = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
      (control) => control.textContent === m.library_collection_copy(),
    )!;
    expect(copy).toBeDefined();
    await act(async () => user.click(copy));
    expect(copied).toEqual([collection.id]);
    expect(destinations).toEqual([]);

    const unknown: CollectionBrowseRecord = {
      id: 'logical-liked',
      title: null,
      builtinKind: 'liked',
      curator: null,
      preview: { state: 'unavailable' },
    };
    await show(<CollectionBrowseList collections={[unknown]} layout="rows" readable={false} />);
    const unreadable = host.querySelector('[data-collection-row]')!;
    const signInHref = '/en/auth/sign-in?return_to=%2Fen%2Fcollections%2Flogical-liked';
    expect(unreadable.querySelector('h2')?.textContent).toBe(browseCollectionTitle(unknown));
    expect(unreadable.querySelector('[data-slot="list-row-link"]')?.getAttribute('aria-labelledby')).toBe(
      unreadable.querySelector('h2')?.id,
    );
    expect([...unreadable.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      signInHref,
      signInHref,
    ]);
    expect(unreadable.querySelector('[data-content-item-slot="trailing"]')?.textContent).toBe(m.account_sign_in());
    expect(unreadable.querySelector('[data-collection-member-count], [data-collection-visibility]')).toBeNull();

    await show(<CollectionBrowseList collections={[collection]} layout="previews" menuFor={menuFor} />);
    const preview = host.querySelector('[data-collection-preview]')!;
    expect(preview.parentElement?.tagName).toBe('UL');
    expect(preview.tagName).toBe('LI');
    expect(preview.querySelector('h2')?.textContent).toBe(collection.title);
    expect(preview.querySelector('[data-slot="list-row-link"]')?.getAttribute('aria-labelledby')).toBe(
      preview.querySelector('h2')?.id,
    );
    expect(preview.querySelector('[data-slot="list-row-link"]')?.getAttribute('href')).toBe(
      '/collections/reading-list',
    );
    expect(preview.querySelectorAll('[data-collection-member-count="40"]')).toHaveLength(1);
    expect(preview.querySelectorAll('[data-collection-visibility="private"]')).toHaveLength(1);
    const subjects = [...preview.querySelectorAll('[data-slot="cover-card"] a')];
    const expectedSubjects = recordedMembers.members
      .slice(0, 3)
      .map(({ subject }) => subjectHref({ id: subject.id, label: subject.label.value }, 'en').href);
    expect(subjects.map((link) => link.getAttribute('href'))).toEqual(expectedSubjects);
    expect(subjects.every((link) => link.closest('[data-slot="list-row-control"]') !== null)).toBe(true);
    expect(preview.querySelector('a a, a button, button a')).toBeNull();
    await act(async () => user.click(subjects[0]!));
    expect(destinations).toEqual([expectedSubjects[0]!]);
    await act(async () => user.click(preview.querySelector('button')!));
    const previewCopy = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
      (control) => control.textContent === m.library_collection_copy(),
    )!;
    await act(async () => user.click(previewCopy));
    expect(copied).toEqual([collection.id, collection.id]);
    expect(destinations).toEqual([expectedSubjects[0]!]);

    await show(<CollectionBrowseList collections={[{ ...unknown, coverSource: 'pending' }]} layout="rows" />);
    expect(host.querySelector('[data-collection-cover="pending"] [role="status"]')?.textContent).toBe(
      m.library_collection_preview_preparing(),
    );
    expect(host.querySelector('[data-collection-member-count]')).toBeNull();
    await show(
      <CollectionBrowseList
        collections={[{ ...unknown, memberCount: 0, preview: { state: 'loaded', members: [] } }]}
        layout="previews"
      />,
    );
    expect(host.textContent).toContain(m.library_collection_empty());
    expect(host.querySelector('[role="status"]')).toBeNull();
    await show(
      <CollectionBrowseList
        collections={[{ ...unknown, preview: { state: 'loaded', members: [], emptyConfirmed: true } }]}
        layout="previews"
      />,
    );
    expect(host.textContent).toContain(m.library_collection_preview_no_visible_members());
    expect(host.textContent).not.toContain(m.library_collection_empty());
    expect(host.querySelector('[data-collection-member-count]')).toBeNull();
    await show(
      <CollectionBrowseList
        collections={[{ ...unknown, memberCount: 0, preview: { state: 'preparing' } }]}
        layout="previews"
      />,
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.library_collection_preview_preparing());
    expect(host.textContent).not.toContain(m.library_collection_empty());
    await show(<CollectionBrowseList collections={[{ ...unknown, memberCount: 0 }]} layout="previews" />);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.library_collection_preview_unavailable());
    expect(host.textContent).not.toContain(m.library_collection_empty());
    await show(
      <CollectionBrowseList
        collections={[{ ...unknown, preview: { state: 'loaded', members: [] } }]}
        layout="previews"
      />,
    );
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.library_collection_preview_unavailable());
    expect(host.textContent).not.toContain(m.library_collection_empty());
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
