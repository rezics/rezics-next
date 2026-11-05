import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Game source admission preserves Realm, refuses contradictory intent, and never substitutes a Global editor', async () => {
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
        'ResizeObserver',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    window,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
  const { GameProfileEntry } = await import('../src/features/catalogue/game-profile-entry');
  const { collectEditorialEntries } = await import('../src/features/catalogue/editorial-entry');
  const { gameVisitSearch, parseGameVisit } = await import('../src/features/catalogue/game-current-visit');
  const { readGameProfile } = await import('../src/features/catalogue/game-profile');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { candidateContext } = await import('../src/subject/candidates');
  const { gameProfileFixture, gameId } = await import('../src/kernel/fake/catalogue-game-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const fixture = gameProfileFixture('ready', 'en', true);
  const realm = '00000000-0000-4000-8000-00000000f201';
  const context = '00000000-0000-4000-8000-00000000f202';
  const props = {
    id: gameId,
    type: 'schema:VideoGame',
    label: 'The Lantern Game',
    locale: 'en',
    context: candidateContext,
    realm,
    release: fixture.publicRead.subject.release,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<GameProfileEntry {...props} />));
    const href = host.querySelector('a')!.getAttribute('href')!;
    // The installed Subject action is consumed into the contribution menu, not rendered as a raw child.
    expect(collectEditorialEntries(<GameProfileEntry {...props} />).entries[0]!.href).toBe(href);
    const parsed = parseGameVisit(new URL(href, window.location.origin).search, gameId, 'en');
    if (!parsed.valid) throw new Error('Expected admitted source intent');
    expect(parsed.visit).toMatchObject({ context: candidateContext, realm, type: props.type, release: props.release });
    expect(parsed.visit.source).toBe(`/en/subjects/${gameId}/the-lantern-game?realm=${realm}`);
    for (const search of [
      '?realm=' + realm,
      gameVisitSearch(parsed.visit) + '&context=' + candidateContext,
      gameVisitSearch({ ...parsed.visit, realm: context }),
      gameVisitSearch({ ...parsed.visit, source: 'https://site.test' + parsed.visit.source }),
      gameVisitSearch({ ...parsed.visit, source: parsed.visit.source!.replace('/en/', '/ja/') }),
      gameVisitSearch({ ...parsed.visit, source: parsed.visit.source + '&context=' + context }),
      '?source=' + '😀'.repeat(600),
    ])
      expect(parseGameVisit(search, gameId, 'en').valid).toBe(false);
    expect(parseGameVisit('', gameId, 'en')).toEqual({ valid: true, visit: { context: candidateContext } });

    let loads = 0;
    let hold: Promise<void> | undefined;
    let releaseRead!: () => void;
    const render = async (visit = parsed.visit, reader = gameId) => {
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <CandidateReaderBoundary
              observed={{ state: 'signed-in', subject: reader, csrfToken: reader }}
              address={gameVisitSearch(visit)}
            >
              <GameProfile
                id={gameId}
                locale="en"
                session="signed-in"
                visit={visit}
                transport={{
                  ...fixture.transport,
                  load: async () => {
                    loads++;
                    const result = await readGameProfile(fixture.client, gameId, visit);
                    if (hold) await hold;
                    return result;
                  },
                }}
                search={async () => []}
                onNavigate={() => {}}
              />
            </CandidateReaderBoundary>
          </QueryClientProvider>,
        ),
      );
    };
    await render();
    await waitFor(() => expect(host.textContent).toContain(m.game_profile_current()));
    // Actual generated native read and existing correction controls, not a URL-only assertion.
    expect(host.textContent).toContain('Example platform');
    expect(host.querySelector('[data-slot="game-classification"]')).not.toBeNull();
    expect(within(host).getByRole('link', { name: m.game_visit_return() }).getAttribute('href')).toBe(
      parsed.visit.source!,
    );
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const before = loads;
    fixture.publicRead.subject.context = context;
    await render({ ...parsed.visit, context });
    await waitFor(() => expect(host.textContent).toContain(m.game_visit_unsupported()));
    expect(host.querySelector('input, select, [data-slot="game-classification"]')).toBeNull();
    const global = within(host).getByRole('link', { name: m.game_visit_global() });
    expect(global.getAttribute('href')).toBe(`/en/subjects/${gameId}/the-lantern-game/game`);
    expect(loads).toBeGreaterThan(before);
    // A native body from another Context cannot authorize the requested visit.
    expect(await readGameProfile(fixture.client, gameId, parsed.visit)).toEqual({ ok: false, reason: 'stale' });
    fixture.publicRead.subject.context = candidateContext;
    const wrongType = { ...parsed.visit, type: 'wd:Q689445' };
    expect(await readGameProfile(fixture.client, gameId, wrongType)).toEqual({ ok: false, reason: 'stale' });
    expect(
      await readGameProfile(fixture.client, gameId, { ...parsed.visit, release: 'sha256:' + '0'.repeat(64) }),
    ).toEqual({ ok: false, reason: 'stale' });

    fixture.publicRead.subject.labels.en = 'X'.repeat(2 * 1024 * 1024);
    expect(await readGameProfile(fixture.client, gameId, parsed.visit)).toEqual({ ok: false, reason: 'unavailable' });
    fixture.publicRead.subject.labels.en = 'The Lantern Game';
    hold = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await render(parsed.visit);
    const readerB = '00000000-0000-4000-8000-00000000f203';
    await render(parsed.visit, readerB);
    await render(parsed.visit);
    expect(host.textContent).not.toContain('Example platform');
    await act(async () => {
      releaseRead();
    });
    await waitFor(() => expect(host.textContent).toContain(m.game_profile_current()));
    expect(loads).toBeGreaterThan(before + 3);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
