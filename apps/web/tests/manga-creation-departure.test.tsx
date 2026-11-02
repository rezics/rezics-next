import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import type { MangaCommand, MangaTransport } from '../src/features/catalogue/manga-profile';
import type { CreateResult } from '../src/features/catalogue/create-subject';

test('Manga departure retains hidden and nested drafts, exact recovery, and fences retired callers', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/manga' });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const key of [
    'HTMLElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'HTMLTextAreaElement',
    'HTMLButtonElement',
    'Element',
    'Node',
    'Text',
    'NodeFilter',
    'Document',
    'ShadowRoot',
    'Event',
    'KeyboardEvent',
    'FocusEvent',
    'MouseEvent',
    'PointerEvent',
    'CSS',
    'DocumentFragment',
    'DOMParser',
    'MutationObserver',
    'ResizeObserver',
    'Range',
    'DOMRect',
  ])
    globals[key] = window[key];
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia'])
    globals[key] = window[key].bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { MangaProfileEditor } = await import('../src/features/catalogue/manga-profile-view');
  const { candidateSession } = await import('../src/subject/candidate-lifetime');
  const { sessionQuery } = await import('../src/session/query');
  const { mangaFixture, mangaSeriesId } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Editor = candidateSession(MangaProfileEditor);
  const owner = { state: 'signed-in' as const, subject: mangaSeriesId, csrfToken: 'original-token' };
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const until = async (ready: () => boolean) => {
    for (let n = 0; n < 150 && !ready(); n++) await settle();
    expect(ready()).toBe(true);
  };
  const body = () => within(document.body);
  const click = (name: string, scope: HTMLElement = host) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const replace = (name: string, value: string, scope: HTMLElement = host) =>
    act(async () => {
      const input = within(scope).getByRole('textbox', { name });
      await user.clear(input);
      if (value) await user.type(input, value);
    });
  const changeHandler = (element: HTMLElement) => {
    const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'))!;
    return (
      Reflect.get(element, key) as {
        onChange: (event: { target: { value: string } }) => void;
      }
    ).onChange;
  };
  const select = (name: string, value: string, scope: HTMLElement = host) =>
    act(async () => user.selectOptions(within(scope).getByRole('combobox', { name }), value));
  const blocked = () => !window.dispatchEvent(new window.Event('beforeunload', { cancelable: true }));
  const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const leaveAttempt = async () => {
    await act(async () => user.click(within(host).getByRole('link', { name: m.catalogue_create_search() })));
    await until(() => !!dialog());
  };
  const mount = async (fixture = mangaFixture('uncertain'), create = fixture.transport.create) => {
    await act(async () => root.render(null));
    client.clear();
    client.setQueryData(sessionQuery.queryKey, owner);
    const route = createRootRoute({ component: Outlet });
    const editor = createRoute({
      getParentRoute: () => route,
      path: '/en/catalogue/manga',
      component: () => (
        <Editor locale="en" session="signed-in" transport={{ ...fixture.transport, create }} search={async () => []} />
      ),
    });
    const search = createRoute({
      getParentRoute: () => route,
      path: '/en/search',
      component: () => <p>Search destination</p>,
    });
    const reader = createRoute({
      getParentRoute: () => route,
      path: '/en/subjects/$id/$slug',
      component: () => <p>Exact reader</p>,
    });
    const router = createRouter({
      routeTree: route.addChildren([editor, search, reader]),
      history: createMemoryHistory({ initialEntries: ['/en/catalogue/manga'] }),
    });
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await until(() => !!host.querySelector('fieldset') && !host.querySelector('fieldset')!.disabled);
    return router;
  };
  const add = async (group: string, property: string, title: string) => {
    await select(group, property);
    const picker = within(host).getByRole('combobox', { name: group });
    await click(m.correction_add(), picker.closest('section')!);
    return within(host).getByRole('region', { name: title });
  };
  try {
    let router = await mount();
    expect(blocked()).toBe(false);
    await act(async () => user.click(within(host).getByRole('link', { name: m.catalogue_create_search() })));
    await until(() => router.state.location.pathname === '/en/search');
    expect(dialog()).toBeNull();

    const recovery = mangaFixture();
    let rejectFirst = true;
    router = await mount(recovery, async (command) => {
      if (rejectFirst) {
        rejectFirst = false;
        return { ok: false, reason: 'invalid', errors: [] };
      }
      return recovery.transport.create(command);
    });
    await replace(m.catalogue_create_label(), 'Before recovery');
    await replace(m.catalogue_create_aliases(), 'Sibling alias');
    await click(m.manga_title());
    await until(() => host.textContent!.includes(m.correction_invalid()));
    const recoveredLabel = within(host).getByRole('textbox', { name: m.catalogue_create_label() });
    await act(async () => changeHandler(recoveredLabel)({ target: { value: 'Recovered title' } }));
    expect((within(host).getByRole('textbox', { name: m.catalogue_create_label() }) as HTMLInputElement).value).toBe(
      'Recovered title',
    );
    expect((within(host).getByRole('textbox', { name: m.catalogue_create_aliases() }) as HTMLTextAreaElement).value).toBe(
      'Sibling alias',
    );
    expect(host.textContent).not.toContain(m.correction_invalid());
    await click(m.manga_title());
    await until(() => host.textContent!.includes(m.manga_created()));

    const fixture = mangaFixture('uncertain');
    const commands: MangaCommand[] = [];
    let enterCreate!: () => void;
    let releaseCreate!: () => void;
    const createEntered = new Promise<void>((resolve) => (enterCreate = resolve));
    const createGate = new Promise<void>((resolve) => (releaseCreate = resolve));
    router = await mount(fixture, async (command) => {
      commands.push(command);
      const result = await fixture.transport.create(command);
      if (commands.length === 1) {
        enterCreate();
        await createGate;
      }
      return result;
    });
    await select(m.manga_grain(), 'schema:PublicationVolume');
    const isbnTitle = fixture.release.properties['schema:isbn']!.labels.en!;
    const isbn = await add(m.manga_publication(), 'schema:isbn', isbnTitle);
    await replace(m.correction_value(), '9781234567897', isbn);
    await select(m.manga_grain(), 'schema:ComicSeries');
    expect(blocked()).toBe(true);
    await leaveAttempt();
    await click(m.thread_authoring_stay(), dialog()!);
    await select(m.manga_grain(), 'schema:PublicationVolume');
    expect(
      (
        within(within(host).getByRole('region', { name: isbnTitle })).getByRole('textbox', {
          name: m.correction_value(),
        }) as HTMLInputElement
      ).value,
    ).toBe('9781234567897');
    await select(m.manga_grain(), 'schema:ComicSeries');
    const authored = await add(
      m.authored_title(),
      'schema:abstract',
      fixture.release.properties['schema:abstract']!.labels.en!,
    );
    await replace(m.authored_language(), 'ja', authored);
    await replace(m.authored_licence(), 'CC-BY-4.0', authored);
    await replace(m.relation_citation(), 'https://example.org/source', authored);
    await act(async () => {
      await user.click(authored.querySelector<HTMLElement>('[contenteditable="true"]')!);
      await user.keyboard('Original writing');
      await user.tab();
      await user.click(within(authored).getByRole('checkbox', { name: m.authored_original() }));
    });
    await select(m.manga_grain(), 'schema:PublicationVolume');
    // The only authored work is now in the hidden holder; returning to the initial Type below must retain it.
    expect(blocked()).toBe(true);
    await leaveAttempt();
    await click(m.thread_authoring_stay(), dialog()!);
    await select(m.manga_grain(), 'schema:ComicSeries');
    const restored = within(host).getByRole('region', {
      name: fixture.release.properties['schema:abstract']!.labels.en!,
    });
    expect((within(restored).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement).value).toBe(
      'https://example.org/source',
    );
    expect(restored.textContent).toContain('Original writing');
    expect(within(restored).getByRole('checkbox', { name: m.authored_original() }).getAttribute('aria-checked')).toBe(
      'true',
    );
    await replace(m.catalogue_create_label(), 'Paper');
    await click(m.catalogue_create_add_language());
    const labels = within(host).getAllByRole('textbox', { name: m.catalogue_create_label() });
    const languages = within(host).getAllByRole('textbox', { name: m.catalogue_create_language() });
    await act(async () => {
      await user.type(languages[1]!, 'ja');
      await user.type(labels[1]!, '紙の天文台');
    });
    const aliases = within(host).getAllByRole('textbox', { name: m.catalogue_create_aliases() });
    await act(async () => user.type(aliases[1]!, 'Paper alias'));
    await click(m.catalogue_create_add_language());
    const thirdLabel = within(host).getAllByRole('textbox', { name: m.catalogue_create_label() })[2]!;
    const removedLabel = changeHandler(thirdLabel);
    const removeButtons = within(host).getAllByRole('button', { name: m.catalogue_create_remove_language() });
    await act(async () => user.click(removeButtons.at(-1)!));
    await act(async () => removedLabel({ target: { value: 'Removed row mutation' } }));
    expect(within(host).getAllByRole('textbox', { name: m.catalogue_create_label() })).toHaveLength(2);

    const retained = [
      changeHandler(labels[1]!),
      changeHandler(aliases[1]!),
      changeHandler(languages[1]!),
    ];
    expect(commands).toHaveLength(0);
    await click(m.manga_title());
    await createEntered;
    const submittedCommand = commands[0]!;
    await act(async () => {
      retained[0]!({ target: { value: 'Late label' } });
      retained[1]!({ target: { value: 'Late alias' } });
      retained[2]!({ target: { value: 'fr' } });
    });
    expect((labels[1] as HTMLInputElement).value).toBe('紙の天文台');
    expect((aliases[1] as HTMLTextAreaElement).value).toBe('Paper alias');
    expect((languages[1] as HTMLInputElement).value).toBe('ja');
    expect(commands[0]).toBe(submittedCommand);
    releaseCreate();
    await until(() => commands.length === 1 && host.textContent!.includes(m.correction_unavailable()));
    const posts = () => fixture.calls.filter((call) => call.method === 'POST');
    const exact = structuredClone(posts()[0]);
    await act(async () => {
      retained[0]!({ target: { value: 'Late label' } });
      retained[1]!({ target: { value: 'Late alias' } });
      retained[2]!({ target: { value: 'fr' } });
    });
    expect((labels[1] as HTMLInputElement).value).toBe('紙の天文台');
    expect((aliases[1] as HTMLTextAreaElement).value).toBe('Paper alias');
    expect((languages[1] as HTMLInputElement).value).toBe('ja');
    expect(host.textContent).toContain(m.correction_unavailable());
    expect(commands[0]).toBe(submittedCommand);
    await leaveAttempt();
    expect(dialog()!.textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.thread_authoring_stay(), dialog()!);
    expect((labels[1] as HTMLInputElement).value).toBe('紙の天文台');
    await click(m.correction_retry());
    await until(() => host.textContent!.includes(m.manga_created()));
    expect(commands[1]).toBe(commands[0]);
    expect(posts()[1]).toEqual(exact);
    expect(commands[1]!.item.labels.ja).toBe('紙の天文台');
    expect(JSON.stringify(commands[1]!.item.statements)).toContain('Original writing');
    expect(JSON.stringify(commands[1]!.item.statements)).toContain('https://example.org/source');
    expect(JSON.stringify(commands[1]!.item.statements)).toContain('CC-BY-4.0');
    expect(blocked()).toBe(false);
    const link = within(host).getByRole('link', { name: m.candidate_view_public() });
    const href = link.getAttribute('href')!;
    await act(async () => user.click(link));
    await until(() => router.state.location.href === href);
    expect(dialog()).toBeNull();

    let finish!: (result: CreateResult) => void;
    let calls = 0;
    const pending: MangaTransport['create'] = () => {
      calls++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    router = await mount(mangaFixture(), pending);
    await replace(m.catalogue_create_label(), 'Unresolved');
    await click(m.manga_title());
    await leaveAttempt();
    expect(dialog()!.textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.thread_authoring_leave(), dialog()!);
    await until(() => router.state.location.pathname === '/en/search');
    expect(blocked()).toBe(false);
    await act(async () => router.navigate({ to: '/en/catalogue/manga' }));
    await until(() => !!host.querySelector('form'));
    await act(async () => finish({ ok: true, id: mangaSeriesId, reader: { state: 'ready', href } }));
    expect(host.textContent).not.toContain(m.manga_created());
    expect((within(host).getByRole('textbox', { name: m.catalogue_create_label() }) as HTMLInputElement).value).toBe(
      '',
    );
    expect(calls).toBe(1);
    for (const session of [
      { ...owner, csrfToken: 'replacement-token' },
      { ...owner, subject: 'another-viewer' },
    ]) {
      router = await mount(mangaFixture(), pending);
      await replace(m.catalogue_create_label(), 'Retiring');
      const retiredLabelChange = changeHandler(
        within(host).getByRole('textbox', { name: m.catalogue_create_label() }),
      );
      await click(m.manga_title());
      await leaveAttempt();
      await act(async () => client.setQueryData(sessionQuery.queryKey, session));
      await until(() => !dialog());
      expect(blocked()).toBe(false);
      await until(() => !!within(host).queryByRole('textbox', { name: m.catalogue_create_label() }));
      await act(async () => retiredLabelChange({ target: { value: 'Retired reader mutation' } }));
      expect(
        (within(host).getByRole('textbox', { name: m.catalogue_create_label() }) as HTMLInputElement).value,
      ).toBe('');
      await act(async () => finish({ ok: true, id: mangaSeriesId, reader: { state: 'ready', href } }));
      expect(host.textContent).not.toContain(m.manga_created());
      await act(async () => router.navigate({ to: '/en/search' }));
      await until(() => router.state.location.pathname === '/en/search');
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
