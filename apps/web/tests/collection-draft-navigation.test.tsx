import { expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-collection.json';
import recordedMembers from '../src/kernel/recorded/library-collection-members.json';
import type { CollectionWriteResult } from '../src/library/collection-edit';
import type { EditableCollectionPage } from '../src/library/collection-load';

test('curated draft departure preserves loaded edits and selection; revert, save and retirement release it', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('../src/library/collection-current-admission', () => ({
    useCollectionCurrentAdmission: () => ({
      owner: 1,
      current: () => true,
      retained: () => true,
      observed: () => true,
      csrf: () => 'original-csrf',
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
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLAnchorElement',
        'HTMLFormElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
      ].map((key) => [key, window[key as keyof typeof window]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRouter, createRootRoute, createRoute, createMemoryHistory, RouterProvider, Outlet } =
    await import('@tanstack/react-router');
  const sessions = await import('../src/session/query');
  spyOn(sessions, 'useSession').mockReturnValue({ state: 'signed-in', subject: 'owner', csrfToken: 'original-csrf' });
  const { m } = await import('../src/paraglide/messages.js');
  const menus = await import('@rezics/ui/menu');
  const editors = await import('../src/library/collection-editor');
  let actions!: ComponentProps<typeof menus.Menu>,
    metadata!: ComponentProps<typeof editors.CollectionMetadataEditor>,
    members!: ComponentProps<typeof editors.CollectionMemberList>;
  const OriginalMenu = menus.Menu,
    OriginalMetadata = editors.CollectionMetadataEditor,
    OriginalMembers = editors.CollectionMemberList;
  spyOn(menus, 'Menu').mockImplementation((props) => {
    if (props.entries?.some((entry) => 'label' in entry && entry.label === m.library_collection_edit()))
      actions = props;
    return <OriginalMenu {...props} />;
  });
  spyOn(editors, 'CollectionMetadataEditor').mockImplementation((props) => {
    metadata = props;
    return <OriginalMetadata {...props} />;
  });
  spyOn(editors, 'CollectionMemberList').mockImplementation((props) => {
    members = props;
    return <OriginalMembers {...props} />;
  });
  const edits = await import('../src/library/collection-edit');
  const update = spyOn(edits, 'updateCollection');
  const note = spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: 'member' });
  const move = spyOn(edits, 'moveCollectionMember').mockResolvedValue({ ok: true, id: 'member' });
  const remove = spyOn(edits, 'removeCollectionMember');
  const { subjectOf } = await import('../src/library/reads');
  const { CollectionPage } = await import('../src/library/collection-page');
  const page: EditableCollectionPage = {
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
      actions: [
        {
          action: 'collection:update',
          operations: [
            'collection.update',
            'collection_member.update',
            'collection_member.move',
            'collection_member.delete',
          ],
        },
      ],
    },
    members: recordedMembers.members.slice(0, 2).map((member) => ({ ...member, subject: subjectOf(member.subject) })),
  };
  const client = new QueryClient(),
    queryKey = ['draft-navigation'];
  client.setQueryData(queryKey, page);
  const refresh = mock(async (): Promise<EditableCollectionPage> => {
    throw new Error('refresh unavailable');
  });
  let current = true;
  const Screen = () => (
    <CollectionPage
      page={page}
      queryKey={queryKey}
      cursor={undefined}
      refreshPage={refresh}
      isCurrent={() => current}
    />
  );
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/en/collections/alpha', component: Screen }),
      createRoute({ getParentRoute: () => rootRoute, path: '/away', component: () => 'Away' }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/en/collections/alpha'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const settle = (work: () => void) =>
    act(async () => {
      work();
      await Bun.sleep(30);
    });
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const click = (label: string) =>
    settle(() => [...dialog()!.querySelectorAll('button')].find((button) => button.textContent === label)!.click());
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const navigate = (href = '/away') =>
    settle(() => {
      void router.navigate({ href });
    });
  const begin = () =>
    settle(() => {
      const entry = actions.entries!.find((item) => 'label' in item && item.label === m.library_collection_edit());
      if (entry && 'onSelect' in entry) void entry.onSelect!();
    });
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    await settle(() => {});
    await begin();
    expect(unload()).toBe(false);
    await settle(() => members.onSelectionChange!(page.members[0]!.id, true));
    expect(unload()).toBe(false);
    await settle(() => metadata.onTitleChange('Draft'));
    expect(unload()).toBe(true);
    await settle(() => metadata.onTitleChange(page.title));
    expect(unload()).toBe(false);
    await settle(() => members.onNoteChange!(page.members[0]!.id, 'Draft note'));
    await settle(() => members.onMove!(page.members[1]!.id, null));
    const draft = members.members;
    await navigate('/en/collections/alpha?cursor=other');
    expect(dialog()).not.toBeNull();
    await click(m.library_collection_draft_navigation_stay());
    expect(router.state.location.searchStr).toBe('');
    expect(members.members).toEqual(draft);
    expect(members.selectedIds!.has(page.members[0]!.id)).toBe(true);
    await settle(() => {
      host.querySelector('a[href]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(dialog()).not.toBeNull();
    await click(m.library_collection_draft_navigation_stay());
    await settle(() => members.onMove!(page.members[0]!.id, null));
    await settle(() => members.onNoteChange!(page.members[0]!.id, page.members[0]!.note ?? ''));
    expect(unload()).toBe(false);
    await settle(() => metadata.onTitleChange('Saved title'));
    let finish!: (value: CollectionWriteResult) => void;
    update
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true, id: 'alpha', revision: 8 });
    const save = () =>
      settle(() => metadata.onSubmit({ preventDefault() {} } as Parameters<typeof metadata.onSubmit>[0]));
    await save();
    await navigate();
    expect(dialog()!.textContent).toContain(m.library_collection_draft_navigation_pending());
    expect(dialog()!.textContent).not.toContain(m.library_collection_draft_navigation_leave());
    await settle(() => finish({ ok: false, reason: 'unavailable' }));
    await click(m.library_collection_draft_navigation_stay());
    await navigate();
    expect(dialog()!.textContent).toContain(m.library_collection_draft_navigation_pending());
    await click(m.library_collection_draft_navigation_stay());
    await save();
    expect(update.mock.calls[1]![0]).toEqual(update.mock.calls[0]![0]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(unload()).toBe(false);
    expect(host.textContent).not.toContain(m.library_collection_draft_navigation_unsaved());
    await navigate();
    expect(router.state.location.pathname).toBe('/away');
    await navigate('/en/collections/alpha');
    await begin();
    await settle(() => members.onRemove!(page.members[0]!.id));
    await navigate();
    await click(m.library_collection_draft_navigation_leave());
    expect(router.state.location.pathname).toBe('/away');
    expect(remove).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    await navigate('/en/collections/alpha');
    await begin();
    await settle(() => metadata.onDescriptionChange('Retiring draft'));
    await navigate();
    expect(dialog()).not.toBeNull();
    current = false;
    await settle(() => client.setQueryData(queryKey, { ...page }));
    // A live guard checks retirement even before the next editor render.
    expect(unload()).toBe(false);
    await click(m.library_collection_draft_navigation_leave());
    expect(router.state.location.pathname).toBe('/away');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
