import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('generic fact departure preserves drafts and exact retries, retires Leave and permits confirmed review', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/edit' });
  const keys =
    'window document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLButtonElement HTMLFormElement Element Node NodeFilter Document ShadowRoot DocumentFragment MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value:
        key === 'IS_REACT_ACT_ENVIRONMENT'
          ? true
          : typeof window[key] === 'function' && key[0] === key[0]!.toLowerCase()
            ? window[key].bind(window)
            : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { SubjectFacts } = await import('../src/features/catalogue/subject-facts-view');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const locale = getLocale();
  setLocale('en', { reload: false });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const ready = await readMangaProfile(mangaFixture().client, mangaVolumeId);
  if (!ready.ok || !ready.public) throw new Error('Expected supplied facts');
  const initial = { ...ready, public: ready.public, source: null };
  const property = 'schema:numberOfPages';
  initial.release.types[initial.public.subject.type]!.properties = [property, 'schema:isbn'];
  initial.release.properties[property]!.qualifiers = ['schema:isbn'];
  initial.public.subject.statements[property]![0]!.qualifiers = [
    { property: { id: 'schema:isbn', data_type: 'external-id' }, value: { type: 'value', content: 'edition' } },
  ];
  const calls: FactCommand[] = [];
  const credentials: string[] = [];
  let resolve!: (result: FactResult) => void;
  let visible = true,
    revision = 0,
    credential = 'credential-A',
    reviewSession: string | undefined,
    failedRead = false;
  const transport = {
    read: async () => (failedRead ? { ok: false as const, reason: 'unavailable' as const } : initial),
    propose: (command: FactCommand) => {
      calls.push(command);
      credentials.push(credential);
      return new Promise<FactResult>((yes) => {
        resolve = yes;
      });
    },
  };
  const review = (_property: string, session?: string) => {
    reviewSession = session;
    return {
      read: async () => ({ ok: false as const, reason: 'unavailable' as const }),
      confirm: async () => ({ ok: false as const, reason: 'denied' as const }),
    };
  };
  let update!: () => void;
  const page = () => {
    const [, refresh] = useState(0);
    update = () => refresh((value) => value + 1);
    return (
      <CandidateReaderBoundary
        observed={{ state: 'signed-in', subject: 'contributor', csrfToken: credential }}
        address="facts"
      >
        <CatalogueCurrentReading visible={visible} ready={visible} revision={String(revision)}>
          <SubjectFacts initial={initial} locale="en" transport={transport} review={review} />
        </CatalogueCurrentReading>
      </CandidateReaderBoundary>
    );
  };
  const parent = createRootRoute({ component: Outlet });
  const edit = createRoute({
    getParentRoute: () => parent,
    path: '/edit',
    component: page,
    validateSearch: (search) => search,
  });
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => <p>Arrived</p> });
  const router = createRouter({
    routeTree: parent.addChildren([edit, away]),
    history: createMemoryHistory({ initialEntries: ['/edit'] }),
  });
  const render = () => act(async () => root.render(<RouterProvider router={router} />));
  const button = (name: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
  const click = (node: HTMLElement) => act(async () => node.click());
  const row = () =>
    [...host.querySelectorAll<HTMLElement>('section[aria-label]')].find(
      (node) => node.getAttribute('aria-label') === initial.release.properties[property]!.labels.en,
    )!;
  const inputs = () => [...row().querySelectorAll<HTMLInputElement>('input')];
  const enter = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const blocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const navigate = async (search = false) =>
    act(async () => {
      void router.navigate(search ? { to: '/edit', search: { property: 'schema:isbn' } } : { to: '/away' });
    });
  const stay = () => click(button(m.thread_authoring_stay()));
  const leave = () => click(button(m.thread_authoring_leave()));
  const submit = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  try {
    await act(async () => router.load());
    await render();
    expect(blocked()).toBe(false);
    await click(button('Edit this field', row()));
    expect(blocked()).toBe(false);
    for (const [before, after] of [
      ['+192', '+240'],
      ['edition', 'revised edition'],
      ['https://example.org/paper-observatory/volume-2', 'https://example.org/new-evidence'],
    ])
      await enter(
        inputs().find((input) => input.value === before)!,
        after!,
      );
    const isbn = [...host.querySelectorAll<HTMLElement>('section[aria-label]')].find(
      (node) => node.getAttribute('aria-label') === initial.release.properties['schema:isbn']!.labels.en,
    )!;
    await click(button('Edit this field', isbn));
    await enter(isbn.querySelector('input')!, '9780000000001');
    const sibling = isbn.querySelector('input')!.value;
    const assertion = inputs().map((input) => input.value);
    expect(blocked()).toBe(true);
    await navigate();
    await stay();
    expect(inputs().map((input) => input.value)).toEqual(assertion);
    for (const scope of [row(), isbn]) await click(scope.querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(blocked()).toBe(true);
    await navigate(true);
    await stay();
    expect(isbn.querySelector('input')!.value).toBe(sibling);
    expect(calls).toHaveLength(0);
    await click(row().querySelector<HTMLElement>('[role="checkbox"]')!);
    await submit();
    expect(calls).toHaveLength(1);
    const exact = structuredClone(calls[0]);
    expect(blocked()).toBe(true);
    await navigate();
    await stay();
    await act(async () => resolve({ ok: false, reason: 'uncertain' }));
    failedRead = true;
    await click(button(m.correction_reload()));
    expect(host.querySelector('input')).toBeNull();
    expect(blocked()).toBe(true);
    await navigate();
    await stay();
    failedRead = false;
    await click(button(m.correction_reload()));
    visible = false;
    revision++;
    await act(async () => update());
    expect(host.querySelector('input')).toBeNull();
    expect(blocked()).toBe(true);
    await navigate();
    await stay();
    visible = true;
    revision++;
    await act(async () => update());
    await submit();
    expect(calls[1]).toEqual(exact);
    expect(credentials).toEqual(['credential-A', 'credential-A']);
    await navigate();
    await leave();
    expect(blocked()).toBe(false);
    await act(async () => router.navigate({ to: '/edit' }));
    await act(async () =>
      resolve({ ok: true, kind: 'proposed-awaiting-review', candidate: crypto.randomUUID(), revision: 1 }),
    );
    expect(host.textContent).not.toContain(m.correction_proposed());
    await click(button('Edit this field', row()));
    await enter(
      inputs().find((input) => input.value === '+192')!,
      '+241',
    );
    await submit();
    await act(async () =>
      resolve({
        ok: true,
        kind: 'proposed-awaiting-review',
        candidate: crypto.randomUUID(),
        revision: 1,
        session: 'exact-session',
      }),
    );
    expect(blocked()).toBe(false);
    await click(
      [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
        (node) => node.textContent?.trim() === m.correction_review(),
      )!,
    );
    expect(reviewSession).toBe('exact-session');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    credential = 'credential-B';
    await act(async () => update());
    await click(button('Edit this field', row()));
    await enter(
      inputs().find((input) => input.value === '+192')!,
      '+242',
    );
    await submit();
    expect(blocked()).toBe(true);
    credential = 'credential-C';
    await act(async () => update());
    expect(blocked()).toBe(false);
    await act(async () =>
      resolve({ ok: true, kind: 'proposed-awaiting-review', candidate: crypto.randomUUID(), revision: 1 }),
    );
    expect(host.textContent).not.toContain(m.correction_proposed());
    await navigate();
    expect(router.state.location.pathname).toBe('/away');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    setLocale(locale, { reload: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
