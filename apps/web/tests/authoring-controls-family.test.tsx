import { expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement, useLayoutEffect, useState } from 'react';
import type { DocumentSnapshot } from '@rezics/document';
import type { CurrentPost, EditFailure, RevisedPost, WriteFailure } from '../src/threads/actions';
import type { ReplyCommand } from '../src/threads/reply-context-intent';
import type { DraftMediaState } from '../src/threads/media-state';
import recorded from '../src/kernel/recorded/thread-owned.json';
import de from '../messages/de.json';

// Authored mounted acceptance, UNRUN in this worker. DOM classes are not measured browser geometry;
// supplied adapters prove no native admission, privacy, population growth or physical request custody.
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
type Context = { kind: 'discussion'; subjectIds: string[] };
type EditCommand = { body: DocumentSnapshot; mediaIds: string[]; revisionId: string; idempotencyKey: string };
type Command = ReplyCommand<Context> | EditCommand;
type Receipt = { id: string };
type Outcome = { ok: true; value: Receipt; post: RevisedPost } | WriteFailure | EditFailure;
type Configuration = {
  name: string;
  kind: 'opening' | 'reply' | 'inline';
  body: DocumentSnapshot;
  parent?: string | null;
  mediaIds?: string[];
  context?: Context;
};

test('actual authoring family keeps form operands, recovery, independent instances and retired-result fences with long localized text', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/de/compose', width: 390, height: 844 });
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
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { PostComposer, InlinePostEditor } = await import('../src/threads/composer');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { sessionQuery } = await import('../src/session/query');
  const { fromPlainText, documentText } = await import('@rezics/document');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const mediaState = await import('../src/threads/media-state');
  const upload = await import('../src/threads/upload');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const originalLocale = getLocale();
  setLocale('de', { reload: false });
  const longText = de.thread_media_state_unavailable;
  const longAlt = `${longText} ${'Wiederherstellungsbeschreibung'.repeat(5)}`;
  const body = fromPlainText(longText, 'blocks');
  const owner = {
    state: 'signed-in' as const,
    subject: recorded.thread.authorId,
    csrfToken: 'authoring-family-session',
  };
  const context: Context = { kind: 'discussion', subjectIds: [] };
  const accepted = { id: recorded.thread.id };
  const revised = { ...recorded.thread.firstPost, body } as RevisedPost;
  const success: Outcome = { ok: true, value: accepted, post: revised };
  const mediaIds = Array.from({ length: 6 }, (_, n) => id(75 + n));
  const imageNodes = mediaIds.map((imageId, n) => ({
    type: 'image',
    attrs: { id: `recovery-${n}`, src: `/media/${imageId}/original`, alt: longAlt },
  }));
  const withImages: DocumentSnapshot = {
    ...body,
    doc: { ...body.doc, content: [...body.doc.content!, ...imageNodes] },
  };
  const states: DraftMediaState[] = mediaIds.map((imageId, n) => ({
    id: imageId,
    state: (['missing', 'rejected', 'unavailable', 'reserved', 'uploaded', 'available'] as const)[n]!,
  }));
  const checks: { data: string[]; signal: AbortSignal; result: ReturnType<typeof gate<DraftMediaState[]>> }[] = [];
  const checkSpy = spyOn(mediaState, 'checkDraftMediaStates').mockImplementation((input) => {
    const result = gate<DraftMediaState[]>();
    checks.push({ data: input.data, signal: input.signal!, result });
    return result.promise;
  });
  const uploads: {
    target: unknown;
    file: File;
    signal: AbortSignal;
    result: ReturnType<typeof gate<{ src: string; width: number; height: number }>>;
  }[] = [];
  const uploadSpy = spyOn(upload, 'uploadReplyImage').mockImplementation((target, file, signal) => {
    const result = gate<{ src: string; width: number; height: number }>();
    uploads.push({ target, file, signal, result });
    return result.promise;
  });
  const reads: { path: string; init: RequestInit; result: ReturnType<typeof gate<Response>> }[] = [];
  // The existing media transport seam: only deliberate original-image reads, no invented endpoint.
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (!/^\/media\/[0-9a-f-]+\/original$/.test(path)) throw new Error(`Unexpected request: ${path}`);
    const result = gate<Response>();
    reads.push({ path, init: init!, result });
    // Ignore abort intentionally: the real component must reject a retired late response itself.
    return result.promise;
  };
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(fetcher, { preconnect() {} }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let client: InstanceType<typeof QueryClient> | undefined;
  let update!: (next: Configuration[]) => void;
  let calls: { name: string; input: Command; snapshot: Command; result: ReturnType<typeof gate<Outcome>> }[] = [];
  let successes: { name: string; args: unknown[] }[] = [];
  let cancels: { name: string; args: unknown[] }[] = [];
  let pending: boolean[] = [];
  let locks: boolean[] = [];
  const fallbacks: HTMLElement[] = [];
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const region = (name: string) => host.querySelector<HTMLElement>(`[data-instance="${name}"]`)!;
  const button = (name: string, label: string) => {
    const found = [...region(name).querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent?.trim() === label,
    );
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (name: string, label: string) => act(async () => user.click(button(name, label)));
  const submitTwice = async (name: string) =>
    act(async () => {
      const form = region(name).querySelector('form')!;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const ownControl = (control: HTMLElement) => {
    for (const token of [
      'h-auto',
      'min-h-11',
      'min-w-11',
      'whitespace-normal',
      '[overflow-wrap:anywhere]',
      'focus-visible:ring-2',
      'focus-visible:ring-ring',
      'focus-visible:ring-offset-2',
    ])
      expect(control.classList.contains(token)).toBe(true);
    expect(control.classList.contains('whitespace-nowrap')).toBe(false);
    control.focus();
    expect(window.document.activeElement).toBe(control);
  };
  const wrapped = (element: Element) => {
    expect(element.classList.contains('min-w-0')).toBe(true);
    expect(element.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
  };
  const finish = async (index: number, outcome: Outcome) =>
    act(async () => {
      calls[index]!.result.resolve(outcome);
    });
  const mount = async (configs: Configuration[]) => {
    await act(async () => root.render(null));
    client?.clear();
    calls = [];
    successes = [];
    cancels = [];
    pending = [];
    locks = [];
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, owner);
    function Page() {
      const [current, setCurrent] = useState(configs);
      update = setCurrent;
      // Observe the actual initial fallback before the installed editor's passive initialization.
      useLayoutEffect(() => {
        fallbacks.push(...host.querySelectorAll<HTMLElement>('.thread-opening-fallback, .thread-reply-fallback'));
      }, []);
      return (
        <AuthoringDepartureProvider>
          {current.map((config) => {
            const onSubmit = (input: Command) => {
              const result = gate<Outcome>();
              calls.push({ name: config.name, input, snapshot: structuredClone(input), result });
              return result.promise;
            };
            const onSuccess = (...args: unknown[]) => {
              successes.push({ name: config.name, args });
            };
            return (
              <section key={config.name} data-instance={config.name}>
                {config.kind === 'inline' ? (
                  <InlinePostEditor
                    initialBody={config.body}
                    {...(config.mediaIds === undefined ? {} : { initialMediaIds: config.mediaIds })}
                    containerId={recorded.thread.id}
                    revisionId={recorded.thread.firstPost.revisionId}
                    idempotencyKey={id(10)}
                    onSubmit={
                      onSubmit as (input: EditCommand) => Promise<{ ok: true; post: RevisedPost } | EditFailure>
                    }
                    onSuccess={onSuccess}
                    onCancel={(...args) => {
                      cancels.push({ name: config.name, args });
                    }}
                  />
                ) : (
                  <PostComposer
                    initialBody={config.body}
                    initialKey={id(config.kind === 'opening' ? 11 : 12)}
                    {...(config.kind === 'opening'
                      ? { titleRequired: true, boardId: recorded.thread.boardId }
                      : { containerId: recorded.thread.id })}
                    {...(config.parent === undefined ? {} : { replyTargetId: config.parent })}
                    {...(config.context === undefined ? {} : { submissionContext: config.context })}
                    onSubmit={
                      onSubmit as (input: ReplyCommand<Context>) => Promise<{ ok: true; value: Receipt } | WriteFailure>
                    }
                    onSuccess={onSuccess}
                    onPendingChange={(value) => pending.push(value)}
                    onIntentLockChange={(value) => locks.push(value)}
                  />
                )}
              </section>
            );
          })}
        </AuthoringDepartureProvider>
      );
    }
    const route = createRootRoute({ component: Outlet });
    const compose = createRoute({ getParentRoute: () => route, path: '/compose', component: Page });
    const router = createRouter({
      routeTree: route.addChildren([compose]),
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
    await settle(() =>
      configs.every((config) => !!region(config.name)?.querySelector('.ProseMirror[contenteditable="true"]')),
    );
  };
  const originalResponse = () =>
    new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });

  try {
    // Two real independent instances: keep the frozen title oracle and each useId form association.
    const opening: Configuration = { name: 'opening', kind: 'opening', body, context };
    const reply: Configuration = { name: 'reply', kind: 'reply', body, parent: recorded.thread.firstPost.id, context };
    await mount([opening, reply]);
    expect(m.thread_media_state_unavailable()).toBe(longText);
    expect(fallbacks.length).toBeGreaterThanOrEqual(2);
    for (const fallback of fallbacks) {
      expect(fallback.getAttribute('role')).toBe('textbox');
      expect(fallback.getAttribute('aria-multiline')).toBe('true');
      expect(fallback.getAttribute('contenteditable')).toBe('true');
      wrapped(fallback);
    }
    const title = region('opening').querySelector<HTMLInputElement>('#thread-title')!;
    const sendOpening = button('opening', m.thread_write_send());
    const sendReply = button('reply', m.thread_write_send());
    expect(region('opening').querySelector('label')!.htmlFor).toBe('thread-title');
    expect(title.form).toBe(region('opening').querySelector('form'));
    expect(sendOpening.form).toBe(title.form);
    expect(sendReply.form).toBe(region('reply').querySelector('form'));
    expect(sendOpening.form!.id).not.toBe(sendReply.form!.id);
    expect(sendOpening.disabled).toBe(true);
    await submitTwice('opening');
    expect(calls).toHaveLength(0);
    await act(async () => user.type(title, `  ${longText}  `));
    expect(sendOpening.disabled).toBe(false);
    // Supplied long text plus a second mounted instance adds no read or callback before an action.
    expect(calls).toHaveLength(0);
    expect(reads).toHaveLength(0);
    expect(checks).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    for (const send of [sendOpening, sendReply]) {
      ownControl(send);
      expect(send.classList.contains('disabled:opacity-100')).toBe(true);
      expect(send.classList.contains('max-w-[min(24rem,50cqi)]')).toBe(true);
    }
    wrapped(region('opening').firstElementChild!);
    await submitTwice('opening');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.snapshot).toEqual({
      title: `  ${longText}  `,
      body,
      mediaIds: [],
      submissionContext: context,
      idempotencyKey: id(11),
    });
    expect(sendOpening.disabled).toBe(true);
    expect(sendReply.disabled).toBe(false);
    await finish(0, success);
    expect(successes).toEqual([{ name: 'opening', args: [accepted] }]);
    expect(successes[0]!.args[0]).toBe(accepted);
    expect(title.value).toBe('');
    expect(documentText(body)).toBe(longText);

    // Unknown results lock the exact parent, body, context, media and UUID until an immutable replay.
    await submitTwice('reply');
    expect(calls).toHaveLength(2);
    const firstReply = calls[1]!;
    expect(firstReply.snapshot).toEqual({
      title: '',
      body,
      mediaIds: [],
      submissionContext: context,
      idempotencyKey: firstReply.snapshot.idempotencyKey,
      parentId: reply.parent,
    });
    expect(firstReply.snapshot.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await finish(1, { ok: false, reason: 'unavailable' });
    ownControl(button('reply', m.thread_write_retry()));
    await act(async () => update([opening, { ...reply, parent: id(99) }]));
    expect(button('reply', m.thread_write_send()).disabled).toBe(true);
    expect(
      [...region('reply').querySelectorAll('button')].some((item) => item.textContent === m.thread_write_retry()),
    ).toBe(false);
    expect(region('reply').textContent).toContain(m.thread_write_uncertain_changed());
    await submitTwice('reply');
    expect(calls).toHaveLength(2);
    await act(async () => update([opening, reply]));
    await submitTwice('reply');
    expect(calls).toHaveLength(3);
    expect(calls[2]!.input).toBe(firstReply.input);
    expect(calls[2]!.snapshot).toEqual(firstReply.snapshot);
    await finish(2, success);
    expect(successes).toEqual([
      { name: 'opening', args: [accepted] },
      { name: 'reply', args: [accepted] },
    ]);
    expect(successes[1]!.args[0]).toBe(accepted);
    expect(pending).toEqual([true, false, true, false, true, false]);
    expect(locks).toEqual([true, false, true, true, true, false]);
    expect(reads).toHaveLength(0);
    expect(checks).toHaveLength(0);
    expect(uploads).toHaveLength(0);

    // Known refusals keep draft/parent and the supplied exact existing-review destination.
    const failures: WriteFailure[] = [
      { ok: false, reason: 'conflict', existingReviewId: recorded.thread.id },
      { ok: false, reason: 'rate-limited', retryAfter: 3600 },
      { ok: false, reason: 'forbidden' },
    ];
    for (const failure of failures) {
      const config = failure.existingReviewId ? opening : reply;
      await mount([config]);
      if (config.kind === 'opening')
        await act(async () => user.type(region(config.name).querySelector('#thread-title')!, longText));
      await submitTwice(config.name);
      const original = calls[0]!.snapshot;
      await finish(0, failure);
      expect(calls).toHaveLength(1);
      const alert = region(config.name).querySelector('[role="alert"]')!;
      wrapped(alert);
      expect(successes).toHaveLength(0);
      expect(documentText(original.body)).toBe(longText);
      if (failure.existingReviewId) {
        const link = alert.querySelector('a')!;
        expect(link.getAttribute('href')).toBe(`/de/threads/${failure.existingReviewId}`);
        expect(link.textContent).toBe(m.thread_review_existing());
        // The notice owns this link; the composer must not style its descendants.
        expect(link.classList.contains('min-h-11')).toBe(false);
      } else {
        expect(alert.textContent).toContain(
          failure.reason === 'rate-limited'
            ? m.thread_write_rate_limited({ seconds: 3600 })
            : m.thread_write_forbidden(),
        );
        ownControl(button(config.name, m.thread_write_retry()));
        await click(config.name, m.thread_write_retry());
        expect(calls).toHaveLength(2);
        expect(calls[1]!.snapshot).toEqual(original);
        await finish(1, success);
        expect(successes[0]!.args).toEqual([accepted]);
      }
    }

    // Save/cancel/stale-load-current use the supplied post directly, without a hidden reread.
    const inline: Configuration = { name: 'inline', kind: 'inline', body };
    await mount([inline]);
    ownControl(button('inline', m.thread_edit_save()));
    ownControl(button('inline', m.thread_edit_cancel()));
    await click('inline', m.thread_edit_cancel());
    expect(cancels).toEqual([{ name: 'inline', args: [] }]);
    expect(calls).toHaveLength(0);
    await mount([inline]);
    await submitTwice('inline');
    expect(calls[0]!.snapshot).toEqual({
      body,
      revisionId: recorded.thread.firstPost.revisionId,
      idempotencyKey: id(10),
      mediaIds: [],
    });
    expect(button('inline', m.thread_edit_cancel()).disabled).toBe(true);
    await click('inline', m.thread_edit_cancel());
    expect(cancels).toHaveLength(0);
    const currentBody: DocumentSnapshot = {
      ...body,
      doc: { ...body.doc, content: [...body.doc.content!, imageNodes[0]!] },
    };
    const currentPost = {
      ...recorded.thread.firstPost,
      revisionId: id(50),
      body: currentBody,
      mediaIds: [mediaIds[0]!],
    } as CurrentPost;
    await finish(0, { ok: false, reason: 'stale', currentPost });
    ownControl(button('inline', m.thread_edit_load_current()));
    await click('inline', m.thread_edit_load_current());
    expect(region('inline').querySelector('[role="alert"]')).toBeNull();
    expect(reads).toHaveLength(0);
    await submitTwice('inline');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.snapshot).toEqual({
      body: currentBody,
      revisionId: id(50),
      mediaIds: [mediaIds[0]],
      idempotencyKey: calls[1]!.snapshot.idempotencyKey,
    });
    expect(calls[1]!.snapshot.idempotencyKey).not.toBe(id(10));
    await finish(1, success);
    expect(successes).toEqual([{ name: 'inline', args: [revised] }]);
    expect(successes[0]!.args[0]).toBe(revised);
    await mount([inline]);
    await submitTwice('inline');
    await finish(0, { ok: false, reason: 'unavailable' });
    await submitTwice('inline');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.snapshot).toEqual(calls[0]!.snapshot);
    await finish(1, { ok: false, reason: 'unavailable' });
    await click('inline', m.thread_edit_cancel());
    expect(cancels).toHaveLength(0);
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(m.thread_authoring_discard_pending());
    const discard = [...dialog.querySelectorAll('button')].find(
      (item) => item.textContent === m.thread_authoring_discard(),
    )!;
    await act(async () => user.click(discard));
    expect(cancels).toEqual([{ name: 'inline', args: [] }]);
    expect(successes).toHaveLength(0);

    // Complete media recovery family with localized, unbroken descriptions and unchanged callback counts.
    await mount([{ ...inline, body: withImages }]);
    expect(reads).toHaveLength(0);
    expect(checks).toHaveLength(0);
    expect(uploads).toHaveLength(0);
    await submitTwice('inline');
    expect(calls[0]!.snapshot).toEqual({
      body: withImages,
      revisionId: recorded.thread.firstPost.revisionId,
      idempotencyKey: id(10),
      mediaIds,
    });
    await finish(0, { ok: false, reason: 'media-unavailable', media: states });
    const list = region('inline').querySelector('ul[aria-label]')!;
    wrapped(list);
    expect(list.querySelectorAll('li')).toHaveLength(6);
    for (const text of [de.thread_media_missing, de.thread_media_rejected, longText, de.thread_media_used])
      expect(list.textContent).toContain(text);
    for (const row of list.querySelectorAll('li')) {
      wrapped(row);
      wrapped(row.querySelector('span')!);
      expect(row.textContent).toContain(longAlt);
      for (const control of row.querySelectorAll<HTMLElement>('button')) ownControl(control);
    }
    await click('inline', m.thread_media_check_again());
    expect(checks).toHaveLength(1);
    expect(checks[0]!.data).toEqual(mediaIds);
    expect(button('inline', m.thread_media_check_again()).disabled).toBe(true);
    await act(async () => checks[0]!.result.resolve(states));
    await click('inline', m.thread_media_upload_again());
    expect(reads).toHaveLength(1);
    expect(reads[0]!.path).toBe(`/media/${mediaIds[5]}/original`);
    expect(reads[0]!.init.credentials).toBe('same-origin');
    expect(button('inline', m.thread_edit_save()).disabled).toBe(true);
    await submitTwice('inline');
    expect(calls).toHaveLength(1);
    await act(async () => reads[0]!.result.resolve(originalResponse()));
    await settle(() => uploads.length === 1);
    expect(uploads[0]!.target).toBe(recorded.thread.id);
    expect(uploads[0]!.file.name).toBe('pasted-image');
    expect(uploads[0]!.file.type).toBe('image/png');
    expect(uploads[0]!.file.size).toBe(4);
    expect(uploads[0]!.signal.aborted).toBe(false);
    await act(async () => uploads[0]!.result.resolve({ src: id(90), width: 1, height: 1 }));
    // Remove each unusable original using the module's actual row action; the successful copy stays attached.
    for (let n = 0; n < 5; n++) await click('inline', m.thread_media_remove());
    expect(region('inline').querySelector('ul[aria-label]')).toBeNull();
    await submitTwice('inline');
    expect(calls).toHaveLength(2);
    const recoveredBody = {
      ...body,
      doc: {
        ...body.doc,
        content: [...body.doc.content!, { ...imageNodes[5], attrs: { ...imageNodes[5]!.attrs, src: id(90) } }],
      },
    };
    expect(calls[1]!.snapshot).toEqual({
      body: recoveredBody,
      revisionId: recorded.thread.firstPost.revisionId,
      mediaIds: [id(90)],
      idempotencyKey: calls[1]!.snapshot.idempotencyKey,
    });
    await finish(1, { ok: false, reason: 'unavailable' });
    await submitTwice('inline');
    expect(calls).toHaveLength(3);
    expect(calls[2]!.snapshot).toEqual(calls[1]!.snapshot);
    await finish(2, success);
    expect(successes[0]!.args[0]).toBe(revised);
    expect(checks).toHaveLength(1);
    expect(reads).toHaveLength(1);
    expect(uploads).toHaveLength(1);

    // Pending original copy locks a reply; target replacement retires the read without a late upload.
    const oneImage = { ...body, doc: { ...body.doc, content: [...body.doc.content!, imageNodes[0]!] } };
    await mount([{ ...reply, body: oneImage }]);
    expect(reads).toHaveLength(2);
    expect(button('reply', m.thread_write_send()).disabled).toBe(true);
    await submitTwice('reply');
    expect(calls).toHaveLength(0);
    const lateRead = reads[1]!;
    await mount([reply]);
    expect(lateRead.init.signal!.aborted).toBe(true);
    await act(async () => lateRead.result.resolve(originalResponse()));
    expect(uploads).toHaveLength(1);
    expect(button('reply', m.thread_write_send()).disabled).toBe(false);
    // Also fence a non-cooperative command and manual check across a session away/back transition.
    await submitTwice('reply');
    const lateCommand = calls[0]!;
    await act(async () => {
      client!.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
      client!.setQueryData(sessionQuery.queryKey, owner);
      lateCommand.result.resolve(success);
    });
    expect(successes).toHaveLength(0);
    expect(region('reply').querySelector('form')).toBeNull();
    expect(region('reply').textContent).toContain(m.thread_authoring_session_changed());
    await mount([inline]);
    await submitTwice('inline');
    const lateEdit = calls[0]!;
    await mount([inline]);
    await act(async () => lateEdit.result.resolve(success));
    expect(successes).toHaveLength(0);
    expect(cancels).toHaveLength(0);
    expect(calls).toHaveLength(0);
    await mount([{ ...inline, body: withImages }]);
    await submitTwice('inline');
    await finish(0, { ok: false, reason: 'media-unavailable', media: states });
    await click('inline', m.thread_media_check_again());
    const lateCheck = checks[1]!;
    await mount([inline]);
    expect(lateCheck.signal.aborted).toBe(true);
    await act(async () => lateCheck.result.resolve(states));
    expect(region('inline').querySelector('[role="alert"]')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(successes).toHaveLength(0);
    expect(reads).toHaveLength(2);
    expect(uploads).toHaveLength(1);
    expect(checks).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    client?.clear();
    checkSpy.mockRestore();
    uploadSpy.mockRestore();
    setLocale(originalLocale, { reload: false });
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
