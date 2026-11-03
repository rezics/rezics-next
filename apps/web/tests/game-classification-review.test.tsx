import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FactCommand, FactResult } from '../src/features/catalogue/subject-facts';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const extraPlatform = '00000000-0000-4000-8000-00000000f105';
const extraUrl = 'https://archive.example/game/cited-platform';

test('Game classification reuses evidence, reviews the changed set, repairs one holder, and keeps independent sealed outcomes', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/game' });
  const globals = {
    ...Object.fromEntries(
      'document navigator HTMLElement HTMLInputElement HTMLSelectElement HTMLButtonElement Node Element Document DocumentFragment MutationObserver ResizeObserver'
        .split(' ')
        .map((key) => [key, Reflect.get(window, key)]),
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
  const { GameClassifications } = await import('../src/features/catalogue/game-profile-fields');
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { gameProfileFixture, gameId, gamePlatformId } = await import('../src/kernel/fake/catalogue-game-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fixture = gameProfileFixture('ready', 'en', true);
  const platformStatement = fixture.publicRead.subject.statements['schema:gamePlatform']![0]!;
  platformStatement.references[0]!.parts.push({
    property: { id: 'schema:inLanguage', data_type: 'string' },
    value: { type: 'value', content: 'cited-ja' },
  });
  const missingId = '00000000-0000-4000-8000-00000000f199';
  const missing = structuredClone(platformStatement);
  missing.id = missingId;
  missing.value = { type: 'value', content: missingId };
  missing.qualifiers = [];
  missing.references = [];
  fixture.publicRead.subject.statements['schema:gamePlatform']!.push(missing);
  const read = { ok: true as const, release: fixture.release, public: fixture.publicRead };
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const commands: FactCommand[] = [];
  let propose: (command: FactCommand) => Promise<FactResult> = async (command) => {
    commands.push(structuredClone(command));
    return command.statement.property.id === 'schema:genre'
      ? { ok: false, reason: 'denied' }
      : { ok: false, reason: 'uncertain' };
  };
  const platformLabel = fixture.release.properties['schema:gamePlatform']!.labels.en!;
  const genreLabel = fixture.release.properties['schema:genre']!.labels.en!;
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: gameId, csrfToken: 'review-session' }}
            address={gameId}
          >
            <CatalogueCurrentReading visible ready revision="current">
              <GameClassifications
                read={read}
                locale="en"
                search={async () => [
                  { id: extraPlatform, title: 'Another platform', types: ['skos:Concept'], typeLabel: 'Concept', cover: null },
                ]}
                transport={{
                  read: fixture.transport.facts.read,
                  propose: (command) => propose(command),
                }}
                review={fixture.transport.classificationReview}
              />
            </CatalogueCurrentReading>
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    const platform = host.querySelector<HTMLElement>('[data-classification-property="schema:gamePlatform"]')!;
    const genre = host.querySelector<HTMLElement>('[data-classification-property="schema:genre"]')!;
    expect(platform.textContent).toContain(gamePlatformId);
    expect(platform.textContent).toContain('Example platform');
    expect(platform.textContent).toContain(m.candidate_rank_normal());
    expect(platform.textContent).toContain('Japanese');
    expect(platform.querySelector('a[href="https://example.test/game-notes"]')).not.toBeNull();
    expect(platform.textContent).toContain(m.candidate_value_unavailable());
    expect(within(genre).getByText(m.facts_no_value())).toBeDefined();
    const click = (node: HTMLElement) => act(async () => user.click(node));
    await click(within(platform).getAllByRole('button', { name: m.facts_edit_field() })[0]!);
    const qualifier = within(platform).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
    await act(async () => {
      await user.clear(qualifier);
      await user.type(qualifier, 'fr');
    });
    await click(within(genre).getByRole('button', { name: m.facts_add_value() }));
    const picker = within(genre).getByRole('combobox', { name: genreLabel });
    await act(async () => user.type(picker, 'Another'));
    await waitFor(() =>
      expect(within(host.ownerDocument.body).getByRole('option', { name: 'Another platform Concept' })).toBeDefined(),
    );
    await act(async () => user.keyboard('{ArrowDown}{Enter}'));
    expect(within(genre).getByText(m.game_classification_target({ id: extraPlatform }))).toBeDefined();
    await click(within(genre).getByRole('button', { name: m.correction_add_reference() }));
    const addPart = within(genre).getByRole('combobox', { name: m.correction_add_part() });
    await act(async () => user.selectOptions(addPart, 'schema:url'));
    await click(within(genre).getByRole('button', { name: m.correction_add() }));
    await act(async () => user.type(within(genre).getByRole('textbox', { name: m.correction_url() }), extraUrl));
    await click(
      within(platform).getByRole('button', {
        name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1`,
      }),
    );
    const reuse = host.querySelector<HTMLElement>('[data-fact-reuse]')!;
    expect(reuse.textContent).toContain('cited-ja');
    await click(within(reuse).getByRole('checkbox', { name: genreLabel }));
    await click(within(reuse).getByRole('button', { name: m.facts_reuse_apply() }));
    expect(host.textContent).toContain(
      m.game_classification_reused_group({ number: 2, field: genreLabel, source: platformLabel }),
    );
    expect(host.textContent).toContain(m.game_classification_retained_groups({ field: genreLabel }));
    const reviewPanel = () => host.querySelector<HTMLElement>('[data-fact-review]')!;
    await waitFor(() => expect(reviewPanel()).not.toBeNull());
    expect(reviewPanel().textContent).toContain(extraPlatform);
    expect(reviewPanel().textContent).toContain('French');
    expect(reviewPanel().textContent).toContain(extraUrl);
    const submit = () => within(host).getByRole('button', { name: m.facts_submit() }) as HTMLButtonElement;
    const openField = within(reviewPanel())
      .getAllByRole('button', { name: m.facts_review_open_field() })
      .find((button) => button.closest('li')?.textContent?.includes(platformLabel))!;
    await click(openField);
    expect(host.textContent).toContain(m.facts_review_stale());
    expect(submit().disabled).toBe(true);
    expect(window.document.activeElement).toBe(platform.querySelector('fieldset'));
    await act(async () => {
      await user.clear(qualifier);
      await user.type(qualifier, 'de');
    });
    await click(within(host).getByRole('button', { name: m.facts_review() }));
    expect(reviewPanel().textContent).toContain('German');
    expect(submit().disabled).toBe(false);
    await click(submit());
    expect(commands).toHaveLength(2);
    expect(new Set(commands.map((command) => command.key)).size).toBe(2);
    const platformCommand = commands.find((command) => command.statement.property.id === 'schema:gamePlatform')!;
    const genreCommand = commands.find((command) => command.statement.property.id === 'schema:genre')!;
    expect(platformCommand.statement.value).toEqual({ type: 'value', content: gamePlatformId });
    expect(platformCommand.statement.qualifiers![0]!.value).toEqual({ type: 'value', content: 'de' });
    expect(platformCommand.statement.references[0]!.parts).toHaveLength(2);
    expect(genreCommand.statement.value).toEqual({ type: 'value', content: extraPlatform });
    expect(genreCommand.statement.references).toHaveLength(2);
    expect(genreCommand.statement.references[1]!.parts).toEqual(platformCommand.statement.references[0]!.parts);
    expect(within(platform).getByText(m.correction_unavailable())).toBeDefined();
    expect(within(genre).getByRole('alert').textContent).toBe(m.correction_denied());
    const frozen = structuredClone(platformCommand);
    await click(within(genre).getByRole('button', { name: m.catalogue_create_review_new() }));
    await click(within(genre).getByRole('button', { name: m.authored_discard() }));
    await click(within(genre).getByRole('button', { name: m.authored_discard() }));
    expect(genre.querySelector('fieldset')).toBeNull();
    expect(host.textContent).toContain(m.game_classification_removed_diagnostic({ field: genreLabel }));
    await click(submit());
    expect(commands).toHaveLength(3);
    expect(commands[2]).toEqual(frozen);
    expect(commands[2]!.key).toBe(platformCommand.key);
    expect(commands[2]!.statement).toEqual(platformCommand.statement);
    expect(platform.querySelector('fieldset')?.disabled).toBe(true);
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
