import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GameRead } from '../src/features/catalogue/game-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Game refresh keeps local corrections and labelled evidence, recovers, and retires concealed readings', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/game' });
  const globals = {
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLSelectElement',
        'HTMLButtonElement',
        'Node',
        'Element',
        'Document',
        'DocumentFragment',
        'MutationObserver',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
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
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let outcome: GameRead | Error = initial;
  let loads = 0;
  const transport = {
    ...fixture.transport,
    load: async () => {
      loads++;
      if (outcome instanceof Error) throw outcome;
      return structuredClone(outcome);
    },
  };
  const click = async (node: HTMLElement) => {
    await act(async () => user.click(node));
  };
  const refresh = () => within(host).getByRole('button', { name: m.game_profile_refresh() });
  const status = (message: string) => waitFor(() => expect(host.textContent).toContain(message));
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <GameProfile
            id={gameId}
            locale="en"
            session="signed-in"
            transport={transport}
            search={async () => []}
            onNavigate={() => {}}
          />
        </QueryClientProvider>,
      ),
    );
    await status(m.game_profile_current());
    // Reference fields and qualifier fields remain identifiable, scoped to the actual statement.
    const citation = host.querySelector('a[href="https://example.test/game-notes"]')!.closest('dl')!;
    expect(citation.querySelector('dt')?.textContent).toBe(initial.release.properties['schema:url']!.labels.en);
    const summary = [...host.querySelectorAll<HTMLElement>('summary')].find(
      (node) => node.textContent === m.game_profile_classification(),
    )!;
    await click(summary);
    const region = host.querySelector<HTMLElement>('[data-slot="game-classification"]')!;
    await click(within(region).getByRole('button', { name: m.facts_edit_field() }));
    const input = within(region).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
    await act(async () => {
      await user.clear(input);
      await user.type(input, 'fr');
    });
    for (const failure of [{ ok: false, reason: 'unavailable' } as GameRead, new Error('temporary read failure')]) {
      outcome = failure;
      await click(refresh());
      await status(m.game_profile_refresh_failed());
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe('fr');
      expect(summary.closest('details')?.open).toBe(true);
      outcome = structuredClone(initial);
      if (outcome.ok && outcome.public) outcome.public.subject.labels.en = 'Recovered current Game';
      await click(within(host).getByRole('button', { name: m.catalogue_create_retry() }));
      await status('Recovered current Game');
      await status(m.game_profile_current());
      expect(input.isConnected).toBe(true);
      expect(input.value).toBe('fr');
    }
    expect(loads).toBe(5);
    for (const concealed of [{ ok: false, reason: 'denied' } as GameRead, { ...initial, public: null }]) {
      outcome = concealed;
      await click(refresh());
      await waitFor(() => expect(host.querySelector('nav')).toBeNull());
      expect(host.textContent).not.toContain('Recovered current Game');
      expect(input.isConnected).toBe(false);
      outcome = { ok: false, reason: 'unavailable' };
      await click(refresh());
      expect(host.textContent).not.toContain('The Lantern Game');
      outcome = initial;
      await click(refresh());
      await status(m.game_profile_current());
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(oldLocale, { reload: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
