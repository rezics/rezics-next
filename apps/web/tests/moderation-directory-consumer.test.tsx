import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import type { WorkbenchNativeSource } from '../src/moderation/workbench-queue/read';
import type { ModerationDirectoryPage } from '../src/moderation/workbench-queue/directory';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/moderation/workbench' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  MutationObserver: browser.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { readWorkbench, readWorkbenchPage, prepareWorkbenchRead } =
  await import('../src/moderation/workbench-queue/read');
const { WorkbenchPage } = await import('../src/moderation/workbench-queue/page');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { sessionQuery } = await import('../src/session/query');
const { workbenchSearch, workbenchReadKey, workbenchQueueHref } =
  await import('../src/moderation/workbench-queue/scope');
const { WorkbenchView } = await import('../src/moderation/workbench-queue/view');
const { moderationDirectoryPage } = await import('../src/moderation/workbench-queue/directory');
const { m } = await import('../src/paraglide/messages.js');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});

const search = workbenchSearch({});
const directory = (): ModerationDirectoryPage => ({
  state: 'ready',
  source: 'native-observation',
  validUntil: new Date(Date.now() + 60000).toISOString(),
  next: 'sealed-frontier',
  items: [
    {
      scope: { kind: 'board', id: 'direct-board' },
      label: 'Direct board',
      parent: null,
      queues: ['reports', 'appeals', 'resolved'],
      viewer: { open: 'permitted' },
    },
  ],
});
function source(page: ModerationDirectoryPage): WorkbenchNativeSource {
  return {
    directory: async () => page,
    realms: async () => {
      throw new Error('Membership is not queue discovery');
    },
    boards: async () => {
      throw new Error('Realm inventory is not queue discovery');
    },
    boardReports: async () => ({ reports: [], next: 'original-queue-cursor' }),
    boardAppeals: async () => ({ appeals: [], next: null }),
    catalogueReports: async () => {
      throw new Error('Board authority cannot widen to Global');
    },
  };
}
async function mount(page: ModerationDirectoryPage, onSearch = (_: unknown) => {}, retry = () => {}) {
  const native = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe('https://kernel.invalid/v1/me/moderation-directory?limit=20');
      expect(init?.cache).toBe('no-store');
      return Response.json(page);
    }) as typeof fetch,
  });
  const read = await readWorkbenchPage(native, search, 'Bearer prepared', {
    subject: 'moderator',
    csrfFingerprint: await privateReaderFingerprint(null),
  });
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  root = createRoot(host);
  await act(() => root!.render(<WorkbenchView page={read} onSearch={onSearch} onRetry={retry} />));
  return host;
}

test('a direct board is discoverable without membership; selection opens only its exact native queue', async () => {
  const selected: unknown[] = [];
  const host = await mount(directory(), (value) => selected.push(value));
  await act(() => host.querySelector<HTMLButtonElement>('[data-moderation-scope]')!.click());
  expect(selected).toEqual([expect.objectContaining({ board: 'direct-board', queue: 'reports' })]);
  expect(selected[0]).not.toHaveProperty('scope');
  const page = await readWorkbench(source(directory()), workbenchSearch({ board: 'direct-board', cursor: 'native' }));
  expect(page.next).toBe('original-queue-cursor');
  expect(page.directory).toBeUndefined();
  const unsupported = await readWorkbench(
    source(directory()),
    workbenchSearch({ scope: 'catalogue', queue: 'appeals' }),
  );
  expect(unsupported.state).toBe('unavailable');
});

test('coverage, permission and sparse continuation stay distinct; retry retains the original frontier', async () => {
  let retries = 0;
  for (const state of ['preparing', 'unavailable', 'denied'] as const) {
    const host = await mount({ state, items: [], next: null }, undefined, () => retries++);
    expect(host.querySelector('[data-moderation-scope]')).toBeNull();
    expect(host.textContent).not.toContain(m.moderation_directory_empty());
    if (state !== 'denied') await act(() => host.querySelector<HTMLButtonElement>('[data-workbench-retry]')!.click());
    await act(() => root!.unmount());
    root = undefined;
  }
  expect(retries).toBe(2);
  const next: unknown[] = [];
  const host = await mount({ ...directory(), items: [] }, (value) => next.push(value));
  expect(host.textContent).not.toContain(m.moderation_directory_empty());
  await act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === m.threads_next_page())!.click());
  expect(next).toEqual([expect.objectContaining({ directoryCursor: 'sealed-frontier' })]);
  const continued = workbenchSearch({ directoryCursor: 'sealed-frontier' });
  expect(workbenchReadKey(continued)).not.toBe(workbenchReadKey(search));
  expect(workbenchQueueHref(continued)).toContain('directoryCursor=sealed-frontier');
});

test('denied and expired directory advice cannot open scopes; absent binding never reports empty', async () => {
  const ready = directory();
  if (ready.state !== 'ready') throw new Error('fixture');
  ready.items[0]!.viewer.open = 'denied';
  const denied = await mount(ready);
  expect(denied.querySelector<HTMLButtonElement>('[data-moderation-scope]')?.disabled).toBe(true);
  await act(() => root!.unmount());
  root = undefined;
  const expired = await mount({ ...ready, validUntil: '2000-01-01T00:00:00.000Z' });
  expect(expired.textContent).not.toContain('Direct board');
  expect(expired.querySelector('[data-moderation-scope]')).toBeNull();
  const unbound = source(directory());
  delete unbound.directory;
  expect((await readWorkbench(unbound, search)).directory?.state).toBe('unavailable');
});

test('consumer bounds reject oversized, duplicate and unsupported advice and drop private fields', () => {
  const page = directory();
  if (page.state !== 'ready') throw new Error('fixture');
  for (const invalid of [
    { ...page, items: Array(21).fill(page.items[0]) },
    { ...page, items: [page.items[0], page.items[0]] },
    { ...page, items: [{ ...page.items[0], label: 'x'.repeat(1025) }] },
    { ...page, items: [{ ...page.items[0], scope: { kind: 'catalogue' } }] },
    { ...page, source: '' },
    { ...page, next: 'x'.repeat(4097) },
  ])
    expect(moderationDirectoryPage(invalid).state).toBe('unavailable');
  const now = Date.now();
  expect(moderationDirectoryPage({ ...page, validUntil: new Date(now).toISOString() }, now).state).toBe('stale');
  expect(moderationDirectoryPage({ ...page, validUntil: new Date(now + 180001).toISOString() }, now).state).toBe(
    'unavailable',
  );
  const result = moderationDirectoryPage({ ...page, reporter: 'private', count: 99 });
  expect(result).not.toHaveProperty('reporter');
  expect(result).not.toHaveProperty('count');
});

test('private continuation recovery keeps the frontier, restores keyboard focus and retires on session replacement', async () => {
  const cache = new QueryClient();
  const session = { state: 'signed-in', subject: 'directory-reader', csrfToken: null };
  cache.setQueryData(sessionQuery.queryKey, session);
  const readerOrigin = { subject: session.subject, csrfFingerprint: await privateReaderFingerprint(null) };
  const input = workbenchSearch({ directoryCursor: 'original-frontier' });
  const calls: string[] = [];
  let attempts = 0;
  const read = async (selected: typeof input) => {
    calls.push(selected.directoryCursor!);
    const page = await readWorkbench(
      source(attempts++ < 2 ? { state: 'unavailable', items: [], next: null } : directory()),
      selected,
    );
    return { ...page, generation: crypto.randomUUID(), readerOrigin };
  };
  const initial = await prepareWorkbenchRead(cache, input, read, new AbortController().signal);
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  root = createRoot(host);
  await act(() =>
    root!.render(
      <QueryClientProvider client={cache}>
        <WorkbenchPage
          page={initial}
          search={input}
          read={read}
          onSearch={() => {
            throw new Error('Recovery must retain the original search');
          }}
        />
      </QueryClientProvider>,
    ),
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = host.querySelector<HTMLButtonElement>('[data-workbench-retry]')!;
    retry.focus();
    await act(async () => {
      retry.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, detail: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(
      attempt === 0 ? host.querySelector('[data-workbench-retry]') : host.querySelector('article'),
    );
  }
  expect(calls).toEqual(Array(3).fill('original-frontier'));
  expect(host.textContent).toContain('Direct board');
  await act(async () => cache.setQueryData(sessionQuery.queryKey, { ...session, subject: 'replacement-reader' }));
  expect(host.textContent).not.toContain('Direct board');
  expect(host.querySelector('[data-moderation-scope]')).toBeNull();
  await act(() => root!.unmount());
  root = undefined;
  cache.clear();
});

test('installed directory failures preserve native denial and stale-cursor distinctions', async () => {
  for (const [status, code, state] of [
    [400, 'invalid_cursor', 'stale'],
    [409, 'stale_cursor', 'stale'],
    [401, 'unauthorized', 'denied'],
    [404, 'not_found', 'denied'],
    [503, 'dependency_unavailable', 'unavailable'],
  ] as const) {
    const native = createKernelClient('https://kernel.invalid', {
      fetch: (async () => Response.json({ code }, { status })) as typeof fetch,
    });
    const result = await readWorkbenchPage(
      native,
      workbenchSearch({ directoryCursor: 'captured' }),
      'Bearer prepared',
      {
        subject: 'moderator',
        csrfFingerprint: await privateReaderFingerprint(null),
      },
    );
    expect(result.directory).toEqual({ state, items: [], next: null });
  }
});
