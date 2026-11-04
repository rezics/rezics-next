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
  const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
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
  function Screen() {
    const { data } = useQuery({ queryKey, queryFn: refresh, enabled: false });
    return (
      <CollectionPage
        page={data!}
        queryKey={queryKey}
        cursor={undefined}
        refreshPage={refresh}
        isCurrent={() => current}
      />
    );
  }
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
    expect(
      [...dialog()!.querySelectorAll('button')].some(
        (button) => button.textContent === m.library_collection_draft_navigation_leave(),
      ),
    ).toBe(false);
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
    expect(unload()).toBe(false);
    expect(dialog()).toBeNull();
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

test('presentation draft returns, cancels and hands off to the existing Save capture without another mutation', async () => {
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/presentation' });
  window.document.head.innerHTML = '<link rel="canonical" href="https://site.test/en/collections/presentation">';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    ...Object.fromEntries(
      [
        'HTMLElement',
        'HTMLButtonElement',
        'HTMLInputElement',
        'HTMLSelectElement',
        'HTMLAnchorElement',
        'HTMLFormElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
        'ResizeObserver',
        'ShadowRoot',
        'NodeFilter',
        'Event',
        'FocusEvent',
        'MouseEvent',
        'KeyboardEvent',
        'PointerEvent',
      ].map((key) => [key, window[key as keyof typeof window]]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
  const { createRouter, createRootRoute, createRoute, createMemoryHistory, RouterProvider, Outlet } =
    await import('@tanstack/react-router');
  const sessions = await import('../src/session/query');
  spyOn(sessions, 'useSession').mockReturnValue({ state: 'signed-in', subject: 'owner', csrfToken: 'original-csrf' });
  const { m } = await import('../src/paraglide/messages.js');
  const menus = await import('@rezics/ui/menu');
  const editors = await import('../src/library/collection-editor');
  let actions!: ComponentProps<typeof menus.Menu>;
  let metadata!: ComponentProps<typeof editors.CollectionMetadataEditor>;
  let presentation!: ComponentProps<typeof editors.CollectionPresentationFields>;
  const OriginalMenu = menus.Menu,
    OriginalMetadata = editors.CollectionMetadataEditor,
    OriginalPresentation = editors.CollectionPresentationFields;
  spyOn(menus, 'Menu').mockImplementation((props) => {
    if (props.entries?.some((entry) => 'label' in entry && entry.label === m.library_collection_edit()))
      actions = props;
    return <OriginalMenu {...props} />;
  });
  spyOn(editors, 'CollectionMetadataEditor').mockImplementation((props) => {
    metadata = props;
    return <OriginalMetadata {...props} />;
  });
  spyOn(editors, 'CollectionPresentationFields').mockImplementation((props) => {
    presentation = props;
    return <OriginalPresentation {...props} />;
  });
  const edits = await import('../src/library/collection-edit');
  let finish!: (result: CollectionWriteResult) => void;
  const update = spyOn(edits, 'updateCollection').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const note = spyOn(edits, 'updateMemberNote'),
    move = spyOn(edits, 'moveCollectionMember'),
    remove = spyOn(edits, 'removeCollectionMember');
  const { subjectOf } = await import('../src/library/reads');
  const { CollectionPage } = await import('../src/library/collection-page');
  const page: EditableCollectionPage = {
    ...recording.collection,
    id: 'presentation',
    title: 'Saved native collection',
    revision: 7,
    presentationKind: null,
    presentationKindSource: 'mixed',
    coverMediaId: null,
    presentationTypes: [{ id: 'schema:Book', label: 'Released book Type' }],
    visibility: 'private',
    curator: null,
    firstPage: true,
    following: null,
    next: null,
    publicExport: false,
    viewerActions: { state: 'ready', actions: [{ action: 'collection:update', operations: ['collection.update'] }] },
    members: recordedMembers.members.slice(0, 2).map((member) => ({ ...member, subject: subjectOf(member.subject) })),
  };
  const readback: EditableCollectionPage = {
    ...page,
    revision: 8,
    presentationKind: 'schema:Book',
    presentationKindSource: 'owner',
  };
  const client = new QueryClient(),
    queryKey = ['presentation-save'];
  client.setQueryData(queryKey, page);
  const refresh = mock(async () => readback);
  function Screen() {
    const { data } = useQuery({ queryKey, queryFn: refresh, enabled: false });
    return (
      <CollectionPage
        page={data!}
        queryKey={queryKey}
        cursor={undefined}
        refreshPage={refresh}
        isCurrent={() => true}
      />
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/en/collections/presentation', component: Screen }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/en/collections/presentation'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const settle = (work: () => void) =>
    act(async () => {
      work();
      await Bun.sleep(30);
    });
  const begin = () =>
    settle(() => {
      const entry = actions.entries!.find((item) => 'label' in item && item.label === m.library_collection_edit());
      if (entry && 'onSelect' in entry) void entry.onSelect!();
    });
  const trigger = () => host.querySelector<HTMLButtonElement>('[data-presentation-review-trigger]')!;
  const unsaved = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
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
    await settle(() => presentation.onKindChange('schema:Book'));
    expect(unsaved()).toBe(true);
    await settle(() => trigger().click());
    await settle(() =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === m.collection_choice_return_editor())!
        .click(),
    );
    expect(presentation.kind).toBe('schema:Book');
    expect(document.activeElement).toBe(trigger());
    expect(update).not.toHaveBeenCalled();
    await settle(() =>
      [...host.querySelectorAll('[data-collection-save] button')]
        .find((button) => button.textContent === m.library_collection_cancel())!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
    await begin();
    expect(presentation.kind).toBeNull();
    expect(unsaved()).toBe(false);
    await settle(() => presentation.onKindChange('schema:Book'));
    await settle(() => trigger().click());
    await settle(() => host.querySelector<HTMLButtonElement>('[data-review-return-save]')!.click());
    expect(host.querySelector('[data-presentation-review]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[data-collection-save] button[type="submit"]'));
    expect(update).not.toHaveBeenCalled();
    await settle(() => metadata.onSubmit({ preventDefault() {} } as Parameters<typeof metadata.onSubmit>[0]));
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0].data).toMatchObject({ presentationKind: 'schema:Book', revision: 7 });
    expect(update.mock.calls[0]![0].data).not.toHaveProperty('coverMediaId');
    expect(presentation.disabled).toBe(true);
    await settle(() => presentation.onKindChange(null));
    expect(presentation.kind).toBe('schema:Book');
    await settle(() => finish({ ok: true, id: page.id, revision: 8 }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-presentation-review-trigger]')).toBeNull();
    expect(host.querySelector('[data-collection-kind="schema:Book"]')).not.toBeNull();
    expect(unsaved()).toBe(false);
    expect(note).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
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
