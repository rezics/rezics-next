import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GameReaderReady } from '../src/features/catalogue/game-reader/model';
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
  const { GameReader } = await import('../src/features/catalogue/game-reader/view');
  const { isolatedWorkReading } = await import('../src/features/catalogue/work-reading-port');
  const { collectEditorialEntries } = await import('../src/features/catalogue/editorial-entry');
  const { gameVisitSearch, parseGameVisit } = await import('../src/features/catalogue/game-current-visit');
  const { consumeGameClassificationReturn, gameClassificationReturn } =
    await import('../src/features/catalogue/game-current-visit-descriptor');
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
  const concept = '00000000-0000-4000-8000-00000000f105';
  const firstAssertion = '00000000-0000-4000-8000-00000000f111';
  const secondAssertion = '00000000-0000-4000-8000-00000000f112';
  const firstEvidence = 'https://example.test/first-genre-source';
  const secondEvidence = 'https://example.test/selected-genre-source';
  fixture.publicRead.related[concept] = { type: 'skos:Concept', labels: { en: 'Adventure' } };
  const genreAssertion = (id: string, citation: string) => ({
    id,
    property: { id: 'schema:genre', data_type: 'wikibase-item' },
    value: { type: 'value', content: concept },
    rank: 'normal',
    qualifiers: [],
    references: [
      {
        hash: citation,
        parts: [{ property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: citation } }],
      },
    ],
    rezics: { release: fixture.publicRead.subject.release, revision: fixture.publicRead.subject.revision },
  });
  fixture.publicRead.subject.statements['schema:genre'] = [
    genreAssertion(firstAssertion, firstEvidence),
    genreAssertion(secondAssertion, secondEvidence),
  ];
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
    reader: null,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  const readerHost = window.document.createElement('aside') as HTMLElement;
  const cancelledHost = window.document.createElement('aside') as HTMLElement;
  window.document.body.append(host);
  window.document.body.append(readerHost);
  window.document.body.append(cancelledHost);
  const root = createRoot(host);
  const readerRoot = createRoot(readerHost);
  const cancelledRoot = createRoot(cancelledHost);
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
                reader={visit.reader ?? null}
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
    expect(within(host).queryByRole('heading', { name: m.game_visit_inspection_title() })).toBeNull();
    const selectedVisit = {
      ...parsed.visit,
      reader: null,
      selection: { holder: gameId, property: 'schema:genre', statement: secondAssertion },
    };
    const selectedInput = parseGameVisit(gameVisitSearch(selectedVisit), gameId, 'en');
    if (!selectedInput.valid) throw new Error('Expected an admitted exact assertion locator');
    await render(selectedInput.visit);
    await waitFor(() => expect(host.textContent).toContain(m.game_profile_current()));
    const currentInspection = within(host).getByRole('heading', { name: m.game_visit_inspection_title() });
    expect(currentInspection.parentElement!.parentElement!.querySelector(`a[href="${secondEvidence}"]`)).not.toBeNull();
    expect(currentInspection.parentElement!.parentElement!.querySelector(`a[href="${firstEvidence}"]`)).toBeNull();
    const admittedInspectors = within(host).getAllByRole('button', {
      name: m.game_visit_inspect_assertion({ property: 'genre' }),
    });
    expect(admittedInspectors).toHaveLength(2);
    await act(async () => {
      host
        .querySelector<HTMLElement>(`[data-game-inspect-assertion="${firstAssertion}"]`)!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const chosenFirst = within(host).getByRole('heading', { name: m.game_visit_inspection_title() });
    expect(chosenFirst.parentElement!.parentElement!.getAttribute('data-game-inspected-assertion')).toBe(
      firstAssertion,
    );
    expect(chosenFirst.parentElement!.parentElement!.querySelector(`a[href="${firstEvidence}"]`)).not.toBeNull();
    expect(chosenFirst.parentElement!.parentElement!.querySelector(`a[href="${secondEvidence}"]`)).toBeNull();
    await act(async () => {
      within(host)
        .getByRole('button', { name: m.game_visit_close_inspection() })
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() =>
      expect(within(host).queryByRole('heading', { name: m.game_visit_inspection_title() })).toBeNull(),
    );
    await act(async () => {
      within(host)
        .getByRole('button', { name: m.game_profile_refresh() })
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => expect(host.textContent).toContain(m.game_profile_current()));
    expect(within(host).queryByRole('heading', { name: m.game_visit_inspection_title() })).toBeNull();
    const inspectors = within(host).getAllByRole('button', {
      name: m.game_visit_inspect_assertion({ property: 'genre' }),
    });
    expect(inspectors).toHaveLength(2);
    await act(async () => {
      inspectors[1]!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    const inspectionHeading = within(host).getByRole('heading', { name: m.game_visit_inspection_title() });
    const inspection = inspectionHeading.parentElement!.parentElement!;
    expect(inspection.querySelector(`a[href="${secondEvidence}"]`)).not.toBeNull();
    expect(inspection.querySelector(`a[href="${firstEvidence}"]`)).toBeNull();
    const returnLink = within(host).getByRole('link', { name: m.game_visit_return() });
    returnLink.focus();
    returnLink.addEventListener('click', (event) => event.preventDefault(), { once: true });
    await act(async () => {
      returnLink.dispatchEvent(
        new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 0 }),
      );
    });
    const returnHref = returnLink.getAttribute('href')!;
    const returnFragment = new URL(returnHref, window.location.origin).hash;
    const returnDescriptor = gameClassificationReturn(returnFragment);
    expect(returnDescriptor).toMatchObject({
      holder: gameId,
      context: candidateContext,
      realm,
      type: props.type,
      locale: 'en',
      release: props.release,
      reader: null,
      property: 'schema:genre',
      statement: secondAssertion,
      focus: 'keyboard',
      source: parsed.visit.source,
    });
    expect(consumeGameClassificationReturn(window.sessionStorage, returnHref)).toBe(true);
    expect(consumeGameClassificationReturn(window.sessionStorage, returnHref)).toBe(false);
    expect(gameClassificationReturn(`${returnFragment}&unknown=extra`)).toBeUndefined();
    expect(gameClassificationReturn(`${returnFragment}&statement=${secondAssertion}`)).toBeUndefined();
    if (!returnDescriptor) throw new Error('Expected current assertion return descriptor');
    const { pickText: readPickText } = await import('@rezics/composition');
    const currentPublicRead = structuredClone(fixture.publicRead);
    const publicRelease = fixture.release;
    const readerReady = {
      ok: true,
      public: currentPublicRead,
      digest: currentPublicRead.subject.release,
      admitted: true,
      grain: readPickText(publicRelease.types['schema:VideoGame']!.labels, 'en'),
      groups: [
        {
          id: 'classification',
          fields: [
            {
              property: 'schema:genre',
              label: readPickText(publicRelease.properties['schema:genre']!.labels, 'en'),
              date: false,
              statements: currentPublicRead.subject.statements['schema:genre'] ?? [],
            },
          ],
        },
      ],
      unsupported: [],
      editions: [],
      editionTypes: [],
      editionsAdmitted: false,
      next: null,
      caughtUp: true,
      labels: {
        'schema:genre': readPickText(publicRelease.properties['schema:genre']!.labels, 'en'),
      },
    } as unknown as GameReaderReady;
    let resolveReader!: (page: GameReaderReady) => void;
    const readPage = new Promise<GameReaderReady>((resolve) => {
      resolveReader = resolve;
    });
    await act(async () =>
      readerRoot.render(
        <QueryClientProvider client={client}>
          <GameReader
            id={gameId}
            context={candidateContext}
            type="schema:VideoGame"
            locale="en"
            realm={realm}
            source={currentPublicRead}
            reader={null}
            returnSelection={returnDescriptor}
            transport={() => readPage}
            reading={isolatedWorkReading}
          />
        </QueryClientProvider>,
      ),
    );
    expect(readerHost.querySelector(`[data-game-current-assertion="${secondAssertion}"]`)).toBeNull();
    await act(async () => {
      resolveReader(readerReady);
      await readPage;
    });
    await waitFor(() => expect(readerHost.querySelectorAll('[data-game-current-assertion]')).toHaveLength(2));
    expect(
      readerHost.querySelector('[data-current-return-selection]')?.getAttribute('data-game-current-assertion'),
    ).toBe(secondAssertion);
    await waitFor(() =>
      expect(window.document.activeElement?.getAttribute('data-game-current-assertion')).toBe(secondAssertion),
    );
    const changedPublicRead = structuredClone(currentPublicRead);
    changedPublicRead.subject.statements['schema:genre'] = [changedPublicRead.subject.statements['schema:genre']![0]!];
    const changedReady = {
      ...readerReady,
      public: changedPublicRead,
      groups: readerReady.groups.map((group) => ({
        ...group,
        fields: group.fields.map((field) => ({
          ...field,
          statements:
            field.property === 'schema:genre'
              ? changedPublicRead.subject.statements['schema:genre']!
              : field.statements,
        })),
      })),
    } as GameReaderReady;
    const outside = window.document.createElement('button');
    outside.textContent = 'Continue';
    await act(async () =>
      cancelledRoot.render(
        <QueryClientProvider client={client}>
          <GameReader
            id={gameId}
            context={candidateContext}
            type="schema:VideoGame"
            locale="en"
            realm={realm}
            source={changedPublicRead}
            reader={null}
            returnSelection={returnDescriptor}
            transport={async () => changedReady}
            reading={isolatedWorkReading}
          />
        </QueryClientProvider>,
      ),
    );
    cancelledHost.append(outside);
    await act(async () => {
      window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      outside.focus();
    });
    await waitFor(() => expect(cancelledHost.textContent).toContain(m.game_visit_selection_removed()));
    expect(window.document.activeElement).toBe(outside);
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
    await act(async () => {
      root.unmount();
      readerRoot.unmount();
      cancelledRoot.unmount();
    });
    client.clear();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
}, 25_000);
