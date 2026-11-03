import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GameCommand } from '../src/features/catalogue/game-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('Game creation reviews multilingual facts, copies evidence, repairs nested holders and rereads the returned UUID', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/game' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
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
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { GameProfile } = await import('../src/features/catalogue/game-profile-view');
  const { gameProfileFixture, gameId } = await import('../src/kernel/fake/catalogue-game-profile');
  const { pickText } = await import('@rezics/composition');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document, delay: null });
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const canvas = () => within(host);
  async function render(node: ReactNode, reader = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', fresh = true) {
    if (fresh) {
      await act(async () => root.render(null));
      client.clear();
      client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            observed={{ state: 'signed-in', subject: reader, csrfToken: 'token' }}
            address="game-create-review"
          >
            {node}
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  }
  async function choose(type: string) {
    await waitFor(() => expect(canvas().getByRole('combobox', { name: m.catalogue_create_type() })).toBeDefined());
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type() }), type),
    );
  }
  async function confirm() {
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-game-create-review]')).not.toBeNull();
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
  }
  async function add(property: string) {
    await act(async () =>
      user.selectOptions(canvas().getByRole('combobox', { name: m.character_add_fact() }), property),
    );
    await act(async () => user.click(canvas().getByRole('button', { name: m.correction_add() })));
    return [...host.querySelectorAll<HTMLElement>('[data-slot="game-initial-fact"]')].at(-1)!;
  }
  async function cite(row: HTMLElement, url: string) {
    await act(async () => user.click(within(row).getByRole('button', { name: m.correction_add_reference() })));
    await act(async () =>
      user.selectOptions(within(row).getByRole('combobox', { name: m.correction_add_part() }), 'schema:url'),
    );
    await act(async () => user.click(within(row).getByRole('button', { name: m.correction_add() })));
    await act(async () => {
      const input = within(row).getAllByRole('textbox', { name: m.correction_url() }).at(-1)!;
      await user.clear(input);
      await user.type(input, url);
    });
  }
  try {
    const fixture = gameProfileFixture();
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        transport={fixture.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:VideoGame');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Reviewed lantern'),
    );
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_add_language() })));
    await act(async () => user.type(host.querySelector<HTMLElement>('#create-language-1')!, 'ja'));
    await act(async () => user.type(host.querySelector<HTMLElement>('#create-label-1')!, '灯りのゲーム'));
    await act(async () => user.type(host.querySelector<HTMLElement>('#create-aliases-1')!, 'ランタン'));
    const urlRow = await add('schema:url');
    const languageRow = await add('schema:inLanguage');
    await act(async () => {
      const input = within(urlRow).getAllByRole('textbox', { name: m.correction_url() })[0]!;
      await user.clear(input);
      await user.type(input, 'https://example.org/game');
    });
    await act(async () => user.type(within(languageRow).getByRole('textbox', { name: m.correction_value() }), 'ja'));
    await cite(urlRow, 'https://example.org/game-source');
    await cite(languageRow, 'https://example.org/language-source');
    await act(async () =>
      user.click(
        within(urlRow).getByRole('button', { name: `${m.facts_reuse_reference()} · ${m.correction_references()} 1` }),
      ),
    );
    const panel = host.querySelector('[data-fact-reuse]')!;
    expect(panel.textContent).toContain('https://example.org/game-source');
    expect(panel.textContent).toContain(pickText(fixture.release.properties['schema:inLanguage']!.labels, 'en').text);
    await act(async () => user.click(within(panel).getByRole('checkbox')));
    await act(async () => user.click(within(panel).getByRole('button', { name: m.facts_reuse_apply() })));
    expect(within(languageRow).getAllByRole('group', { name: /Citations/ })).toHaveLength(2);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    const review = host.querySelector('[data-game-create-review]')!;
    expect(review.textContent).toContain(m.game_profile_review_grain_work());
    expect(review.textContent).toContain('schema:VideoGame');
    expect(review.textContent).toContain('灯りのゲーム');
    expect(review.textContent).toContain('ランタン');
    expect(review.textContent).toContain('https://example.org/game-source');
    expect(review.textContent).toContain(m.candidate_rank_normal());
    expect(fixture.calls.some((call) => call.method === 'POST')).toBe(false);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(host.textContent).toContain(gameId);
    const created = fixture.calls.find((call) => call.method === 'POST')!.body as GameCommand['item'];
    expect(created.type).toBe('schema:VideoGame');
    expect(created.labels).toEqual({ en: 'Reviewed lantern', ja: '灯りのゲーム' });
    expect(created.aliases).toEqual({ ja: ['ランタン'] });
    expect(created.statements['schema:inLanguage']![0]!.rank).toBe('normal');
    expect(created.statements['schema:inLanguage']![0]!.references).toHaveLength(2);

    const switched = gameProfileFixture();
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        transport={switched.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:VideoGame');
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Kept work'));
    const workFact = await add('schema:inLanguage');
    await act(async () => user.type(within(workFact).getByRole('textbox', { name: m.correction_value() }), 'en'));
    await choose('wd:Q20631656');
    expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(0);
    await act(async () => user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), ' Release'));
    const releaseFact = await add('schema:inLanguage');
    await act(async () => user.type(within(releaseFact).getByRole('textbox', { name: m.correction_value() }), 'ja'));
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    expect(host.querySelector('[data-game-create-review]')?.textContent).toContain(
      m.game_profile_review_grain_release(),
    );
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_submit() })));
    await waitFor(() => expect(switched.calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    const releaseItem = switched.calls.find((call) => call.method === 'POST')!.body as GameCommand['item'];
    expect(releaseItem.type).toBe('wd:Q20631656');
    expect(JSON.stringify(releaseItem)).not.toContain('"content":"en"');

    const repaired = gameProfileFixture();
    const commands: GameCommand[] = [];
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        search={async () => []}
        onNavigate={() => {}}
        transport={{
          ...repaired.transport,
          create: async (command) => {
            commands.push(structuredClone(command));
            if (commands.length === 1)
              return {
                ok: false as const,
                reason: 'invalid' as const,
                errors: [
                  { pointer: '/statements/schema:url/0/references/0/parts/0/value/content', code: 'invalid_format' },
                ],
              };
            return repaired.transport.create(command);
          },
        }}
      />,
    );
    await choose('schema:VideoGame');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Repair nested'),
    );
    const bad = await add('schema:url');
    const keep = await add('schema:inLanguage');
    await act(async () => {
      const input = within(bad).getAllByRole('textbox', { name: m.correction_url() })[0]!;
      await user.clear(input);
      await user.type(input, 'https://example.org/repair');
    });
    await act(async () => user.type(within(keep).getByRole('textbox', { name: m.correction_value() }), 'ja'));
    await cite(bad, 'https://example.org/bad');
    const keepId = within(keep).getByRole('textbox', { name: m.correction_value() }).id;
    await confirm();
    const link = await waitFor(() =>
      canvas().getByRole('link', {
        name: new RegExp(pickText(repaired.release.properties['schema:url']!.labels, 'en').text),
      }),
    );
    expect(decodeURIComponent(link.getAttribute('href')!.slice(1))).not.toBe(keepId);
    await act(async () => user.click(within(bad).getByRole('button', { name: m.recipe_remove_field() })));
    await act(async () => user.click(within(bad).getByRole('button', { name: m.recipe_remove_field() })));
    expect(host.querySelectorAll('[data-slot="game-initial-fact"]')).toHaveLength(1);
    expect(within(keep).getByRole('textbox', { name: m.correction_value() }).id).toBe(keepId);
    await confirm();
    await waitFor(() => expect(commands).toHaveLength(2));
    expect(commands[1]!.item.statements).not.toHaveProperty('schema:url');
    expect(commands[1]!.key).not.toBe(commands[0]!.key);

    const uncertain = gameProfileFixture('uncertain');
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        transport={uncertain.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:VideoGame');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Uncertain lantern'),
    );
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_uncertain()));
    const frozen = structuredClone(uncertain.calls.find((call) => call.method === 'POST'));
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    const writes = uncertain.calls.filter((call) => call.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(frozen);
    expect(writes[1]).toEqual(frozen);

    const unread = gameProfileFixture();
    let reads = 0;
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        search={async () => []}
        onNavigate={() => {}}
        transport={{
          ...unread.transport,
          create: async (command) => {
            const result = await unread.transport.create(command);
            if (!result.ok) return result;
            return { ...result, reader: { state: 'unavailable' as const } };
          },
          read: async (id) => {
            reads++;
            expect(id).toBe(gameId);
            return unread.transport.read(id);
          },
        }}
      />,
    );
    await choose('schema:VideoGame');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Unread lantern'),
    );
    await confirm();
    await waitFor(() => expect(host.textContent).toContain(m.catalogue_create_reader_unavailable()));
    expect(host.textContent).toContain(gameId);
    expect(unread.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(reads).toBe(0);
    await act(async () => user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() })));
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    expect(unread.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(reads).toBe(1);

    const retired = gameProfileFixture();
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        transport={retired.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await choose('schema:VideoGame');
    await act(async () =>
      user.type(canvas().getByRole('textbox', { name: m.catalogue_create_label() }), 'Retired sentinel'),
    );
    await confirm();
    await waitFor(() => expect(canvas().getByRole('link', { name: m.catalogue_create_open() })).toBeDefined());
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        transport={retired.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
      '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
      false,
    );
    await waitFor(() => expect(host.querySelector('#create-label-0')).not.toBeNull());
    expect(host.innerHTML).not.toContain('Retired sentinel');
    expect(canvas().queryByRole('link', { name: m.catalogue_create_open() })).toBeNull();

    const blocked = gameProfileFixture('unavailable');
    await render(
      <GameProfile
        locale="en"
        session="signed-in"
        transport={blocked.transport}
        search={async () => []}
        onNavigate={() => {}}
      />,
    );
    await waitFor(() => expect(host.textContent).toContain(m.correction_unavailable()));
    expect(host.querySelector('form')).toBeNull();
    expect(blocked.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
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
}, 30_000);
