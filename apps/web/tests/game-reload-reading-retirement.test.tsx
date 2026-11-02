import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Game reload retires its current reading at start and keeps private corrections for matching recovery', async () => {
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
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let loads = 0;
  let entered!: () => void;
  let release!: () => void;
  const loadEntered = new Promise<void>((resolve) => (entered = resolve));
  const pendingLoad = new Promise<void>((resolve) => (release = resolve));
  const transport = {
    ...fixture.transport,
    load: async () => {
      loads++;
      if (loads === 1) return structuredClone(initial);
      entered();
      await pendingLoad;
      return structuredClone(initial);
    },
  };
  const click = async (node: HTMLElement) => act(async () => user.click(node));
  const status = (message: string) => waitFor(() => expect(host.textContent).toContain(message));
  const refresh = () => within(host).getByRole('button', { name: m.game_profile_refresh() });
  const queued = (element: HTMLElement) => {
    const key = Object.keys(element).find((item) => item.startsWith('__reactProps$'))!;
    const props = Reflect.get(element, key) as { onClick: (event: unknown) => void };
    return () => props.onClick({ currentTarget: element, preventDefault() {} });
  };
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            CandidateReaderBoundary,
            { observed: { state: 'signed-in', subject: gameId, csrfToken: 'original-session' }, address: gameId },
            createElement(GameProfile, {
              id: gameId,
              locale: 'en',
              session: 'signed-in',
              transport,
              search: async () => [],
              onNavigate: () => {},
            }),
          ),
        ),
      ),
    );
  try {
    await render();
    await status(m.game_profile_current());
    const summary = [...host.querySelectorAll('summary')].find(
      (node) => node.textContent === m.game_profile_classification(),
    )!;
    await click(summary);
    const region = host.querySelector<HTMLElement>('[data-slot="game-classification"]')!;
    await click(within(region).getByRole('button', { name: m.facts_edit_field() }));
    const input = within(region).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
    await act(async () => {
      await user.clear(input);
      await user.type(input, 'private draft');
    });
    const oldRefresh = queued(refresh());
    await click(refresh());
    await loadEntered;
    expect(loads).toBe(2);
    expect(host.textContent).not.toContain(m.game_profile_current());
    expect(host.querySelector('nav')).toBeNull();
    expect(input.isConnected).toBe(false);
    await act(async () => oldRefresh());
    expect(loads).toBe(2);
    await act(async () => {
      release();
      await pendingLoad;
    });
    await status(m.game_profile_current());
    expect(within(host).getByRole('textbox', { name: m.correction_value() })).toHaveProperty('value', 'private draft');
    await act(async () => oldRefresh());
    expect(loads).toBe(2);
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
