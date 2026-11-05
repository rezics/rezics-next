import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';
import type { EditorRead } from '../src/features/catalogue/statement-editor';

mock.module('cloudflare:workers', () => ({ env: {} }));
test('Album departure preserves all private siblings and exact retries, then permanently retires the leaving holder', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/edit' });
  const globals: Record<string, unknown> = { window, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of 'document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLFormElement Element Node MutationObserver ResizeObserver Document DocumentFragment'.split(
    ' ',
  ))
    globals[key] = Reflect.get(window, key);
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { AlbumProfile } = await import('../src/features/catalogue/album-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { albumFixture, albumId } = await import('../src/kernel/fake/catalogue-album-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = albumFixture();
  const property = 'schema:datePublished',
    sibling = 'schema:inLanguage';
  fixture.release.types['schema:MusicAlbum']!.properties.push(sibling);
  const source = fixture.publicRead.subject.statements[property]![0]!;
  source.qualifiers.push({ property: { id: sibling, data_type: 'string' }, value: { type: 'value', content: 'en' } });
  const initial = await fixture.loadCorrection();
  const current = await fixture.editors.facts.read();
  let next: EditorRead = current;
  const commands: FactCommand[] = [];
  let finish!: (result: FactResult) => void;
  const editors = {
    ...fixture.editors,
    facts: {
      read: async () => next,
      propose: async (command: FactCommand): Promise<FactResult> => {
        command.session ??= 'original-session';
        commands.push(command);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  let changeCaller!: (token: string) => void;
  function Surface() {
    const [csrfToken, setToken] = useState('first');
    changeCaller = setToken;
    return (
      <CandidateReaderBoundary observed={{ state: 'signed-in', subject: 'viewer', csrfToken }} address={albumId}>
        <AlbumProfile
          id={albumId}
          locale="en"
          session="signed-in"
          transport={{ ...fixture.transport, load: async () => initial }}
          search={async () => []}
          editors={editors}
        />
      </CandidateReaderBoundary>
    );
  }
  const base = createRootRoute({ component: Outlet });
  const edit = createRoute({ getParentRoute: () => base, path: '/edit', component: Surface });
  const away = createRoute({ getParentRoute: () => base, path: '/away', component: () => <p>Destination</p> });
  const router = createRouter({
    routeTree: base.addChildren([edit, away]),
    history: createMemoryHistory({ initialEntries: ['/edit'] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const settle = (action: () => void = () => {}) =>
    act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  const click = (name: string, scope = host) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const field = (id: string) => within(host).getByRole('region', { name: fixture.release.properties[id]!.labels.en! });
  const input = (id: string, name: string) => within(field(id)).getByRole('textbox', { name }) as HTMLInputElement;
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const navigate = (to: '/away' | '/edit') =>
    settle(() => {
      void router.navigate({ to });
    });
  const dialog = () => within(window.document.body as unknown as HTMLElement).getByRole('alertdialog');
  const stage = () => click(m.facts_edit_field(), field(property));
  const editYear = () =>
    act(async () => {
      const year = input(property, m.correction_year());
      await user.clear(year);
      await user.type(year, '2025');
    });
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
    expect(unload()).toBe(false); // A source copy is still pristine.
    expect(commands).toHaveLength(0);
    await navigate('/away');
    expect(router.state.location.pathname).toBe('/away');
    await navigate('/edit');
    await stage();
    await editYear();
    await click(m.facts_edit_field(), field(sibling));
    const language = input(sibling, m.correction_value());
    await act(async () => user.type(language, 'fr'));
    const include = within(field(sibling)).getByRole('checkbox', { name: m.facts_include() });
    await act(async () => user.click(include));
    const year = input(property, m.correction_year()),
      citation = input(property, m.correction_url());
    await act(async () =>
      user.selectOptions(within(host).getByRole('combobox', { name: m.relation_property() }), 'schema:contributor'),
    );
    const relationCitation = within(host).getByRole('textbox', { name: m.relation_citation() }) as HTMLInputElement;
    await act(async () => user.type(relationCitation, 'https://example.test/credit'));
    expect(unload()).toBe(true);
    await navigate('/away');
    expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    await click(m.thread_authoring_stay(), dialog());
    expect(input(property, m.correction_year())).toBe(year);
    expect(citation.value).toBe('https://artist.example/harbour');
    expect(language.value).toBe('fr');
    expect(include.getAttribute('aria-checked')).toBe('false');
    expect(relationCitation.value).toBe('https://example.test/credit');
    expect(commands).toHaveLength(0); // Observing dirty state prepares no command.
    await click(m.facts_submit());
    expect(commands).toHaveLength(1);
    const original = commands[0]!,
      sealed = structuredClone(original);
    expect(original.statement.qualifiers).toEqual([
      { property: { id: sibling }, value: { type: 'value', content: 'en' } },
    ]);
    expect(original.statement.references[0]!.parts[0]!.value.content).toBe(citation.value);
    await navigate('/away');
    expect(dialog().textContent).toContain(m.thread_authoring_leave_pending());
    await click(m.thread_authoring_stay(), dialog());
    expect(router.state.location.pathname).toBe('/edit');
    expect(input(sibling, m.correction_value())).toBe(language);
    await settle(() => finish({ ok: false, reason: 'uncertain' }));
    next = { ok: false, reason: 'unavailable' };
    await click(m.correction_reload());
    expect(host.querySelectorAll('input')).toHaveLength(0);
    expect(unload()).toBe(true); // A failed current read retains the private holder.
    await navigate('/away');
    await click(m.thread_authoring_stay(), dialog());
    next = current;
    await click(m.correction_retry());
    await settle();
    expect(input(sibling, m.correction_value()).value).toBe('fr');
    expect(within(field(sibling)).getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
    await click(m.facts_submit());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(original);
    expect(commands[1]).toEqual(sealed);
    const late = finish;
    await navigate('/away');
    await click(m.thread_authoring_leave(), dialog());
    await settle();
    expect(router.state.location.pathname).toBe('/away');
    expect(unload()).toBe(false);
    await navigate('/edit');
    await settle(() => late({ ok: true, candidate: crypto.randomUUID(), session: 'late-session' }));
    expect(host.textContent).not.toContain(m.correction_proposed());
    expect(unload()).toBe(false);
    await stage();
    await editYear();
    await click(m.facts_submit());
    await settle(() => finish({ ok: true, candidate: crypto.randomUUID(), session: 'confirmed-session' }));
    expect(unload()).toBe(false); // Confirmed results alone need no decision.
    await act(async () => user.click(within(field(property)).getByRole('link', { name: m.correction_review() })));
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    await navigate('/away');
    expect(router.state.location.pathname).toBe('/away');
    await navigate('/edit');
    await stage();
    await editYear();
    expect(unload()).toBe(true);
    await settle(() => changeCaller('replacement'));
    expect(unload()).toBe(false);
    expect(host.textContent).not.toContain(m.facts_private());
    await navigate('/away');
    expect(router.state.location.pathname).toBe('/away');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
