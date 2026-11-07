import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode, useLayoutEffect, useState } from 'react';
import * as start from '../.storybook/react-start';
import type { ProfileReadResult, ProfileSaveResult, ProfileValues } from '../src/settings/profile-model';
import type { ProfileAttempt, ProfileEditor } from '../src/settings/profile-write';
import { createBrowserSettingsAmbient } from '../src/settings/adapters/ambient';
import { performanceAmbientTree } from './performance-ambient';

const settingsAmbient = createBrowserSettingsAmbient();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const reads: ReturnType<typeof deferred<ProfileReadResult>>[] = [];
const writes: {
  attempt: ProfileAttempt;
  token: string | null;
  result: ReturnType<typeof deferred<ProfileSaveResult>>;
}[] = [];
const uploads: { signal: AbortSignal; result: ReturnType<typeof deferred<{ src: string }>> }[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/settings/actions', () => ({
  readProfile: () => {
    const request = deferred<ProfileReadResult>();
    reads.push(request);
    return request.promise;
  },
  saveProfile: (input: { data: ProfileAttempt; headers: HeadersInit }) => {
    const request = {
      attempt: input.data,
      token: new Headers(input.headers).get('X-CSRF-Token'),
      result: deferred<ProfileSaveResult>(),
    };
    writes.push(request);
    return request.result.promise;
  },
}));
class UploadRefusal extends Error {}
mock.module('../src/threads/upload', () => ({
  UploadRefusal,
  uploadAvatar: (_accountId: string, _file: File, signal: AbortSignal) => {
    const request = { signal, result: deferred<{ src: string }>() };
    uploads.push(request);
    return request.result.promise;
  },
  resumeReplyImageUpload: () => {
    throw new Error('No reservation in this journey');
  },
}));
const accountId = '019a0000-0000-7000-8000-000000000301';
const otherId = '019a0000-0000-7000-8000-000000000302';
const token = 'original-private-token';
const session = (subject = accountId, csrfToken: string | null = token) => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const profile = (subject = accountId): ProfileValues => ({
  accountId: subject,
  kind: 'organization',
  displayName: 'Current profile',
  biography: 'Current biography',
  avatar: null,
  links: [],
  publicViews: { posts: true, reviews: false, collections: true, realms: false },
  speakersListed: false,
});

// Real installed QueryClient events and mounted production callers; only BFF/platform transports are replaced.
// This campaign and its growth assertions are authored UNRUN. createRoot is not hydration or native authority proof.
test('committed equal session results revoke the connected owner synchronously while ordinary notifications retain useful work', async () => {
  reads.length = writes.length = uploads.length = 0;
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/settings' });
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  class TestURL extends URL {
    static override createObjectURL(_blob: Blob) {
      const url = `blob:event-avatar-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    }
    static override revokeObjectURL(url: string) {
      revokedUrls.push(url);
    }
  }
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    URL: TestURL,
    File: window.File,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let root: import('react-dom/client').Root | undefined;
  const clients: import('@tanstack/react-query').QueryClient[] = [];
  try {
    const [
      { createRoot },
      queryApi,
      routerApi,
      { sessionQuery },
      { useProfileEditor },
      { ProfileSection },
      { settingsContent },
      { PublicViewsSection },
      { m },
    ] = await Promise.all([
      import('react-dom/client'),
      import('@tanstack/react-query'),
      import('@tanstack/react-router'),
      import('../src/session/query'),
      import('../src/settings/profile-write-query'),
      import('../src/settings/profile'),
      import('../src/settings/adapters/presentation'),
      import('../src/settings/public-views'),
      import('../src/paraglide/messages.js'),
    ]);
    const { QueryClient, QueryClientProvider, QueryObserver } = queryApi;
    const { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider } = routerApi;
    const listenerCounts = new Map<import('@tanstack/react-query').QueryClient, { active: number; peak: number }>();
    function makeClient() {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(sessionQuery.queryKey, session(), { updatedAt: 1234 });
      clients.push(client);
      const cache = client.getQueryCache();
      const subscribe = cache.subscribe.bind(cache);
      const counts = { active: 0, peak: 0 };
      listenerCounts.set(client, counts);
      // Count actual subscriptions without manufacturing events or replacing the installed cache.
      cache.subscribe = (listener) => {
        counts.active++;
        counts.peak = Math.max(counts.peak, counts.active);
        const unsubscribe = subscribe(listener);
        let active = true;
        return () => {
          if (active) {
            active = false;
            counts.active--;
            unsubscribe();
          }
        };
      };
      return client;
    }
    let client = makeClient();
    let latest!: ReturnType<typeof useProfileEditor>;
    const observers = new Map<number, ProfileEditor>();
    let beforeCommit: (() => void) | undefined;
    let probeCleanups = 0;
    function Probe({ index }: { index: number }) {
      const result = useProfileEditor(settingsContent.mediaFailure);
      latest = result;
      observers.set(index, result.editor);
      if (beforeCommit) {
        const callback = beforeCommit;
        beforeCommit = undefined;
        callback();
      }
      useLayoutEffect(() => {
        observers.set(index, result.editor);
        return () => {
          probeCleanups++;
          if (observers.get(index) === result.editor) observers.delete(index);
        };
      }, [index, result.editor]);
      return null;
    }
    let resize: (count: number) => void = () => {
      throw new Error('Surface is not mounted');
    };
    function Surface() {
      const [observerCount, setObserverCount] = useState(1);
      resize = setObserverCount;
      return createElement(
        'main',
        null,
        createElement(Probe, { index: 0 }),
        createElement(ProfileSection, { content: settingsContent }),
        createElement(PublicViewsSection, { mediaFailure: settingsContent.mediaFailure }),
        ...Array.from({ length: observerCount - 1 }, (_, index) =>
          createElement(Probe, { key: index + 1, index: index + 1 }),
        ),
      );
    }
    const base = createRootRoute({ component: () => createElement(Outlet) });
    const settings = createRoute({ getParentRoute: () => base, path: '/settings', component: Surface });
    const elsewhere = createRoute({
      getParentRoute: () => base,
      path: '/elsewhere',
      component: () => createElement('p', null, 'Elsewhere'),
    });
    const router = createRouter({
      routeTree: base.addChildren([settings, elsewhere]),
      history: createMemoryHistory({ initialEntries: ['/settings'] }),
    });
    const host = window.document.createElement('main');
    window.document.body.append(host);
    root = createRoot(host as unknown as HTMLElement);
    // Scheduler turns wait for observed work; there are no fixed-duration sleeps.
    const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const flush = () =>
      act(async () => {
        await turn();
      });
    const until = async (condition: () => boolean, label: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (condition()) return;
        await flush();
      }
      throw new Error(`Timed out waiting for ${label}`);
    };
    const render = () =>
      act(async () => {
        root!.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(StrictMode, null, createElement(RouterProvider, { router })),
          ),
        );
        await Promise.resolve();
      });
    const resolveRead = async (index: number, value = profile()) => {
      await act(async () => {
        reads[index]!.resolve({ ok: true, profile: value });
        await turn();
      });
    };
    const ready = async (index: number, value = profile()) => {
      await until(() => reads.length === index + 1, 'one fresh private read');
      const editor = latest.editor;
      expect(editor.snapshot().known).toBeNull();
      expect(editor.snapshot().attempt).toBeNull();
      await resolveRead(index, value);
      await until(() => editor.snapshot().readAuthority === 'allowed', 'fresh matching profile admission');
      expect(latest.editor).toBe(editor);
      return editor;
    };
    const button = (text: string) => {
      const node = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === text);
      if (!node) throw new Error(`Missing button ${text}`);
      return node;
    };
    const click = (element: { click: () => void }) =>
      act(async () => {
        element.click();
        await Promise.resolve();
      });
    // Preserve the actual React closures from an old rendered element, even after React detaches that element.
    const handler = (element: object, name: string): ((event?: unknown) => void) => {
      const key = Object.keys(element).find((item) => item.startsWith('__reactProps$'));
      if (!key) throw new Error('Missing rendered React event props');
      const callback = (element as Record<string, Record<string, unknown>>)[key]![name];
      if (typeof callback !== 'function') throw new Error(`Missing rendered ${name}`);
      return (event?: unknown) => {
        const nativeEvent = new window.MouseEvent('click', { bubbles: true });
        callback(
          event ?? {
            nativeEvent,
            currentTarget: element,
            target: element,
            button: 0,
            defaultPrevented: false,
            preventDefault: () => nativeEvent.preventDefault(),
            stopPropagation: () => nativeEvent.stopPropagation(),
            isDefaultPrevented: () => false,
            isPropagationStopped: () => false,
            persist() {},
          },
        );
      };
    };
    const privateQueries = (target = client) => target.getQueryCache().findAll({ queryKey: ['settings', 'profile'] });
    const sessionRecord = () => {
      const record = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
      if (!record) throw new Error('Missing exact session query');
      return record;
    };
    const ordinary = async () => {
      await act(async () => {
        const observer = new QueryObserver(client, { ...sessionQuery, enabled: false });
        const unsubscribe = observer.subscribe(() => {});
        observer.setOptions({ ...sessionQuery, enabled: false, staleTime: 45_000 });
        await client.invalidateQueries({ queryKey: sessionQuery.queryKey, exact: true, refetchType: 'none' });
        sessionRecord().setState({ fetchStatus: 'paused' });
        sessionRecord().setState({ fetchStatus: 'idle' });
        client.setQueryData(['unrelated'], { value: crypto.randomUUID() });
        unsubscribe();
      });
    };
    const chooseAvatar = async () => {
      const input = host.querySelector('input[type="file"]');
      if (!input) throw new Error('Missing production avatar chooser');
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new window.File(['gif'], 'avatar.gif', { type: 'image/gif' })],
      });
      await act(async () => {
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      await until(
        () => host.textContent?.includes(m.settings_profile_crop_use_original()) === true,
        'the supplied original-image path',
      );
      await click(button(m.settings_profile_crop_use_original()));
    };
    const staleActions = (editor: ProfileEditor, renderedSubmit?: (event?: unknown) => void) => {
      editor.edit({ biography: 'Retired edit' });
      editor.review();
      void editor.submit('profile');
      void editor.submit('views');
      void editor.retry();
      void editor.reload();
      renderedSubmit?.({ preventDefault() {} });
    };

    await render();
    let editor = await ready(0);
    expect(listenerCounts.get(client)!.active).toBe(1);
    expect(listenerCounts.get(client)!.peak).toBe(1);
    expect(new Set(observers.values()).size).toBe(1);
    // 1/10/100 real hook observers share the same read and cache subscription, including StrictMode replay.
    for (const count of [1, 10, 100, 1]) {
      if (observers.size !== count) {
        observers.clear();
        await act(async () => resize(count));
      }
      await until(() => observers.size === count, 'the current observer population');
      expect(new Set(observers.values())).toEqual(new Set([editor]));
      expect(reads).toHaveLength(1);
      expect(listenerCounts.get(client)!.active).toBe(1);
      expect(listenerCounts.get(client)!.peak).toBe(1);
    }
    await act(async () => editor.edit({ biography: 'Useful dirty draft', accountId: otherId, kind: 'actor' }));
    expect(editor.snapshot().draft?.accountId).toBe(accountId);
    expect(editor.snapshot().draft?.kind).toBe('organization');
    await ordinary();
    expect(latest.editor).toBe(editor);
    expect(editor.snapshot().draft?.biography).toBe('Useful dirty draft');

    // A genuine retained-success fetch and cancellation emits fetch/setState, not a committed success.
    const heldSession = deferred<ReturnType<typeof session>>();
    const fetching = client
      .fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: () => heldSession.promise })
      .catch(() => undefined);
    await until(() => sessionRecord().state.fetchStatus === 'fetching', 'a real retained-success fetch');
    await ordinary();
    expect(latest.editor).toBe(editor);
    await client.cancelQueries({ queryKey: sessionQuery.queryKey, exact: true });
    heldSession.resolve(session());
    await fetching;
    expect(editor.snapshot().draft?.biography).toBe('Useful dirty draft');

    await click(button(m.settings_profile_save()));
    await until(() => writes.length === 1, 'the current native write');
    const original = writes[0]!.attempt;
    await ordinary();
    await editor.submit('profile');
    expect(writes).toHaveLength(1);
    expect(editor.snapshot().attempt).toBe(original);
    expect(writes[0]!.token).toBe(token);
    await act(async () => {
      writes[0]!.result.resolve({ ok: true, profile: original.after });
      await Promise.resolve();
    });
    await until(() => reads.length === 2, 'the current write readback');
    await ordinary();
    await resolveRead(1, original.after);
    await until(() => editor.snapshot().phase === 'saved', 'current confirmation');
    expect(latest.editor).toBe(editor); // Its own successful profile publication is not a session observation.
    expect(privateQueries()).toHaveLength(1);
    expect(privateQueries()[0]!.state.data).toEqual(original.after);

    await act(async () => editor.edit({ biography: 'Uncertain intent' }));
    await click(button(m.settings_profile_save()));
    await until(() => writes.length === 2, 'the uncertain write');
    await act(async () => {
      writes[1]!.result.resolve({
        ok: false,
        status: 503,
        message: '',
        failure: {
          status: 503,
          code: 'dependency_unavailable',
          retryable: true,
          retryAfter: '0',
          requestId: 'current-write',
        },
      });
    });
    const uncertain = writes[1]!.attempt;
    expect(editor.snapshot().phase).toBe('uncertain');
    expect(Object.isFrozen(uncertain)).toBe(true);
    expect(Object.isFrozen(uncertain.patch)).toBe(true);
    await ordinary();
    expect(editor.snapshot().attempt).toBe(uncertain);
    const reread = editor.reload();
    await until(() => reads.length === 3, 'the uncertain reread');
    await ordinary();
    await act(async () => {
      reads[2]!.resolve({
        ok: false,
        status: 403,
        failure: { status: 403, code: 'platform_closed', retryable: false, requestId: 'current-read' },
      });
    });
    await reread;
    expect(editor.snapshot().readAuthority).toBe('denied');
    expect(editor.snapshot().failure?.requestId).toBe('current-read');
    await ordinary();
    await click(button(m.settings_profile_retry_save()));
    await until(() => writes.length === 3, 'the original uncertain retry');
    expect(writes[2]!.attempt).toBe(uncertain);
    expect(writes[2]!.token).toBe(token);
    await ordinary();
    await act(async () => {
      writes[2]!.result.resolve({ ok: true, profile: uncertain.after });
    });
    expect(reads).toHaveLength(3); // A denied reader cannot publish a receipt.
    expect(editor.snapshot().attempt).toBe(uncertain);
    const recovered = editor.reload();
    await until(() => reads.length === 4, 'explicit recovery');
    await resolveRead(3, {
      ...uncertain.after,
      publicViews: { ...uncertain.after.publicViews, realms: true },
      speakersListed: true,
    });
    await recovered;
    expect(editor.snapshot().attempt).toBeNull();
    expect(editor.snapshot().known?.speakersListed).toBe(true);
    expect(editor.snapshot().known?.publicViews.realms).toBe(true);

    // Useful avatar completion/cancellation/focus survives ordinary notifications.
    await chooseAvatar();
    await until(() => uploads.length === 1, 'current avatar upload');
    await ordinary();
    expect(uploads[0]!.signal.aborted).toBe(false);
    await act(async () => {
      uploads[0]!.result.resolve({ src: 'current-avatar' });
    });
    await until(() => editor.snapshot().draft?.avatar?.media === 'current-avatar', 'current avatar draft');
    const cancelAvatar = button(m.settings_profile_avatar_cancel());
    await click(cancelAvatar);
    expect(editor.snapshot().draft?.avatar).toBeNull();
    expect(window.document.activeElement?.textContent).toBe(m.settings_profile_choose_avatar());

    // Capture actual form and avatar closures and an outstanding departure before an equal success event.
    await chooseAvatar();
    await until(() => uploads.length === 2, 'avatar held across an equal success');
    const staleAvatar = handler(button(m.settings_profile_avatar_cancel()), 'onClick');
    const form = host.querySelector('form');
    if (!form) throw new Error('Missing current profile form');
    const oldSubmit = handler(form, 'onSubmit');
    await act(async () => editor.edit({ biography: 'Retired dirty draft' }));
    let navigation: Promise<unknown> | undefined;
    await act(async () => {
      navigation = router.navigate({ to: '/elsewhere' });
      await Promise.resolve();
    });
    await until(() => !!host.querySelector('[role="alertdialog"]'), 'the real departure decision');
    await ordinary();
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    const old = editor;
    const oldKey = privateQueries()[0]!.queryKey;
    const storedSession = client.getQueryData(sessionQuery.queryKey);
    const timestamp = client.getQueryState(sessionQuery.queryKey)!.dataUpdatedAt;
    const sends = writes.length;
    const currentReads = reads.length;
    const focused = window.document.activeElement;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { ...session() }, { updatedAt: timestamp });
      // These assertions precede React commit and must hold even though object identity/time are retained.
      expect(client.getQueryData(sessionQuery.queryKey)).toBe(storedSession);
      expect(old.snapshot().known).toBeNull();
      expect(old.snapshot().draft).toBeNull();
      expect(uploads[1]!.signal.aborted).toBe(true);
      expect(client.getQueryData(oldKey)).toBeUndefined();
      staleActions(old, oldSubmit);
      staleAvatar();
      queueMicrotask(() => {
        staleActions(old, oldSubmit);
        staleAvatar();
      });
      expect(window.document.activeElement).toBe(focused);
      expect(writes).toHaveLength(sends);
      expect(reads).toHaveLength(currentReads);
    });
    await navigation;
    expect(router.state.location.pathname).toBe('/settings');
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    editor = await ready(currentReads);
    expect(editor).not.toBe(old);
    expect(editor.snapshot().draft).toEqual(profile());
    await act(async () => {
      uploads[1]!.result.resolve({ src: 'retired-avatar' });
    });
    expect(editor.snapshot().draft?.avatar).toBeNull();
    expect(privateQueries()).toHaveLength(1);
    expect(client.getQueryData(oldKey)).toBeUndefined();

    // A fetched equal result also commits success with structural sharing; a pending uncertainty is terminal.
    await act(async () => editor.edit({ biography: 'Frozen prior attempt' }));
    const uncertainIndex = writes.length;
    const sending = editor.submit('profile');
    await until(() => writes.length === uncertainIndex + 1, 'a fresh uncertain command');
    await act(async () => {
      writes[uncertainIndex]!.result.reject(new Error('Response lost'));
    });
    await sending;
    const frozenAttempt = editor.snapshot().attempt;
    expect(frozenAttempt).not.toBeNull();
    const prior = editor;
    const fetchedSession = deferred<ReturnType<typeof session>>();
    const equalFetch = client.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: () => fetchedSession.promise });
    await ordinary();
    expect(prior.snapshot().attempt).toBe(frozenAttempt);
    const nextRead = reads.length;
    await act(async () => {
      fetchedSession.resolve(session());
      await equalFetch;
      expect(prior.snapshot().known).toBeNull();
      staleActions(prior);
    });
    editor = await ready(nextRead);
    expect(editor.snapshot().attempt).toBeNull();
    expect(writes).toHaveLength(uncertainIndex + 1);

    // A queued validation focus belongs to the submitting card, including the event-to-commit window.
    await act(async () => editor.edit({ displayName: 'x'.repeat(4097) }));
    const invalidForm = host.querySelector('form');
    const invalidName = host.querySelector('input[id$="-displayName"]');
    if (!invalidForm || !invalidName) throw new Error('Missing validation controls');
    let retiredFocus = 0;
    invalidName.focus = () => {
      retiredFocus++;
    };
    const invalidSubmit = handler(invalidForm, 'onSubmit');
    const validationRead = reads.length;
    const validationSends = writes.length;
    await act(async () => {
      invalidSubmit({ preventDefault() {} });
      client.setQueryData(sessionQuery.queryKey, session());
      invalidSubmit({ preventDefault() {} });
    });
    editor = await ready(validationRead);
    expect(retiredFocus).toBe(0);
    expect(writes).toHaveLength(validationSends);

    // Complete the cross-product of original continuations and supported retirement boundaries.
    // Late success and refusal settle both before and after successor admission; neither can steal pending state.
    for (const boundary of ['equal', 'error', 'removal', 'signed-out', 'null', 'aba', 'provider'] as const) {
      for (const operation of ['read', 'save', 'readback', 'uncertain-read', 'upload', 'cancel'] as const) {
        const originalClient = client;
        const originalEditor = editor;
        const originalKey = privateQueries()[0]!.queryKey;
        const form = host.querySelector('form');
        if (!form) throw new Error(`Missing form for ${boundary}/${operation}`);
        const renderedSubmit = handler(form, 'onSubmit');
        const chooser = host.querySelector('input[type="file"]');
        if (!chooser) throw new Error('Missing avatar input');
        const renderedChoose = handler(chooser, 'onChange');
        const gif = new window.File(['gif'], 'old.gif', { type: 'image/gif' });
        const queuedOldActions = () => {
          staleActions(originalEditor, renderedSubmit);
          renderedChoose({ target: { files: [gif], value: '' } });
        };
        let pending: Promise<void> | undefined;
        let heldRead: number | undefined;
        let heldWrite: number | undefined;
        let heldUpload: number | undefined;
        let cancelCompletion: ReturnType<typeof deferred<void>> | undefined;
        let restoreCancel: (() => void) | undefined;
        await act(async () => originalEditor.edit({ biography: `Old ${operation} intent` }));
        if (operation === 'read' || operation === 'uncertain-read') {
          if (operation === 'uncertain-read') {
            const index = writes.length;
            const send = originalEditor.submit('profile');
            await until(() => writes.length === index + 1, 'the held original intent');
            await act(async () => {
              writes[index]!.result.resolve({
                ok: false,
                status: 503,
                message: '',
                failure: { status: 503, retryable: true },
              });
            });
            await send;
            expect(originalEditor.snapshot().attempt).not.toBeNull();
          }
          heldRead = reads.length;
          pending = originalEditor.reload();
          await until(() => reads.length === heldRead! + 1, 'the held original read');
        } else if (operation === 'save' || operation === 'readback') {
          const index = writes.length;
          pending = originalEditor.submit('profile');
          await until(() => writes.length === index + 1, 'the held original save');
          if (operation === 'save') heldWrite = index;
          else {
            heldRead = reads.length;
            await act(async () => {
              writes[index]!.result.resolve({ ok: true, profile: writes[index]!.attempt.after });
            });
            await until(() => reads.length === heldRead! + 1, 'the held original confirmation');
          }
        } else if (operation === 'upload') {
          heldUpload = uploads.length;
          await chooseAvatar();
          await until(() => uploads.length === heldUpload! + 1, 'the held old upload');
        } else {
          // Preserve the actual cancellation and pause only its returned continuation, just before native send.
          const cancelQueries = originalClient.cancelQueries.bind(originalClient);
          cancelCompletion = deferred<void>();
          originalClient.cancelQueries = async (...args: Parameters<typeof cancelQueries>) => {
            await cancelQueries(...args);
            await cancelCompletion!.promise;
          };
          restoreCancel = () => {
            originalClient.cancelQueries = cancelQueries;
          };
          heldWrite = writes.length;
          pending = originalEditor.submit('profile');
          await Promise.resolve();
          expect(writes).toHaveLength(heldWrite);
        }
        const beforeReads = reads.length;
        const beforeWrites = writes.length;
        const beforeUploads = uploads.length;
        const terminal = () => {
          expect(originalEditor.isActive()).toBe(false);
          expect(originalEditor.snapshot().known).toBeNull();
          expect(originalEditor.snapshot().draft).toBeNull();
          expect(originalEditor.snapshot().attempt).toBeNull();
          expect(originalClient.getQueryData(originalKey)).toBeUndefined();
          if (heldUpload !== undefined) expect(uploads[heldUpload]!.signal.aborted).toBe(true);
          queuedOldActions();
          expect(writes).toHaveLength(beforeWrites);
          expect(uploads).toHaveLength(beforeUploads);
        };
        const cleanupBefore = probeCleanups;
        let windowObserved = false;
        if (boundary === 'provider') {
          client = makeClient();
          beforeCommit = () => {
            // The new hook has rendered; old effects have not cleaned up. Invoke old rendered callbacks now.
            expect(probeCleanups).toBe(cleanupBefore);
            terminal();
            windowObserved = true;
          };
          await render();
          expect(windowObserved).toBe(true);
        } else {
          await act(async () => {
            if (boundary === 'equal') {
              client.setQueryData(sessionQuery.queryKey, session(), {
                updatedAt: client.getQueryState(sessionQuery.queryKey)!.dataUpdatedAt,
              });
            } else if (boundary === 'error') {
              sessionRecord().setState({
                status: 'error',
                error: new Error('Session unavailable'),
                fetchStatus: 'idle',
              });
            } else if (boundary === 'removal') {
              client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
              terminal();
              // Restore the prepared boundary before the shared session observer can initiate a native read.
              client.setQueryData(sessionQuery.queryKey, session());
            } else if (boundary === 'signed-out') {
              client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
            } else if (boundary === 'null') {
              client.setQueryData(sessionQuery.queryKey, session(accountId, null));
            } else {
              client.setQueryData(sessionQuery.queryKey, session(otherId, 'other-private-token'));
              terminal();
              client.setQueryData(sessionQuery.queryKey, session());
            }
            terminal();
            queueMicrotask(queuedOldActions);
            expect(reads).toHaveLength(beforeReads);
          });
        }
        restoreCancel?.();
        if (boundary === 'error' || boundary === 'signed-out') {
          await act(async () => client.setQueryData(sessionQuery.queryKey, session()));
        }
        await until(() => reads.length === beforeReads + 1, 'the successor private read');
        const successor = latest.editor;
        expect(successor).not.toBe(originalEditor);
        expect(successor.snapshot().known).toBeNull();
        expect(successor.snapshot().attempt).toBeNull();
        terminal();
        const settleOld = async (refused: boolean) => {
          await act(async () => {
            if (heldRead !== undefined) {
              reads[heldRead]!.resolve(
                refused
                  ? { ok: false, status: 403, failure: { status: 403, code: 'platform_closed' } }
                  : { ok: true, profile: { ...profile(), biography: 'Late old read' } },
              );
            }
            if (heldWrite !== undefined && operation !== 'cancel') {
              writes[heldWrite]!.result.resolve(
                refused
                  ? { ok: false, status: 503, message: 'Old refusal', failure: { status: 503 } }
                  : { ok: true, profile: writes[heldWrite]!.attempt.after },
              );
            }
            if (heldUpload !== undefined) {
              if (refused) uploads[heldUpload]!.result.reject(new Error('Late old upload refusal'));
              else uploads[heldUpload]!.result.resolve({ src: 'late-old-avatar' });
            }
            cancelCompletion?.resolve();
            await pending;
          });
        };
        const lateAfterAdmission = operation === 'save' || operation === 'readback' || operation === 'cancel';
        if (!lateAfterAdmission) {
          await settleOld(boundary === 'error' || boundary === 'signed-out' || boundary === 'provider');
          expect(successor.snapshot().known).toBeNull();
          expect(successor.snapshot().failure).toBeUndefined();
        }
        await resolveRead(beforeReads);
        await until(() => successor.snapshot().readAuthority === 'allowed', 'the successor matching response');
        expect(successor.snapshot().draft).toEqual(profile());
        const successorKey = privateQueries()[0]!.queryKey;
        const successorSubmit = handler(host.querySelector('form')!, 'onSubmit');
        // Start fresh pending work before an old finally settles. It must remain exclusively owned by the successor.
        let successorPending: Promise<void> | undefined;
        let successorWrite: number | undefined;
        if (boundary !== 'null') {
          await act(async () => successor.edit({ biography: 'Successor pending draft' }));
          successorWrite = writes.length;
          successorPending = successor.submit('profile');
          await until(() => writes.length === successorWrite! + 1, 'the successor pending write');
          expect(writes[successorWrite]!.token).toBe(token);
        } else {
          expect(latest.readable).toBe(true);
          expect(latest.writable).toBe(false);
          const snapshot = successor.snapshot();
          successor.edit({ biography: 'Read-only refused edit' });
          await successor.submit('profile');
          await successor.retry();
          expect(successor.snapshot()).toBe(snapshot);
        }
        if (lateAfterAdmission) await settleOld(boundary === 'error' || boundary === 'null' || boundary === 'provider');
        const snapshot = successor.snapshot();
        const sendsAfterSuccessor = writes.length;
        await act(async () => {
          queuedOldActions();
          await Promise.resolve();
        });
        expect(writes).toHaveLength(sendsAfterSuccessor);
        expect(successor.snapshot()).toBe(snapshot);
        expect(client.getQueryData(successorKey)).toEqual(profile());
        expect(originalClient.getQueryData(originalKey)).toBeUndefined();
        expect(privateQueries()).toHaveLength(1);
        if (successorWrite !== undefined) {
          expect(successor.snapshot().phase).toBe('saving');
          expect(successor.snapshot().attempt).toBe(writes[successorWrite]!.attempt);
          // A duplicate current submit must still be refused after the retired finally has run.
          successorSubmit({ preventDefault() {} });
          await successor.submit('profile');
          expect(writes).toHaveLength(sendsAfterSuccessor);
          await act(async () => {
            writes[successorWrite]!.result.resolve({ ok: false, status: 409, message: '', failure: { status: 409 } });
          });
          await successorPending;
          expect(successor.snapshot().phase).toBe('refused');
          expect(successor.snapshot().attempt).toBeNull();
          expect(successor.snapshot().draft?.biography).toBe('Successor pending draft');
        }
        editor = successor;
        if (boundary === 'null') {
          const next = reads.length;
          await act(async () => client.setQueryData(sessionQuery.queryKey, session()));
          expect(successor.snapshot().known).toBeNull();
          editor = await ready(next);
        }
        expect(listenerCounts.get(client)!.active).toBe(1);
        if (originalClient !== client) expect(listenerCounts.get(originalClient)!.active).toBe(0);
      }
    }

    // A fresh read for the wrong prepared account never admits even valid profile fields.
    let next = reads.length;
    await act(async () => client.setQueryData(sessionQuery.queryKey, session()));
    await until(() => reads.length === next + 1, 'the wrong-account response window');
    const mismatched = latest.editor;
    await resolveRead(next, profile(otherId));
    await until(() => mismatched.snapshot().phase === 'unavailable', 'the immutable prepared-account refusal');
    expect(mismatched.snapshot().known).toBeNull();
    expect(mismatched.snapshot().draft).toBeNull();
    next = reads.length;
    const recovery = mismatched.reload();
    await until(() => reads.length === next + 1, 'the explicit matching recovery');
    await resolveRead(next);
    await recovery;
    expect(mismatched.snapshot().known).toEqual(profile());

    // Final detach forbids direct and queued actions immediately; remount cannot promote the prior cache or draft.
    const finalOwner = latest.editor;
    const finalKey = privateQueries()[0]!.queryKey;
    const finalRead = reads.length;
    const finalReload = finalOwner.reload();
    await until(() => reads.length === finalRead + 1, 'the final held read');
    await act(async () => {
      root!.unmount();
      root = undefined;
      staleActions(finalOwner);
      queueMicrotask(() => staleActions(finalOwner));
    });
    expect(finalOwner.isActive()).toBe(false);
    expect(listenerCounts.get(client)!.active).toBe(0);
    expect(client.getQueryData(finalKey)).toBeUndefined();
    root = createRoot(host as unknown as HTMLElement);
    next = reads.length;
    await render();
    await until(() => reads.length === next + 1, 'the remounted fresh read');
    expect(latest.editor).not.toBe(finalOwner);
    await resolveRead(finalRead, { ...profile(), biography: 'Late final read' });
    await finalReload;
    expect(latest.editor.snapshot().known).toBeNull();
    const remounted = await ready(next);
    expect(remounted.snapshot().draft).toEqual(profile());
    await act(async () => root!.unmount());
    root = undefined;
    expect(listenerCounts.get(client)!.active).toBe(0);
    expect(privateQueries()).toHaveLength(0);
    expect(createdUrls.toSorted()).toEqual(revokedUrls.toSorted());
    for (const target of clients) {
      expect(listenerCounts.get(target)!.peak).toBe(1);
      expect(listenerCounts.get(target)!.active).toBe(0);
      expect(
        JSON.stringify(
          target
            .getQueryCache()
            .getAll()
            .map((record) => record.queryKey),
        ),
      ).not.toContain(token);
    }
  } finally {
    if (root) await act(async () => root!.unmount());
    for (const client of clients) client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
}, 120_000);
