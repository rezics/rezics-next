import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Release } from '@rezics/definitions';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';
import type { StatementInput } from '../src/features/catalogue/statement-editor';
import type { GameRead } from '../src/features/catalogue/game-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

// Authored UNRUN. Mounted DOM assertions are not browser geometry, SSR or native acceptance proof.
const originalReader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10';
const replacementReader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const longName = 'Released game classification — 日本語 العربية ' + 'CompleteName'.repeat(18);
const longCitation = 'https://archive.example/game/' + 'unabridged-record-'.repeat(24) + '?exact=A%2Fb#source';
type InitialRow = { key: string; statement: StatementInput };

async function mounted(
  run: (ui: {
    host: HTMLElement;
    render: (node: ReactNode, reader?: string) => Promise<void>;
    user: ReturnType<(typeof import('storybook/test'))['userEvent']['setup']>;
    within: (typeof import('storybook/test'))['within'];
    waitFor: (typeof import('storybook/test'))['waitFor'];
    extraIO: string[];
  }) => Promise<void>,
) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/game' });
  const extraIO: string[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    SVGElement: window.SVGElement,
    ShadowRoot: window.ShadowRoot,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: RequestInfo | URL) => {
      extraIO.push(String(input));
      throw new Error('Presentation must not add IO');
    }) as typeof fetch,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    await run({
      host,
      user,
      within,
      waitFor,
      extraIO,
      render: async (node, reader = originalReader) => {
        await act(async () =>
          root.render(
            <QueryClientProvider client={client}>
              <CandidateReaderBoundary
                address="game-fields"
                observed={
                  reader
                    ? { state: 'signed-in', subject: reader, csrfToken: 'fixture-csrf' }
                    : { state: 'signed-out', subject: null, csrfToken: null }
                }
              >
                {node}
              </CandidateReaderBoundary>
            </QueryClientProvider>,
          ),
        );
      },
    });
    expect(extraIO).toEqual([]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    setLocale(previousLocale, { reload: false });
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function initialRow(property = 'schema:inLanguage', content = 'ja'): InitialRow {
  return {
    key: crypto.randomUUID(),
    statement: {
      property: { id: property },
      value: { type: 'value', content },
      qualifiers: [],
      references: [],
      rank: 'normal',
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

// One actual-component campaign covers both initial-fact consumers and the complete correction journey.
test('Game and Addon complete fields family preserves independent labels, native drafts, bounded controls, outcomes and retired sessions', async () => {
  await mounted(async ({ host, render, user, within, waitFor }) => {
    const { GameInitialFacts, GameClassifications } = await import('../src/features/catalogue/game-profile-fields');
    const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
    const { AddonProfileCreate } = await import('../src/features/catalogue/addon-profile-create');
    const { gameProfileFixture, gameId, gamePlatformId, gameCreatorId } =
      await import('../src/kernel/fake/catalogue-game-profile');
    const { addonProfileFixture, addonWorkId } = await import('../src/kernel/fake/catalogue-addon-profile');
    const { addonBase, addonType } = await import('../src/features/catalogue/addon-profile');
    const { statementInput } = await import('../src/features/catalogue/statement-editor');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = gameProfileFixture('ready', 'en', true);
    const release = structuredClone(fixture.release);
    release.properties['schema:inLanguage']!.labels = { en: longName };
    let searches = 0;
    const search = async () => {
      searches++;
      return [];
    };
    const changes: InitialRow[][][] = [[], []];
    const supplied = initialRow();
    supplied.statement.qualifiers = [
      { property: { id: 'schema:name' }, value: { type: 'value', content: { text: longName, language: 'ja' } } },
    ];
    supplied.statement.references = [
      { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: longCitation } }] },
    ];
    const original = structuredClone(supplied);
    function Initial({
      index,
      rows = [supplied],
      current = release,
      disabled = false,
    }: {
      index: number;
      rows?: InitialRow[];
      current?: Release;
      disabled?: boolean;
    }) {
      const [statements, setStatements] = useState(rows);
      return (
        <div data-initial={index}>
          <GameInitialFacts
            type="schema:VideoGame"
            release={current}
            locale="en"
            search={search}
            statements={statements}
            disabled={disabled}
            change={(next) => {
              changes[index]!.push(next);
              setStatements(next);
            }}
          />
        </div>
      );
    }
    await render(
      <>
        <Initial index={0} />
        <Initial index={1} />
      </>,
    );
    const mounts = [...host.querySelectorAll<HTMLElement>('[data-initial]')];
    const selectors = mounts.map(
      (mount) => within(mount).getByRole('combobox', { name: m.character_add_fact() }) as HTMLSelectElement,
    );
    expect(selectors[0]!.id).not.toBe(selectors[1]!.id);
    for (let index = 0; index < 2; index++) {
      const mount = mounts[index]!;
      const select = selectors[index]!;
      const label = within(mount).getByText(m.character_add_fact(), { selector: 'label' }) as HTMLLabelElement;
      expect(label.htmlFor).toBe(select.id);
      expect(label.control).toBe(select);
      await act(async () => user.click(label));
      expect(host.ownerDocument.activeElement).toBe(select);
      const heading = within(mount).getByRole('heading', { level: 2, name: longName });
      expect(heading.closest('section')?.querySelector('[data-slot="game-initial-fact"]')).not.toBeNull();
      expect(heading.getAttribute('lang')).toBe('en');
      expect((within(mount).getByRole('textbox', { name: m.correction_url() }) as HTMLInputElement).value).toBe(
        longCitation,
      );
      expect(within(mount).getByRole('textbox', { name: m.correction_language() })).toBeDefined();
    }
    await act(async () => user.selectOptions(selectors[0]!, 'schema:url'));
    expect(selectors[1]!.value).toBe('');
    const add = within(mounts[0]!).getAllByRole('button', { name: m.correction_add() })[0]!;
    await act(async () => user.tab());
    expect(host.ownerDocument.activeElement).toBe(add);
    expect(add.className).toContain('focus-visible:outline-2');
    expect(add.className).toContain('[@media(max-width:639px)_and_(pointer:coarse)]:min-h-11');
    await act(async () => user.keyboard('{Enter}'));
    expect(changes[0]!.at(-1)).toHaveLength(2);
    expect(changes[1]).toEqual([]);
    const allocated = changes[0]!.at(-1)![1]!;
    expect(allocated.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(allocated.statement).toEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: '' },
      qualifiers: [],
      references: [],
      rank: 'normal',
    });
    expect(selectors[0]!.value).toBe('');
    expect([...selectors[0]!.options].some((option) => option.value === 'schema:url')).toBe(false);
    expect([...selectors[0]!.options].some((option) => option.value === 'schema:inLanguage')).toBe(true);
    await act(async () => user.selectOptions(selectors[0]!, 'schema:inLanguage'));
    await act(async () => user.click(add));
    expect(changes[0]!.at(-1)!.filter((row) => row.statement.property.id === 'schema:inLanguage')).toHaveLength(2);
    await act(async () => user.click(within(mounts[0]!).getAllByRole('button', { name: m.recipe_remove_field() })[1]!));
    expect(changes[0]!.at(-1)).toHaveLength(2);
    expect(changes[0]!.at(-1)!.some((row) => row.key === allocated.key)).toBe(false);
    expect(supplied).toEqual(original);

    await render(<Initial key="cap" index={0} rows={Array.from({ length: 31 }, () => initialRow())} />);
    let select = within(host).getByRole('combobox', { name: m.character_add_fact() }) as HTMLSelectElement;
    await act(async () => user.selectOptions(select, 'schema:inLanguage'));
    await act(async () => user.click(within(host).getByRole('button', { name: m.correction_add() })));
    expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(32);
    await act(async () => user.selectOptions(select, 'schema:inLanguage'));
    expect((within(host).getByRole('button', { name: m.correction_add() }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => user.click(within(host).getAllByRole('button', { name: m.recipe_remove_field() })[0]!));
    expect((within(host).getByRole('button', { name: m.correction_add() }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => user.click(within(host).getAllByRole('button', { name: m.recipe_remove_field() })[0]!));
    expect((within(host).getByRole('button', { name: m.correction_add() }) as HTMLButtonElement).disabled).toBe(false);
    const removed = structuredClone(release);
    delete removed.properties['schema:inLanguage'];
    await render(<Initial key="removed" index={0} current={removed} />);
    expect(host.textContent).toContain(m.candidate_value_unavailable());
    expect(host.textContent).toContain(m.correction_preserved());
    expect(within(host).getByRole('button', { name: m.recipe_remove_field() })).toBeDefined();
    await render(<Initial key="disabled" index={0} disabled />);
    expect(host.querySelector('fieldset')?.disabled).toBe(true);
    expect(searches).toBe(0);
    expect(fixture.calls).toEqual([]);

    const creation = gameProfileFixture();
    const gameCreations: Parameters<typeof creation.transport.create>[0][] = [];
    const navigations: string[] = [];
    await render(
      <GameProfile
        key="game-create"
        locale="en"
        session="signed-in"
        search={search}
        transport={{
          ...creation.transport,
          create: (command) => {
            gameCreations.push(command);
            return creation.transport.create(command);
          },
        }}
        onNavigate={(href) => {
          navigations.push(href);
        }}
      />,
    );
    const type = await within(host).findByRole('combobox', { name: m.catalogue_create_type() });
    await act(async () => user.selectOptions(type, 'schema:VideoGame'));
    await act(async () =>
      user.type(within(host).getByRole('textbox', { name: m.catalogue_create_label() }), 'The Lantern Game'),
    );
    await act(async () =>
      user.selectOptions(within(host).getByRole('combobox', { name: m.character_add_fact() }), 'schema:inLanguage'),
    );
    await act(async () => user.click(within(host).getByRole('button', { name: m.correction_add() })));
    const creationFrame = host.querySelector<HTMLElement>('[data-slot="game-initial-fact"]')!;
    await act(async () => user.type(within(creationFrame).getByRole('textbox', { name: m.correction_value() }), 'ja'));
    expect(gameCreations).toEqual([]);
    const readsBeforeCreate = creation.calls.filter((call) => call.method === 'GET').length;
    expect(readsBeforeCreate).toBe(2);
    await act(async () => user.click(within(host).getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(navigations).toEqual([`/en/subjects/${gameId}/the-lantern-game`]));
    expect(gameCreations).toHaveLength(1);
    expect(gameCreations[0]!.item).toEqual({
      type: 'schema:VideoGame',
      labels: { en: 'The Lantern Game' },
      descriptions: {},
      aliases: {},
      statements: {
        'schema:inLanguage': [
          {
            property: { id: 'schema:inLanguage' },
            value: { type: 'value', content: 'ja' },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
        ],
      },
    });
    expect(creation.calls.filter((call) => call.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/v1/subjects',
        body: gameCreations[0]!.item,
        key: gameCreations[0]!.key,
        authorization: 'Bearer fixture',
      },
    ]);
    expect(creation.calls.filter((call) => call.method === 'GET')).toHaveLength(readsBeforeCreate + 3);
    expect(searches).toBe(0);

    // Real classification selection retains its baseline, qualifiers, citations and candidate address.
    const secondPlatform = structuredClone(fixture.publicRead.subject.statements['schema:gamePlatform']![0]!);
    secondPlatform.id = '00000000-0000-4000-8000-00000000f106';
    secondPlatform.value = { type: 'value', content: '00000000-0000-4000-8000-00000000f105' };
    fixture.publicRead.subject.statements['schema:gamePlatform']!.push(secondPlatform);
    fixture.publicRead.related['00000000-0000-4000-8000-00000000f105'] = {
      type: 'skos:Concept',
      labels: { en: longName },
    };
    const read = { ok: true as const, release: fixture.release, public: fixture.publicRead };
    const selected = structuredClone(fixture.publicRead);
    const pending = deferred<FactResult>();
    const commands: FactCommand[] = [];
    const reviews: [string, string | undefined][] = [];
    await render(
      <GameClassifications
        key="success"
        read={read}
        locale="en"
        search={search}
        transport={{
          read: fixture.transport.facts.read,
          propose: (command) => {
            commands.push(command);
            return pending.promise;
          },
        }}
        review={(property, session) => {
          reviews.push([property, session]);
          return fixture.transport.classificationReview(property, session);
        }}
      />,
    );
    const platform = host.querySelector<HTMLElement>('[data-slot="game-classification"]')!;
    const field = within(platform);
    expect(platform.querySelector('h3[data-content-item-slot="title"]')?.closest('section')).toBe(
      platform.parentElement,
    );
    expect(platform.textContent).toContain('Example platform');
    expect(platform.textContent).toContain(longName);
    expect(platform.textContent).toContain('ja');
    expect(platform.querySelector('a[href="https://example.test/game-notes"]')).not.toBeNull();
    const submit = within(host).getByRole('button', { name: m.facts_submit() });
    await act(async () => user.click(field.getAllByRole('button', { name: m.facts_edit_field() })[1]!));
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    const qualifier = field.getByRole('textbox', { name: m.correction_value() });
    await act(async () => {
      await user.clear(qualifier);
      await user.type(qualifier, 'fr');
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    expect(commands).toEqual([]);
    await act(async () => user.click(submit));
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(platform.querySelector('fieldset')?.disabled).toBe(true);
    await act(async () => user.click(submit));
    expect(commands).toHaveLength(1);
    const expected = statementInput(selected.subject.statements['schema:gamePlatform']![1]!);
    expected.qualifiers![0]!.value = { type: 'value', content: 'fr' };
    expect(commands[0]!.statement).toEqual(expected);
    expect(commands[0]!.id).toBe(gameId);
    await act(async () => pending.resolve(await fixture.transport.classifications.propose(commands[0]!)));
    expect(field.getByText(m.correction_proposed())).toBeDefined();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(fixture.calls).toEqual([
      {
        method: 'POST',
        path: `/v1/subjects/${gameId}/candidates`,
        body: { statement: expected },
        key: commands[0]!.key,
        authorization: 'Bearer fixture',
      },
    ]);
    expect(fixture.publicRead).toEqual(selected);
    await act(async () => user.click(field.getByRole('button', { name: m.correction_review() })));
    await waitFor(() => expect(within(host).getByRole('heading', { name: m.candidate_proposed() })).toBeDefined());
    expect(reviews).toEqual([['schema:gamePlatform', 'game-session']]);
    expect([...fixture.candidates.values()][0]!.statement.qualifiers[0]!.value).toEqual({
      type: 'value',
      content: 'fr',
    });
    expect([...fixture.candidates.values()][0]!.decision).toBeNull();
    expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(
      fixture.calls.filter((call) => call.method === 'GET').map((call) => [call.path, call.key, call.authorization]),
    ).toEqual([
      [`/v1/subjects/${gameId}`, null, 'Bearer fixture'],
      [`/v1/subjects/${gameId}/candidates`, null, 'Bearer fixture'],
    ]);

    // Empty classification Add and the real item picker keep target filtering and per-field outcomes independent.
    const partial = gameProfileFixture('ready', 'en', true);
    const partialRead = { ok: true as const, release: partial.release, public: partial.publicRead };
    const partialCommands: FactCommand[] = [];
    const pickerCalls: { text: string; signal: AbortSignal }[] = [];
    const nextPlatform = '00000000-0000-4000-8000-00000000f105';
    await render(
      <GameClassifications
        key="partial"
        read={partialRead}
        locale="en"
        search={async (text, signal) => {
          pickerCalls.push({ text, signal });
          return [
            { id: nextPlatform, title: longName, types: ['skos:Concept'], typeLabel: 'Concept', cover: null },
            {
              id: gameCreatorId,
              title: 'Ineligible writer',
              types: ['schema:Person'],
              typeLabel: 'Person',
              cover: null,
            },
          ];
        }}
        transport={{
          read: partial.transport.facts.read,
          propose: (command) => {
            partialCommands.push(command);
            return command.statement.property.id === 'schema:genre'
              ? Promise.resolve({ ok: false as const, reason: 'denied' as const })
              : partial.transport.classifications.propose(command);
          },
        }}
        review={partial.transport.classificationReview}
      />,
    );
    const partialFrames = [...host.querySelectorAll<HTMLElement>('[data-slot="game-classification"]')];
    const platformScope = within(partialFrames[0]!);
    const genreFrame = partialFrames.find(
      (frame) => frame.querySelector('h3')?.textContent === partial.release.properties['schema:genre']!.labels.en,
    )!;
    const genre = within(genreFrame);
    expect(genre.getByText(m.facts_no_value())).toBeDefined();
    expect(genre.queryByRole('button', { name: m.facts_edit_field() })).toBeNull();
    await act(async () => user.click(genre.getByRole('button', { name: m.facts_add_value() })));
    const picker = genre.getByRole('combobox', { name: partial.release.properties['schema:genre']!.labels.en! });
    expect(pickerCalls).toEqual([]);
    await act(async () => user.type(picker, 'platform'));
    await waitFor(() =>
      expect(within(host.ownerDocument.body).getByRole('option', { name: `${longName} Concept` })).toBeDefined(),
    );
    expect(within(host.ownerDocument.body).queryByRole('option', { name: /Ineligible writer/ })).toBeNull();
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
    expect((picker as HTMLInputElement).value).toBe(longName);
    expect(pickerCalls).toHaveLength(1);
    expect(pickerCalls[0]!.text).toBe('platform');
    expect(pickerCalls[0]!.signal).toBeInstanceOf(AbortSignal);
    await act(async () => user.click(platformScope.getByRole('button', { name: m.facts_edit_field() })));
    const partialValue = platformScope.getByRole('textbox', { name: m.correction_value() });
    await act(async () => {
      await user.clear(partialValue);
      await user.type(partialValue, 'fr');
    });
    const partialSubmit = within(host).getByRole('button', { name: m.facts_submit() });
    expect(partialCommands).toEqual([]);
    await act(async () => user.click(partialSubmit));
    expect(partialCommands).toHaveLength(2);
    expect(new Set(partialCommands.map((command) => command.key)).size).toBe(2);
    const genreCommand = partialCommands.find((command) => command.statement.property.id === 'schema:genre')!;
    expect(genreCommand.statement).toEqual({
      property: { id: 'schema:genre' },
      value: { type: 'value', content: nextPlatform },
      qualifiers: [],
      references: [],
      rank: 'normal',
    });
    expect(platformScope.getByText(m.correction_proposed())).toBeDefined();
    expect(genre.getByRole('alert').textContent).toBe(m.correction_denied());
    await act(async () => user.click(partialSubmit));
    expect(partialCommands).toHaveLength(3);
    expect(partialCommands[2]).toBe(genreCommand);
    expect(partial.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(partial.calls.some((call) => call.method === 'GET')).toBe(false);
    expect(pickerCalls).toHaveLength(1);

    for (const scenario of ['denied', 'stale', 'uncertain', 'unavailable'] as const) {
      const failure = gameProfileFixture(scenario === 'unavailable' ? 'ready' : scenario, 'en', true);
      const attempts: FactCommand[] = [];
      const current = { ok: true as const, release: failure.release, public: failure.publicRead };
      await render(
        <GameClassifications
          key={scenario}
          read={current}
          locale="en"
          search={search}
          transport={{
            read: failure.transport.facts.read,
            propose: (command) => {
              attempts.push(command);
              return scenario === 'unavailable'
                ? Promise.resolve({ ok: false as const, reason: 'unavailable' as const })
                : failure.transport.classifications.propose(command);
            },
          }}
          review={failure.transport.classificationReview}
        />,
      );
      const region = host.querySelector<HTMLElement>('[data-slot="game-classification"]')!;
      const scope = within(region);
      await act(async () => user.click(scope.getByRole('button', { name: m.facts_edit_field() })));
      const input = scope.getByRole('textbox', { name: m.correction_value() });
      await act(async () => {
        await user.clear(input);
        await user.type(input, 'fr');
      });
      const send = within(host).getByRole('button', { name: m.facts_submit() });
      await act(async () => user.click(send));
      expect(scope.getByRole('alert').textContent).toBe(
        scenario === 'denied'
          ? m.correction_denied()
          : scenario === 'stale'
            ? m.correction_stale()
            : m.correction_unavailable(),
      );
      expect((input as HTMLInputElement).value).toBe('fr');
      expect(region.querySelector('fieldset')?.disabled).toBe(true);
      expect(scope.queryByRole('button', { name: m.correction_review() })).toBeNull();
      if (scenario === 'stale') expect((send as HTMLButtonElement).disabled).toBe(true);
      else {
        const frozen = structuredClone(attempts[0]);
        await act(async () => user.click(send));
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toBe(attempts[0]);
        expect(attempts[1]).toEqual(frozen);
        for (const call of failure.calls.filter((call) => call.method === 'POST')) {
          expect(call.path).toBe(`/v1/subjects/${gameId}/candidates`);
          expect(call.body).toEqual({ statement: attempts[0]!.statement });
          expect(call.key).toBe(attempts[0]!.key);
          expect(call.authorization).toBe('Bearer fixture');
        }
        if (scenario === 'uncertain') {
          expect(failure.receipts.size).toBe(1);
          expect(scope.getByText(m.correction_proposed())).toBeDefined();
        }
      }
      expect(failure.calls.some((call) => call.method === 'GET')).toBe(false);
      if (scenario === 'denied') {
        await act(async () => user.click(scope.getByRole('button', { name: m.catalogue_create_review_new() })));
        expect(region.querySelector('fieldset')?.disabled).toBe(false);
        await act(async () => {
          await user.clear(input);
          await user.type(input, 'de');
        });
        expect(attempts).toHaveLength(2);
        await act(async () => user.click(send));
        expect(attempts).toHaveLength(3);
        expect(attempts[2]!.key).not.toBe(attempts[0]!.key);
        expect(attempts[2]!.statement.qualifiers![0]!.value).toEqual({ type: 'value', content: 'de' });
      }
    }

    // Existing Addon caller composes the changed initial controls without a caller edit or inherited base facts.
    const addon = addonProfileFixture();
    const addonRead = await addon.transport.load({ work: addonWorkId });
    if (!addonRead.ok) throw new Error('Expected Addon creation read');
    const beforeAddon = structuredClone(addon.calls);
    const creations: Parameters<typeof addon.transport.create>[0][] = [];
    const created: string[] = [];
    await render(
      <AddonProfileCreate
        key="addon"
        read={addonRead}
        locale="en"
        session="signed-in"
        transport={{
          ...addon.transport,
          create: (command) => {
            creations.push(command);
            return addon.transport.create(command);
          },
        }}
        search={search}
        onCreated={(result) => {
          created.push(result.id);
        }}
      />,
    );
    await waitFor(() => expect(within(host).getByRole('textbox', { name: m.catalogue_create_label() })).toBeDefined());
    await act(async () => user.click(within(host).getByRole('button', { name: m.addon_use_base() })));
    const base = host.querySelector<HTMLElement>('[data-slot="game-initial-fact"]')!;
    expect(base.querySelector('h2[data-content-item-slot="title"]')?.textContent).toBe(
      addonRead.release.properties[addonBase]!.labels.en!,
    );
    const baseLabel = addonRead.release.properties[addonBase]!.labels.en!;
    expect(within(base).getByRole('combobox', { name: baseLabel })).toBeDefined();
    expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(1);
    expect(addon.calls).toEqual(beforeAddon);
    expect(addonRead.release.types[addonType]).toBeDefined();
    await act(async () =>
      user.type(within(host).getByRole('textbox', { name: m.catalogue_create_label() }), 'The Lantern Addon'),
    );
    expect(creations).toEqual([]);
    await act(async () => user.click(within(host).getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(creations).toHaveLength(1);
    expect(creations[0]!.item).toEqual({
      type: addonType,
      labels: { en: 'The Lantern Addon' },
      descriptions: {},
      aliases: {},
      statements: {
        [addonBase]: [
          {
            property: { id: addonBase },
            value: { type: 'value', content: addonWorkId },
            qualifiers: [],
            references: [],
            rank: 'normal',
          },
        ],
      },
    });
    expect(addon.calls.filter((call) => call.method === 'POST')).toEqual([
      {
        method: 'POST',
        path: '/v1/subjects',
        query: '',
        body: creations[0]!.item,
        key: creations[0]!.key,
      },
    ]);

    // Original reader retirement owns in-flight completion and queued callbacks through the actual Game consumer.
    const retiring = gameProfileFixture('ready', 'en', true);
    const late = deferred<FactResult>();
    const oldCommands: FactCommand[] = [];
    const transport = {
      ...retiring.transport,
      classifications: {
        ...retiring.transport.classifications,
        propose: (command: FactCommand) => {
          oldCommands.push(command);
          return late.promise;
        },
      },
    };
    const profile = (signedIn = true) => (
      <GameProfile
        key="retirement"
        id={gameId}
        locale="en"
        session={signedIn ? 'signed-in' : 'signed-out'}
        transport={transport}
        search={search}
        onNavigate={() => {}}
      />
    );
    await render(profile());
    await waitFor(() => expect(host.querySelector('[data-slot="game-classification"]')).not.toBeNull());
    const summary = [...host.querySelectorAll<HTMLElement>('summary')].find(
      (node) => node.textContent === m.game_profile_classification(),
    )!;
    await act(async () => user.click(summary));
    const retiringRegion = host.querySelector<HTMLElement>('[data-slot="game-classification"]')!;
    await act(async () => user.click(within(retiringRegion).getByRole('button', { name: m.facts_edit_field() })));
    const oldInput = within(retiringRegion).getByRole('textbox', { name: m.correction_value() });
    await act(async () => {
      await user.clear(oldInput);
      await user.type(oldInput, 'fr');
    });
    const oldSubmit = within(summary.closest('details')!).getByRole('button', { name: m.facts_submit() });
    const propsKey = Object.keys(oldSubmit).find((key) => key.startsWith('__reactProps$'))!;
    const queued = Reflect.get(oldSubmit, propsKey).onClick as () => void;
    await act(async () => user.click(oldSubmit));
    expect(oldCommands).toHaveLength(1);
    const frozenOld = structuredClone(oldCommands[0]);
    await render(profile(false), '');
    await waitFor(() => expect(within(host).getByRole('status').textContent).toBe(m.relation_sign_in()));
    const callsAtRetirement = structuredClone(retiring.calls);
    await act(async () => {
      late.resolve({
        ok: true,
        kind: 'proposed-awaiting-review',
        candidate: gamePlatformId,
        revision: 2,
        session: 'original-session',
      });
    });
    await act(async () => queued());
    expect(oldCommands).toHaveLength(1);
    expect(oldCommands[0]).toEqual(frozenOld);
    expect(retiring.calls).toEqual(callsAtRetirement);
    expect(host.querySelector('[data-slot="game-classification"]')).toBeNull();
    expect(host.textContent).not.toContain(m.correction_proposed());
    await render(profile(), replacementReader);
    await waitFor(() => expect(host.querySelector('[data-slot="game-classification"]')).not.toBeNull());
    expect(host.textContent).not.toContain(m.correction_proposed());
    await act(async () => queued());
    expect(oldCommands).toHaveLength(1);
    expect(searches).toBe(0);
    expect(host.querySelector('a a, a button, button button, [data-slot="list-row-link"]')).toBeNull();

    for (const scenario of ['concealed', 'unavailable'] as const) {
      const unavailable = gameProfileFixture(scenario, 'en', true);
      await render(
        <GameProfile
          key={scenario}
          id={gameId}
          locale="en"
          session="signed-in"
          transport={unavailable.transport}
          search={search}
          onNavigate={() => {}}
        />,
      );
      await waitFor(() =>
        expect(within(host).getByRole('alert').textContent).toBe(
          scenario === 'concealed' ? m.correction_denied() : m.correction_unavailable(),
        ),
      );
      expect(host.querySelector('[data-slot="game-classification"]')).toBeNull();
      expect(unavailable.calls).toHaveLength(2);
      expect(unavailable.calls.every((call) => call.method === 'GET' && call.authorization === null)).toBe(true);
    }

    // Supplied-data growth only: 64 rows use two independent <=32-row initial editors.
    // No-reference rows isolate frame overhead; existing native reference menus still own dictionary choices.
    // Proxies guard against adding a whole-population traversal to these supplied-data mounts.
    for (const count of [1, 8, 64]) {
      const bounded = structuredClone(release);
      bounded.properties = new Proxy(bounded.properties, {
        ownKeys() {
          throw new Error('Unexpected population traversal');
        },
      });
      bounded.types = new Proxy(bounded.types, {
        ownKeys() {
          throw new Error('Unexpected type traversal');
        },
      });
      const batches = Array.from({ length: Math.ceil(count / 32) }, (_, index) =>
        Array.from({ length: Math.min(32, count - index * 32) }, () => initialRow('schema:inLanguage', longName)),
      );
      await render(
        <div key={`growth-${count}`}>
          {batches.map((rows, index) => (
            <Initial key={index} index={index} rows={rows} current={bounded} />
          ))}
        </div>,
      );
      expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(count);
      expect(host.querySelectorAll('fieldset > legend')).toHaveLength(batches.length);
      expect(searches).toBe(0);
      expect(fixture.calls.filter((call) => call.method === 'GET')).toHaveLength(2);
    }
  });
}, 60_000);

test('initial Game creation retry coalesces reads and orients only current deliberate keyboard recovery', async () => {
  await mounted(async ({ host, render, user, within, waitFor }) => {
    const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
    const { gameProfileFixture } = await import('../src/kernel/fake/catalogue-game-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = gameProfileFixture();
    const unavailable: GameRead = { ok: false, reason: 'unavailable' };
    const ready: GameRead = { ok: true, release: fixture.release, public: null };
    let next: GameRead | Promise<GameRead> | Error = unavailable;
    let loads = 0;
    const transport = {
      ...fixture.transport,
      load: async () => {
        loads++;
        if (next instanceof Error) throw next;
        return await next;
      },
    };
    const outside = host.ownerDocument.createElement('button');
    host.ownerDocument.body.append(outside);
    const show = (key: string, locale = 'en', reader = originalReader) =>
      render(
        <GameProfile
          key={key}
          locale={locale}
          session="signed-in"
          transport={transport}
          search={async () => []}
          onNavigate={() => {}}
        />,
        reader,
      );
    const retry = () => within(host).getByRole('button', { name: m.correction_reload() });
    const failure = () => waitFor(() => expect(within(host).getByRole('alert')).toBeDefined());
    const pending = () => {
      expect(host.textContent).toContain(m.catalogue_create_loading());
      expect(within(host).queryByRole('alert')).toBeNull();
      expect(retry()).toHaveProperty('disabled', true);
    };
    let finish!: (read: GameRead) => void;
    const hold = () => {
      next = new Promise<GameRead>((resolve) => {
        finish = resolve;
      });
    };
    const settle = async (read: GameRead) => {
      await act(async () => {
        finish(read);
      });
      await waitFor(() => expect(host.textContent).not.toContain(m.catalogue_create_loading()));
    };
    try {
      hold();
      await show('initial');
      await act(async () => outside.focus());
      await settle(ready);
      expect(host.ownerDocument.activeElement).toBe(outside);
      for (const scenario of ['keyboard', 'missing', 'pointer', 'moved', 'locale', 'session', 'editor', 'unmount']) {
        next = scenario === 'keyboard' ? new Error('Metadata read failed') : unavailable;
        await show(scenario);
        await failure();
        const opener = retry();
        const propsKey = Object.keys(opener).find((key) => key.startsWith('__reactProps$'))!;
        const queued = Reflect.get(opener, propsKey).onClick;
        hold();
        const before = loads;
        await act(async () => {
          if (scenario === 'pointer') await user.click(opener);
          else {
            opener.focus();
            await user.keyboard('{Enter}');
          }
          queued({ currentTarget: opener, detail: 0 });
          queued({ currentTarget: opener, detail: 1 });
        });
        await waitFor(() => expect(loads).toBe(before + 1));
        pending();
        if (scenario === 'keyboard') {
          await settle(unavailable);
          await failure();
          expect(host.ownerDocument.activeElement).toBe(opener);
          hold();
          await act(async () => user.keyboard(' '));
          pending();
          expect(loads).toBe(before + 2);
        }
        if (scenario === 'missing') opener.remove();
        if (scenario === 'moved')
          await act(async () => {
            outside.focus();
            opener.focus();
          });
        if (['locale', 'session', 'editor', 'unmount'].includes(scenario)) {
          next = unavailable;
          if (scenario === 'unmount') await render(<p>Closed</p>);
          else
            await show(
              scenario === 'editor' ? 'replacement' : scenario,
              scenario === 'locale' ? 'ja' : 'en',
              scenario === 'session' ? replacementReader : originalReader,
            );
          await act(async () => outside.focus());
          const currentLoads = loads;
          await act(async () => queued({ currentTarget: opener, detail: 0 }));
          expect(loads).toBe(currentLoads);
        }
        await settle(scenario === 'missing' ? unavailable : ready);
        if (scenario === 'keyboard') {
          expect(host.ownerDocument.activeElement).toBe(host.querySelector('h1'));
          expect(host.querySelector('form')).not.toBeNull();
        } else if (scenario === 'missing') {
          expect(host.ownerDocument.activeElement).toBe(within(host).getByRole('alert').parentElement);
        } else {
          expect(host.ownerDocument.activeElement).not.toBe(host.querySelector('h1'));
          if (['locale', 'session', 'editor', 'unmount'].includes(scenario)) {
            expect(host.ownerDocument.activeElement).toBe(outside);
            expect(host.querySelector('form')).toBeNull();
          }
        }
      }
      expect(fixture.calls).toEqual([]);
    } finally {
      outside.remove();
    }
  });
});

test('Game creation recovers rejected multilingual drafts and exact corrections without replacing uncertain intent', async () => {
  await mounted(async ({ host, render, user, within, waitFor }) => {
    const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
    const { gameProfileFixture, gameId } = await import('../src/kernel/fake/catalogue-game-profile');
    const { m } = await import('../src/paraglide/messages.js');
    const fixture = gameProfileFixture();
    const commands: Parameters<typeof fixture.transport.create>[0][] = [];
    const navigations: string[] = [];
    let unavailable = false,
      mode = 'reject';
    let settleUncertain: (result: Awaited<ReturnType<typeof fixture.transport.create>>) => void = () => {};
    const errors = [
      '/statements/schema:inLanguage/1/value/content',
      '/statements/schema:inLanguage/1/references/0/parts/0/value/content',
      '/statements/schema:inLanguage/1/future',
    ];
    const transport: typeof fixture.transport = {
      ...fixture.transport,
      load: async () =>
        unavailable ? { ok: false, reason: 'unavailable' } : { ok: true, release: fixture.release, public: null },
      create: async (command) => {
        commands.push(structuredClone(command));
        if (mode === 'reject') {
          unavailable = true;
          return {
            ok: false,
            reason: 'invalid',
            refreshDefinitions: true,
            errors: errors.map((pointer) => ({ pointer, code: 'invalid_format' })),
          };
        }
        if (mode === 'uncertain')
          return new Promise((resolve) => {
            settleUncertain = resolve;
          });
        if (mode === 'conflict') return { ok: false, reason: 'conflict' };
        return { ok: true, id: gameId, reader: { state: 'unavailable' } };
      },
      read: async (id) => {
        expect(id).toBe(gameId);
        return { state: 'ready', href: '/exact/returned-reader' };
      },
    };
    const show = (reader?: string, session: 'signed-in' | 'unavailable' = 'signed-in', id?: string) =>
      render(
        <GameProfile
          id={id}
          locale="en"
          session={session}
          transport={transport}
          search={async () => []}
          onNavigate={(href) => navigations.push(href)}
        />,
        reader,
      );
    const click = async (node: HTMLElement) => {
      await act(async () => user.click(node));
    };
    const button = (name: string) => within(host).getByRole('button', { name });
    const type = async (node: HTMLElement, value: string) => {
      await act(async () => {
        await user.clear(node);
        await user.type(node, value);
      });
    };
    await show();
    const select = await within(host).findByRole('combobox', { name: m.catalogue_create_type() });
    await act(async () => user.selectOptions(select, 'schema:VideoGame'));
    await type(host.querySelector<HTMLElement>('#create-label-0')!, 'Lantern');
    await click(button(m.catalogue_create_add_language()));
    await type(host.querySelector<HTMLElement>('#create-language-1')!, 'ja');
    await type(host.querySelector<HTMLElement>('#create-label-1')!, '灯り');
    for (const value of ['en', 'ja']) {
      await act(async () =>
        user.selectOptions(within(host).getByRole('combobox', { name: m.character_add_fact() }), 'schema:inLanguage'),
      );
      await click(button(m.correction_add()));
      const rows = host.querySelectorAll<HTMLElement>('[data-slot="game-initial-fact"]');
      await type(within(rows[rows.length - 1]!).getByRole('textbox', { name: m.correction_value() }), value);
    }
    const rows = host.querySelectorAll<HTMLElement>('[data-slot="game-initial-fact"]');
    const second = rows[1]!;
    await click(within(second).getByRole('button', { name: m.correction_add_reference() }));
    await act(async () =>
      user.selectOptions(within(second).getByRole('combobox', { name: m.correction_add_part() }), 'schema:url'),
    );
    await click(within(second).getByRole('button', { name: m.correction_add() }));
    await type(within(second).getByRole('textbox', { name: m.correction_url() }), 'https://example.test/original');
    // Switching Type retains its own rows, independently of the terms.
    await act(async () => user.selectOptions(select, 'wd:Q689445'));
    expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(0);
    await act(async () => user.selectOptions(select, 'schema:VideoGame'));
    const term = host.querySelector<HTMLInputElement>('#create-label-1')!;
    await click(button(m.catalogue_create_submit()));
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_unavailable()));
    expect(term.isConnected).toBe(true);
    expect(term.value).toBe('灯り');
    expect((button(m.catalogue_create_submit()) as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(2);
    unavailable = false;
    await click(button(m.catalogue_create_retry()));
    await waitFor(() => expect((button(m.catalogue_create_submit()) as HTMLButtonElement).disabled).toBe(false));
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[role="alert"] li a')];
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.textContent?.includes('2'))).toBe(true);
    const targets = links.map((link) => host.ownerDocument.getElementById(decodeURIComponent(link.hash.slice(1)))!);
    for (const [index, link] of links.entries()) {
      await click(link);
      expect(host.ownerDocument.activeElement).toBe(targets[index]!);
    }
    // Deleting a preceding repeat must not move the rejected address to another row.
    await click(
      within(host.querySelector<HTMLElement>('[data-slot="game-initial-fact"]')!).getByRole('button', {
        name: m.recipe_remove_field(),
      }),
    );
    expect(targets.every((target) => target.isConnected)).toBe(true);
    await type(targets[0]!, 'fr');
    await type(targets[1]!, 'https://example.test/corrected');
    mode = 'conflict';
    await click(button(m.catalogue_create_submit()));
    expect((button(m.catalogue_create_submit()) as HTMLButtonElement).disabled).toBe(true);
    await click(button(m.catalogue_create_review_new()));
    mode = 'uncertain';
    unavailable = true;
    const queuedEdits = targets.map(
      (node) =>
        Reflect.get(
          node,
          Object.keys(node).find((key) => key.startsWith('__reactProps'))!,
        ).onChange,
    );
    await click(button(m.catalogue_create_submit()));
    const sealed = structuredClone(commands.at(-1));
    for (const pending of [true, false]) {
      if (!pending)
        await act(async () => settleUncertain({ ok: false, reason: 'unavailable', refreshDefinitions: true }));
      await act(async () => {
        for (const edit of queuedEdits) edit({ target: { value: 'stale intent' } });
      });
      expect((targets[0] as HTMLInputElement).value).toBe('fr');
      expect((targets[1] as HTMLInputElement).value).toBe('https://example.test/corrected');
    }
    expect(host.querySelector('form fieldset')?.hasAttribute('disabled')).toBe(true);
    mode = 'ready';
    const submit = host.querySelector<HTMLElement>('button[type="submit"]')!;
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    await click(submit);
    expect(commands.at(-1)).toEqual(sealed);
    expect(commands[0]!.item.labels).toEqual({ en: 'Lantern', ja: '灯り' });
    await click(button(m.catalogue_create_retry()));
    expect(navigations).toEqual(['/exact/returned-reader']);
    await show(replacementReader);
    await waitFor(() => expect(term.isConnected).toBe(false));
    unavailable = false;
    transport.load = async () => ({
      ok: true,
      release: fixture.release,
      public: gameProfileFixture('ready', 'en', true).publicRead,
    });
    await show(originalReader, 'unavailable', gameId);
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_unavailable()));
    expect(host.textContent).not.toContain(m.catalogue_create_loading());
    expect(button(m.catalogue_create_retry())).toBeDefined();
  });
});
