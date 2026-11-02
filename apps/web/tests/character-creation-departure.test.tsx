import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { CharacterCommand, CharacterTransport } from '../src/features/catalogue/character-profile';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Character creation protects local work, preserves unknown retries on Stay and retires on Leave', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/character' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouter } =
    await import('@tanstack/react-router');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const { CharacterProfileCreate } = await import('../src/features/catalogue/character-profile-create');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { characterProfileFixture } = await import('../src/kernel/fake/catalogue-character-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const fixture = characterProfileFixture();
  const release = structuredClone(fixture.release);
  release.properties['schema:height']!.qualifiers = ['schema:inLanguage'];
  const requests: { command: CharacterCommand; credential: string }[] = [];
  const credential = 'character-reader-session';
  let mode: 'invalid' | 'unknown' | 'deferred' | 'success' = 'invalid';
  let resolveDeferred: ((result: CreateResult) => void) | undefined;
  let router: ReturnType<typeof createRouter>;
  let created = 0;
  const success: CreateResult = { ok: true, id: 'created-character', reader: null as never };
  const transport: CharacterTransport = {
    ...fixture.transport,
    create: (command) => {
      requests.push({ command, credential });
      if (mode === 'invalid')
        return Promise.resolve({
          ok: false,
          reason: 'invalid',
          errors: [{ pointer: '/labels/ja', code: 'unsupported' }],
        });
      if (mode === 'unknown') return Promise.resolve({ ok: false, reason: 'unavailable' });
      if (mode === 'deferred') return new Promise((resolve) => (resolveDeferred = resolve));
      return Promise.resolve(success);
    },
  };
  function CreatePage() {
    const currentRouter = useRouter();
    return (
      <>
        <CandidateReaderBoundary
          address="character-creation-departure"
          observed={{ state: 'signed-in', subject: 'reader', csrfToken: credential }}
        >
          <CharacterProfileCreate
            release={release}
            locale="en"
            transport={transport}
            onCreated={() => {
              created++;
              void currentRouter.navigate({ to: '/success' });
            }}
          />
        </CandidateReaderBoundary>
        <button type="button" onClick={() => void currentRouter.navigate({ to: '/away' })}>
          Go away
        </button>
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const createRoute = createRoute({ getParentRoute: () => rootRoute, path: '/create', component: CreatePage });
  const awayRoute = createRoute({ getParentRoute: () => rootRoute, path: '/away', component: () => <h1>Away</h1> });
  const successRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/success',
    component: () => <h1>Created</h1>,
  });
  router = createRouter({
    routeTree: rootRoute.addChildren([createRoute, awayRoute, successRoute]),
    history: createMemoryHistory({ initialEntries: ['/create'] }),
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const canvas = within(host);
  const screen = within(window.document.body as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document, delay: null });
  const input = (name: string, index = 0) => canvas.getAllByRole('textbox', { name })[index] as HTMLInputElement;
  const click = (name: string, scope = canvas) => act(async () => user.click(scope.getByRole('button', { name })));
  const replace = (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      if (value) await user.type(control, value);
    });
  const beforeUnloadIsBlocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await waitFor(() => expect(input(m.catalogue_create_label())).toBeDefined());
    expect(beforeUnloadIsBlocked()).toBe(false);
    await replace(input(m.catalogue_create_label()), 'Traveler');
    await click(m.catalogue_create_add_language());
    await replace(input(m.catalogue_create_language(), 1), 'ja');
    await replace(input(m.catalogue_create_label(), 1), '旅人');
    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:height');
      await user.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    });
    await replace(input(m.correction_amount()), '+170');
    await act(async () =>
      user.selectOptions(
        canvas.getByRole('combobox', { name: m.correction_unit() }),
        'http://www.wikidata.org/entity/Q174728',
      ),
    );
    await act(async () =>
      user.selectOptions(canvas.getByRole('combobox', { name: m.correction_add_qualifier() }), 'schema:inLanguage'),
    );
    await replace(input(m.correction_value()), 'ja');
    const fact = host.querySelector('[data-slot="character-initial-fact"]') as HTMLElement;
    await click(m.correction_add_reference(), within(fact));
    await act(async () =>
      user.selectOptions(within(fact).getByRole('combobox', { name: m.correction_add_part() }), 'schema:url'),
    );
    const citation = within(fact).getByRole('textbox', { name: m.correction_url() }) as HTMLInputElement;
    await replace(citation, 'https://example.org/traveler');
    expect(beforeUnloadIsBlocked()).toBe(true);
    await click(m.character_create());
    await waitFor(() =>
      expect(canvas.getByRole('region', { name: m.character_create_correction_summary() })).toBeDefined(),
    );
    expect(requests).toHaveLength(1);
    const correctionLink = canvas
      .getByRole('region', { name: m.character_create_correction_summary() })
      .querySelector('a') as HTMLAnchorElement;
    const targetId = decodeURIComponent(correctionLink.getAttribute('href')!.slice(1));
    const correctionTarget = window.document.getElementById(targetId);
    const amount = input(m.correction_amount());
    const qualifier = canvas.getByRole('combobox', { name: m.correction_add_qualifier() }) as HTMLSelectElement;
    const goAway = () => click('Go away');
    await goAway();
    const dialog = () => screen.queryByRole('alertdialog');
    await waitFor(() => expect(dialog()?.textContent).toContain(m.thread_authoring_leave_unsaved()));
    await click(m.thread_authoring_stay(), screen);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(router.state.location.pathname).toBe('/create');
    expect(input(m.catalogue_create_label(), 1)).toBe(correctionTarget);
    expect(input(m.catalogue_create_label(), 1).id).toBe(targetId);
    expect(correctionLink.getAttribute('href')).toBe(`#${encodeURIComponent(targetId)}`);
    expect(input(m.catalogue_create_language(), 1).value).toBe('ja');
    expect(amount.value).toBe('+170');
    expect(canvas.getByRole('combobox', { name: m.correction_unit() })).toHaveProperty(
      'value',
      'http://www.wikidata.org/entity/Q174728',
    );
    expect(qualifier.value).toBe('schema:inLanguage');
    expect(input(m.correction_value()).value).toBe('ja');
    expect(citation.value).toBe('https://example.org/traveler');
    expect(host.querySelector('[data-slot="character-initial-fact"]')).toBe(fact);
    expect(requests).toHaveLength(1);
    expect(beforeUnloadIsBlocked()).toBe(true);
    await goAway();
    await waitFor(() => expect(dialog()).not.toBeNull());
    await click(m.thread_authoring_leave(), screen);
    await waitFor(() => expect(router.state.location.pathname).toBe('/away'));
    expect(requests).toHaveLength(1);
    expect(created).toBe(0);

    mode = 'unknown';
    await act(async () => {
      await router.navigate({ to: '/create' });
    });
    await replace(input(m.catalogue_create_label()), 'Unknown traveler');
    await click(m.character_create());
    await waitFor(() => expect(canvas.getByRole('button', { name: m.correction_retry() })).toBeDefined());
    const original = requests[1]!;
    await goAway();
    await waitFor(() => expect(dialog()?.textContent).toContain(m.thread_authoring_leave_pending()));
    expect(requests).toHaveLength(2);
    await click(m.thread_authoring_stay(), screen);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(input(m.catalogue_create_label()).value).toBe('Unknown traveler');
    expect(requests).toHaveLength(2);

    mode = 'deferred';
    await click(m.correction_retry());
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]!.command).toBe(original.command);
    expect(requests[2]!.command).toEqual(original.command);
    expect(requests[2]!.credential).toBe(original.credential);
    await goAway();
    await waitFor(() => expect(dialog()?.textContent).toContain(m.thread_authoring_leave_pending()));
    await click(m.thread_authoring_stay(), screen);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(requests).toHaveLength(3);
    await goAway();
    await waitFor(() => expect(dialog()).not.toBeNull());
    await click(m.thread_authoring_leave(), screen);
    await waitFor(() => expect(router.state.location.pathname).toBe('/away'));
    await act(async () => resolveDeferred?.(success));
    await waitFor(() => expect(router.state.location.pathname).toBe('/away'));
    expect(created).toBe(0);
    expect(requests).toHaveLength(3);

    mode = 'success';
    await act(async () => {
      await router.navigate({ to: '/create' });
    });
    expect(input(m.catalogue_create_label()).value).toBe('');
    await replace(input(m.catalogue_create_label()), 'Fresh traveler');
    await click(m.character_create());
    await waitFor(() => expect(router.state.location.pathname).toBe('/success'));
    expect(created).toBe(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(requests).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
