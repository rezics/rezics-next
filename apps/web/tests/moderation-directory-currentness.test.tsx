import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import type { ModerationDirectoryPage } from '../src/moderation/workbench-queue/directory';
import type { WorkbenchReader, WorkbenchNativeSource } from '../src/moderation/workbench-queue/read';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/moderation/workbench' });
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
const { prepareWorkbenchRead, readWorkbench } = await import('../src/moderation/workbench-queue/read');
const { WorkbenchPage } = await import('../src/moderation/workbench-queue/page');
const { WorkbenchView } = await import('../src/moderation/workbench-queue/view');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const locale = getLocale();
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  setLocale(locale, { reload: false });
});
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});
const session = { state: 'signed-in', subject: 'A', csrfToken: null };
const origin = { subject: 'A', csrfFingerprint: await privateReaderFingerprint(null) };
const page = (lifetime = 60000): ModerationDirectoryPage => ({
  state: 'ready',
  source: 'native-source',
  validUntil: new Date(Date.now() + lifetime).toISOString(),
  next: 'native-next',
  items: [
    {
      scope: { kind: 'board', id: 'direct' },
      label: 'Native label',
      parent: null,
      queues: ['reports'],
      viewer: { open: 'permitted' },
    },
  ],
});
const source = (directory: WorkbenchNativeSource['directory']): WorkbenchNativeSource => ({
  directory,
  boardReports: async () => ({ reports: [], next: null }),
  boardAppeals: async () => ({ appeals: [], next: null }),
  catalogueReports: async () => ({ reports: [], next: null }),
});
function host() {
  const element = document.createElement('main');
  document.body.replaceChildren(element);
  root = createRoot(element);
  return element;
}
function cache() {
  const client = new QueryClient();
  client.setQueryData(['session'], session);
  return client;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('sparse continuation uses its native frontier, failure retries that page and expiry requires explicit restart', async () => {
  const selected: ReturnType<typeof workbenchSearch>[] = [];
  const initial = workbenchSearch({ directoryCursor: 'original-frontier' });
  const sparse = await readWorkbench(
    source(async () => ({ ...page(), items: [] })),
    initial,
  );
  const element = host();
  await act(() => root!.render(<WorkbenchView page={sparse} onSearch={(next) => selected.push(next)} />));
  expect(element.textContent).toContain(m.moderation_directory_empty_next());
  await act(() =>
    [...element.querySelectorAll('button')].find((b) => b.textContent === m.threads_next_page())!.click(),
  );
  expect(selected[0]?.directoryCursor).toBe('native-next');
  const input = selected.pop()!;
  const client = cache();
  const calls: string[] = [];
  let attempts = 0;
  const read: WorkbenchReader = async (search, signal) => ({
    ...(await readWorkbench(
      source(async (operands, requestSignal) => {
        expect(requestSignal).toBe(signal);
        calls.push(operands.cursor!);
        if (attempts++ < 2) throw new Error('temporary dependency failure');
        return page(500);
      }),
      search,
      signal,
    )),
    generation: crypto.randomUUID(),
    readerOrigin: origin,
  });
  const prepared = await prepareWorkbenchRead(client, input, read, new AbortController().signal);
  await act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <WorkbenchPage page={prepared} search={input} read={read} onSearch={(next) => selected.push(next)} />
      </QueryClientProvider>,
    ),
  );
  expect(element.textContent).toContain(m.moderation_directory_continuation_failed());
  for (let attempt = 0; attempt < 2; attempt++) {
    const retry = element.querySelector<HTMLButtonElement>('[data-workbench-retry]')!;
    retry.focus();
    await act(async () => {
      retry.dispatchEvent(new browser.MouseEvent('click', { bubbles: true, detail: 0 }));
      await new Promise((done) => setTimeout(done, 0));
    });
    expect(document.activeElement).toBe(
      attempt === 0 ? element.querySelector('[data-workbench-retry]') : element.querySelector('article'),
    );
  }
  expect(calls).toEqual(Array(3).fill('native-next'));
  const obsolete = element.querySelector<HTMLButtonElement>('[data-moderation-scope]')!;
  expect(element.textContent).toContain('Native label');
  await act(async () => {
    await new Promise((done) => setTimeout(done, 550));
  });
  expect(element.textContent).not.toContain('Native label');
  expect(element.textContent).toContain(m.moderation_directory_expired());
  await act(() => obsolete.click());
  expect(selected).toEqual([]);
  await act(() =>
    [...element.querySelectorAll('button')].find((b) => b.textContent === m.moderation_directory_restart())!.click(),
  );
  expect(selected).toEqual([workbenchSearch({})]);
  await act(() => client.clear());
});

test('successful equal replacement and batched A/B/A synchronously retire mounted selections', async () => {
  for (const replacement of ['equal', 'ABA'] as const) {
    const client = cache();
    const selections: unknown[] = [];
    const input = workbenchSearch({});
    const read: WorkbenchReader = async (search) => ({
      ...(await readWorkbench(
        source(async () => page()),
        search,
      )),
      generation: crypto.randomUUID(),
      readerOrigin: origin,
    });
    const prepared = await prepareWorkbenchRead(client, input, read, new AbortController().signal);
    const element = host();
    await act(() =>
      root!.render(
        <QueryClientProvider client={client}>
          <WorkbenchPage page={prepared} search={input} onSearch={(next) => selections.push(next)} />
        </QueryClientProvider>,
      ),
    );
    const selection = element.querySelector<HTMLButtonElement>('[data-moderation-scope]')!;
    await act(() => {
      if (replacement === 'ABA') client.setQueryData(['session'], { ...session, subject: 'B' });
      client.setQueryData(['session'], { ...session });
      selection.click();
    });
    expect(selections).toEqual([]);
    expect(element.textContent).not.toContain('Native label');
    expect(element.querySelector('[data-moderation-scope]')).toBeNull();
    await act(() => root!.unmount());
    root = undefined;
    client.clear();
  }
});

test('session replacement aborts preparation; fetch start alone preserves the successful incarnation', async () => {
  const client = cache();
  const input = workbenchSearch({});
  const response = deferred();
  let signal!: AbortSignal;
  const pending = prepareWorkbenchRead(
    client,
    input,
    async (search, requestSignal) => {
      signal = requestSignal!;
      await response.promise;
      return {
        ...(await readWorkbench(
          source(async () => page()),
          search,
          signal,
        )),
        generation: 'late',
        readerOrigin: origin,
      };
    },
    new AbortController().signal,
  );
  const fetching = deferred();
  const fetch = client.fetchQuery({
    queryKey: ['session'],
    queryFn: async () => {
      await fetching.promise;
      return session;
    },
  });
  expect(signal.aborted).toBe(false);
  client.setQueryData(['session'], { ...session, subject: 'B' });
  client.setQueryData(['session'], { ...session });
  expect(signal.aborted).toBe(true);
  response.resolve();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  fetching.resolve();
  await fetch;
  client.clear();
});

test('locale replacement during preparation cannot publish labels', async () => {
  const client = cache();
  const input = workbenchSearch({});
  const response = deferred();
  const pending = prepareWorkbenchRead(
    client,
    input,
    async (search) => {
      await response.promise;
      return {
        ...(await readWorkbench(
          source(async () => page()),
          search,
        )),
        generation: 'late',
        readerOrigin: origin,
      };
    },
    new AbortController().signal,
  );
  setLocale(locale === 'en' ? 'de' : 'en', { reload: false });
  response.resolve();
  const result = await pending;
  expect(result.readerBinding?.retired).toBe(true);
  expect(result.directory).toBeUndefined();
  client.clear();
});
