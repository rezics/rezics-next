import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { LibraryRestoreResult, ReloadedLibraryEntry } from '../src/library/entries-read';

// UNRUN: mounted/native-shaped regressions authored for receiving integration.
// happy-dom supplies interaction semantics, never physical target or wrapping proof.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const subjectId = 'book-one';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const receipt = { subjectId, deletionId: 'undo-ok', revision: 12 };
const returnTo = '/en/subjects/book-one/a-book?realm=original&cursor=opaque%2Bnext';
const title = `A supplied multilingual title 日本語 — ${'UnbrokenTitle'.repeat(35)}`;
const stateLabel = `0 — ${'SuppliedState'.repeat(30)}`;
const entry: ReloadedLibraryEntry = {
  subjectId,
  state: 'native-state',
  stateLabel,
  revision: 7,
  incarnationId,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  subject: { id: subjectId, label: { value: title, language: 'ja' }, type: 'book', types: ['book'], cover: null },
};

test('actual POST controls preserve operands, keyboard order, result facts and admission retirement without incidental requests', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://rezics.test${returnTo}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
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
  const originalFetch = globalThis.fetch;
  const incidental: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => {
    incidental.push(args);
    throw new Error('Rendering or focusing entry forms must not make a request');
  }) as typeof fetch;
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { EntryRemoveForm, EntryUndoForm, EntryRestoreFeedback, EntryFormPage } =
    await import('../src/library/entry-undo');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const locale = getLocale();
  setLocale('en', { reload: false });
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: [returnTo] }),
  });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const admitted = ['personal_library', 'library_entry.restore'];
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: 'session-csrf' });
  client.setQueryData(['exposure', 'anonymous'], admitted);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const show = (children: ReactNode) =>
    act(async () =>
      root.render(
        <RouterContextProvider router={router}>
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RouterContextProvider>,
      ),
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const formFields = (form: HTMLFormElement) => [...new window.FormData(form as never).entries()];
  const button = () => host.querySelector('button')! as unknown as HTMLButtonElement;
  const expectTargetStyles = (target: HTMLElement) => {
    for (const name of ['min-h-11', 'min-w-11', 'max-w-full', 'whitespace-normal', 'focus-visible:outline-2'])
      expect(target.classList.contains(name)).toBe(true);
    expect(target.classList.contains('h-7')).toBe(false);
    expect(target.classList.contains('whitespace-nowrap')).toBe(false);
  };
  const submitted: { form: HTMLFormElement; submitter: EventTarget | null }[] = [];
  host.addEventListener('submit', (event) => {
    event.preventDefault();
    submitted.push({
      form: event.target as unknown as HTMLFormElement,
      submitter: (event as unknown as SubmitEvent).submitter,
    });
  });
  const removal = (csrfToken?: string) => (
    <EntryRemoveForm
      locale="en"
      returnTo={returnTo}
      {...(csrfToken === undefined ? {} : { csrfToken })}
      subjectId={subjectId}
      revision={7}
      incarnationId={incarnationId}
      idempotencyKey={idempotencyKey}
    />
  );
  try {
    await show(removal('original-csrf'));
    const remove = button();
    const form = remove.form!;
    expect(remove.textContent).toBe(m.library_remove_from_library());
    expect(form.method).toBe('post');
    expect(form.getAttribute('action')).toBe('/library/entry');
    expect(formFields(form)).toEqual([
      ['locale', 'en'],
      ['csrf_token', 'original-csrf'],
      ['returnTo', returnTo],
      ['intent', 'remove'],
      ['subjectId', subjectId],
      ['revision', '7'],
      ['incarnationId', incarnationId],
      ['idempotencyKey', idempotencyKey],
    ]);
    expectTargetStyles(remove);
    await act(async () => {
      await user.tab();
      await user.keyboard('{Enter}');
    });
    expect(window.document.activeElement).toBe(remove);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.submitter).toBe(remove);
    expect(formFields(submitted[0]!.form)).toEqual(formFields(form));
    await show(removal());
    expect(host.querySelector('[name="csrf_token"]')?.getAttribute('value')).toBe('session-csrf');
    await show(<EntryRemoveForm locale="en" subjectId={subjectId} revision={0} idempotencyKey={idempotencyKey} />);
    expect(formFields(button().form!)).toContainEqual(['revision', '0']);
    expect(host.querySelector('[name="incarnationId"]')).toBeNull();
    expect(formFields(button().form!)).toContainEqual(['returnTo', '/en/library']);

    await show(<EntryFormPage locale="en" undo={receipt} csrfToken="original-csrf" returnTo={returnTo} />);
    const undo = button();
    const back = host.querySelector('a')! as unknown as HTMLAnchorElement;
    expect(undo.textContent?.trim()).toBe(m.editor_undo());
    expectTargetStyles(undo);
    expectTargetStyles(back);
    expect(undo.form!.method).toBe('post');
    expect(undo.form!.getAttribute('action')).toBe('/library/entry');
    expect(formFields(undo.form!)).toEqual([
      ['locale', 'en'],
      ['csrf_token', 'original-csrf'],
      ['returnTo', returnTo],
      ['intent', 'restore'],
      ['subjectId', subjectId],
      ['deletionId', 'undo-ok'],
      ['revision', '12'],
    ]);
    expect(back.getAttribute('href')).toBe(returnTo);
    expect(back.closest('form')).toBeNull();
    undo.focus();
    await act(async () => {
      await user.keyboard('{Enter}');
      await user.tab();
    });
    expect(submitted).toHaveLength(2);
    expect(submitted[1]!.submitter).toBe(undo);
    expect(window.document.activeElement).toBe(back);
    await act(async () => {
      await user.tab({ shift: true });
    });
    expect(window.document.activeElement).toBe(undo);

    const messages = {
      occupied: m.library_restore_occupied(),
      stale: m.library_restore_stale(),
      expired: m.library_restore_expired(),
      closed: m.platform_closed_message(),
      unavailable: m.library_subject_unavailable(),
    };
    for (const reason of ['occupied', 'stale', 'expired', 'closed', 'unavailable'] as const) {
      const restore: LibraryRestoreResult =
        reason === 'occupied' ? { ok: false, reason, entry: { ...entry, revision: 15 } } : { ok: false, reason };
      await show(<EntryFormPage locale="en" restore={restore} csrfToken="original-csrf" returnTo={returnTo} />);
      expect(host.querySelector('[role="status"]')?.textContent).toBe(messages[reason]);
      expect(host.querySelector('form')).toBeNull();
      expect(host.querySelector('a')?.getAttribute('href')).toBe(returnTo);
      const article = host.querySelector('article[data-restored-entry]');
      expect(article !== null).toBe(reason === 'occupied');
      if (article) {
        expect(article.getAttribute('data-entry-revision')).toBe('15');
        expect(article.querySelector('[lang="ja"]')?.textContent).toBe(title);
        expect(article.textContent).toBe(title + stateLabel);
      }
    }
    await show(<EntryRestoreFeedback locale="en" restore={{ ok: false, reason: 'occupied' }} />);
    expect(host.textContent).toBe(messages.occupied);
    expect(host.querySelector('article')).toBeNull();
    await show(<EntryFormPage locale="en" restore={{ ok: true, entry }} csrfToken={null} returnTo={returnTo} />);
    expect(host.querySelector('article')?.textContent).toBe(title + stateLabel);
    expect(host.querySelector('article')?.closest('ul,ol,[role="list"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('button,form')).toBeNull();
    expect(host.textContent).not.toContain('native-state');
    await show(
      <EntryRestoreFeedback locale="en" restore={{ ok: true, entry: { ...entry, subject: null, stateLabel: '0' } }} />,
    );
    expect(host.querySelector('article')?.textContent).toBe(m.library_subject_unavailable() + '0');
    expect(host.textContent).not.toContain(title);
    await show(<EntryFormPage locale="en" removed conflict csrfToken={null} returnTo={returnTo} />);
    expect([...host.querySelectorAll('[role="status"]')].map((node) => node.textContent)).toEqual([
      m.library_removed(),
      m.library_conflict(),
    ]);
    expect(host.querySelector('form,button,[name="deletionId"]')).toBeNull();

    for (const translatedLocale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      setLocale(translatedLocale, { reload: false });
      await show(
        <>
          {removal('original-csrf')}
          <EntryFormPage locale={translatedLocale} undo={receipt} csrfToken="original-csrf" returnTo={returnTo} />
        </>,
      );
      const controls = [...host.querySelectorAll('button')];
      expect(controls.map((control) => control.textContent?.trim())).toEqual([
        m.library_remove_from_library(),
        m.editor_undo(),
      ]);
      for (const control of controls) expectTargetStyles(control as unknown as HTMLElement);
      expect(host.querySelector('a')?.textContent?.trim()).toBe(m.library_menu_back());
    }
    setLocale('en', { reload: false });

    // The actual restore operation is required. A group alone never supplies either POST control.
    await act(async () => {
      client.setQueryData(['exposure', 'anonymous'], ['personal_library']);
    });
    await show(
      <>
        {removal()}
        <EntryUndoForm locale="en" undo={receipt} />
      </>,
    );
    expect(host.querySelector('form')).toBeNull();
    const lifetime = viewerExposureLifetime(client);
    const admitCurrent = (groups: string[]) => {
      const snapshot = lifetime.getSnapshot();
      if (snapshot.state !== 'signed-in') throw new Error('Missing viewer observation');
      client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
        subject: snapshot.observation.subject,
        admitted: groups,
      });
      return snapshot.observation;
    };
    let first!: { subject: string; id: number };
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'A-csrf' });
      first = admitCurrent(admitted);
    });
    await settle();
    expect(host.querySelectorAll('form')).toHaveLength(2);
    await act(async () => {
      client.setQueryData(['session'], { state: 'unknown', csrfToken: null });
    });
    expect(host.querySelector('form')).toBeNull();
    await act(async () => {
      client.setQueryData(viewerExposureQuery(first).queryKey, { subject: 'A', admitted });
    });
    expect(host.querySelector('form')).toBeNull();
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'B', csrfToken: 'B-csrf' });
      admitCurrent([]);
    });
    expect(host.querySelector('form')).toBeNull();
    await act(async () => {
      client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'new-A-csrf' });
      const latest = admitCurrent(admitted);
      expect(latest.id).not.toBe(first.id);
    });
    await settle();
    expect(host.querySelectorAll('form')).toHaveLength(2);
    // Exposure retirement does not refresh or replace the form's captured credential.
    expect(host.querySelector('[name="csrf_token"]')?.getAttribute('value')).toBe('session-csrf');
    await act(async () => {
      admitCurrent([]);
    });
    expect(host.querySelector('form')).toBeNull();
    expect(incidental).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    globalThis.fetch = originalFetch;
    setLocale(locale, { reload: false });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});

// Exercise the unchanged document handler with real generated transport, not a replacement form component.
test('native document POST consumes the actual removal field set then the supplied receipt with no reload or extra entry read', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { createRecordedKernelFetch, setFakeAdmitted } = await import('../src/kernel/fake');
  const { libraryEntryFormResponse } = await import('../src/library/entry-form');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { EntryRemoveForm } = await import('../src/library/entry-undo');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  const calls: Request[] = [];
  setFakeAdmitted(['personal_library', 'library_entry.restore']);
  const fake = createRecordedKernelFetch({});
  const kernel = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      calls.push(request.clone());
      return fake(request);
    }) as typeof fetch,
  });
  const client = new QueryClient();
  client.setQueryData(['exposure', 'anonymous'], ['personal_library', 'library_entry.restore']);
  const parse = (html: string) => new window.DOMParser().parseFromString(html, 'text/html');
  const fields = (form: HTMLFormElement) =>
    new URLSearchParams([...new window.FormData(form as never)].map(([key, value]) => [key, String(value)]));
  try {
    const document = parse(
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <EntryRemoveForm
            locale="en"
            csrfToken="original-csrf"
            returnTo={returnTo}
            subjectId={subjectId}
            revision={7}
            incarnationId={incarnationId}
            idempotencyKey={idempotencyKey}
          />
        </QueryClientProvider>,
      ),
    );
    const send = (form: HTMLFormElement) =>
      libraryEntryFormResponse(
        new Request(`https://rezics.test${form.getAttribute('action')}`, {
          method: form.method,
          headers: { authorization: 'Bearer reader' },
          body: fields(form),
        }),
        {},
        kernel,
      );
    const removed = await send(document.querySelector('form')! as unknown as HTMLFormElement);
    expect(removed.status).toBe(200);
    expect(removed.headers.get('cache-control')).toBe('private, no-store');
    const receiptDocument = parse(await removed.text());
    expect(receiptDocument.querySelector('script')).toBeNull();
    const undo = receiptDocument.querySelector('form')! as unknown as HTMLFormElement;
    expect(Object.fromEntries(fields(undo))).toEqual({
      locale: 'en',
      csrf_token: 'original-csrf',
      returnTo,
      intent: 'restore',
      subjectId,
      deletionId: 'undo-ok',
      revision: '12',
    });
    const restored = await send(undo);
    expect(restored.status).toBe(200);
    const result = parse(await restored.text());
    expect(result.querySelector('script,form')).toBeNull();
    expect(result.querySelector('article[data-restored-entry]')?.getAttribute('data-entry-revision')).toBe('7');
    expect(result.querySelector('a')?.getAttribute('href')).toBe(returnTo);
    const writes = calls.filter((call) => new URL(call.url).pathname.startsWith('/v1/libraryEntries'));
    expect(writes.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['DELETE', '/v1/libraryEntries/book-one'],
      ['POST', '/v1/libraryEntries/book-one:restore'],
    ]);
    expect(new URL(writes[0]!.url).searchParams.get('revision')).toBe('7');
    expect(new URL(writes[0]!.url).searchParams.get('incarnationId')).toBe(incarnationId);
    expect(writes[0]!.headers.get('idempotency-key')).toBe(idempotencyKey);
    expect(await writes[1]!.json()).toEqual({ deletionId: 'undo-ok', revision: 12 });
    expect(writes.every((request) => request.headers.get('authorization') === 'Bearer reader')).toBe(true);
  } finally {
    client.clear();
    setFakeAdmitted([]);
    await window.happyDOM.close();
  }
});
