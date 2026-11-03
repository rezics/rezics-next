import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Game departure preserves every private holder on Stay and permanently releases recovery on Leave', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/edit' });
  const globals = {
    ...Object.fromEntries(
      'document navigator HTMLElement HTMLFormElement HTMLInputElement HTMLSelectElement HTMLButtonElement Node Element Document DocumentFragment MutationObserver ResizeObserver'
        .split(' ')
        .map((key) => [key, Reflect.get(window, key)]),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { gameProfileFixture, gameId } = await import('../src/kernel/fake/catalogue-game-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = gameProfileFixture('ready', 'en', true);
  const initial = await fixture.transport.load();
  if (!initial.ok || !initial.public) throw new Error('Expected an existing Game');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  let readable = true,
    csrfToken = 'original',
    held: Promise<void> | undefined,
    destination: Promise<void> | undefined;
  let entered = 0;
  const transport = {
    ...fixture.transport,
    load: async () => (readable ? structuredClone(initial) : { ok: false as const, reason: 'unavailable' as const }),
    classifications: {
      ...fixture.transport.classifications,
      propose: async (command: Parameters<typeof fixture.transport.classifications.propose>[0]) => {
        const result = await fixture.transport.classifications.propose(command);
        if (held) await held;
        return result;
      },
    },
  };
  const base = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/edit'] }),
    routeTree: base.addChildren([
      createRoute({
        getParentRoute: () => base,
        path: '/edit',
        component: () => (
          <CandidateReaderBoundary observed={{ state: 'signed-in', subject: gameId, csrfToken }} address={gameId}>
            <GameProfile
              id={gameId}
              locale="en"
              session="signed-in"
              transport={transport}
              search={async () => []}
              onNavigate={() => {}}
            />
          </CandidateReaderBoundary>
        ),
      }),
      createRoute({
        getParentRoute: () => base,
        path: '/away',
        loader: async () => {
          entered++;
          await destination;
        },
        component: () => <p>Destination</p>,
      }),
    ]),
  });
  const click = (node: HTMLElement) => act(async () => user.click(node));
  const button = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name });
  const details = (name: string) =>
    [...host.querySelectorAll<HTMLElement>('details')].find(
      (node) => node.querySelector('summary')?.textContent === name,
    )!;
  const classification = () => details(m.game_profile_classification());
  const platform = () => host.querySelector<HTMLElement>('[data-classification-property="schema:gamePlatform"]')!;
  const input = () => within(platform()).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
  const fill = (field: HTMLInputElement, value: string) =>
    act(async () => {
      await user.clear(field);
      await user.type(field, value);
    });
  const popup = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const unload = () => !window.dispatchEvent(new window.Event('beforeunload', { cancelable: true }));
  const writes = () => fixture.calls.filter((call) => call.method === 'POST');
  const ready = () => waitFor(() => expect(host.textContent).toContain(m.game_profile_current()));
  const go = async (to: '/edit' | '/away') => {
    await act(async () => {
      void router.navigate({ to });
    });
  };
  const stay = async () => {
    await go('/away');
    await waitFor(() => expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1));
    await click(button(popup()!, m.thread_authoring_stay()));
    expect(router.state.location.pathname).toBe('/edit');
  };
  const edit = async () => {
    await click(within(platform()).getAllByRole('button', { name: m.facts_edit_field() })[0]!);
    await fill(input(), 'fr');
  };
  const submit = async () => {
    const review = within(classification()).queryByRole('button', { name: m.facts_review() });
    if (review && !(review as HTMLButtonElement).disabled) await click(review);
    await click(button(classification(), m.facts_submit()));
  };
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    await ready();
    expect(unload()).toBe(false);
    for (const name of [m.game_profile_classification(), m.game_profile_facts(), m.game_profile_relations()])
      details(name).setAttribute('open', '');
    await click(within(platform()).getAllByRole('button', { name: m.facts_edit_field() })[0]!);
    expect(unload()).toBe(false); // An unchanged source copy has no unfinished change.
    await fill(input(), 'fr');
    expect(unload()).toBe(true);
    await fill(input(), 'ja');
    expect(unload()).toBe(false);
    const facts = details(m.game_profile_facts());
    const stage = within(facts)
      .getAllByRole('button', { name: m.facts_edit_field() })
      .find((node) => !(node as HTMLButtonElement).disabled)!;
    await click(stage);
    const included = within(facts).getByRole('checkbox', { name: m.facts_include() });
    await click(included);
    expect(unload()).toBe(true); // Exclusion never discards a sibling's private assertion.
    const relations = details(m.game_profile_relations());
    const property = within(relations).getByLabelText(m.relation_property()) as HTMLSelectElement;
    await act(async () => user.selectOptions(property, 'schema:author'));
    await fill(input(), 'fr');
    const fields = [...host.querySelectorAll<HTMLInputElement>('input')],
      values = fields.map((field) => field.value);
    await stay();
    expect([...host.querySelectorAll('input')]).toEqual(fields);
    expect(fields.map((field) => field.value)).toEqual(values);
    expect(included.getAttribute('aria-checked')).toBe('false');
    expect(property.value).toBe('schema:author');
    expect(writes()).toHaveLength(0); // Observing dirtiness neither validates nor submits.
    readable = false;
    await click(button(host, m.game_profile_refresh()));
    await waitFor(() => expect(host.textContent).toContain(m.game_profile_refresh_failed()));
    expect(host.querySelector('input')).toBeNull();
    expect(unload()).toBe(true);
    await stay();
    readable = true;
    await click(button(host, m.game_profile_refresh()));
    await ready();
    expect(input().value).toBe('fr');
    expect(
      within(details(m.game_profile_facts()))
        .getByRole('checkbox', { name: m.facts_include() })
        .getAttribute('aria-checked'),
    ).toBe('false');
    csrfToken = 'replacement';
    await act(async () => {
      await router.invalidate();
    });
    await ready();
    expect(unload()).toBe(false); // Caller retirement releases every old holder.
    fixture.setScenario('uncertain');
    await edit();
    await submit();
    await waitFor(() => expect(writes()).toHaveLength(1));
    const original = structuredClone(writes()[0]);
    await stay();
    expect(unload()).toBe(true);
    expect(input().closest('fieldset')?.disabled).toBe(true);
    fixture.setScenario('ready');
    await submit();
    await waitFor(() => expect(host.textContent).toContain(m.correction_proposed()));
    expect(writes()[1]).toEqual(original); // Body, key and credential belong to the original command.
    expect(unload()).toBe(false);
    await click(button(classification(), m.correction_review()));
    expect(popup()).toBeNull();
    await go('/away');
    await waitFor(() => expect(router.state.location.pathname).toBe('/away'));
    await go('/edit');
    await ready();
    details(m.game_profile_classification()).setAttribute('open', '');
    const delivery = Promise.withResolvers<void>(),
      arrival = Promise.withResolvers<void>();
    held = delivery.promise;
    destination = arrival.promise;
    await edit();
    await submit();
    await waitFor(() => expect(writes()).toHaveLength(3));
    await stay();
    await go('/away');
    await waitFor(() => expect(popup()).not.toBeNull());
    await click(button(popup()!, m.thread_authoring_leave()));
    await waitFor(() => expect(entered).toBe(2));
    expect(unload()).toBe(false); // Release precedes completion of destination reads.
    await act(async () => delivery.resolve());
    expect(host.textContent).not.toContain(m.correction_proposed());
    await act(async () => arrival.resolve());
    await waitFor(() => expect(router.state.location.pathname).toBe('/away'));
    held = destination = undefined;
    await go('/edit');
    await ready();
    expect(unload()).toBe(false);
    expect(host.textContent).not.toContain(m.correction_proposed());
    expect(platform().querySelector('fieldset')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    mock.restore();
  }
});
