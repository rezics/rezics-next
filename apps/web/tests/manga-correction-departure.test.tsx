import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('Manga departure retains private siblings and exact retries through recovery, and retires Leave and caller results', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/edit' });
  const globals: Record<string, unknown> = { window, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLFormElement Element Node NodeFilter ShadowRoot MutationObserver ResizeObserver Document DocumentFragment'.split(
    ' ',
  ))
    globals[key] = window[key];
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
  const { RelationEditorNavigation } = await import('../src/features/catalogue/relation-editor-navigation');
  const { useCurrentReadingVisible } = await import('../src/features/catalogue/editor-lifetime');
  const { mangaFixture, mangaVolumeId } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { readMangaProfile } = await import('../src/features/catalogue/manga-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const locale = getLocale();
  setLocale('en', { reload: false });
  const fixture = mangaFixture(),
    initial = await readMangaProfile(fixture.client, mangaVolumeId);
  if (!initial.ok || !initial.public) throw new Error('Expected Manga reading');
  const property = 'schema:numberOfPages',
    sibling = 'schema:isbn';
  initial.release.properties[property]!.qualifiers = [sibling];
  initial.public.subject.statements[property]![0]!.qualifiers = [
    { property: { id: sibling, data_type: 'external-id' }, value: { type: 'value', content: 'edition' } },
  ];
  let next: Awaited<ReturnType<typeof readMangaProfile>> = initial;
  let token = 'original-token',
    update!: () => void,
    finish!: (result: FactResult) => void;
  const commands: FactCommand[] = [],
    credentials: string[] = [];
  let reviewSession: string | undefined;
  function NativeSibling() {
    const [value, change] = useState('');
    const visible = useCurrentReadingVisible();
    return (
      <>
        <RelationEditorNavigation dirty={!!value} pending={false} isCurrent={() => true} />
        {visible && (
          <input aria-label="Relation sibling" value={value} onChange={(event) => change(event.target.value)} />
        )}
      </>
    );
  }
  function Surface() {
    const [, refresh] = useState(0);
    update = () => refresh((value) => value + 1);
    return (
      <CandidateReaderBoundary
        observed={{ state: 'signed-in', subject: 'reader', csrfToken: token }}
        address={mangaVolumeId}
      >
        <MangaProfileEditor
          id={mangaVolumeId}
          locale="en"
          session="signed-in"
          search={async () => []}
          transport={{ ...fixture.transport, load: async () => next }}
          correction={{
            facts: {
              read: async () => ({ ...initial, public: initial.public!, source: null }),
              propose: (command) => {
                command.session ??= 'sealed-session';
                commands.push(command);
                credentials.push(token);
                return new Promise((resolve) => {
                  finish = resolve;
                });
              },
            },
            review: (_property, session) => {
              reviewSession = session;
              return {
                read: async () => ({ ok: false, reason: 'unavailable' }),
                confirm: async () => ({ ok: false, reason: 'denied' }),
              };
            },
            relations: <NativeSibling />,
            authored: null,
          }}
        />
      </CandidateReaderBoundary>
    );
  }
  const base = createRootRoute({ component: Outlet });
  const edit = createRoute({
    getParentRoute: () => base,
    path: '/edit',
    component: Surface,
    validateSearch: (search) => search,
  });
  const away = createRoute({ getParentRoute: () => base, path: '/away', component: () => <p>Destination</p> });
  const router = createRouter({
    routeTree: base.addChildren([edit, away]),
    history: createMemoryHistory({ initialEntries: ['/edit'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const settle = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  const button = (name: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === name)!;
  const click = (node: HTMLElement) => act(async () => node.click());
  const field = (id: string) =>
    [...host.querySelectorAll<HTMLElement>('section[aria-label]')].find(
      (node) => node.getAttribute('aria-label') === initial.release.properties[id]!.labels.en,
    )!;
  const input = (value: string) =>
    [...host.querySelectorAll<HTMLInputElement>('input')].find((node) => node.value === value)!;
  const enter = (node: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const unload = () => !window.dispatchEvent(new window.Event('beforeunload', { cancelable: true }));
  const navigate = (to: '/away' | '/edit' = '/away', search = {}) =>
    settle(() => {
      void router.navigate({ to, search });
    });
  const stage = (id = property) => click(button(m.facts_edit_field(), field(id)));
  const submit = () => click(button(m.facts_submit()));
  const stay = () => click(button(m.thread_authoring_stay()));
  const leave = () => click(button(m.thread_authoring_leave()));
  try {
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await settle();
    await stage();
    expect(unload()).toBe(false); // Unchanged source copies do not protect.
    await navigate();
    expect(router.state.location.pathname).toBe('/away');
    await navigate('/edit');
    await stage();
    await enter(input('+192'), '+240');
    await enter(input('edition'), 'revised edition');
    const citation = host.querySelector<HTMLInputElement>(`input[aria-label="${m.correction_url()}"]`)!;
    await enter(citation, 'https://example.test/evidence');
    await stage(sibling);
    await enter(input('9781234567897'), '9780000000001');
    for (const id of [property, sibling]) await click(field(id).querySelector<HTMLElement>('[role="checkbox"]')!);
    expect(unload()).toBe(true); // Exclusion never discards either draft.
    await enter(host.querySelector<HTMLInputElement>('[aria-label="Relation sibling"]')!, 'retained relation');
    await navigate('/edit', { property: sibling });
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await stay();
    expect(router.state.location.search).toEqual({});
    expect(input('+240')).toBeDefined();
    expect(input('revised edition')).toBeDefined();
    expect(input('9780000000001')).toBeDefined();
    expect(input('retained relation')).toBeDefined();
    expect(citation.value).toBe('https://example.test/evidence');
    expect(commands).toHaveLength(0);
    await enter(input('retained relation'), '');
    await click(field(property).querySelector<HTMLElement>('[role="checkbox"]')!);
    await submit();
    const original = commands[0]!,
      sealed = structuredClone(original);
    expect(commands).toHaveLength(1);
    expect(sealed.statement.qualifiers[0]!.value.content).toBe('revised edition');
    expect(sealed.statement.references[0]!.parts[0]!.value.content).toBe(citation.value);
    await navigate();
    expect(document.body.textContent).toContain(m.thread_authoring_leave_pending());
    await stay();
    // Reload retires the original observation, including its later successful response.
    next = { ok: false, reason: 'unavailable' };
    await click(button(m.correction_reload()));
    await settle();
    expect(host.querySelector('input')).toBeNull();
    expect(unload()).toBe(true);
    await settle(() => finish({ ok: true, candidate: crypto.randomUUID(), session: 'retired-reading' }));
    await navigate();
    await stay();
    next = initial;
    await click(button(m.correction_reload()));
    await settle();
    expect(input('9780000000001')).toBeDefined();
    expect(field(sibling).querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('false');
    await submit();
    expect(commands[1]).toBe(original);
    expect(commands[1]).toEqual(sealed);
    expect(credentials).toEqual(['original-token', 'original-token']);
    await settle(() => finish({ ok: false, reason: 'uncertain' }));
    await navigate();
    expect(unload()).toBe(true);
    await stay();
    await submit();
    const late = finish;
    await navigate();
    await leave();
    await settle();
    expect(unload()).toBe(false);
    await navigate('/edit');
    await settle(() => late({ ok: true, candidate: crypto.randomUUID(), session: 'late' }));
    expect(host.textContent).not.toContain(m.correction_proposed());
    expect(unload()).toBe(false);
    await stage();
    await enter(input('+192'), '+241');
    await submit();
    await settle(() => finish({ ok: true, candidate: crypto.randomUUID(), session: 'confirmed' }));
    expect(unload()).toBe(false);
    await stage(sibling);
    await enter(input('9781234567897'), '9780000000002');
    await click(
      [...field(property).querySelectorAll<HTMLAnchorElement>('a')].find(
        (node) => node.textContent?.trim() === m.correction_review(),
      )!,
    );
    expect(reviewSession).toBe('confirmed');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(input('9780000000002')).toBeDefined();
    expect(unload()).toBe(true);
    await submit();
    const callerLate = finish;
    await settle(() => {
      token = 'replacement-token';
      update();
    });
    expect(unload()).toBe(false);
    await settle(() => callerLate({ ok: true, candidate: crypto.randomUUID() }));
    expect(host.textContent).not.toContain(m.correction_proposed());
    await navigate();
    expect(router.state.location.pathname).toBe('/away');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(locale, { reload: false });
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
