import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mountComposer() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    FormData: window.FormData,
    scrollTo: window.scrollTo.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    createImageBitmap: async () => ({ width: 2, height: 3, close() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { sessionQuery } = await import('../src/session/query');
  const { PostComposer } = await import('../src/threads/composer');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'writer', csrfToken: 'original-csrf' });
  const submitted: unknown[] = [];
  let rebind!: (binding: { initialKey: string; boardId: string }) => void;
  function Compose() {
    const [binding, setBinding] = useState({ initialKey: 'draft-key', boardId: 'board' });
    rebind = setBinding;
    return (
      <PostComposer
        {...binding}
        localDraft={false}
        onSubmit={async (command) => {
          submitted.push(command);
          return { ok: true, value: 'created' };
        }}
        onSuccess={() => {}}
      />
    );
  }
  const route = createRootRoute({ component: Compose });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/compose'] }) });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready(), host.textContent ?? '').toBe(true);
  };
  const button = (name: string, scope: ParentNode = host) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
  const click = (name: string, scope: ParentNode = host) => act(async () => user.click(button(name, scope)));
  const editor = () => host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]')!;
  const attach = async (alt: string) => {
    await click(m.editor_image());
    const dialog = host.querySelector('[role="dialog"]')!;
    await act(async () => {
      await user.upload(
        dialog.querySelector<HTMLInputElement>('input[type="file"]')!,
        new File(['png'], 'same.png', { type: 'image/png' }),
      );
      await user.type(dialog.querySelector<HTMLInputElement>('input:not([type="file"])')!, alt);
    });
    await click(m.editor_insert_image(), dialog);
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle(() => !!editor());
  return {
    host,
    user,
    m,
    settle,
    click,
    button,
    editor,
    attach,
    submitted,
    rebind: (binding: Parameters<typeof rebind>[0]) => act(async () => rebind(binding)),
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('mounted attachment rows explain actual stages and recover only the selected original while keeping the coherent draft', async () => {
  const page = await mountComposer();
  const reserve = deferred<Response>();
  const transfer = deferred<Response>();
  const processing = deferred<Response>();
  const removed = deferred<Response>();
  const calls: { path: string; init: RequestInit }[] = [];
  let reservations = 0;
  const puts = new Map<string, number>();
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init = {}) => {
    const path = String(input);
    calls.push({ path, init });
    if (init.method === 'POST') {
      reservations++;
      if (reservations === 1) return reserve.promise;
      if (reservations === 4) return removed.promise;
      return Response.json({
        media: {
          id: `image-${reservations}`,
          containerId: 'native-container',
          state: 'reserved',
          mediaType: 'image/png',
          byteCount: 3,
        },
      });
    }
    if (init.method === 'PUT') {
      puts.set(path, (puts.get(path) ?? 0) + 1);
      if (path === '/media/image-1' && puts.get(path) === 1) return transfer.promise;
      return new Response(null, { status: 204 });
    }
    if (path === '/media/image-3') return processing.promise;
    return Response.json({
      media: {
        id: path.split('/').at(-1),
        state: path.endsWith('image-2') ? 'rejected' : puts.get(path) === 1 ? 'reserved' : 'available',
        mediaType: 'image/png',
        byteCount: 3,
      },
    });
  });
  const row = (alt: string) =>
    [...page.host.querySelectorAll<HTMLElement>('[role="group"]')].find(
      (node) => node.querySelector('p')?.textContent === alt,
    )!;
  try {
    await act(async () => {
      await page.user.click(page.editor());
      await page.user.keyboard('Keep my writing.');
    });
    await page.attach('First description');
    await page.settle(() => page.host.textContent?.includes(page.m.thread_attachment_reserving()) === true);
    await act(async () =>
      reserve.resolve(
        Response.json({
          media: {
            id: 'image-1',
            containerId: 'native-container',
            state: 'reserved',
            mediaType: 'image/png',
            byteCount: 3,
          },
        }),
      ),
    );
    await page.settle(
      () => row('First description')?.textContent?.includes(page.m.thread_attachment_transferring()) === true,
    );
    await act(async () => transfer.reject(new Error('lost transfer receipt')));
    await page.settle(() => !!page.button(page.m.editor_retry_upload(), row('First description')));
    await page.attach('Second description');
    await page.settle(() => row('Second description')?.textContent?.includes(page.m.editor_upload_rejected()) === true);
    expect(row('First description').textContent).toContain(page.m.thread_attachment_known_unknown());
    expect(page.button(page.m.editor_retry_upload(), row('Second description'))).toBeUndefined();
    expect(page.button(page.m.thread_write_send()).disabled).toBe(true);
    const second = calls.filter(({ init }) => init.method === 'POST')[1]!;
    expect(JSON.parse(String(second.init.body))).toMatchObject({ containerId: 'native-container' });
    const boundary = calls.length;
    await page.click(page.m.editor_retry_upload(), row('First description'));
    await page.settle(() => !row('First description'));
    expect(calls.slice(boundary).map(({ path, init }) => [init.method, path])).toEqual([
      ['GET', '/media/image-1'],
      ['PUT', '/media/image-1'],
      ['GET', '/media/image-1'],
    ]);
    expect(await (calls.at(-2)!.init.body as Blob).text()).toBe('png');
    expect(page.host.querySelectorAll('[role="img"][aria-label="First description"]')).toHaveLength(1);
    expect(page.button(page.m.thread_write_send()).disabled).toBe(true);
    await act(async () =>
      page.user.upload(
        row('Second description').querySelector<HTMLInputElement>('input[type="file"]')!,
        new File(['new'], 'replacement.png', { type: 'image/png' }),
      ),
    );
    // Let the replacement finish processing; its original description and position survive.
    await page.settle(() => page.host.textContent?.includes(page.m.thread_attachment_processing()) === true);
    await act(async () =>
      processing.resolve(
        Response.json({ media: { id: 'image-3', state: 'available', mediaType: 'image/png', byteCount: 3 } }),
      ),
    );
    await page.settle(() => !row('Second description'));
    expect(page.host.querySelectorAll('[role="img"][aria-label="Second description"]')).toHaveLength(1);
    await page.attach('Removed description');
    await page.settle(() => reservations === 4);
    await page.click(page.m.editor_dismiss_upload(), row('Removed description'));
    const beforeLate = calls.length;

    expect(page.editor().textContent).toContain('Keep my writing.');
    expect(page.host.querySelectorAll('[role="img"][aria-label="First description"]')).toHaveLength(1);
    await page.settle(() => !page.button(page.m.thread_write_send()).disabled);
    await page.click(page.m.thread_write_send());
    await page.settle(() => page.submitted.length === 1);
    expect(JSON.stringify(page.submitted)).toContain('First description');
    expect(JSON.stringify(page.submitted)).toContain('Second description');
    expect(JSON.stringify(page.submitted)).not.toContain('Removed description');
    await act(async () =>
      removed.resolve(
        Response.json({ media: { id: 'image-4', state: 'reserved', mediaType: 'image/png', byteCount: 3 } }),
      ),
    );
    expect(calls).toHaveLength(beforeLate);
  } finally {
    transport.mockRestore();
    await page.dispose();
  }
});

test('board and command-key replacements retire old attachment callbacks while the freshly admitted composer works', async () => {
  for (const change of ['board', 'key'] as const) {
    const page = await mountComposer();
    const late = deferred<Response>();
    let posts = 0;
    let puts = 0;
    const media = (state: string) =>
      Response.json({
        media: { id: 'current-image', containerId: 'current-container', state, mediaType: 'image/png', byteCount: 3 },
      });
    const transport = spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.method === 'POST') {
        posts++;
        return posts === 1 ? late.promise : media('reserved');
      }
      if (init?.method === 'PUT') {
        puts++;
        return new Response(null, { status: 204 });
      }
      return media('available');
    });
    try {
      await page.attach('Old occurrence');
      await page.settle(() => posts === 1);
      const oldRemove = page.button(page.m.editor_dismiss_upload());
      await page.rebind({
        initialKey: change === 'key' ? 'new-key' : 'draft-key',
        boardId: change === 'board' ? 'new-board' : 'board',
      });
      await page.settle(() => !!page.editor());
      await act(async () => {
        oldRemove.click();
        late.resolve(media('reserved'));
        await Promise.resolve();
      });
      expect(puts).toBe(0);
      expect(page.host.querySelector('[role="img"]')).toBeNull();
      await page.attach('New occurrence');
      await page.settle(() => page.host.querySelector('[role="img"][aria-label="New occurrence"]') !== null);
      expect(posts).toBe(2);
      expect(puts).toBe(1);
    } finally {
      transport.mockRestore();
      await page.dispose();
    }
  }
});
