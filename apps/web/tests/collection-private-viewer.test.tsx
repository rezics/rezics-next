import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useLayoutEffect, type ComponentProps, type ComponentType } from 'react';
import * as start from '../.storybook/react-start';
import collectionRecording from '../src/kernel/recorded/library-collection.json';
import membersRecording from '../src/kernel/recorded/library-collection-members.json';
import type { CollectionPageResult, CollectionReadAddress, DynamicMembersResult } from '../src/library/collection-load';
import type { SessionEnv } from '../src/session/client';

// UNRUN: mounted/deferred source regressions, using the installed DOM and recorded native subjects.
// Integration, native authorization and browser/visual acceptance remain deferred by the launch contract.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Address = CollectionReadAddress & { credentialMode: 'anonymous' | 'session' };
type Call = {
  input: Address;
  kind: 'page' | 'members';
  work: ReturnType<typeof deferred<CollectionPageResult | DynamicMembersResult>>;
};
const calls: Call[] = [];
// Keep the real validators, query function and mounted route. Control only the server-function transport.
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn() {
    const delegate = start.createServerFn();
    let validate: ((input: unknown) => unknown) | undefined;
    const chain = {
      validator(next: (input: unknown) => unknown) {
        validate = next;
        delegate.validator(next);
        return chain;
      },
      handler<T extends (...args: never[]) => unknown>(handler: T): T {
        const original = delegate.handler(handler);
        return ((input?: { data: unknown }) => {
          if (validate?.name === 'validatePageInput' || validate?.name === 'validateDynamicMembersInput') {
            const call: Call = {
              input: validate(input?.data) as Address,
              kind: validate.name === 'validatePageInput' ? 'page' : 'members',
              work: deferred<CollectionPageResult | DynamicMembersResult>(),
            };
            calls.push(call);
            return call.work.promise;
          }
          return original(input as never);
        }) as T;
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/original' });
window.document.head.innerHTML = '<link rel="canonical" href="https://site.test/en/collections/original">';
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
const { renderToString } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { collectionRequestVariant, collectionResultMatches, loadEditableCollectionPage } =
  await import('../src/library/collection-load');
const { subjectOf } = await import('../src/library/reads');
const pageModule = await import('../src/library/collection-page');
const dynamicModule = await import('../src/library/dynamic-collection-page');
type PageProps = ComponentProps<typeof pageModule.CollectionPage>;
type DynamicProps = ComponentProps<typeof dynamicModule.DynamicCollectionPage>;
let pageProps: PageProps | undefined;
let dynamicProps: DynamicProps | undefined;
const OriginalPage = pageModule.CollectionPage;
const OriginalDynamic = dynamicModule.DynamicCollectionPage;
spyOn(pageModule, 'CollectionPage').mockImplementation((props) => {
  pageProps = props;
  return <OriginalPage {...props} />;
});
spyOn(dynamicModule, 'DynamicCollectionPage').mockImplementation((props) => {
  dynamicProps = props;
  return <OriginalDynamic {...props} />;
});
const { Route } = await import('../src/routes/collections/$id');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { libraryNavigationQuery } = await import('../src/library/pins-read');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
setLocale('en', { reload: false });
let address: { id: string; cursor?: string; filters?: Record<string, string | string[]> } = { id: 'original' };
let initialPage: CollectionPageResult | undefined;
spyOn(Route, 'useParams').mockImplementation(() => ({ id: address.id }) as never);
spyOn(Route, 'useSearch').mockImplementation(() => ({ cursor: address.cursor, filters: address.filters }) as never);
spyOn(Route, 'useLoaderData').mockImplementation(() => initialPage as never);
const Screen = Route.options.component as ComponentType;
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const provenance = (call: Pick<Call, 'input' | 'kind'>, viewerId: string | null) => ({
  mode: call.input.credentialMode,
  viewerId,
  request: collectionRequestVariant(call.input, call.kind),
});
function ready(call: Call, viewerId = 'alice', change: Partial<CollectionPageResult> = {}): CollectionPageResult {
  return {
    ...collectionRecording.collection,
    id: call.input.id,
    title: `${viewerId} private Collection`,
    visibility: 'private',
    members: membersRecording.members.map((member) => ({ ...member, subject: subjectOf(member.subject) })),
    next: null,
    firstPage: !call.input.cursor,
    following: null,
    memberState: 'ready',
    publicExport: false,
    ...(call.input.cursor ? { cursor: call.input.cursor } : {}),
    viewerActions: {
      state: 'ready',
      actions: [{ action: 'collection:update', operations: ['collection.update', 'collection_member.move'] }],
    },
    provenance: provenance(call, viewerId),
    ...change,
  } as CollectionPageResult;
}
function dynamic(call: Call, viewerId = 'alice'): CollectionPageResult {
  return {
    id: call.input.id,
    title: `${viewerId} dynamic Collection`,
    description: null,
    curator: null,
    builtinKind: 'everything',
    members: [],
    next: null,
    preparing: false,
    retryAfterMs: 1000,
    unavailable: false,
    ...(call.input.cursor ? { cursor: call.input.cursor } : {}),
    provenance: provenance(call, viewerId),
  };
}
function members(call: Call, viewerId = 'alice'): DynamicMembersResult {
  return {
    members: [{ subject: subjectOf(membersRecording.members[0]!.subject) }],
    next: null,
    preparing: false,
    retryAfterMs: 1000,
    unavailable: false,
    provenance: provenance(call, viewerId),
  };
}
const settle = (work: () => void) =>
  act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
function CommitSnapshot({ observe }: { observe: () => void }) {
  useLayoutEffect(observe);
  return null;
}
async function mount() {
  calls.length = 0;
  pageProps = undefined;
  dynamicProps = undefined;
  initialPage = undefined;
  address = { id: 'original' };
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false, gcTime: Infinity } },
  });
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const invalidations = spyOn(router, 'invalidate').mockResolvedValue(undefined);
  const commits: string[] = [];
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <Screen />
          <CommitSnapshot
            observe={() => {
              commits.push(host.textContent ?? '');
            }}
          />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const show = async (
    subject: string | null = 'alice',
    patch: { admitted?: boolean; csrf?: string | null; state?: 'unknown' | 'signed-out' | 'signed-in' } = {},
  ) => {
    await settle(() => {
      client.setQueryData(sessionQuery.queryKey, {
        state: patch.state ?? 'signed-in',
        subject,
        csrfToken: patch.csrf === undefined ? 'csrf' : patch.csrf,
      });
      client.setQueryData(exposureQuery.queryKey, patch.admitted === false ? [] : ['collections']);
      client.setQueryData(['exposure', 'anonymous'], ['collections']);
      client.setQueryData(libraryNavigationQuery('en', 100).queryKey, { pins: { state: 'closed' }, collections: [] });
      root.render(tree());
    });
  };
  return {
    host,
    client,
    router,
    invalidations,
    commits,
    show,
    tree,
    async answer(call = calls.at(-1)!, result = ready(call)) {
      await settle(() => call.work.resolve(result));
    },
    async refetch() {
      await settle(() => {
        void client.refetchQueries({ queryKey: ['collection-page'], type: 'active' });
      });
    },
    async hide() {
      await settle(() => root.render(null));
    },
    async close() {
      await act(async () => root.unmount());
      invalidations.mockRestore();
      client.clear();
      host.remove();
    },
  };
}

test('Private Collection page and refresh editor member responses remain bound to the actual current viewer and exact request', async () => {
  const ui = await mount();
  try {
    await ui.show();
    const oldPage = calls[0]!;
    await ui.show('bob');
    const bobPage = calls.at(-1)!;
    expect(bobPage).not.toBe(oldPage);
    await ui.answer(bobPage, ready(bobPage, 'bob'));
    expect(ui.host.textContent).toContain('bob private Collection');
    await ui.answer(oldPage);
    expect(ui.host.textContent).not.toContain('alice private Collection');
    expect(
      ui.client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes('alice'))
        .every((query) => !query.state.data),
    ).toBe(true);
    const oldProps = pageProps!;
    const refresh = oldProps.refreshPage();
    const refreshCall = calls.at(-1)!;
    const editor = oldProps.readEditorPage!();
    const editorCall = calls.at(-1)!;
    const refreshRejected = expect(refresh).rejects.toThrow('retired');
    const editorRejected = expect(editor).rejects.toThrow('retired');
    await ui.show('carol');
    await ui.answer(calls.at(-1)!, ready(calls.at(-1)!, 'carol'));
    await ui.answer(refreshCall, ready(refreshCall, 'bob'));
    await ui.answer(editorCall, ready(editorCall, 'bob'));
    await refreshRejected;
    await editorRejected;
    expect(ui.host.textContent).toContain('carol private Collection');
    expect(ui.invalidations).not.toHaveBeenCalled();
    expect(ui.commits.at(-1)).not.toContain('bob private Collection');
    await expect(oldProps.refreshPage()).rejects.toThrow('retired'); // No new IO from a retired child.
  } finally {
    await ui.close();
  }
});

test('admission, address, native authority and unmount retire reads while ordinary current refetch and CSRF rotation keep the child', async () => {
  const ui = await mount();
  try {
    await ui.show();
    await ui.answer();
    const first = pageProps!;
    const currentRead = first.readEditorPage!();
    const currentCall = calls.at(-1)!;
    await ui.show('alice', { csrf: 'rotated-nonempty' });
    await ui.refetch();
    await ui.answer();
    await ui.answer(currentCall);
    expect(await currentRead).toMatchObject({ id: address.id }); // No gratuitous lifetime replacement.
    for (const replace of ['admission', 'address', 'authority', 'unmount'] as const) {
      const source = pageProps!;
      const pending = source.refreshPage();
      const call = calls.at(-1)!;
      const rejected = expect(pending).rejects.toThrow('retired');
      if (replace === 'admission') {
        await ui.show('alice', { admitted: false });
        expect(ui.host.textContent).not.toContain('alice private Collection');
        await ui.show();
        await ui.answer();
      } else if (replace === 'address') {
        address = { id: 'replacement', cursor: 'exact-cursor', filters: { 'f.schema:genre': ['one', 'two'] } };
        await ui.show();
        await ui.answer();
        expect(pageProps!.page.id).toBe('replacement');
      } else if (replace === 'authority') {
        await ui.refetch();
        const replacement = calls.at(-1)!;
        await ui.answer(replacement, ready(replacement, 'alice', { viewerActions: { state: 'unavailable' } }));
      } else await ui.hide();
      await ui.answer(call);
      await rejected;
      expect(ui.invalidations).not.toHaveBeenCalled();
    }
  } finally {
    await ui.close();
  }
});

async function beginEditing(ui: Awaited<ReturnType<typeof mount>>, viewer = 'alice') {
  await settle(() =>
    ui.host.querySelector<HTMLButtonElement>(`button[aria-label="${m.library_collection_actions()}"]`)!.click(),
  );
  await settle(() => {
    const edit = [...window.document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
      (node) => node.textContent?.trim() === m.library_collection_edit(),
    );
    expect(edit).toBeDefined();
    edit!.click();
  });
  const call = calls.at(-1)!;
  expect(call.input.editor).toBe(true);
  await ui.answer(call, ready(call, viewer));
  expect(ui.host.querySelector('#collection-edit-form')).not.toBeNull();
}

test('a mounted editor draft survives ordinary current reads and retires before the replacement viewer renders', async () => {
  const ui = await mount();
  try {
    await ui.show();
    await ui.answer();
    await beginEditing(ui);
    const input = ui.host.querySelector<HTMLInputElement>('#collection-edit-form input[maxlength="512"]')!;
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'Alice unsaved draft',
      );
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await ui.show('alice', { csrf: 'new-nonempty-csrf' });
    await ui.refetch();
    await ui.answer();
    expect(ui.host.querySelector<HTMLInputElement>('#collection-edit-form input[maxlength="512"]')!.value).toBe(
      'Alice unsaved draft',
    );
    await ui.show('bob');
    expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
    expect(ui.host.textContent).not.toContain('alice private Collection');
    const bob = calls.at(-1)!;
    await ui.answer(bob, ready(bob, 'bob'));
    expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
    expect(ui.host.innerHTML).not.toContain('Alice unsaved draft');
  } finally {
    await ui.close();
  }
});

test('a dispatched native save cannot send its next member write with replacement credentials', async () => {
  const ui = await mount();
  const edits = await import('../src/library/collection-edit');
  const parent = deferred<{ ok: true; id: string; revision: number }>();
  const update = spyOn(edits, 'updateCollection').mockImplementation(() => parent.promise);
  const note = spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: 'member' });
  try {
    await ui.show();
    await ui.answer();
    await beginEditing(ui);
    const textarea = ui.host.querySelector<HTMLTextAreaElement>('textarea[id^="collection-member-note-"]')!;
    expect(textarea).not.toBeNull();
    await settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        'Alice private note',
      );
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await settle(() =>
      ui.host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(update).toHaveBeenCalledTimes(1);
    await ui.show('bob', { csrf: 'csrf-bob' });
    const bob = calls.at(-1)!;
    await ui.answer(bob, ready(bob, 'bob'));
    await settle(() => parent.resolve({ ok: true, id: address.id, revision: 2 }));
    expect(note).not.toHaveBeenCalled();
    expect(ui.invalidations).not.toHaveBeenCalled();
  } finally {
    update.mockRestore();
    note.mockRestore();
    await ui.close();
  }
});

type MountedCollection = Awaited<ReturnType<typeof mount>>;
async function changeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await settle(() => {
    const prototype = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
async function clickNamed(ui: MountedCollection, name: string) {
  const button = [...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === name,
  );
  expect(button).toBeDefined();
  expect(button!.disabled).toBe(false);
  await settle(() => button!.click());
}
async function submitDraft(ui: MountedCollection) {
  await settle(() =>
    ui.host.querySelector('#collection-edit-form')!.dispatchEvent(
      new window.Event('submit', { bubbles: true, cancelable: true }),
    ),
  );
}
async function stageDraft(ui: MountedCollection, next: 'transfer' | 'batch' | 'member' | 'chain') {
  if (next === 'member' || next === 'chain') {
    const notes = ui.host.querySelectorAll<HTMLTextAreaElement>('textarea[id^="collection-member-note-"]');
    if (next === 'chain') await changeValue(notes[notes.length - 2]!, 'First originating private note');
    await changeValue(notes[notes.length - 1]!, 'Originating private note');
  }
  if (next === 'transfer' || next === 'chain') {
    const destination = collectionRecording.collection;
    await settle(() => ui.client.setQueryData(libraryNavigationQuery('en', 100).queryKey, {
      pins: { state: 'closed' }, collections: [destination],
    }));
    await settle(() => ui.host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await settle(() => {
      const select = ui.host.querySelector<HTMLSelectElement>('[data-collection-selection] select')!;
      select.value = destination.id;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    await clickNamed(ui, m.library_collection_move_selected());
  }
  if (next === 'batch' || next === 'chain') {
    await settle(() => ui.host.querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    await clickNamed(ui, m.library_collection_remove_selected());
  }
}

test('originating parent saves stop transfer, batch and member continuations on viewer, admission, address retirement and unmount', async () => {
  const edits = await import('../src/library/collection-edit');
  const commands = await import('../src/library/collection-commands');
  const reads = await import('../src/library/collection-read');
  for (const retirement of ['viewer', 'admission', 'authority', 'address', 'unmount'] as const) {
    for (const next of ['transfer', 'batch', 'member'] as const) {
      const ui = await mount();
      const parent = deferred<{ ok: true; id: string; revision: number }>();
      const update = spyOn(edits, 'updateCollection').mockImplementation(() => parent.promise);
      const transfer = spyOn(commands, 'transferCollectionMembers').mockResolvedValue({ ok: true, revision: 3, destinationRevision: 2 });
      const batch = spyOn(commands, 'batchRemoveCollectionMembers').mockResolvedValue({ ok: true, revision: 3, undo: [] });
      const note = spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: 'member' });
      const destination = spyOn(reads, 'readCollectionDestination').mockResolvedValue(collectionRecording.collection);
      try {
        await ui.show();
        await ui.answer();
        await beginEditing(ui);
        await stageDraft(ui, next);
        await submitDraft(ui);
        expect(update).toHaveBeenCalledTimes(1);
        if (retirement === 'viewer') {
          await ui.show('bob', { csrf: 'csrf-bob' });
          const call = calls.at(-1)!;
          await ui.answer(call, ready(call, 'bob'));
          await beginEditing(ui, 'bob'); // The replacement remains usable while Alice's IO is pending.
        } else if (retirement === 'admission') {
          await ui.show('alice', { admitted: false });
          expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
          await ui.show();
          await ui.answer();
          await beginEditing(ui); // Regaining admission cannot revive the retired save.
        } else if (retirement === 'address') {
          address = { id: 'replacement', cursor: 'next', filters: { 'f.schema:genre': 'new' } };
          await ui.show();
          await ui.answer();
          await beginEditing(ui);
        } else if (retirement === 'authority') {
          await ui.refetch();
          const call = calls.at(-1)!;
          await ui.answer(call, ready(call, 'alice', { viewerActions: { state: 'unavailable' } }));
          expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
        } else await ui.hide();
        const readCount = calls.length;
        const currentMarkup = ui.host.innerHTML;
        await settle(() => parent.resolve({ ok: true, id: 'original', revision: 2 }));
        expect(transfer).not.toHaveBeenCalled();
        expect(batch).not.toHaveBeenCalled();
        expect(note).not.toHaveBeenCalled();
        expect(calls).toHaveLength(readCount);
        expect(ui.invalidations).not.toHaveBeenCalled();
        expect(ui.host.innerHTML).toBe(currentMarkup);
      } finally {
        update.mockRestore(); transfer.mockRestore(); batch.mockRestore(); note.mockRestore(); destination.mockRestore();
        await ui.close();
      }
    }
  }
});

test('retirement during transfer, batch or member IO keeps its native outcome without later commands or reload effects', async () => {
  const edits = await import('../src/library/collection-edit');
  const commands = await import('../src/library/collection-commands');
  const reads = await import('../src/library/collection-read');
  for (const pending of ['transfer', 'batch', 'member'] as const) {
    const ui = await mount();
    const transferResult = deferred<{ ok: true; revision: number; destinationRevision: number }>();
    const batchResult = deferred<{ ok: true; revision: number; undo: [] }>();
    const memberResult = deferred<{ ok: true; id: string }>();
    const update = spyOn(edits, 'updateCollection').mockResolvedValue({ ok: true, id: 'original', revision: 2 });
    const transfer = spyOn(commands, 'transferCollectionMembers').mockImplementation(() =>
      pending === 'transfer' ? transferResult.promise : Promise.resolve({ ok: true, revision: 3, destinationRevision: 2 }),
    );
    const batch = spyOn(commands, 'batchRemoveCollectionMembers').mockImplementation(() =>
      pending === 'batch' ? batchResult.promise : Promise.resolve({ ok: true, revision: 4, undo: [] }),
    );
    const note = spyOn(edits, 'updateMemberNote').mockImplementation(() => memberResult.promise);
    const destination = spyOn(reads, 'readCollectionDestination').mockResolvedValue(collectionRecording.collection);
    try {
      await ui.show();
      await ui.answer();
      await beginEditing(ui);
      await stageDraft(ui, 'chain');
      await submitDraft(ui);
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(batch).toHaveBeenCalledTimes(pending === 'transfer' ? 0 : 1);
      expect(note).toHaveBeenCalledTimes(pending === 'member' ? 1 : 0);
      await ui.show('bob');
      const replacement = calls.at(-1)!;
      await ui.answer(replacement, ready(replacement, 'bob'));
      const readCount = calls.length;
      await settle(() => {
        transferResult.resolve({ ok: true, revision: 3, destinationRevision: 2 });
        batchResult.resolve({ ok: true, revision: 4, undo: [] });
        memberResult.resolve({ ok: true, id: 'member' });
      });
      expect(batch).toHaveBeenCalledTimes(pending === 'transfer' ? 0 : 1);
      expect(note).toHaveBeenCalledTimes(pending === 'member' ? 1 : 0);
      expect(calls).toHaveLength(readCount);
      expect(ui.invalidations).not.toHaveBeenCalled();
      expect(ui.host.textContent).toContain('bob private Collection');
      expect(ui.host.querySelector('[role="alert"]')).toBeNull();
    } finally {
      update.mockRestore(); transfer.mockRestore(); batch.mockRestore(); note.mockRestore(); destination.mockRestore();
      await ui.close();
    }
  }
});

test('a current editor keeps its exact uncertain save payload and key across nonempty CSRF rotation and ordinary refetch', async () => {
  const ui = await mount();
  const edits = await import('../src/library/collection-edit');
  const uncertain = deferred<{ ok: false; reason: 'unavailable' }>();
  const update = spyOn(edits, 'updateCollection')
    .mockImplementationOnce(() => uncertain.promise)
    .mockResolvedValue({ ok: true, id: 'original', revision: 2 });
  const note = spyOn(edits, 'updateMemberNote').mockResolvedValue({ ok: true, id: 'member' });
  try {
    await ui.show();
    await ui.answer();
    await beginEditing(ui);
    await stageDraft(ui, 'member');
    await submitDraft(ui);
    expect(update).toHaveBeenCalledTimes(1);
    const original = structuredClone(update.mock.calls[0]![0]!.data);
    await ui.show('alice', { csrf: 'rotated-nonempty' });
    await ui.refetch();
    await ui.answer();
    await settle(() => uncertain.resolve({ ok: false, reason: 'unavailable' }));
    expect(ui.host.querySelector('#collection-edit-form')).not.toBeNull();
    await submitDraft(ui);
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[1]![0]!.data).toEqual(original);
    expect(new Headers(update.mock.calls[1]![0]!.headers).get('X-CSRF-Token')).toBe('rotated-nonempty');
    expect(note).toHaveBeenCalledTimes(1);
    const refresh = calls.at(-1)!;
    expect(refresh.input.editor).not.toBe(true);
    await ui.answer(refresh, ready(refresh, 'alice', { revision: 2 }));
    expect(ui.invalidations).toHaveBeenCalledTimes(1);
    expect(ui.host.querySelector('#collection-edit-form')).toBeNull();
  } finally {
    update.mockRestore(); note.mockRestore();
    await ui.close();
  }
});

test('mismatched actual subject, address, filter, cursor and editor provenance fail closed before cache or callback effects', async () => {
  for (const mismatch of ['viewer', 'id', 'filter', 'cursor', 'editor', 'missing'] as const) {
    const ui = await mount();
    try {
      await ui.show();
      const call = calls.at(-1)!;
      const result = ready(call);
      if (mismatch === 'viewer') result.provenance!.viewerId = 'bob';
      if (mismatch === 'id') result.id = 'foreign';
      if (mismatch === 'filter')
        result.provenance!.request = collectionRequestVariant({ ...call.input, search: { type: 'schema:Movie' } });
      if (mismatch === 'cursor')
        result.provenance!.request = collectionRequestVariant({ ...call.input, cursor: 'foreign' });
      if (mismatch === 'editor') result.provenance!.request = collectionRequestVariant({ ...call.input, editor: true });
      if (mismatch === 'missing') delete result.provenance;
      await ui.answer(call, result);
      expect(ui.host.textContent).not.toContain('alice private Collection');
      expect(
        ui.client
          .getQueryCache()
          .getAll()
          .filter((query) => query.queryKey[0] === 'collection-page')
          .every((query) => !query.state.data),
      ).toBe(true);
    } finally {
      await ui.close();
    }
  }
  const ui = await mount();
  try {
    await ui.show();
    await ui.answer();
    for (const editor of [false, true]) {
      const read = editor ? pageProps!.readEditorPage!() : pageProps!.refreshPage();
      const rejected = expect(read).rejects.toThrow('does not match');
      const call = calls.at(-1)!;
      await ui.answer(call, ready(call, 'foreign-viewer'));
      await rejected;
    }
  } finally {
    await ui.close();
  }
});

test('dynamic member callbacks validate actual provenance and retire on replacement and unmount', async () => {
  const ui = await mount();
  try {
    await ui.show();
    const first = calls.at(-1)!;
    await ui.answer(first, dynamic(first));
    const oldReader = dynamicProps!.readMembers!;
    const pending = oldReader(address.id);
    const old = calls.at(-1)!;
    const rejected = expect(pending).rejects.toThrow('retired');
    await ui.show('bob');
    const replacement = calls.at(-1)!;
    await ui.answer(replacement, dynamic(replacement, 'bob'));
    const current = dynamicProps!.readMembers!(address.id);
    const currentCall = calls.at(-1)!;
    await settle(() => old.work.resolve(members(old)));
    await rejected;
    await settle(() => currentCall.work.resolve(members(currentCall, 'bob')));
    expect(await current).toMatchObject({ preparing: false });
    const mismatch = dynamicProps!.readMembers!(address.id);
    const mismatchCall = calls.at(-1)!;
    const mismatched = expect(mismatch).rejects.toThrow('do not match');
    await settle(() => mismatchCall.work.resolve(members(mismatchCall, 'alice')));
    await mismatched;
    const unmounted = dynamicProps!.readMembers!(address.id);
    const unmountedCall = calls.at(-1)!;
    const retired = expect(unmounted).rejects.toThrow('retired');
    await ui.hide();
    await settle(() => unmountedCall.work.resolve(members(unmountedCall, 'bob')));
    await retired;
    expect(ui.host.textContent).toBe('');
  } finally {
    await ui.close();
  }
});

test('anonymous SSR and hydration keep only the explicit public loader; unknown subject or invalid session cannot start private reads', async () => {
  const ui = await mount();
  try {
    const call = { input: { id: address.id, credentialMode: 'anonymous' as const }, kind: 'page' as const } as Call;
    initialPage = ready(call, 'public', { visibility: null });
    if (!('preparing' in initialPage)) delete initialPage.viewerActions;
    initialPage.provenance = provenance(call, null);
    await ui.show(null, { state: 'unknown', csrf: null });
    expect(ui.host.textContent).toContain('public private Collection');
    expect(calls).toHaveLength(0);
    expect(renderToString(ui.tree())).toContain('public private Collection');
    for (const patch of [
      { state: 'signed-in' as const, csrf: 'csrf' },
      { state: 'signed-out' as const, csrf: null },
    ]) {
      await ui.show(null, patch);
      expect(calls).toHaveLength(0);
    }
    await ui.show('alice', { csrf: '' });
    expect(calls).toHaveLength(0);
    // A private initial page is never repurposed as anonymous while current private IO is pending.
    initialPage = ready({ ...call, input: { ...call.input, credentialMode: 'session' } });
    await ui.show();
    expect(ui.host.textContent).not.toContain('alice private Collection');
    await ui.answer();
    expect(ui.host.textContent).toContain('alice private Collection'); // Private-404 recovery.
  } finally {
    await ui.close();
  }
});

test('server provenance comes from the actual prepared subject for curated/dynamic ready and not-ready paths; explicit bearer alone is refused', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'collections',
    WEBSITE_CLIENT_ID: 'site',
    WEBSITE_CLIENT_KEY: 'secret',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => ({
          status: 'active',
          accessToken: 'opaque',
          subject: 'actual-server-viewer',
          csrfToken: 'csrf',
        }),
      }),
    },
  } as unknown as SessionEnv;
  let kind = 'curated';
  let status = 200;
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/viewerActions')) return Response.json({ resources: [] });
      if (path.includes('/follows/')) return Response.json({ follow: null });
      if (path.endsWith('/members'))
        return Response.json(status === 200 ? { members: [], next: null } : { preparing: status === 202 }, { status });
      return Response.json({
        collection: {
          ...collectionRecording.collection,
          id: 'server-address',
          curatorAccountId: 'actual-server-viewer',
          membershipKind: kind,
          builtinKind: 'everything',
        },
      });
    },
  });
  for (kind of ['curated', 'dynamic'])
    for (status of [200, 202, 503]) {
      const input = { id: 'server-address', cursor: 'addressed-cursor', search: { type: 'schema:Book' } };
      const request = new Request('https://site.test/read', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      });
      const page = await loadEditableCollectionPage(client, request, sessionEnv, input);
      expect(collectionResultMatches(page, input, 'session', 'actual-server-viewer')).toBe(true);
      expect(collectionResultMatches(page, input, 'session', 'claimed-browser-viewer')).toBe(false);
      if ('preparing' in page) expect([page.preparing, page.unavailable]).toEqual([status === 202, status === 503]);
    }
  const count = requests.length;
  await expect(
    loadEditableCollectionPage(
      client,
      new Request('https://site.test/read', { headers: { authorization: 'Bearer opaque' } }),
      {},
      { id: 'server-address' },
    ),
  ).rejects.toMatchObject({ isNotFound: true });
  expect(requests).toHaveLength(count);
  expect(requests.every((request) => request.cache === 'no-store' && request.redirect === 'manual')).toBe(true);
});
