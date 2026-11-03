import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { documentText, fromPlainText } from '@rezics/document';
import {
  BrowserWritingStore,
  LocalWritingDraft,
  prepareWriting,
  WritingError,
  writingIndexKey,
  writingLimits,
  writingSlotKey,
  writingScope,
  type SavedWriting,
  type WritingPayload,
  type WritingStorage,
} from '../src/threads/local-writing-draft';

const actor = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const scope = writingScope({ containerId: 'thread-1' })!;
const payload = (text = 'Private unsent writing') => prepareWriting('A title', fromPlainText(text, 'blocks'));
class MemoryStorage implements WritingStorage {
  values = new Map<string, string>();
  reads: string[] = [];
  writes: string[] = [];
  denied = false;
  failIndex = false;
  getItem(key: string) {
    this.reads.push(key);
    if (this.denied) throw new Error('Storage denied');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes.push(key);
    if (this.denied || (this.failIndex && key === writingIndexKey)) throw new Error('QuotaExceededError');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (this.denied) throw new Error('Storage denied');
    this.values.delete(key);
  }
}
function saved(result: ReturnType<BrowserWritingStore['save']>): SavedWriting {
  if (!('saved' in result)) throw new Error('Unexpected replacement');
  return result.saved;
}
function harness(storage = new MemoryStorage()) {
  const store = new BrowserWritingStore(storage);
  const owner = new AbortController();
  let current = true;
  let queued: (() => void) | undefined;
  let timerCount = 0;
  const clock = {
    set: ((callback: () => void, delay: number) => {
      expect(delay).toBe(750);
      expect(queued).toBeUndefined();
      queued = callback;
      timerCount++;
      return timerCount;
    }) as unknown as typeof setTimeout,
    clear: (() => {
      queued = undefined;
    }) as unknown as typeof clearTimeout,
  };
  const draft = new LocalWritingDraft(
    () => store,
    actor,
    scope,
    () => current,
    owner.signal,
    clock,
  );
  return {
    storage,
    store,
    owner,
    draft,
    tick() {
      const run = queued;
      queued = undefined;
      run?.();
    },
    retire() {
      current = false;
      owner.abort();
      current = true;
    },
    pending: () => Boolean(queued),
  };
}

test('explicit choice, one idle save, exact restore/discard, refusal and success keep commands out of browser storage', () => {
  const h = harness();
  let encodes = 0;
  const read = () => {
    encodes++;
    return payload();
  };
  h.draft.load();
  h.draft.schedule(read);
  h.tick();
  expect(encodes).toBe(0);
  h.draft.enable(read);
  for (let n = 0; n < 20; n++) h.draft.schedule(read);
  expect(h.pending()).toBe(true);
  h.tick();
  expect(encodes).toBe(1);
  expect(h.draft.snapshot().saved?.payload.text).toBe('Private unsent writing');
  expect(h.store.load('another-account', scope)).toBeNull();
  expect(h.store.load(actor, writingScope({ containerId: 'replacement-thread' })!)).toBeNull();
  const reload = harness(h.storage);
  reload.draft.load();
  expect(reload.draft.snapshot().enabled).toBe(false);
  expect(reload.draft.snapshot().preview?.updated).toBeGreaterThan(0);
  expect(reload.draft.restore()?.text).toBe('Private unsent writing');
  expect(reload.draft.beginSubmission()).toBe(true);
  expect(reload.store.load(actor, scope)?.state).toBe('unknown');
  reload.draft.schedule(read);
  reload.tick();
  expect(encodes).toBe(1);
  reload.draft.settle('refused');
  expect(reload.store.load(actor, scope)?.state).toBe('unsent');
  expect(reload.draft.beginSubmission()).toBe(true);
  reload.draft.settle('success');
  expect(reload.store.load(actor, scope)).toBeNull();
  const again = harness(h.storage);
  again.draft.enable(read);
  again.tick();
  again.draft.discard();
  expect(again.store.load(actor, scope)).toBeNull();
  const forbidden = ['csrfToken', 'idempotencyKey', 'receipt', 'reservation', 'sessionToken'];
  const raw = JSON.stringify([...h.storage.values]);
  for (const field of forbidden) expect(raw).not.toContain(field);
});

test('unknown reloads never produce fresh intent, away/back cancels timers, and exact cleanup preserves replacements', () => {
  const h = harness();
  h.draft.enable(() => payload());
  h.tick();
  expect(h.draft.beginSubmission()).toBe(true);
  h.draft.settle('unknown');
  const later = harness(h.storage);
  later.draft.load();
  expect(later.draft.restore()).toBeNull();
  // A known refusal of unrelated live text cannot unlock an old unknown request.
  expect(later.draft.beginSubmission()).toBe(true);
  later.draft.settle('refused');
  expect(later.store.load(actor, scope)?.state).toBe('unknown');
  later.draft.discard();
  expect(later.store.load(actor, scope)).toBeNull();
  const fresh = harness();
  fresh.draft.enable(() => payload());
  fresh.retire();
  fresh.tick();
  expect(fresh.storage.writes).toEqual([]);
  expect(fresh.draft.snapshot().preview).toBeNull();
  fresh.draft.load();
  fresh.draft.enable(() => payload());
  fresh.tick();
  expect(fresh.storage.writes).toEqual([]);
  const store = new BrowserWritingStore(new MemoryStorage());
  const old = saved(store.save(actor, scope, payload(), null));
  const replacement = saved(store.save(actor, scope, payload('Replacement'), old));
  store.discard(old);
  expect(store.load(actor, scope)?.revision).toBe(replacement.revision);
});

test('storage failures, corrupt/unsupported data, limits and attachment repair preserve live writing', () => {
  const h = harness();
  const live = payload();
  h.storage.denied = true;
  h.draft.load();
  h.draft.enable(() => live);
  h.tick();
  expect(h.draft.snapshot().issue).toBe('storage');
  expect(live.text).toBe('Private unsent writing');
  h.storage.denied = false;
  h.draft.retry(() => live);
  h.tick();
  const original = h.draft.snapshot().saved!;
  h.storage.failIndex = true;
  expect(h.draft.beginSubmission()).toBe(false);
  expect(h.store.load(actor, scope)?.state).toBe('unsent');
  expect(() => h.store.save(actor, scope, payload('Changed'), original)).toThrow(WritingError);
  expect(h.store.load(actor, scope)?.payload.text).toBe(live.text);
  h.storage.failIndex = false;
  for (const raw of [
    '{',
    JSON.stringify({ version: 99, entries: [] }),
    JSON.stringify({ version: 1, entries: Array(17).fill(original) }),
  ]) {
    h.storage.values.set(writingIndexKey, raw);
    const broken = harness(h.storage);
    broken.draft.load();
    expect(broken.draft.snapshot().issue).not.toBeNull();
    expect(broken.draft.restore()).toBeNull();
    expect(live.text).toBe('Private unsent writing');
  }
  h.storage.values.set('other-app', 'untouched');
  h.draft.discardBroken();
  expect(h.storage.values.get('other-app')).toBe('untouched');
  const image = structuredClone(fromPlainText('Keep me', 'blocks'));
  image.doc.content!.push({
    type: 'image',
    attrs: { id: 'image', src: '/media/private-capability/original', alt: 'Attachment description' },
  });
  const repaired = prepareWriting('', image);
  expect(repaired.attachmentRepair).toBe(true);
  expect(repaired.text).toContain('Attachment description');
  expect(JSON.stringify(repaired)).not.toContain('private-capability');
  expect(image.doc.content!.at(-1)?.type).toBe('image');
  expect(() => prepareWriting('', { ...image, version: 'future' } as never)).toThrow(WritingError);
  const safeScope = writingScope({
    boardId: 'board',
    submissionContext: { subjectIds: ['subject'], csrfToken: 'secret', receipt: 'receipt' },
  });
  expect(JSON.stringify(safeScope)).not.toContain('secret');
  const mismatch = saved(h.store.save(actor, scope, live, null));
  h.storage.values.set(writingSlotKey(mismatch.slot), '{}');
  expect(() => h.store.load(actor, scope)).toThrow(WritingError);
});

test('1/8/16 slots and 1/64/128 KiB serialized payloads use indexed O(K) metadata and one O(B) payload', () => {
  const encodedBytes = (text: string) => new TextEncoder().encode(text).length;
  for (const count of [1, 8, 16])
    for (const size of [1024, 64 * 1024, 128 * 1024]) {
      const storage = new MemoryStorage();
      const store = new BrowserWritingStore(storage, () => 1);
      const small = prepareWriting('', fromPlainText('é', 'blocks'));
      const overhead = encodedBytes(JSON.stringify({ version: 1, revision: crypto.randomUUID(), payload: small }));
      const exact: WritingPayload = { ...small, title: 'x'.repeat(size - overhead) };
      for (let slot = 0; slot < count; slot++) {
        saved(store.save(actor, { ...scope, threadId: `thread-${slot}` }, exact, null));
      }
      expect(storage.values.size).toBe(count + 1);
      const index = JSON.parse(storage.values.get(writingIndexKey)!);
      expect(index.entries.reduce((sum: number, entry: SavedWriting) => sum + entry.bytes, 0)).toBe(count * size);
      storage.reads = [];
      const result = store.load(actor, { ...scope, threadId: 'thread-0' })!;
      expect(result.bytes).toBe(size);
      expect(storage.reads).toEqual([writingIndexKey, writingSlotKey(0)]);
      const before = [...storage.values];
      expect(() =>
        store.save(
          actor,
          { ...scope, threadId: 'thread-0' },
          { ...exact, title: exact.title + 'x'.repeat(128 * 1024 - size + 1) },
          result,
        ),
      ).toThrow(WritingError);
      expect([...storage.values]).toEqual(before);
      if (count === 16) {
        const plan = store.save(actor, { ...scope, threadId: 'new-thread' }, exact, null);
        expect('replace' in plan).toBe(true);
        expect([...storage.values]).toEqual(before);
        if ('replace' in plan)
          saved(store.save(actor, { ...scope, threadId: 'new-thread' }, exact, null, plan.replace.revision));
        expect(storage.values.size).toBe(17);
      }
    }
});

test('mounted composer saves explicitly, previews after reload, restores with a fresh key, exports and redacts on away/back', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { PostComposer } = await import('../src/threads/composer');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { state: 'signed-in' as const, subject: actor, csrfToken: 'never-persist-this-token' };
  client.setQueryData(sessionQuery.queryKey, session);
  let epoch = 0;
  const commands: { idempotencyKey: string; body: unknown }[] = [];
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <PostComposer
        key={epoch}
        initialKey={`current-visit-${epoch}`}
        containerId="thread-1"
        initialBody={epoch === 0 ? fromPlainText('Private original', 'blocks') : undefined}
        onSubmit={async (command) => {
          commands.push(command);
          return { ok: true, value: 'confirmed' };
        }}
        onSuccess={() => undefined}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const render = async () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
  const click = async (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
      expect(button).toBeDefined();
      expect(button!.disabled).toBe(false);
      button!.click();
    });
  const settle = async (predicate: () => boolean) => {
    for (let n = 0; n < 120 && !predicate(); n++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    expect(predicate()).toBe(true);
  };
  try {
    await render();
    await settle(() => host.textContent!.includes(m.thread_draft_save()));
    expect(window.localStorage.getItem(writingIndexKey)).toBeNull();
    await click(m.thread_draft_save());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800));
    });
    expect(window.localStorage.getItem(writingIndexKey)).not.toBeNull();
    expect(JSON.stringify(window.localStorage)).not.toContain(session.csrfToken);
    await act(async () => root.render(null));
    epoch++;
    await render();
    await settle(() => host.textContent!.includes(m.thread_draft_restore()));
    expect(host.querySelector('.ProseMirror')?.textContent ?? '').not.toContain('Private original');
    await click(m.thread_draft_restore());
    await settle(() => host.querySelector('[name="idempotency_key"]')?.getAttribute('value') !== 'current-visit-1');
    await click(m.thread_draft_export());
    expect(host.querySelector('textarea')?.value).toBe('Private original');
    await act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.idempotencyKey).not.toBe('current-visit-1');
    expect(documentText(commands[0]!.body as never)).toBe('Private original');
    expect(new BrowserWritingStore(window.localStorage).load(actor, scope)).toBeNull();
    // Preview retirement also fences a synchronous away/back cycle before React can batch it away.
    saved(
      new BrowserWritingStore(window.localStorage).save(actor, scope, payload('Do not reveal after retirement'), null),
    );
    await act(async () => root.render(null));
    epoch++;
    await render();
    await settle(() => host.textContent!.includes('Do not reveal after retirement'));
    const privatePreview = host.querySelector('[data-private-writing]')!;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      expect(privatePreview.textContent).toBe('');
      client.setQueryData(sessionQuery.queryKey, session);
    });
    expect(host.textContent).not.toContain('Do not reveal after retirement');
    expect(host.textContent).toContain(m.thread_authoring_session_changed());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
