import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AlbumCommand, AlbumTransport } from '../src/features/catalogue/album-profile';

test('Album departure retains mounted nested drafts and native retries, then fences Leave and caller retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/catalogue/album' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'navigator HTMLElement HTMLInputElement HTMLFormElement Element Node NodeFilter Document ShadowRoot DocumentFragment MutationObserver ResizeObserver'.split(
    ' ',
  ))
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const testing = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', testing));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testing));
  const { AlbumProfileCreate } = await import('../src/features/catalogue/album-profile-create');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { albumFixture, albumId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { release } = albumFixture();
  const client = new QueryClient(),
    user = userEvent.setup({ document: window.document });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const commands: AlbumCommand[] = [];
  let finish!: (result: Awaited<ReturnType<AlbumTransport['create']>>) => void;
  let metadata = true;
  const transport: AlbumTransport = {
    load: async () => ({ ok: true, release, public: null }),
    read: async () => ({ state: 'unavailable' }),
    create: async (command) => {
      Object.assign(command, { credential: 'original-credential' });
      commands.push(command);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const parent = createRootRoute({ component: Outlet });
  const create = createRoute({
    getParentRoute: () => parent,
    path: '/catalogue/album',
    component: () => (
      <AlbumProfileCreate
        release={release}
        metadataCurrent={() => metadata}
        onReload={async () => {}}
        locale="en"
        transport={transport}
        search={async () => []}
        enabled
      />
    ),
  });
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => <p>Destination</p> });
  const router = createRouter({
    routeTree: parent.addChildren([create, away]),
    history: createMemoryHistory({ initialEntries: ['/catalogue/album'] }),
  });
  const paint = (csrfToken = 'first') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: 'viewer', csrfToken }}
            address="album-create"
          >
            <RouterProvider router={router} />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  const click = (name: string) => act(async () => user.click(within(document.body).getByRole('button', { name })));
  const type = (name: string, value: string) =>
    act(async () => user.type(within(host).getByRole('textbox', { name }), value));
  const select = (name: string, value: string) =>
    act(async () => user.selectOptions(within(host).getByRole('combobox', { name }), value));
  const go = (to = '/away') =>
    act(async () => {
      void router.navigate({ to });
    });
  const blocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const draft = () =>
    [...host.querySelectorAll<HTMLInputElement>('input,textarea,select')].map((node) => [node.id, node.value]);
  const success = { ok: true as const, id: albumId, reader: { state: 'ready' as const, href: '/returned-album' } };
  try {
    await act(async () => router.load());
    await paint();
    expect(blocked()).toBe(false);
    await go();
    expect(host.textContent).toContain('Destination');
    await go('/catalogue/album');
    await click(m.catalogue_create_add_language());
    expect(blocked()).toBe(false); // Extra blank language scaffolding retains its existing meaning.
    await select(m.character_add_fact(), 'schema:contributor');
    await click(m.correction_add());
    expect(blocked()).toBe(true); // An explicitly added fact counts even before its value is entered.
    await type(m.relation_citation(), 'https://example.test/source');
    await select(m.relation_qualifier(), 'wdt:P1932');
    await click(m.relation_add_qualifier());
    await type(release.properties['wdt:P1932']!.labels.en!, 'Private credit');
    const retained = draft(),
      control = host.querySelector('[id^="album-citation-"]');
    metadata = false;
    await paint();
    await go();
    await click(m.thread_authoring_stay());
    expect(router.state.location.pathname).toBe('/catalogue/album');
    metadata = true;
    await paint();
    expect(draft()).toEqual(retained);
    expect(host.querySelector('[id^="album-citation-"]')).toBe(control);
    expect(commands).toHaveLength(0);
    await go();
    await click(m.thread_authoring_leave());
    await go('/catalogue/album');
    expect(blocked()).toBe(false);
    expect(host.textContent).not.toContain('Private credit');
    await type(m.catalogue_create_label(), 'Private Album');
    await click(m.album_create());
    const exact = structuredClone(commands[0]);
    await go();
    expect(document.body.textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.thread_authoring_stay());
    expect(commands[0]).toEqual(exact);
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    await click(m.catalogue_create_retry());
    expect(commands[1]).toBe(commands[0]);
    expect(commands[1]).toEqual(exact);
    await act(async () => finish(success));
    expect(blocked()).toBe(false);
    expect(within(host).getByRole('link', { name: m.catalogue_create_open() }).getAttribute('href')).toBe(
      '/returned-album',
    );
    await go();
    await go('/catalogue/album');
    await type(m.catalogue_create_label(), 'Sent before Leave');
    await click(m.album_create());
    const lateLeave = finish;
    await go();
    await click(m.thread_authoring_leave());
    await go('/catalogue/album');
    await act(async () => lateLeave(success));
    expect(blocked()).toBe(false);
    expect(host.textContent).not.toContain(albumId);
    await type(m.catalogue_create_label(), 'Old caller');
    await click(m.album_create());
    const lateCaller = finish;
    await paint('replacement');
    await act(async () => lateCaller(success));
    expect(blocked()).toBe(false);
    expect(host.textContent).not.toContain(albumId);
    expect((within(host).getByRole('textbox', { name: m.catalogue_create_label() }) as HTMLInputElement).value).toBe(
      '',
    );
    expect(commands).toHaveLength(4);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of saved)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
});
