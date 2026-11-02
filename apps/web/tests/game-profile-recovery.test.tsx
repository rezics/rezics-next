import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GameRead } from '../src/features/catalogue/game-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Game retires refused readings, privately retains exact corrections, and recovers only matching reads', async () => {
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
  let outcome: GameRead | Error = initial;
  let loads = 0;
  let deliver!: () => void;
  const delivery = new Promise<void>((resolve) => {
    deliver = resolve;
  });
  let held = true;
  let loseNextResponse = false;
  const sentCommands: Parameters<typeof fixture.transport.classifications.propose>[0][] = [];
  const transport = {
    ...fixture.transport,
    classifications: {
      ...fixture.transport.classifications,
      propose: async (command: Parameters<typeof fixture.transport.classifications.propose>[0]) => {
        sentCommands.push(structuredClone(command));
        const result = await fixture.transport.classifications.propose(command);
        if (held) await delivery;
        if (loseNextResponse) {
          loseNextResponse = false;
          throw new Error('simulated lost response');
        }
        return result;
      },
    },
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
  const keyboardRefresh = async (result: GameRead | Error) => {
    outcome = result;
    const button = refresh();
    await act(async () => {
      button.focus();
      await user.keyboard('{Enter}');
    });
    return button;
  };
  const status = (message: string) => waitFor(() => expect(host.textContent).toContain(message));
  const render = async (csrfToken = 'original-session') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
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
        </QueryClientProvider>,
      ),
    );
  const corrections = () => fixture.calls.filter((call) => call.method === 'POST');
  const privateOnly = () => {
    expect(host.querySelector('nav, h2, dl, input, summary, a')).toBeNull();
    expect(host.innerHTML).not.toContain(gameId);
    expect(host.innerHTML).not.toContain('https://example.test/game-notes');
    expect(host.textContent).not.toContain('Recovered current Game');
    expect(host.textContent).not.toContain('The Lantern Game');
  };
  const draftInput = () =>
    within(host.querySelector<HTMLElement>('[data-slot="game-classification"]')!).getByRole('textbox', {
      name: m.correction_value(),
    }) as HTMLInputElement;
  try {
    await render();
    await status(m.game_profile_current());
    // Reference fields and qualifier fields remain identifiable, scoped to the actual statement.
    const citation = host.querySelector('a[href="https://example.test/game-notes"]')!.closest('dl')!;
    expect(citation.querySelector('dt')?.textContent).toBe(initial.release.properties['schema:url']!.labels.en);
    const summary = [...host.querySelectorAll<HTMLElement>('summary')].find(
      (node) => node.textContent === m.game_profile_classification(),
    )!;
    const holder = summary.closest('details')!;
    await click(summary);
    const region = host.querySelector<HTMLElement>('[data-slot="game-classification"]')!;
    await click(within(region).getByRole('button', { name: m.facts_edit_field() }));
    const input = within(region).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
    await act(async () => {
      await user.clear(input);
      await user.type(input, 'fr');
    });
    const submit = within(holder).getByRole('button', { name: m.facts_submit() });
    await click(submit);
    await waitFor(() => expect(corrections()).toHaveLength(1));
    const original = structuredClone(corrections()[0]);
    for (const failure of [{ ok: false, reason: 'unavailable' } as GameRead, new Error('temporary read failure')]) {
      outcome = failure;
      await click(refresh());
      await status(m.game_profile_refresh_failed());
      privateOnly();
      expect(input.isConnected).toBe(false);
      outcome = structuredClone(initial);
      if (outcome.ok && outcome.public) outcome.public.subject.labels.en = 'Recovered current Game';
      await click(refresh());
      await status('Recovered current Game');
      await status(m.game_profile_current());
      expect(draftInput().value).toBe('fr');
      expect(draftInput().disabled || draftInput().closest('fieldset')?.disabled).toBe(true);
      expect(holder.open).toBe(true);
      expect(corrections()).toHaveLength(1);
    }
    expect(loads).toBe(5);
    for (const concealed of [{ ok: false, reason: 'denied' } as GameRead, { ...initial, public: null }]) {
      outcome = concealed;
      await click(refresh());
      await waitFor(() => expect(host.querySelector('nav')).toBeNull());
      privateOnly();
      outcome = { ok: false, reason: 'unavailable' };
      await click(refresh());
      privateOnly();
      outcome = initial;
      await click(refresh());
      await status(m.game_profile_current());
      expect(draftInput().value).toBe('fr');
    }
    // A different subject can never restore this editor's old reading or drafts.
    outcome = structuredClone(initial);
    if (outcome.ok && outcome.public) outcome.public.subject.id = '00000000-0000-4000-8000-00000000ffff';
    await click(refresh());
    privateOnly();
    outcome = initial;
    await click(refresh());
    await status(m.game_profile_current());
    expect(draftInput().value).toBe('fr');
    // The result from the retired reading cannot resolve its sealed command after recovery.
    held = false;
    await act(async () => {
      deliver();
      await delivery;
    });
    expect(host.textContent).not.toContain(m.correction_proposed());
    expect(corrections()).toHaveLength(1);
    await click(within(holder).getByRole('button', { name: m.facts_submit() }));
    await status(m.correction_proposed());
    expect(corrections()).toHaveLength(2);
    expect(corrections()[1]).toEqual(original);
    const keyboardRead = structuredClone(initial);
    if (keyboardRead.ok && keyboardRead.public) keyboardRead.public.subject.labels.en = 'Keyboard current Game';
    await keyboardRefresh(keyboardRead);
    await status('Keyboard current Game');
    await status(m.game_profile_current());
    expect(document.activeElement).toBe(host.querySelector('[data-slot="view-heading"] h1'));
    await keyboardRefresh(new Error('temporary read failure'));
    await status(m.game_profile_refresh_failed());
    const failure = within(host).getByRole('alert');
    expect(document.activeElement).toBe(failure.parentElement);
    expect(failure.parentElement).toHaveProperty('tabIndex', -1);
    const retry = await keyboardRefresh({ ok: false, reason: 'unavailable' });
    await status(m.game_profile_refresh_failed());
    expect(document.activeElement).toBe(retry);
    await keyboardRefresh(keyboardRead);
    await status('Keyboard current Game');
    expect(document.activeElement).toBe(host.querySelector('[data-slot="view-heading"] h1'));
    // CSRF rotation releases every private holder rather than reviving the previous draft.
    await render('replacement-session');
    await status(m.game_profile_current());
    expect(within(host).queryByRole('textbox', { name: m.correction_value() })).toBeNull();
    expect(host.textContent).not.toContain(m.correction_proposed());

    const language = 'schema:inLanguage';
    const platform = 'schema:gamePlatform';
    const without = (property: string, removeDefinition = true): GameRead => {
      const next = structuredClone(initial);
      if (!next.ok || !next.public) throw new Error('Expected an existing Game');
      const typeId = next.public.subject.type;
      const type = next.release.types[typeId]!;
      next.release.types[typeId] = {
        ...type,
        properties: type.properties.filter((item) => item !== property),
      };
      if (removeDefinition) delete next.release.properties[property];
      return next;
    };
    const field = (property: string) =>
      host.querySelector<HTMLElement>(`[data-classification-property="${property}"]`);
    const fieldInput = (property: string) =>
      within(field(property)!).getByRole('textbox', { name: m.correction_value() }) as HTMLInputElement;
    const classification = () =>
      [...host.querySelectorAll<HTMLElement>('summary')].find(
        (node) => node.textContent === m.game_profile_classification(),
      )!;
    const ensureClassificationOpen = async () => {
      const summary = classification();
      if (!summary.closest('details')!.open) await click(summary);
    };
    const edit = async (property: string) => {
      await ensureClassificationOpen();
      await click(within(field(property)!).getAllByRole('button', { name: m.facts_edit_field() })[0]!);
      return fieldInput(property);
    };
    const write = async (input: HTMLInputElement, value: string) =>
      act(async () => {
        await user.clear(input);
        await user.type(input, value);
      });
    const submitClassifications = () =>
      within(classification().closest('details')!).getByRole('button', { name: m.facts_submit() });

    let input = await edit(language);
    await write(input, 'fr');
    input = await edit(platform);
    await write(input, 'fr');
    const beforeAdmission = sentCommands.length;
    outcome = without(language, false);
    await click(refresh());
    await status(m.game_profile_current());
    expect(fieldInput(language).value).toBe('fr');
    expect(fieldInput(language).closest('fieldset')?.disabled).toBe(true);
    expect(host.textContent).toContain(m.game_profile_support());
    await click(submitClassifications());
    await waitFor(() => expect(sentCommands).toHaveLength(beforeAdmission + 1));
    expect(sentCommands[beforeAdmission]!.statement.property.id).toBe(platform);
    expect(fieldInput(language).value).toBe('fr');
    const withheld = field(language)!;
    await click(within(withheld).getByRole('button', { name: m.recipe_remove_field() }));
    await click(within(withheld).getByRole('button', { name: m.candidate_cancel() }));
    expect(fieldInput(language).value).toBe('fr');
    await click(within(withheld).getByRole('button', { name: m.recipe_remove_field() }));
    expect(field(language)).toBeNull();

    outcome = structuredClone(initial);
    await render('admission-replay-session');
    await status(m.game_profile_current());
    input = await edit(platform);
    await write(input, 'fr');
    const beforeUncertain = sentCommands.length;
    loseNextResponse = true;
    await click(submitClassifications());
    await waitFor(() => expect(sentCommands).toHaveLength(beforeUncertain + 1));
    const originalPlatformCommand = structuredClone(sentCommands[beforeUncertain]!);
    expect(originalPlatformCommand.statement.property.id).toBe(platform);
    await status(m.correction_unavailable());
    input = await edit(language);
    await write(input, 'fr');

    outcome = without(platform);
    await click(refresh());
    await status(m.game_profile_current());
    expect(fieldInput(platform).value).toBe('fr');
    expect(fieldInput(platform).closest('fieldset')?.disabled).toBe(true);
    const beforeValidSibling = sentCommands.length;
    await click(submitClassifications());
    await waitFor(() => expect(sentCommands).toHaveLength(beforeValidSibling + 1));
    expect(sentCommands[beforeValidSibling]!.statement.property.id).toBe(language);
    expect(sentCommands[beforeValidSibling]).not.toEqual(originalPlatformCommand);

    outcome = structuredClone(initial);
    await click(refresh());
    await status(m.game_profile_current());
    expect(fieldInput(platform).value).toBe('fr');
    const beforeReplay = sentCommands.length;
    await click(submitClassifications());
    await waitFor(() => expect(sentCommands).toHaveLength(beforeReplay + 1));
    expect(sentCommands[beforeReplay]).toEqual(originalPlatformCommand);
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
