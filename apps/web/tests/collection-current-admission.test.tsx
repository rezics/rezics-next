import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import collection from '../src/kernel/recorded/library-collection.json';
import memberRecording from '../src/kernel/recorded/library-collection-members.json';
import type { EditableCollectionPage } from '../src/library/collection-load';
import type { CollectionWriteResult } from '../src/library/collection-records';

// UNRUN: focused composed regressions for the actual scoped consumer. Native, browser,
// original acceptance and whole-Goal proof remain deferred by the source-delivery contract.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const exposures: (ReturnType<typeof deferred<{ subject: string | null; admitted: string[] }>> & {
  expected: string;
})[] = [];
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
mock.module('@tanstack/react-start/server', () => start);
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const original = start.createServerFn();
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: (input: unknown) => unknown) {
        validate = next;
        original.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const delegate = original.handler(handler);
        return ((input?: { data?: unknown }) => {
          if (validate?.name === 'expectedSubject') {
            const call = {
              ...deferred<{ subject: string | null; admitted: string[] }>(),
              expected: validate(input?.data) as string,
            };
            exposures.push(call);
            return call.promise;
          }
          return delegate(input as never);
        }) as T;
      },
    };
    return chain;
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/alpha' });
window.document.head.innerHTML = '<link rel="canonical" href="https://site.test/en/collections/alpha">';
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { subjectOf } = await import('../src/library/reads');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const oldLocale = getLocale();
setLocale('en', { reload: false });
const menus = await import('@rezics/ui/menu');
const editors = await import('../src/library/collection-editor');
const pickers = await import('@rezics/ui/entity-picker');
const OriginalMenu = menus.Menu;
const OriginalMembers = editors.CollectionMemberList;
const OriginalPicker = pickers.EntityPicker;
let menu: ComponentProps<typeof OriginalMenu> | undefined;
let memberList: ComponentProps<typeof OriginalMembers> | undefined;
let picker: ComponentProps<typeof OriginalPicker> | undefined;
// Capture callbacks while retaining the installed renderer and shared ContentItem family.
spyOn(menus, 'Menu').mockImplementation((props) => {
  if (props.title === m.library_collection_actions()) menu = props;
  return <OriginalMenu {...props} />;
});
spyOn(editors, 'CollectionMemberList').mockImplementation((props) => {
  memberList = props;
  return <OriginalMembers {...props} />;
});
spyOn(pickers, 'EntityPicker').mockImplementation((props) => {
  picker = props;
  return <OriginalPicker {...props} />;
});
const { CollectionPage } = await import('../src/library/collection-page');
const { CollectionAddMembers } = await import('../src/library/collection-add-members');
const edits = await import('../src/library/collection-edit');
const commands = await import('../src/library/collection-commands');
afterAll(async () => {
  setLocale(oldLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});
const session = (subject = 'alice', csrfToken = 'csrf-one') => ({ state: 'signed-in', subject, csrfToken });
function page(
  subject = 'alice',
  operations = [
    'collection.update',
    'collection_member.create',
    'collection_member.update',
    'collection_member.move',
    'collection_member.delete',
  ],
): EditableCollectionPage {
  const member = memberRecording.members[0]!;
  return {
    ...collection.collection,
    id: 'alpha',
    title: `${subject} Collection`,
    description: null,
    curator: null,
    visibility: 'private',
    revision: 7,
    firstPage: true,
    following: null,
    members: [
      { ...member, id: 'occurrence-one', subject: subjectOf(member.subject) },
      { ...member, id: 'occurrence-two', subject: subjectOf(member.subject) },
    ],
    memberCount: 2,
    next: null,
    memberState: 'ready',
    publicExport: false,
    viewerActions: { state: 'ready', actions: [{ action: 'collection:update', operations }] },
  } as EditableCollectionPage;
}
const settle = (work: () => void) =>
  act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
async function mounted(kind: 'page' | 'occurrence' = 'page') {
  exposures.length = 0;
  menu = undefined;
  memberList = undefined;
  picker = undefined;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/collections/alpha'] }),
  });
  await router.load();
  const invalidate = spyOn(router, 'invalidate').mockResolvedValue(undefined);
  const refresh = mock(async (): Promise<EditableCollectionPage> => props.page);
  let props: ComponentProps<typeof CollectionPage> = {
    page: page(),
    queryKey: ['collection-page', 'owned', 'alpha'],
    cursor: undefined,
    readEditorPage: mock(async () => props.page),
    refreshPage: refresh,
  };
  // Match the owning route: the native page is already the successful data at its exact query address.
  client.setQueryData(props.queryKey, props.page);
  const onAdded = mock(async () => {});
  const onClose = mock(() => {});
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          {kind === 'page' ? (
            <CollectionPage {...props} />
          ) : (
            <CollectionAddMembers collectionId={props.page.id} onAdded={onAdded} onClose={onClose} />
          )}
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const key = () => {
    const value = viewerExposureLifetime(client).getSnapshot();
    if (value.state !== 'signed-in') throw new Error('Expected actual observation');
    return viewerExposureQuery(value.observation).queryKey;
  };
  const expose = (subject = 'alice', admitted = ['collections']) =>
    settle(() => client.setQueryData(key(), { subject, admitted }));
  await settle(() => root.render(tree()));
  return {
    host,
    client,
    router,
    onAdded,
    onClose,
    invalidate,
    refresh,
    key,
    expose,
    props: () => props,
    show: (next: Partial<typeof props> = {}) =>
      settle(() => {
        props = { ...props, ...next };
        root.render(tree());
      }),
    renew: (subject = 'alice', csrf = 'csrf-two') =>
      settle(() => client.setQueryData(sessionQuery.queryKey, session(subject, csrf))),
    close: async () => {
      await act(async () => root.unmount());
      invalidate.mockRestore();
      client.clear();
      host.remove();
    },
  };
}
type UI = Awaited<ReturnType<typeof mounted>>;
function editCallback() {
  const entry = menu?.entries?.find((entry) => 'label' in entry && entry.label === m.library_collection_edit());
  if (!entry || !('onSelect' in entry)) throw new Error('Expected actual editor callback');
  return entry.onSelect!;
}
async function begin(ui: UI) {
  const edit = editCallback();
  await settle(() => {
    void edit();
  });
  expect(ui.host.querySelector('#collection-edit-form')).not.toBeNull();
}
async function submit(ui: UI, occurrence = false) {
  await settle(() => {
    const form = ui.host.querySelector(occurrence ? 'form' : '#collection-edit-form');
    expect(form).not.toBeNull();
    form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  });
}
async function selectOccurrence(ui: UI) {
  const selected = { id: 'picked-subject', title: 'Selected subject', types: [], typeLabel: '', cover: null };
  await settle(() => picker!.onValueChange!([selected]));
  const note = ui.host.querySelector('textarea')!;
  await settle(() => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      note,
      'Exact occurrence note',
    );
    note.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

describe('Actual scoped Collection authority enables owning editor and occurrence workflows while retaining exact uncertain operations across healthy renewal and retiring replaced callbacks', () => {
  test('a null-token owner can inspect duplicate occurrences and refresh the editor while every save remains gated', async () => {
    const ui = await mounted();
    const update = spyOn(edits, 'updateCollection');
    try {
      await settle(() => ui.client.setQueryData(sessionQuery.queryKey, { ...session(), csrfToken: null }));
      await ui.expose();
      await begin(ui);
      expect(memberList!.members.map((member) => member.id)).toEqual(['occurrence-one', 'occurrence-two']);
      await submit(ui);
      expect(update).toHaveBeenCalledTimes(0);
      const reload = [...ui.host.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === m.library_collection_reload(),
      )!;
      expect(reload.disabled).toBe(false);
      await settle(() => reload.click());
      expect(ui.refresh).toHaveBeenCalledTimes(1);
      await ui.renew();
      await ui.expose();
      expect(update).toHaveBeenCalledTimes(0);
    } finally {
      update.mockRestore();
      await ui.close();
    }
  });

  for (const refusal of ['invalid', 'conflict', null] as const)
    test(`selected duplicate occurrences require confirmation and one loaded-CAS command: ${refusal ?? 'Undo'}`, async () => {
      const ui = await mounted();
      const episodes = ['occurrence-one', 'occurrence-two'].map((memberId, index) => ({
        collectionId: 'alpha',
        memberId,
        deletionId: `episode-${index}`,
        revision: 8,
      }));
      const batch = spyOn(commands, 'batchRemoveCollectionMembers').mockResolvedValue(
        refusal ? { ok: false, reason: refusal } : { ok: true, revision: 8, undo: episodes },
      );
      const update = spyOn(edits, 'updateCollection');
      const restore = spyOn(edits, 'restoreCollectionMember').mockResolvedValue({ ok: true, id: 'occurrence-one' });
      const click = (node: Element | null) => settle(() => (node as HTMLElement).click());
      const dialog = () => document.querySelector('[data-collection-removal-confirmation]');
      try {
        await ui.show({
          page: page('alice', [
            'collection.update',
            'collection_member.delete',
            'collection_member.batch_remove',
            'collection_member.restore',
          ]),
        });
        await settle(() => ui.client.setQueryData(ui.props().queryKey, ui.props().page));
        await ui.expose();
        await begin(ui);
        await settle(() => {
          memberList!.onSelectionChange!('occurrence-one', true);
          memberList!.onSelectionChange!('occurrence-two', true);
        });
        await click(
          [...ui.host.querySelectorAll('button')].find(
            (node) => node.textContent === m.library_collection_remove_selected(),
          )!,
        );
        await submit(ui);
        expect(dialog()?.textContent).toContain(m.library_collection_selection_count({ count: 2 }));
        expect(batch).not.toHaveBeenCalled();
        await click(
          [...dialog()!.querySelectorAll('button')].find((node) => node.textContent === m.library_collection_cancel())!,
        );
        expect(batch).not.toHaveBeenCalled();
        await submit(ui);
        await click(
          [...dialog()!.querySelectorAll('button')].find((node) => node.textContent === m.library_collection_save())!,
        );
        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch.mock.calls[0]![0]!.data).toMatchObject({
          collectionId: 'alpha',
          revision: 7,
          memberIds: ['occurrence-one', 'occurrence-two'],
        });
        expect(update).not.toHaveBeenCalled();
        if (refusal) {
          expect(ui.host.querySelector('[data-collection-undo]')).toBeNull();
          expect(ui.refresh).not.toHaveBeenCalled();
        } else {
          const buttons = [...ui.host.querySelectorAll('[data-collection-undo] button')];
          expect(buttons).toHaveLength(2);
          await click(buttons[1]!);
          expect(restore.mock.calls[0]![0]!.data).toMatchObject(episodes[1]!);
          expect(ui.host.querySelectorAll('[data-collection-undo] button')).toHaveLength(1);
        }
      } finally {
        batch.mockRestore();
        update.mockRestore();
        restore.mockRestore();
        await ui.close();
      }
    });

  test('healthy subject-scoped exposure opens the actual editor without a global key; foreign global data cannot supply authority or a native action', async () => {
    const ui = await mounted();
    try {
      expect(ui.client.getQueryData(exposureQuery.queryKey)).toBeUndefined();
      const edit = editCallback();
      await settle(() => {
        void edit();
      });
      expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
      await ui.expose();
      await begin(ui);
      expect(memberList!.members.map((member) => member.id)).toEqual(['occurrence-one', 'occurrence-two']);
      expect(memberList!.members[0]!.subject!.id).toBe(memberList!.members[1]!.subject!.id);
    } finally {
      await ui.close();
    }
    const closed = await mounted();
    try {
      await settle(() => closed.client.setQueryData(exposureQuery.queryKey, ['collections']));
      await closed.expose('foreign-viewer');
      await settle(() => {
        void editCallback()();
      });
      expect(closed.host.querySelector('#collection-edit-form')).toBeNull();
      await closed.expose();
      await closed.show({ page: page('alice', ['collection_member.create']) });
      expect(menu!.entries!.some((entry) => 'label' in entry && entry.label === m.library_collection_edit())).toBe(
        false,
      );
      await closed.show({ page: page(), isCurrent: () => false });
      await settle(() => {
        void editCallback()();
      });
      expect(closed.host.querySelector('#collection-edit-form')).toBeNull();
    } finally {
      await closed.close();
    }
  });

  test('observed viewer, exposure/native action and route address ABA permanently retire precommit callbacks; a replacement remains usable while A settles', async () => {
    const ui = await mounted();
    const pending = deferred<CollectionWriteResult>();
    const update = spyOn(edits, 'updateCollection')
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, id: 'alpha', revision: 8 });
    const note = spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: 'occurrence-two' });
    try {
      await ui.expose();
      for (const replace of ['viewer', 'sign-out', 'exposure', 'native', 'address'] as const) {
        const old = editCallback();
        await settle(() => {
          if (replace === 'viewer') {
            ui.client.setQueryData(sessionQuery.queryKey, session('bob'));
            ui.client.setQueryData(sessionQuery.queryKey, session());
          } else if (replace === 'sign-out') {
            ui.client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
            ui.client.setQueryData(sessionQuery.queryKey, session());
          } else if (replace === 'exposure') {
            ui.client.setQueryData(ui.key(), { subject: 'alice', admitted: [] });
            ui.client.setQueryData(ui.key(), { subject: 'alice', admitted: ['collections'] });
          } else if (replace === 'native') {
            ui.client.setQueryData(ui.props().queryKey, { ...page(), viewerActions: { state: 'unavailable' } });
            ui.client.setQueryData(ui.props().queryKey, page());
          } else {
            // The same synchronous router notifications used by real navigation, before any commit.
            const fromLocation = ui.router.state.location;
            ui.router.emit({
              type: 'onBeforeNavigate',
              fromLocation,
              toLocation: { ...fromLocation, publicHref: '/en/collections/alpha?cursor=next' },
              pathChanged: false,
              hrefChanged: true,
              hashChanged: false,
            });
            ui.router.emit({
              type: 'onBeforeNavigate',
              fromLocation,
              toLocation: fromLocation,
              pathChanged: false,
              hrefChanged: true,
              hashChanged: false,
            });
          }
          void old();
        });
        expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
        await ui.expose();
      }
      await begin(ui);
      await settle(() => memberList!.onNoteChange!('occurrence-two', 'A private draft'));
      await submit(ui);
      const first = structuredClone(update.mock.calls[0]![0]!.data);
      await ui.renew('bob', 'bob-csrf');
      await ui.show({ page: page('bob') });
      await ui.expose('bob');
      await begin(ui);
      expect(ui.host.innerHTML).not.toContain('A private draft');
      await settle(() => memberList!.onNoteChange!('occurrence-one', 'B usable draft'));
      await submit(ui);
      expect(update).toHaveBeenCalledTimes(2);
      expect(new Headers(update.mock.calls[1]![0]!.headers).get('X-CSRF-Token')).toBe('bob-csrf');
      await settle(() => pending.resolve({ ok: true, id: 'alpha', revision: 8 }));
      expect(update.mock.calls[0]![0]!.data).toEqual(first);
      expect(note).toHaveBeenCalledTimes(1);
      expect(note.mock.calls[0]![0]!.data.note).toBe('B usable draft');
    } finally {
      update.mockRestore();
      note.mockRestore();
      await ui.close();
    }
  });

  test('uncertain editor input/revision/key survive healthy scoped renewal and unavailable settlement; retry needs fresh actual operation admission', async () => {
    const ui = await mounted();
    const pending = deferred<CollectionWriteResult>();
    const update = spyOn(edits, 'updateCollection')
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, id: 'alpha', revision: 8 });
    const note = spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: 'occurrence-two' });
    try {
      await ui.expose();
      await begin(ui);
      await settle(() => memberList!.onNoteChange!('occurrence-two', 'Exact retained draft'));
      await submit(ui);
      const exact = structuredClone(update.mock.calls[0]![0]!.data);
      await ui.renew(); // This enrolls a fresh scoped observation, not a legacy cache entry.
      await ui.expose();
      await settle(() =>
        ui.client
          .getQueryCache()
          .find({ queryKey: sessionQuery.queryKey })!
          .setState({ status: 'error', error: new Error('temporarily unavailable') }),
      );
      await settle(() => pending.resolve({ ok: false, reason: 'unavailable' }));
      await submit(ui);
      expect(update).toHaveBeenCalledTimes(1);
      await ui.renew('alice', 'csrf-three');
      await ui.expose();
      expect(ui.host.querySelector('#collection-edit-form')).not.toBeNull();
      expect(memberList!.members[1]!.note).toBe('Exact retained draft');
      await submit(ui);
      expect(update).toHaveBeenCalledTimes(2);
      expect(update.mock.calls[1]![0]!.data).toEqual(exact);
      expect(new Headers(update.mock.calls[1]![0]!.headers).get('X-CSRF-Token')).toBe('csrf-one');
      expect(note).toHaveBeenCalledTimes(1);
      expect(note.mock.calls[0]![0]!.data).toMatchObject({ memberId: 'occurrence-two', note: 'Exact retained draft' });
    } finally {
      update.mockRestore();
      note.mockRestore();
      await ui.close();
    }
  });

  test('an occurrence retains its exact subject/note/key through scoped renewal and missing credentials; accepted add retries only reload', async () => {
    const ui = await mounted();
    const pending = deferred<CollectionWriteResult>();
    const add = spyOn(edits, 'addCollectionMember')
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, id: 'new-occurrence' });
    try {
      await ui.expose();
      await settle(() => {
        const addButton = [...ui.host.querySelectorAll('button')].find(
          (button) => button.textContent?.trim() === m.library_collection_add_items(),
        );
        expect(addButton).toBeDefined();
        addButton!.click();
      });
      await selectOccurrence(ui);
      await submit(ui, true);
      const exact = structuredClone(add.mock.calls[0]![0]!.data);
      expect(exact).toMatchObject({
        collectionId: 'alpha',
        subjectId: 'picked-subject',
        note: 'Exact occurrence note',
      });
      await ui.renew();
      await ui.expose();
      await ui.show({ page: { ...page(), viewerActions: { state: 'unavailable' } } });
      await ui.renew('alice', '');
      await settle(() => pending.resolve({ ok: false, reason: 'unavailable' }));
      await submit(ui, true);
      expect(add).toHaveBeenCalledTimes(1);
      await ui.show({ page: page() });
      await ui.renew('alice', 'csrf-three');
      await ui.expose();
      ui.refresh.mockRejectedValueOnce(new Error('reload unavailable'));
      await submit(ui, true);
      expect(add.mock.calls[1]![0]!.data).toEqual(exact);
      expect(new Headers(add.mock.calls[1]![0]!.headers).get('X-CSRF-Token')).toBe('csrf-three');
      expect(ui.host.querySelector('form')).not.toBeNull();
      await submit(ui, true);
      expect(add).toHaveBeenCalledTimes(2);
      expect(ui.refresh).toHaveBeenCalledTimes(2);
      expect(ui.host.querySelector('form')).toBeNull();
    } finally {
      add.mockRestore();
      await ui.close();
    }
  });

  test('an accepted occurrence settling during a gap is acknowledged privately; retired callbacks cannot add or clear B', async () => {
    const ui = await mounted('occurrence');
    const pending = deferred<CollectionWriteResult>();
    const add = spyOn(edits, 'addCollectionMember')
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ok: true, id: 'B-occurrence' });
    try {
      await ui.expose();
      await selectOccurrence(ui);
      const oldSelection = picker!.onValueChange!;
      await submit(ui, true);
      await ui.renew('alice', '');
      await settle(() => pending.resolve({ ok: true, id: 'accepted-A' }));
      expect(ui.onAdded).not.toHaveBeenCalled();
      await ui.renew();
      await ui.expose();
      await submit(ui, true);
      expect(add).toHaveBeenCalledTimes(1); // Acknowledged success is reload-only, including across an admission gap.
      expect(ui.onAdded).toHaveBeenCalledTimes(1);
      await ui.renew('bob', 'bob-csrf');
      await ui.expose('bob');
      await settle(() =>
        oldSelection([{ id: 'old-A', title: 'A private selection', types: [], typeLabel: '', cover: null }]),
      );
      expect(picker!.value).toEqual([]);
      await selectOccurrence(ui);
      await submit(ui, true);
      expect(add).toHaveBeenCalledTimes(2);
      expect(add.mock.calls[1]![0]!.data.idempotencyKey).not.toBe(add.mock.calls[0]![0]!.data.idempotencyKey);
      expect(new Headers(add.mock.calls[1]![0]!.headers).get('X-CSRF-Token')).toBe('bob-csrf');
    } finally {
      add.mockRestore();
      await ui.close();
    }
  });
});
