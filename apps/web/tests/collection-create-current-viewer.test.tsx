import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { CollectionWriteResult, readNewCollection } from '../src/library/collection-edit';

// UNRUN: mounted deferred-result regressions for integration, using the installed DOM fixture.
// Controlled BFF responses establish neither native authority/receipt nor browser/visual proof.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

type Viewer = {
  state: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  subject?: string | null;
  csrfToken: string | null;
};
type Loaded = Awaited<ReturnType<typeof readNewCollection>>;
const viewer = (subject = 'viewer-one', csrfToken = 'csrf-one'): Viewer => ({ state: 'signed-in', subject, csrfToken });
const loader = (): Loaded => ({
  idempotencyKey: crypto.randomUUID(),
  types: [
    { id: 'book', label: 'Book' },
    { id: 'game', label: 'Game' },
  ],
});
const success: CollectionWriteResult = { ok: true, id: 'returned-collection' };
const staleResults: (CollectionWriteResult | Error)[] = [
  success,
  { ok: false, reason: 'invalid' },
  { ok: false, reason: 'unavailable' },
  new Error('The dispatched create may have committed'),
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mountForm(hydrate = false) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/new' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const edits = await import('../src/library/collection-edit');
  const { NewCollectionForm, Route } = await import('../src/routes/collections/new');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  let loaded = loader();
  const read = spyOn(Route, 'useLoaderData').mockImplementation(() => loaded);
  const Page = Route.options.component!;
  const calls: {
    sender: unknown;
    data: Parameters<typeof edits.createCollection>[0]['data'];
    headers: [string, string][];
    csrf: string | null;
    work: ReturnType<typeof deferred<CollectionWriteResult>>;
  }[] = [];
  const record = (sender: unknown, input: Parameters<typeof edits.createCollection>[0]) => {
    const work = deferred<CollectionWriteResult>();
    const headers = new Headers(input.headers);
    calls.push({
      sender,
      data: structuredClone(input.data),
      headers: [...headers.entries()],
      csrf: headers.get('X-CSRF-Token'),
      work,
    });
    return work.promise;
  };
  const transport = spyOn(edits, 'createCollection');
  transport.mockImplementation((input) => record(transport, input));
  const createSender = (): typeof edits.createCollection => {
    let sender!: typeof edits.createCollection;
    sender = (input) => record(sender, input);
    return sender;
  };
  const navigation: string[] = [];
  const navigate = spyOn(window.location, 'assign').mockImplementation((url) => navigation.push(String(url)));
  const host = document.createElement('div');
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let root: ReturnType<typeof createRoot> | undefined;
  let serverHtml = '';
  const hydrationErrors: unknown[] = [];
  const render = async ({
    session = viewer(),
    admitted = true,
    page = loaded,
    visible = true,
    sender,
  }: {
    session?: Viewer;
    admitted?: boolean;
    page?: Loaded;
    visible?: boolean;
    sender?: typeof edits.createCollection;
  } = {}) => {
    loaded = page;
    await act(async () => {
      client.setQueryData(['session'], session);
      client.setQueryData(['exposure', 'viewer'], admitted ? ['collections'] : []);
      // Public admission alone must never authorize an imperative create.
      client.setQueryData(['exposure', 'anonymous'], ['collections']);
      const tree = (
        <StrictMode>
          <QueryClientProvider client={client}>
            {visible
              ? sender
                ? <NewCollectionForm csrfToken={session.csrfToken ?? ''} types={loaded.types} sender={sender} />
                : <Page />
              : null}
          </QueryClientProvider>
        </StrictMode>
      );
      if (!root && hydrate) {
        serverHtml = renderToString(tree);
        host.innerHTML = serverHtml;
        root = hydrateRoot(host, tree, { onRecoverableError: (error) => hydrationErrors.push(error) });
      } else {
        root ??= createRoot(host);
        root.render(tree);
      }
    });
  };
  const form = () => host.querySelector<HTMLFormElement>('form')!;
  const title = () => host.querySelector<HTMLInputElement>('input[name="title"]')!;
  const description = () => host.querySelector<HTMLTextAreaElement>('textarea[name="description"]')!;
  const kind = () => host.querySelector<HTMLSelectElement>('[data-collection-presentation-fields] select')!;
  const key = () => host.querySelector<HTMLInputElement>('input[name="idempotencyKey"]')!.value;
  const action = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const locked = () => form().querySelector('fieldset')!.disabled;
  const fill = async (value = 'Private title', visibility = 'private', presentationKind = 'book') => {
    await act(async () => {
      title().value = value;
      title().dispatchEvent(new window.Event('input', { bubbles: true }));
      description().value = `${value} description`;
      description().dispatchEvent(new window.Event('input', { bubbles: true }));
      kind().value = presentationKind;
      kind().dispatchEvent(new window.Event('change', { bubbles: true }));
      host.querySelector<HTMLElement>(`#collection-visibility-${visibility}`)!.click();
    });
  };
  const submit = async (twice = false) => {
    await act(async () => {
      const current = form();
      current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      if (twice) current.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const settle = async (index: number, result: CollectionWriteResult | Error) => {
    await act(async () => {
      if (result instanceof Error) calls[index]!.work.reject(result);
      else calls[index]!.work.resolve(result);
    });
  };
  return {
    host,
    m,
    calls,
    createSender,
    navigation,
    hydrationErrors,
    render,
    form,
    title,
    description,
    kind,
    key,
    action,
    locked,
    fill,
    submit,
    settle,
    get serverHtml() {
      return serverHtml;
    },
    href: (id: string) => `/${getLocale()}/collections/${encodeURIComponent(id)}`,
    async dispose() {
      if (root) await act(async () => root!.unmount());
      client.clear();
      read.mockRestore();
      transport.mockRestore();
      navigate.mockRestore();
      host.remove();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
async function withForm(run: (page: Awaited<ReturnType<typeof mountForm>>) => Promise<void>, hydrate = false) {
  const page = await mountForm(hydrate);
  try {
    await run(page);
  } finally {
    await page.dispose();
  }
}

describe('Curated Collection creation preserves exact uncertain intent and isolates observed current viewer lifetimes', () => {
  test('invalid title creates no intent and correcting to the scalar boundary keeps raw text', async () => {
    await withForm(async (page) => {
      await page.render();
      await page.fill('😀'.repeat(201));
      const key = page.key();
      await page.submit();
      expect(page.calls).toHaveLength(0);
      expect(page.key()).toBe(key);
      expect(page.title().getAttribute('aria-invalid')).toBe('true');
      const title = ' ' + '😀'.repeat(199);
      await page.fill(title);
      await page.submit();
      expect(page.calls[0]!.data.title).toBe(title);
      await page.settle(0, success);
    });
  });

  test('viewer replacement retires private drafts and every late completion while the replacement can create', async () => {
    for (const result of staleResults)
      await withForm(async (page) => {
        await page.render();
        await page.fill('Originating private title', 'unlisted', 'game');
        await page.submit(true);
        expect(page.calls).toHaveLength(1);
        const oldKey = page.key();
        await page.render({ session: viewer('viewer-two', 'csrf-two') });
        expect(page.title().value).toBe('');
        expect(page.description().value).toBe('');
        expect(page.kind().value).toBe('');
        expect(page.host.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
        expect(page.key()).not.toBe(oldKey);
        await page.fill('Replacement title');
        await page.submit(true);
        expect(page.calls).toHaveLength(2);
        const replacementKey = page.key();
        await page.settle(0, result);
        expect(page.navigation).toEqual([]);
        expect(page.host.querySelector('[role="alert"]')).toBeNull();
        expect(page.title().value).toBe('Replacement title');
        expect(page.key()).toBe(replacementKey);
        expect(page.action().getAttribute('aria-busy')).toBe('true');
        await page.submit(true);
        expect(page.calls).toHaveLength(2); // Old finally cannot unlock this pending lifetime.
        await page.settle(1, { ok: true, id: 'replacement-created-id' });
        expect(page.navigation).toEqual([page.href('replacement-created-id')]);
      });
  });

  test('authority loss and unmount retire work even if the identical subject later returns', async () => {
    const losses = [
      { session: { ...viewer(), state: 'unknown' } satisfies Viewer },
      { session: { ...viewer(), state: 'signed-out' } satisfies Viewer },
      { session: { ...viewer(), state: 'unavailable' } satisfies Viewer },
      { session: { state: 'signed-in', csrfToken: 'present' } satisfies Viewer },
      { session: { ...viewer(), subject: '' } },
      { session: { ...viewer(), csrfToken: null } },
      { session: { ...viewer(), csrfToken: '' } },
      { admitted: false },
      { visible: false },
    ];
    for (const loss of losses)
      for (const result of staleResults)
        await withForm(async (page) => {
          await page.render(loss);
          expect(page.form()).toBeNull();
          expect(page.calls).toHaveLength(0);
          await page.render();
          await page.fill();
          await page.submit();
          const oldKey = page.key();
          await page.render(loss);
          expect(page.form()).toBeNull();
          await page.render();
          expect(page.title().value).toBe('');
          expect(page.key()).not.toBe(oldKey);
          await page.fill('Fresh lifetime');
          await page.submit();
          await page.settle(0, result);
          expect(page.navigation).toEqual([]);
          expect(page.host.querySelector('[role="alert"]')).toBeNull();
          expect(page.action().getAttribute('aria-busy')).toBe('true');
          await page.submit(true);
          expect(page.calls).toHaveLength(2);
          await page.settle(1, success);
          expect(page.navigation).toEqual([page.href(success.id)]);
        });
  });

  test('loader refresh and CSRF rotation preserve the exact uncertain request; correction waits for a definite refusal', async () => {
    for (const unknown of [{ ok: false, reason: 'unavailable' } as const, new Error('Reply lost')])
      await withForm(async (page) => {
        await page.render();
        await page.fill('  Exact title  ', 'unlisted', 'game');
        page.description().value = '  Exact description\nsecond line  ';
        page.description().dispatchEvent(new page.host.ownerDocument.defaultView!.Event('input', { bubbles: true }));
        await page.submit(true);
        const captured = page.calls[0]!.data;
        expect(captured).toEqual({
          title: '  Exact title  ',
          description: '  Exact description\nsecond line  ',
          visibility: 'unlisted',
          presentationKind: 'game',
          idempotencyKey: page.key(),
        });
        expect(page.calls[0]!.csrf).toBe('csrf-one');
        expect(page.calls[0]!.headers).toEqual([['x-csrf-token', 'csrf-one']]);
        await page.render({ session: viewer('viewer-one', 'csrf-two'), page: { ...loader(), types: [] } });
        expect(page.key()).toBe(captured.idempotencyKey);
        expect(page.title().value).toBe(captured.title);
        expect(page.description().value).toBe(captured.description);
        expect(page.kind().value).toBe('game');
        expect(page.action().getAttribute('aria-busy')).toBe('true');
        await page.settle(0, unknown);
        expect(page.locked()).toBe(true);
        expect(page.action().textContent).toBe(page.m.library_publication_retry());
        expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.library_publication_unknown());
        await page.render({ session: viewer('viewer-one', 'csrf-three'), page: loader() });
        // Even forced DOM mutation cannot replace the already dispatched payload on an explicit retry.
        page.title().value = 'Unsent replacement title';
        page.description().value = 'Unsent replacement description';
        await page.submit(true);
        expect(page.calls).toHaveLength(2);
        expect(page.calls[1]!.sender).toBe(page.calls[0]!.sender);
        expect(page.calls[1]!.data).toEqual(captured);
        expect(page.calls[1]!.headers).toEqual(page.calls[0]!.headers);
        expect(page.calls[1]!.csrf).toBe('csrf-one');
        await page.settle(1, { ok: false, reason: 'unavailable' });
        expect(page.key()).toBe(captured.idempotencyKey);
        await page.submit();
        expect(page.calls[2]!.data).toEqual(captured);
        await page.settle(2, { ok: false, reason: 'invalid' });
        expect(page.locked()).toBe(false);
        expect(page.key()).not.toBe(captured.idempotencyKey);
        expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(page.m.error_message());
        await page.fill('Deliberate correction', 'public', 'book');
        await page.submit(true);
        expect(page.calls).toHaveLength(4);
        expect(page.calls[3]!.data).toEqual({
          title: 'Deliberate correction',
          description: 'Deliberate correction description',
          visibility: 'public',
          presentationKind: 'book',
          idempotencyKey: page.key(),
        });
        await page.settle(3, success);
        expect(page.navigation).toEqual([page.href(success.id)]);
      });
  });

  test('a renewed sender cannot replace the original sender or credentials for an uncertain create', async () => {
    await withForm(async (page) => {
      const originalSender = page.createSender();
      const renewedSender = page.createSender();
      await page.render({ sender: originalSender });
      await page.fill('Retained create', 'unlisted', 'game');
      await page.submit();
      const original = page.calls[0]!;
      await page.settle(0, { ok: false, reason: 'unavailable' });

      await page.render({ session: viewer('viewer-one', 'csrf-two'), sender: renewedSender });
      await page.submit();
      expect(page.calls).toHaveLength(2);
      expect(page.calls[1]!.sender).toBe(originalSender);
      expect(page.calls[1]!.headers).toEqual(original.headers);
      expect(page.calls[1]!.data).toEqual(original.data);
      await page.settle(1, success);
      expect(page.navigation).toEqual([page.href(success.id)]);
    });
  });

  test('uncertain feedback and intent are private to their viewer, and healthy guarded hydration remains usable', async () => {
    await withForm(async (page) => {
      await page.render();
      expect(page.serverHtml).toContain(page.m.library_collection_new());
      expect(page.serverHtml).not.toContain('<form');
      expect(page.hydrationErrors).toEqual([]);
      expect(page.title().required).toBe(true);
      expect(page.title().hasAttribute('maxlength')).toBe(false);
      expect(page.description().rows).toBe(4);
      expect(page.action().disabled).toBe(true);
      await page.submit();
      expect(page.calls).toHaveLength(0); // No default visibility is invented.
      await page.fill('Private unknown');
      await page.submit();
      await page.settle(0, new Error('Unknown outcome'));
      const oldKey = page.key();
      await page.render({ session: viewer('viewer-two') });
      expect(page.host.querySelector('[role="alert"]')).toBeNull();
      expect(page.locked()).toBe(false);
      expect(page.title().value).toBe('');
      expect(page.key()).not.toBe(oldKey);
      await page.fill('Healthy current create', 'public', 'book');
      await page.submit(true);
      expect(page.calls).toHaveLength(2);
      await page.settle(1, { ok: true, id: 'actual returned/id' });
      expect(page.navigation).toEqual([page.href('actual returned/id')]);
      await page.submit(true);
      expect(page.calls).toHaveLength(2);
    }, true);
  });
});
