import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import members from '../src/kernel/recorded/library-collection-members.json';
import type { CollectionWriteResult } from '../src/library/collection-edit';
import type { SessionEnv } from '../src/session/client';

// UNRUN mounted coverage. The real picker, form, router and scoped admission consume supplied
// search/command outcomes. DOM classes are regression guards, never physical layout proof.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections/alpha' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const name of [
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'Document',
  'DocumentFragment',
  'MutationObserver',
  'ResizeObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]) {
  previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const value = window[name as keyof typeof window];
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(window) : value,
  });
}
previous.set('IS_REACT_ACT_ENVIRONMENT', Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { CollectionAddMembers } = await import('../src/library/collection-add-members');
const edits = await import('../src/library/collection-edit');
const { addCollectionMemberRecord } = await import('../src/library/collection-records');
const { createKernelClient } = await import('@rezics/client');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const locale = getLocale();
setLocale('en', { reload: false });
afterAll(async () => {
  setLocale(locale, { reload: false });
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const title = `Selected subject 0 — ${'Long multilingual title 閱讀 読書 '.repeat(8)}${'界'.repeat(180)}`;
const exactNote = `  Original occurrence 0\n\t${'界'.repeat(19_970)}\n `;
const csrfOne = 'A'.repeat(22);
const csrfTwo = 'B'.repeat(22);
const subject = members.members[0]!.subject;
const success: CollectionWriteResult = { ok: true, id: 'new-occurrence' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const settle = (work: () => void = () => {}) =>
  act(async () => {
    work();
    await Bun.sleep(10);
  });
async function until(read: () => boolean) {
  for (let count = 0; count < 60 && !read(); count++) await settle();
  expect(read()).toBe(true);
}
function propsOf<T>(element: Element): T {
  return Object.entries(element).find(([key]) => key.startsWith('__reactProps$'))![1] as T;
}
async function mounted() {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  const viewer = (subject = 'alice', csrfToken = csrfOne) => ({ state: 'signed-in', subject, csrfToken });
  client.setQueryData(sessionQuery.queryKey, viewer());
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/collections/alpha'] }),
  });
  await router.load();
  let collectionId = 'alpha';
  let visible = true;
  let closes = 0;
  const reloads: ReturnType<typeof deferred<void>>[] = [];
  const calls: {
    data: Parameters<typeof edits.addCollectionMember>[0]['data'];
    csrf: string | null;
    request?: Request;
    result: ReturnType<typeof deferred<Response>>;
  }[] = [];
  const add = spyOn(edits, 'addCollectionMember').mockImplementation((input) => {
    const result = deferred<Response>();
    const csrf = new Headers(input.headers).get('X-CSRF-Token');
    const call: (typeof calls)[number] = { data: structuredClone(input.data), csrf, result };
    calls.push(call);
    const native = createKernelClient('https://kernel.test', {
      fetch: (async (target, init) => {
        call.request = new Request(target, init);
        return result.promise;
      }) as typeof fetch,
    });
    const session = client.getQueryData<{ subject: string; csrfToken: string }>(sessionQuery.queryKey)!;
    const credential = async () => ({ status: 'active', accessToken: 'native-test', ...session });
    const env = {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://kernel.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'web-test',
      WEBSITE_CLIENT_KEY: '{}',
      SITE_ORIGINS: 'https://site.test',
      SESSIONS: { idFromName: (name: string) => name, get: () => ({ credential, credentialIfFresh: credential }) },
    } as unknown as Partial<SessionEnv>;
    return addCollectionMemberRecord(
      native,
      new Request(window.location.href, {
        method: 'POST',
        headers: {
          cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
          origin: 'https://site.test',
          'X-CSRF-Token': csrf ?? '',
        },
      }),
      env,
      input.data,
    );
  });
  const searches: string[] = [];
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    searches.push(url.pathname + url.search);
    expect(url.pathname).toBe('/api/search/suggestions');
    return Response.json({
      subjects: [{ id: subject.id, type: subject.type, labels: { en: title }, facts: {}, summary: null }],
      types: { 'schema:Book': { en: 'Book' } },
    });
  });
  const render = () =>
    settle(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              {visible ? (
                <CollectionAddMembers
                  collectionId={collectionId}
                  onAdded={() => {
                    const reload = deferred<void>();
                    reloads.push(reload);
                    return reload.promise;
                  }}
                  onClose={() => {
                    closes++;
                  }}
                />
              ) : null}
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  const admit = async () => {
    await settle(() => {
      const current = viewerExposureLifetime(client).getSnapshot();
      expect(current.state).toBe('signed-in');
      if (current.state === 'signed-in')
        client.setQueryData(viewerExposureQuery(current.observation).queryKey, {
          subject: current.observation.subject,
          admitted: ['collections'],
        });
    });
  };
  const form = () => host.querySelector('form')!;
  const submit = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const cancel = () => host.querySelector<HTMLButtonElement>('button[type="button"]')!;
  const input = () => host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const note = () => host.querySelector<HTMLTextAreaElement>('textarea')!;
  const choose = async () => {
    await settle(() => {
      input().focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), 'Original');
      input().dispatchEvent(
        new window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Original' }),
      );
    });
    await until(() => !!document.querySelector('[role="option"]'));
    await settle(() => document.querySelector<HTMLElement>('[role="option"]')!.click());
    expect(input().value).toBe(title);
    expect(host.querySelector('p')!.textContent).toBe(title);
    await settle(() => host.querySelector('summary')!.click());
  };
  const changeNote = (value: string) =>
    settle(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(note(), value);
      note().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  await render();
  await admit();
  return {
    host,
    client,
    router,
    calls,
    reloads,
    searches,
    form,
    submit,
    cancel,
    input,
    note,
    choose,
    changeNote,
    admit,
    get closes() {
      return closes;
    },
    click: () => settle(() => submit().click()),
    outcome: (index: number, result: CollectionWriteResult | Error) =>
      settle(() => {
        if (result instanceof Error) calls[index]!.result.reject(result);
        else
          calls[index]!.result.resolve(
            result.ok
              ? Response.json({ member: { ...members.members[0]!, id: result.id } }, { status: 201 })
              : Response.json(
                  { code: result.reason === 'full' ? 'collection_full' : result.reason },
                  { status: result.reason === 'unavailable' ? 503 : 409 },
                ),
          );
      }),
    reload: (index: number, error?: Error) =>
      settle(() => {
        if (error) reloads[index]!.reject(error);
        else reloads[index]!.resolve();
      }),
    renew: async (subject = 'alice', csrf = csrfTwo) => {
      await settle(() => client.setQueryData(sessionQuery.queryKey, viewer(subject, csrf)));
      await admit();
    },
    replace: async (address: string) => {
      collectionId = address;
      await render();
    },
    show: async (shown: boolean) => {
      visible = shown;
      await render();
      if (shown) await admit();
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      add.mockRestore();
      transport.mockRestore();
      host.remove();
    },
  };
}
type UI = Awaited<ReturnType<typeof mounted>>;
async function withForm(run: (ui: UI) => Promise<void>) {
  const ui = await mounted();
  try {
    await run(ui);
  } finally {
    await ui.close();
  }
}
function footer(ui: UI) {
  for (const button of [ui.submit(), ui.cancel()]) {
    expect(button.classList.contains('min-h-11')).toBe(true);
    expect(button.classList.contains('h-auto')).toBe(true);
    expect(button.classList.contains('whitespace-normal')).toBe(true);
  }
  expect(ui.form().querySelector('button button, button a, summary button, summary a')).toBeNull();
}

test('actual selected subject, note, error and footer preserve full text and correctable occurrence operands', async () => {
  await withForm(async (ui) => {
    expect(ui.submit().disabled).toBe(true);
    expect(ui.submit().textContent).toBe(m.library_collection_add_selected());
    expect(ui.cancel().textContent).toBe(m.library_collection_cancel());
    footer(ui);
    await ui.choose();
    const note = ui.note();
    expect(ui.host.querySelector('label')!.htmlFor).toBe(note.id);
    expect(note.hasAttribute('maxlength')).toBe(false);
    expect(ui.host.querySelector('summary')!.classList.contains('min-h-11')).toBe(true);
    await ui.changeNote('😀'.repeat(1001));
    await ui.click();
    expect(ui.calls).toHaveLength(0);
    expect(note.getAttribute('aria-invalid')).toBe('true');
    expect(note.value).toBe('😀'.repeat(1001));
    await ui.changeNote(exactNote);
    expect(note.value).toBe(exactNote);
    await ui.click();
    expect(ui.calls).toHaveLength(1);
    expect(ui.calls[0]!.data).toEqual({
      collectionId: 'alpha',
      subjectId: subject.id,
      note: exactNote,
      idempotencyKey: expect.any(String),
    });
    expect(ui.calls[0]!.csrf).toBe(csrfOne);
    const native = ui.calls[0]!.request!;
    expect(new URL(native.url).pathname).toBe('/v1/collections/alpha/members');
    expect(native.method).toBe('POST');
    expect(native.headers.get('authorization')).toBe('Bearer native-test');
    expect(native.headers.get('idempotency-key')).toBe(ui.calls[0]!.data.idempotencyKey);
    expect(await native.json()).toEqual({ subjectId: subject.id, note: exactNote });
    expect(ui.submit().getAttribute('aria-busy')).toBe('true');
    expect(ui.input().disabled && note.disabled && ui.cancel().disabled).toBe(true);
    await ui.outcome(0, { ok: false, reason: 'full' });
    const error = ui.host.querySelector('[role="alert"]')!;
    expect(error.textContent).toBe(m.library_collection_full());
    expect(ui.form().getAttribute('aria-describedby')).toBe(error.id);
    expect(ui.submit().getAttribute('aria-describedby')).toBe(error.id);
    expect(note.disabled).toBe(false);
    await ui.changeNote('Corrected note 0');
    await ui.click();
    expect(ui.calls[1]!.data.note).toBe('Corrected note 0');
    expect(ui.calls[1]!.data.idempotencyKey).not.toBe(ui.calls[0]!.data.idempotencyKey);
    await ui.outcome(1, { ok: false, reason: 'conflict' });
    expect(ui.host.querySelector('[role="alert"]')!.textContent).toBe(m.library_collection_conflict());
    expect(ui.searches).toEqual(['/api/search/suggestions?q=Original&locale=en']);
    expect(ui.reloads).toHaveLength(0);
    await settle(() => ui.cancel().click());
    expect(ui.closes).toBe(1);
    await ui.click();
    expect(ui.calls).toHaveLength(2);
  });
});

test('unavailable or thrown uncertainty retains exact input/key; accepted recovery retries only independent reload', async () => {
  for (const outcome of [{ ok: false, reason: 'unavailable' } as const, new Error('Response lost')])
    await withForm(async (ui) => {
      await ui.choose();
      await ui.changeNote(exactNote);
      await ui.click();
      const exact = structuredClone(ui.calls[0]!.data);
      await ui.outcome(0, outcome);
      expect(ui.note().disabled && ui.input().disabled).toBe(true);
      expect(ui.host.querySelector('[role="alert"]')!.textContent).toBe(m.error_message());
      await ui.changeNote('Attempted replacement');
      await ui.renew();
      await ui.click();
      expect(ui.calls).toHaveLength(2);
      expect(ui.calls[1]!.data).toEqual(exact);
      expect(ui.calls[1]!.csrf).toBe(csrfTwo);
      await ui.outcome(1, success);
      expect(ui.reloads).toHaveLength(1);
      await ui.reload(0, new Error('Read unavailable'));
      expect(ui.submit().textContent).toBe(m.library_collection_reload());
      expect(ui.note().value).toBe(exactNote);
      footer(ui);
      await ui.click();
      expect(ui.calls).toHaveLength(2);
      expect(ui.reloads).toHaveLength(2);
      await ui.reload(1);
      expect(ui.closes).toBe(1);
      await ui.click();
      expect(ui.reloads).toHaveLength(2);
      await ui.show(false);
      await ui.show(true);
      await ui.choose();
      await ui.click();
      expect(ui.calls[2]!.data.subjectId).toBe(exact.subjectId);
      expect(ui.calls[2]!.data.note).toBeNull();
      expect(ui.calls[2]!.data.idempotencyKey).not.toBe(exact.idempotencyKey);
      expect(ui.searches).toHaveLength(2);
    });
});

test('cancel, viewer/address ABA and unmount retire retained callbacks and late reloads without incidental requests', async () => {
  for (const boundary of ['cancel', 'viewer', 'address', 'unmount'] as const)
    await withForm(async (ui) => {
      await ui.choose();
      await ui.changeNote('A original note');
      const old = propsOf<{ onSubmit: (event: { preventDefault(): void }) => void }>(ui.form()).onSubmit;
      await ui.click();
      await ui.outcome(0, success);
      if (boundary === 'cancel') {
        await ui.reload(0, new Error('Reload failed'));
        await settle(() => ui.cancel().click());
      } else if (boundary === 'viewer') {
        await settle(() => {
          ui.client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'bob' });
          ui.client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: csrfOne });
          old({ preventDefault() {} });
        });
        await ui.admit();
      } else if (boundary === 'address') {
        const fromLocation = ui.router.state.location;
        await settle(() => {
          for (const href of ['/en/collections/beta', '/en/collections/alpha'])
            ui.router.emit({
              type: 'onBeforeNavigate',
              fromLocation,
              toLocation: { ...fromLocation, publicHref: href },
              pathChanged: true,
              hrefChanged: true,
              hashChanged: false,
            });
          old({ preventDefault() {} });
        });
        await ui.replace('beta');
        await ui.replace('alpha');
      } else {
        await ui.show(false);
        await ui.show(true);
      }
      await settle(() => old({ preventDefault() {} }));
      if (boundary !== 'cancel') await ui.reload(0);
      expect(ui.calls).toHaveLength(1);
      expect(ui.reloads).toHaveLength(1);
      expect(ui.closes).toBe(boundary === 'cancel' ? 1 : 0);
      expect(ui.host.querySelector('[role="alert"]')?.textContent ?? null).toBe(
        boundary === 'cancel' ? m.error_message() : null,
      );
      expect(ui.searches).toHaveLength(1);
    });
});
