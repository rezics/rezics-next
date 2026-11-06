import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import type { EditFailure, RevisedPost, WriteFailure } from '../src/threads/actions';

// Authored for controller integration. This default-composition regression is intentionally UNRUN here.
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
type Command = { body: DocumentSnapshot; mediaIds: string[]; idempotencyKey: string; revisionId?: string };
type Outcome = { ok: true; value: string; post: RevisedPost } | WriteFailure | EditFailure;
type Configuration = {
  kind: 'reply' | 'inline' | 'new-thread';
  epoch: number;
  target: string;
  body: DocumentSnapshot;
  parent: string | null;
};

test('real reply and inline composers retire pending copies and submissions, while current exact recovery remains usable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: () => {} });
  const elementScroll = window.HTMLElement.prototype as { scrollTo?: (x?: number, y?: number) => void };
  if (typeof elementScroll.scrollTo !== 'function') elementScroll.scrollTo = () => {};
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { PostComposer, InlinePostEditor } = await import('../src/threads/composer');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { sessionQuery } = await import('../src/session/query');
  const { fromPlainText } = await import('@rezics/document');
  const { m } = await import('../src/paraglide/messages.js');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const owner = { state: 'signed-in' as const, subject: id(1), csrfToken: 'original-session' };
  const png = new Uint8Array([137, 80, 78, 71]);
  const originals: {
    response: ReturnType<typeof gate<Response>>;
    blob: ReturnType<typeof gate<Blob>>;
    signal: AbortSignal;
  }[] = [];
  const hops: { method: string; path: string; body?: unknown }[] = [];
  let mediaMode: 'available' | 'unknown-read' | 'unknown-reserve' = 'available';
  const reservedId = id(90);
  const media = () => ({
    media: { id: reservedId, state: 'available', mediaType: 'image/png', byteCount: png.length },
  });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    hops.push({ method, path, ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    if (path.endsWith('/original')) {
      const entry = { response: gate<Response>(), blob: gate<Blob>(), signal: init!.signal! };
      originals.push(entry);
      // Deliberately ignore abort: the caller must fence even a non-cooperative read.
      return entry.response.promise;
    }
    if (path === '/media' && method === 'POST') {
      if (mediaMode === 'unknown-reserve') throw new TypeError('Reservation response lost');
      return Response.json(media());
    }
    if (path === `/media/${reservedId}`) {
      if (method === 'PUT') return new Response(null, { status: 204 });
      return mediaMode === 'unknown-read' ? new Response(null, { status: 503 }) : Response.json(media());
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(fetcher, { preconnect() {} }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const blocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const button = (label: string) => {
    const found = [...window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (label: string) => act(async () => user.click(button(label)));
  const editor = () => host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
  const pasteImage = async () => {
    await settle(() => !!editor());
    await act(async () => {
      await user.click(editor()!);
      const event = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', {
        value: {
          files: [],
          items: [],
          types: ['text/html'],
          getData: (type: string) =>
            type === 'text/html' ? `<img src="/media/${id(75)}" alt="Private copied chart">` : '',
        },
      });
      editor()!.dispatchEvent(event);
    });
    await settle(() => originals.length === 1);
  };
  const completeOriginal = async (blobOnly = false) => {
    const entry = originals[0]!;
    await act(async () => {
      if (blobOnly) entry.blob.resolve(new Blob([png], { type: 'image/png' }));
      else entry.response.resolve(new Response(png, { headers: { 'content-type': 'image/png' } }));
      await Promise.resolve();
    });
  };
  const submitTwice = async () => {
    const form = host.querySelector('form')!;
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const success: Outcome = { ok: true, value: 'accepted', post: { id: id(40) } as RevisedPost };
  let client: InstanceType<typeof QueryClient> | undefined;
  let resetPage: (config: Configuration) => void;
  let config: Configuration;
  let calls: { command: Command; outcome: ReturnType<typeof gate<Outcome>> }[];
  let callbacks: { kind: string; epoch: number; blocked?: boolean }[];

  const mount = async (kind: Configuration['kind'], knownSession = true) => {
    await act(async () => root.render(null));
    client?.clear();
    originals.length = 0;
    hops.length = 0;
    mediaMode = 'available';
    calls = [];
    callbacks = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    if (knownSession) client.setQueryData(sessionQuery.queryKey, owner);
    config = {
      kind,
      epoch: 0,
      target: id(2),
      body: fromPlainText('Original private writing.', 'blocks'),
      parent: null,
    };
    function Page() {
      const [current, update] = useState(config);
      resetPage = (next) => {
        config = next;
        update(next);
      };
      const onSubmit = (command: Command) => {
        const outcome = gate<Outcome>();
        calls.push({ command: structuredClone(command), outcome });
        return outcome.promise;
      };
      const onSuccess = () => {
        callbacks.push({ kind: 'success', epoch: current.epoch, blocked: blocked() });
        void router.navigate({ href: '/done' });
      };
      return (
        <AuthoringDepartureProvider key={current.epoch}>
          {current.kind === 'inline' ? (
            <InlinePostEditor
              initialBody={current.body}
              revisionId="revision-1"
              idempotencyKey={id(10 + current.epoch)}
              containerId={current.target}
              onSubmit={onSubmit as (command: Command) => Promise<{ ok: true; post: RevisedPost } | EditFailure>}
              onCancel={() => callbacks.push({ kind: 'cancel', epoch: current.epoch })}
              onSuccess={onSuccess}
            />
          ) : (
            <PostComposer
              initialBody={current.body}
              initialKey={id(10 + current.epoch)}
              {...(current.kind === 'new-thread'
                ? { boardId: current.target, titleRequired: true }
                : { containerId: current.target })}
              replyTargetId={current.parent}
              onSubmit={onSubmit as (command: Command) => Promise<{ ok: true; value: string } | WriteFailure>}
              onPendingChange={(pending) => callbacks.push({ kind: `pending:${pending}`, epoch: current.epoch })}
              onIntentLockChange={(locked) => callbacks.push({ kind: `locked:${locked}`, epoch: current.epoch })}
              onSuccess={onSuccess}
            />
          )}
          <button type="button" onClick={() => void router.navigate({ href: '/done' })}>
            Leave conversation
          </button>
        </AuthoringDepartureProvider>
      );
    }
    const route = createRootRoute({ component: Outlet });
    const compose = createRoute({ getParentRoute: () => route, path: '/compose', component: Page });
    const done = createRoute({ getParentRoute: () => route, path: '/done', component: () => <h1>Destination</h1> });
    const router = createRouter({
      routeTree: route.addChildren([compose, done]),
      history: createMemoryHistory({ initialEntries: ['/compose'] }),
    });
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client!}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await settle(() => !!editor());
    if (kind === 'new-thread')
      await act(async () => user.type(host.querySelector('#thread-title')!, 'Private opening'));
    return router;
  };
  const replaceEditor = async (targetOnly = false) => {
    await act(async () =>
      resetPage({
        ...config,
        target: targetOnly ? id(3) : config.target,
        epoch: targetOnly ? config.epoch : config.epoch + 1,
        body: fromPlainText('Replacement writing.', 'blocks'),
      }),
    );
    await settle(() => !!editor());
    await act(async () => {
      await user.click(editor()!);
      await user.keyboard(' kept locally');
      await user.tab();
    });
    expect(blocked()).toBe(true);
  };
  try {
    // Both read phases are fenced, across editor/target replacement and batched session away/back.
    for (const kind of ['reply', 'inline', 'new-thread'] as const) {
      for (const retirement of ['unmount', 'target', 'same-account', 'away-back'] as const) {
        const router = await mount(kind);
        await pasteImage();
        const blobOnly = retirement === 'same-account';
        if (blobOnly)
          await act(async () => {
            const response = new Response();
            Object.defineProperty(response, 'blob', { value: () => originals[0]!.blob.promise });
            originals[0]!.response.resolve(response);
            await Promise.resolve();
          });
        if (retirement === 'same-account' || retirement === 'away-back') {
          await act(async () => {
            client!.setQueryData(sessionQuery.queryKey, { ...owner, csrfToken: 'replacement-session' });
            if (retirement === 'away-back') client!.setQueryData(sessionQuery.queryKey, owner);
          });
          expect(host.textContent).not.toContain('Original private writing.');
          expect(host.textContent).not.toContain('Private copied chart');
        }
        await replaceEditor(retirement === 'target');
        const callbackCount = callbacks.length;
        expect(originals[0]!.signal.aborted).toBe(true);
        await completeOriginal(blobOnly);
        expect(hops.filter((hop) => hop.method === 'POST')).toHaveLength(0);
        expect(callbacks).toHaveLength(callbackCount);
        expect(router.state.location.pathname).toBe('/compose');
        expect(host.textContent).toContain('Replacement writing.');
        expect(host.textContent).not.toContain('Original private writing.');
        expect(host.querySelector('[role="img"][aria-label="Private copied chart"]')).toBeNull();
        expect(blocked()).toBe(true);
      }
    }

    // An accepted command is allowed to finish, but its retired continuation cannot navigate or release a new draft.
    for (const kind of ['reply', 'inline'] as const) {
      for (const late of ['success', 'refusal', 'throw'] as const) {
        const router = await mount(kind);
        await submitTwice();
        expect(calls).toHaveLength(1);
        expect(blocked()).toBe(true);
        await replaceEditor();
        const callbackCount = callbacks.length;
        await act(async () => {
          if (late === 'throw') calls[0]!.outcome.reject(new TypeError('Late lost response'));
          else calls[0]!.outcome.resolve(late === 'success' ? success : { ok: false, reason: 'forbidden' });
        });
        expect(callbacks).toHaveLength(callbackCount);
        expect(router.state.location.pathname).toBe('/compose');
        expect(blocked()).toBe(true);
        expect(host.textContent).toContain('Replacement writing.');
        expect(host.textContent).not.toContain(m.thread_write_forbidden());
      }
      // Loss and restoration before a React render must still retire the original onSubmit promise.
      const router = await mount(kind);
      await submitTwice();
      await act(async () => {
        client!.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        client!.setQueryData(sessionQuery.queryKey, owner);
      });
      const callbackCount = callbacks.length;
      await act(async () => calls[0]!.outcome.resolve(success));
      expect(callbacks).toHaveLength(callbackCount);
      expect(host.textContent).not.toContain('Original private writing.');
      expect(router.state.location.pathname).toBe('/compose');
    }

    for (const kind of ['reply', 'inline'] as const) {
      const router = await mount(kind);
      await submitTwice();
      expect(calls).toHaveLength(1);
      const originalCommand = structuredClone(calls[0]!.command);
      await act(async () => calls[0]!.outcome.resolve({ ok: false, reason: 'unavailable' }));
      await settle(() => !!editor());
      expect(blocked()).toBe(true);
      // Ordinary rerender and reply-parent selection retain writing; an unknown command can only replay its parent.
      await act(async () => resetPage({ ...config, parent: kind === 'reply' ? id(55) : null }));
      expect(editor()?.textContent).toContain('Original private writing.');
      if (kind === 'reply') {
        await submitTwice();
        expect(calls).toHaveLength(1);
        await act(async () => resetPage({ ...config, parent: null }));
      }
      await submitTwice();
      expect(calls).toHaveLength(2);
      expect(calls[1]!.command).toEqual(originalCommand);
      await act(async () => calls[1]!.outcome.resolve(success));
      await settle(() => router.state.location.pathname === '/done');
      expect(callbacks.filter((item) => item.kind === 'success')).toEqual([
        { kind: 'success', epoch: 0, blocked: false },
      ]);
      expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    }

    for (const kind of ['reply', 'inline'] as const) {
      const router = await mount(kind);
      await act(async () => {
        await user.click(editor()!);
        await user.keyboard(' pending private addition');
        await user.tab();
      });
      await submitTwice();
      expect(calls).toHaveLength(1);
      await click('Leave conversation');
      await settle(() => window.document.querySelector('[role="alertdialog"]') !== null);
      await click(m.thread_authoring_leave());
      await settle(() => router.state.location.pathname === '/done');
      await act(async () => router.navigate({ href: '/compose' }));
      await settle(() => !!editor());
      await act(async () => {
        await user.click(editor()!);
        await user.keyboard(' current local work');
        await user.tab();
      });
      const callbackCount = callbacks.length;
      await act(async () => calls[0]!.outcome.resolve(success));
      expect(callbacks).toHaveLength(callbackCount);
      expect(router.state.location.pathname).toBe('/compose');
      expect(editor()?.textContent).toContain('current local work');
      expect(editor()?.textContent).not.toContain('pending private addition');
      expect(blocked()).toBe(true);
    }

    // Copied images use the same real recovery and transport as File uploads: exact ID, no second reservation.
    for (const kind of ['reply', 'inline'] as const) {
      await mount(kind);
      mediaMode = 'unknown-read';
      await pasteImage();
      await completeOriginal();
      await settle(() => host.textContent?.includes(m.thread_media_state_unavailable()) === true);
      expect(host.textContent).not.toContain(m.thread_media_rejected());
      expect(blocked()).toBe(true);
      mediaMode = 'available';
      await click(m.thread_media_check_again());
      await settle(() => !button(kind === 'reply' ? m.thread_write_send() : m.thread_edit_save()).disabled);
      expect(host.querySelector('[role="img"][aria-label="Private copied chart"]')).not.toBeNull();
      expect(originals).toHaveLength(1);
      expect(hops.filter((hop) => hop.method === 'POST')).toEqual([
        expect.objectContaining({ path: '/media', body: expect.objectContaining({ containerId: id(2) }) }),
      ]);
      expect(hops.filter((hop) => hop.method === 'PUT')).toHaveLength(1);
      await submitTwice();
      expect(calls[0]!.command.mediaIds).toEqual([reservedId]);
      expect(JSON.stringify(calls[0]!.command.body)).toContain('Private copied chart');
      await act(async () => calls[0]!.outcome.resolve(success));

      await mount(kind);
      mediaMode = 'unknown-reserve';
      await pasteImage();
      await completeOriginal();
      await settle(() => host.textContent?.includes(m.thread_media_state_unavailable()) === true);
      await click(m.thread_media_check_again());
      expect(hops.filter((hop) => hop.method === 'POST')).toHaveLength(1);
      expect(originals).toHaveLength(1);
      await click(m.thread_media_remove());
      await submitTwice();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command.mediaIds).toEqual([]);
      expect(JSON.stringify(calls[0]!.command.body)).toContain('Original private writing.');
      expect(JSON.stringify(calls[0]!.command.body)).not.toContain('Private copied chart');
      await act(async () => calls[0]!.outcome.resolve(success));
    }

    // Prepared/unknown-session compositions can still call their prepared submitter without upload authority.
    for (const kind of ['reply', 'inline'] as const) {
      const router = await mount(kind, false);
      await submitTwice();
      expect(calls).toHaveLength(1);
      await act(async () => calls[0]!.outcome.resolve(success));
      await settle(() => router.state.location.pathname === '/done');
      expect(hops).toHaveLength(0);
    }
  } finally {
    await act(async () => root.unmount());
    client?.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 60_000);
