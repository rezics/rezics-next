import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { CopiesCurrentRead, CopyDetailCurrentRead } from '../src/library/copies-actions';
import type { CopiesPageData, CopyItem, CopyRemoveResult, CopyWriteResult } from '../src/library/copies-read';

// UNRUN at this source boundary. Mounted outcomes use the installed DOM and current-viewer fencing;
// native services, browser geometry and Storybook remain the controller's integration obligations.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
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
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogContent: Part,
  DialogHeader: Part,
  DialogTitle: Part,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({
  BottomSheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label: string; onSelect: () => void }[] }) => (
    <>
      {entries.map((entry) => (
        <button key={entry.label} onClick={entry.onSelect}>
          {entry.label}
        </button>
      ))}
    </>
  ),
}));
const actions = await import('../src/library/copies-actions');
const { loadCopiesPage } = await import('../src/library/copies-read');
const { CopiesCurrent } = await import('../src/library/copies-current');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const edition = id(10);
const profile = { kinds: [{ id: 'print', label: 'Print', statuses: [{ id: 'shelf', label: 'On shelf' }] }] };
const copy = (viewer = 'A'): CopyItem => ({
  id: id(1),
  revision: 7,
  kind: 'print',
  status: 'shelf',
  meaning: 'unknown',
  statusEditing: { state: 'unsupported' },
  location: 'Study',
  source: 'Bookshop',
  acquiredOn: '2020-02-29',
  disposedOn: null,
  note: `Private note ${viewer}`,
  subject: { id: edition, type: 'Book', label: `Private edition ${viewer}`, cover: null },
  idempotencyKey: id(101),
});
type Search = { subjectId?: string; cursor?: string };
function response(search: Search, page: Partial<CopiesPageData> = {}, viewer = 'A'): CopiesCurrentRead {
  return {
    sessionSubject: viewer,
    requested: { subjectId: search.subjectId ?? null, cursor: search.cursor ?? null, locale: 'en' },
    page: {
      signedIn: true,
      subjectId: search.subjectId ?? null,
      copies: [],
      next: null,
      addKey: id(90),
      profile,
      sendKind: true,
      ...page,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
async function mount(search: Search, page: Partial<CopiesPageData> = {}) {
  let initial = response(search, page);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const lists: ReturnType<typeof deferred<CopiesCurrentRead>>[] = [];
  const reads = spyOn(actions, 'readCopiesCurrent').mockImplementation(() => {
    const call = deferred<CopiesCurrentRead>();
    lists.push(call);
    return call.promise;
  });
  const detail = spyOn(actions, 'readCopyDetailCurrent').mockImplementation(
    async () =>
      ({
        sessionSubject: 'A',
        requested: initial.requested,
        id: id(1),
        result: { ok: true, copy: copy() },
      }) satisfies CopyDetailCurrentRead,
  );
  const writes: (ReturnType<typeof deferred<CopyWriteResult>> & { input: Parameters<typeof actions.updateCopy>[0] })[] =
    [];
  const updates = spyOn(actions, 'updateCopy').mockImplementation((input) => {
    const call = { ...deferred<CopyWriteResult>(), input };
    writes.push(call);
    return call.promise;
  });
  const deletes: (ReturnType<typeof deferred<CopyRemoveResult>> & {
    input: Parameters<typeof actions.deleteCopy>[0];
  })[] = [];
  const removals = spyOn(actions, 'deleteCopy').mockImplementation((input) => {
    const call = { ...deferred<CopyRemoveResult>(), input };
    deletes.push(call);
    return call.promise;
  });
  const restores: (ReturnType<typeof deferred<CopyWriteResult>> & { input: Parameters<typeof actions.undoCopy>[0] })[] =
    [];
  const undo = spyOn(actions, 'undoCopy').mockImplementation((input) => {
    const call = { ...deferred<CopyWriteResult>(), input };
    restores.push(call);
    return call.promise;
  });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'csrf-A' });
  client.setQueryData(['exposure', 'anonymous'], []);
  // Seed exact enrolled observations, including credential rotation; no global viewer gate is authority.
  const lifetime = viewerExposureLifetime(client);
  const admit = lifetime.subscribe(() => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state === 'signed-in')
      client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
        subject: snapshot.observation.subject,
        admitted: ['personal_library'],
      });
  });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/copies'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const show = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <CopiesCurrent initial={initial} search={search} locale="en" />
          </RouterContextProvider>
        </QueryClientProvider>,
      ),
    );
  await show();
  await flush();
  const button = (name: string, region: ParentNode = host) => {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const link = (name: string) =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((node) => node.textContent === name);
  const form = () => host.querySelector<HTMLFormElement>('[role="dialog"] form')!;
  const click = (name: string, region: ParentNode = host) => act(async () => button(name, region).click());
  const submit = () =>
    act(async () => {
      form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  return {
    host,
    client,
    lists,
    writes,
    deletes,
    restores,
    link,
    form,
    click,
    submit,
    async refresh(page: Partial<CopiesPageData>) {
      initial = response(search, page);
      await show();
      await act(async () => lists.at(-1)!.resolve(initial));
      await flush();
    },
    async session(subject: string | null, csrfToken = `csrf-${subject}`) {
      await act(async () =>
        client.setQueryData(
          ['session'],
          subject ? { state: 'signed-in', subject, csrfToken } : { state: 'signed-out', csrfToken: null },
        ),
      );
      await show();
      await flush();
    },
    async firstPage() {
      search = { ...(search.subjectId ? { subjectId: search.subjectId } : {}) };
      await show();
      await flush();
      await act(async () => lists.at(-1)!.resolve(response(search, { copies: [copy()], next: 'next-page' })));
      await flush();
    },
    async close() {
      await act(async () => root.unmount());
      admit();
      client.clear();
      host.remove();
      for (const spy of [reads, detail, updates, removals, undo]) spy.mockRestore();
    },
  };
}
function invokeLink(link: HTMLAnchorElement) {
  const props = Object.entries(link).find(([key]) => key.startsWith('__reactProps$'))![1] as {
    onClick: (event: { preventDefault(): void; defaultPrevented: boolean; button: number }) => void;
  };
  const event = {
    defaultPrevented: false,
    button: 0,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  props.onClick(event);
  return event.defaultPrevented;
}

test('requested cursor provenance survives one bounded native read and the existing single invalid-cursor fallback', async () => {
  for (const cursor of [undefined, 'exhausted/keyset+page', 'invalid/keyset+page']) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        return new URL(request.url).searchParams.get('cursor') === 'invalid/keyset+page'
          ? Response.json({ code: 'invalid_cursor' }, { status: 400 })
          : Response.json({ copies: [], next: null });
      }) as typeof fetch,
    });
    const page = await loadCopiesPage(
      client,
      new Request('https://site.test/en/library/copies', {
        headers: { authorization: 'Bearer current-owner' },
      }),
      {},
      { subjectId: edition, ...(cursor ? { cursor } : {}) },
    );
    expect(page.requestedCursor ?? null).toBe(cursor ?? null);
    expect(Boolean(page.cursorRestarted)).toBe(Boolean(cursor?.startsWith('invalid')));
    expect(page.subjectId).toBe(edition);
    expect(calls).toHaveLength(cursor?.startsWith('invalid') ? 2 : 1);
    expect(calls.every((call) => new URL(call.url).searchParams.get('subjectId') === edition)).toBe(true);
    expect(calls.every((call) => new URL(call.url).searchParams.get('limit') === '100')).toBe(true);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer current-owner')).toBe(true);
  }
});

test('invalid addresses show correction without starting a browser copy read or opening an editor', async () => {
  for (const search of [
    { subjectId: 'bad-selector', cursor: 'old' },
    { subjectId: edition, cursor: 'x'.repeat(2049) },
  ]) {
    const h = await mount(search);
    try {
      expect(h.host.querySelector('[role="alert"]')).not.toBeNull();
      expect(h.host.querySelector('form')?.getAttribute('method')).toBe('get');
      expect(h.form()).toBeNull();
      expect(h.lists).toHaveLength(0);
    } finally {
      await h.close();
    }
  }
});

test('a native cursor restart is visible and its first-page link keeps the subject', async () => {
  const h = await mount({ subjectId: edition, cursor: 'stale' }, { cursorRestarted: true });
  try {
    expect(h.host.textContent).toContain(m.library_copies_address_cursor_restarted());
    const target = new URL(h.link(m.library_collections_first_page())!.href);
    expect(target.searchParams.get('subjectId')).toBe(edition);
    expect(target.searchParams.has('cursor')).toBe(false);
  } finally {
    await h.close();
  }
});

test('empty first pages keep library/filter wording; later and sparse pages offer a cursorless edition-preserving recovery', async () => {
  for (const subjectId of [undefined, edition]) {
    const filter = subjectId ? { subjectId } : {};
    const first = await mount(filter);
    try {
      expect(first.host.textContent).toContain(subjectId ? m.library_copy_filtered_empty() : m.library_copy_empty());
      expect(first.link(m.library_collections_first_page())).toBeUndefined();
      expect(first.link(m.library_copy_more())).toBeUndefined();
      await first.click(m.library_copy_add());
      expect(first.form()).not.toBeNull();
    } finally {
      await first.close();
    }
    for (const next of [null, 'more/keyset+page']) {
      const later = await mount({ ...filter, cursor: 'exhausted/keyset+page' }, { next });
      try {
        expect(later.host.textContent).toContain(m.library_copy_page_empty());
        expect(later.host.textContent).not.toContain(m.library_copy_empty());
        expect(later.host.textContent).not.toContain(m.library_copy_filtered_empty());
        const target = new URL(later.link(m.library_collections_first_page())!.href);
        expect(target.searchParams.get('subjectId')).toBe(subjectId ?? null);
        expect(target.searchParams.has('cursor')).toBe(false);
        expect(target.origin).toBe(window.location.origin);
        expect(Boolean(later.link(m.library_copy_more()))).toBe(Boolean(next));
        expect(later.lists).toHaveLength(0); // no automatic cursor walk or preload
        await later.firstPage();
        expect(later.host.textContent).toContain('Private note A');
        expect(later.link(m.library_collections_first_page())).toBeUndefined();
        expect(later.host.querySelectorAll('[data-content-item-slot="title"]')).toHaveLength(1);
      } finally {
        await later.close();
      }
    }
  }
  const sparse = await mount({}, { next: 'more' });
  try {
    expect(sparse.host.textContent).toContain(m.library_copy_page_empty());
  } finally {
    await sparse.close();
  }
});

test('removing the last loaded row offers recovery without changing exact deletion or Undo operands', async () => {
  for (const cursor of [undefined, 'later']) {
    const h = await mount({ subjectId: edition, ...(cursor ? { cursor } : {}) }, { copies: [copy()] });
    try {
      await h.click(m.library_copy_edit());
      await h.click(m.library_copy_delete(), h.form());
      await h.click(m.library_copy_delete_confirm(), h.form());
      expect(h.deletes[0]!.input.data).toEqual({ id: id(1), revision: 7, idempotencyKey: id(101) });
      await act(async () => h.deletes[0]!.resolve({ ok: true, undo: { deletionId: id(80), revision: 8 } }));
      expect(h.host.textContent).toContain(m.library_copy_page_empty());
      expect(new URL(h.link(m.library_collections_first_page())!.href).searchParams.get('subjectId')).toBe(edition);
      expect(h.lists).toHaveLength(0);
      await h.click(m.editor_undo());
      const restore = h.restores[0]!;
      expect(restore.input.data).toMatchObject({ id: id(1), deletionId: id(80), revision: 8 });
      await act(async () => restore.resolve({ ok: true, copy: { ...copy(), revision: 9 } }));
      expect(h.host.textContent).toContain('Private note A');
      expect(h.host.textContent).not.toContain(m.library_copy_page_empty());
    } finally {
      await h.close();
    }
  }
});

test('refresh preserves the original uncertain command; recovery cannot discard it and retired results cannot restore old rows', async () => {
  const h = await mount({ subjectId: edition, cursor: 'later' }, { copies: [copy()] });
  try {
    const oldRecovery = h.link(m.library_collections_first_page())!;
    await h.click(m.library_copy_edit());
    await h.submit();
    const original = h.writes[0]!;
    await act(async () => original.reject(new Error('Unconfirmed write')));
    await h.refresh({ copies: [], addKey: id(91) });
    expect(h.form()).not.toBeNull();
    expect(h.link(m.library_collections_first_page())!.getAttribute('aria-disabled')).toBe('true');
    expect(invokeLink(oldRecovery)).toBe(true);
    expect(invokeLink(h.link(m.library_collections_first_page())!)).toBe(true);
    await h.session('A', 'rotated-csrf');
    await h.submit();
    const retry = h.writes.at(-1)!;
    expect(retry.input.data).toEqual(original.input.data);
    expect(retry.input.data).toMatchObject({ id: id(1), revision: 7, idempotencyKey: id(101), note: 'Private note A' });
    expect(new Headers(retry.input.headers).get('x-csrf-token')).toBe('rotated-csrf');
    await h.session('B');
    expect(h.host.textContent).not.toContain('Private note A');
    expect(h.form()).toBeNull();
    await act(async () => retry.resolve({ ok: true, copy: { ...copy(), revision: 8 } }));
    expect(h.host.textContent).not.toContain('Private note A');
    expect(invokeLink(oldRecovery)).toBe(true);
    await act(async () =>
      h.lists.at(-1)!.resolve(response({ subjectId: edition, cursor: 'later' }, { copies: [copy('B')] }, 'B')),
    );
    await flush();
    expect(h.host.textContent).toContain('Private note B');
    await h.session(null);
    expect(h.host.textContent).not.toContain('Private note B');
    expect(h.link(m.library_collections_first_page())).toBeUndefined();
  } finally {
    await h.close();
  }
});
