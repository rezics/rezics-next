import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-collection.json';
import recordedMembers from '../src/kernel/recorded/library-collection-members.json';
import type { EditableCollectionPage } from '../src/library/collection-load';
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
// Fix unrelated authority/navigation boundaries; exercise the real editor, fields and request callbacks.
mock.module('../src/library/collection-current-admission', () => ({
  useCollectionCurrentAdmission: () => ({
    owner: 1,
    current: () => true,
    retained: () => true,
    observed: () => true,
    csrf: () => 'csrf',
  }),
}));
mock.module('../src/library/pins-current', () => ({ useCurrentLibraryNavigation: () => ({}) }));
mock.module('../src/library/pin-control', () => ({
  usePinControlActions: () => ({ entries: [], notice: '' }),
  PinControlNotice: () => null,
}));
mock.module('../src/accounts/resource-access/link', () => ({ ResourceAccessLink: () => null }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/alpha' });
window.document.head.innerHTML = '<link rel="canonical" href="https://site.test/en/collections/alpha">';
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
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
  await import('@tanstack/react-router');
const sessions = await import('../src/session/query');
spyOn(sessions, 'useSession').mockReturnValue({ state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const locale = getLocale();
setLocale('en', { reload: false });
const menus = await import('@rezics/ui/menu');
const editors = await import('../src/library/collection-editor');
let actions: ComponentProps<typeof menus.Menu>;
let members: ComponentProps<typeof editors.CollectionMemberList>;
const OriginalMenu = menus.Menu,
  OriginalMembers = editors.CollectionMemberList;
spyOn(menus, 'Menu').mockImplementation((props) => {
  if (props.entries?.some((entry) => 'label' in entry && entry.label === m.library_collection_edit())) actions = props;
  return <OriginalMenu {...props} />;
});
spyOn(editors, 'CollectionMemberList').mockImplementation((props) => {
  members = props;
  return <OriginalMembers {...props} />;
});
const { CollectionPage } = await import('../src/library/collection-page');
const edits = await import('../src/library/collection-edit');
const { subjectOf } = await import('../src/library/reads');
const settle = (work: () => void) =>
  act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
afterAll(async () => {
  mock.restore();
  setLocale(locale, { reload: false });
  await window.happyDOM.close();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});
test('Cancel isolates metadata/notes; uncertain retry keeps identity; failed conflict reload preserves drafts until a ready replacement', async () => {
  const initial: EditableCollectionPage = {
    ...recording.collection,
    id: 'alpha',
    title: 'Original',
    revision: 7,
    visibility: 'private',
    curator: null,
    firstPage: true,
    following: null,
    next: null,
    publicExport: false,
    viewerActions: {
      state: 'ready',
      actions: [{ action: 'collection:update', operations: ['collection.update', 'collection_member.update'] }],
    },
    members: recordedMembers.members.slice(0, 1).map((member) => ({ ...member, subject: subjectOf(member.subject) })),
  };
  let latest = initial;
  const refresh = mock(async () => latest),
    update = spyOn(edits, 'updateCollection');
  const client = new QueryClient(),
    queryKey = ['metadata-recovery'];
  client.setQueryData(queryKey, initial);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  await router.load();
  spyOn(router, 'invalidate').mockResolvedValue(undefined);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  function Screen() {
    const { data } = useQuery({ queryKey, queryFn: refresh, enabled: false });
    return <CollectionPage page={data!} queryKey={queryKey} cursor={undefined} refreshPage={refresh} />;
  }
  const begin = () =>
    settle(() => {
      const entry = actions.entries!.find((e) => 'label' in e && e.label === m.library_collection_edit());
      if (entry && 'onSelect' in entry) void entry.onSelect!();
    });
  const button = (text: string) => [...host.querySelectorAll('button')].find((e) => e.textContent === text)!;
  const title = () => host.querySelector<HTMLInputElement>('#collection-edit-form input')!;
  const change = () =>
    settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(title(), 'Draft');
      title().dispatchEvent(new window.Event('input', { bubbles: true }));
      members.onNoteChange!(initial.members[0]!.id, 'Draft note');
    });
  const submit = () =>
    settle(() => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  try {
    await settle(() =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <Screen />
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
    await begin();
    await change();
    await settle(() => button(m.library_collection_cancel()).click());
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).not.toContain('Draft note');
    expect(client.getQueryData(queryKey)).toEqual(initial);
    expect(update).not.toHaveBeenCalled();
    await begin();
    await change();
    await settle(() => members.onNoteChange!(initial.members[0]!.id, '😀'.repeat(1001)));
    await submit();
    expect(update).not.toHaveBeenCalled(); // A late note must prevent the earlier metadata write.
    expect(title().value).toBe('Draft');
    expect(title().disabled).toBe(false);
    expect(host.querySelector<HTMLTextAreaElement>('[id^="collection-member-note-"]')!.value).toBe('😀'.repeat(1001));
    expect(host.querySelector('[aria-invalid="true"]')).not.toBeNull();
    await settle(() => members.onNoteChange!(initial.members[0]!.id, 'Draft note'));
    update.mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce({ ok: false, reason: 'conflict' });
    await submit();
    expect(title().value).toBe('Draft');
    expect(title().disabled).toBe(true);
    await submit();
    const first = update.mock.calls[0]![0]!.data;
    expect(first).toMatchObject({ revision: 7, title: 'Draft', visibility: 'private' });
    expect(update.mock.calls[1]![0]!.data).toEqual(first);
    expect(button(m.library_collection_cancel()).disabled).toBe(false);
    refresh.mockRejectedValueOnce(new Error('reload failed'));
    await settle(() => button(m.library_collection_reload()).click());
    expect(title().value).toBe('Draft');
    expect(host.querySelector<HTMLTextAreaElement>('[id^="collection-member-note-"]')!.value).toBe('Draft note');
    latest = { ...initial, revision: 8, memberState: 'preparing' };
    await settle(() => button(m.library_collection_reload()).click());
    expect(title().value).toBe('Draft');
    latest = { ...initial, revision: 9, title: 'Server title' };
    await settle(() => button(m.library_collection_reload()).click());
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('Server title');
    await begin();
    expect(title().value).toBe('Server title');
    await change();
    latest = { ...latest, revision: 10, title: 'Draft', members: members.members as typeof initial.members };
    update.mockResolvedValueOnce({ ok: true, id: 'alpha', revision: 10 });
    spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: initial.members[0]!.id });
    await submit();
    expect(update.mock.calls[2]![0]!.data).toMatchObject({ revision: 9, visibility: 'private' });
    expect(update.mock.calls[2]![0]!.data.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(host.querySelector('form')).toBeNull();
    expect(host.textContent).toContain('Draft note');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
