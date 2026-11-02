import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { CharacterCommand } from '../src/features/catalogue/character-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('successful Character refresh withdraws only the choice and requires deliberate re-selection', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/character' });
  const globals = {
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'Element',
        'Node',
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
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CharacterProfileCreate } = await import('../src/features/catalogue/character-profile-create');
  const { characterType } = await import('../src/features/catalogue/character-profile');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { characterProfileFixture } = await import('../src/kernel/fake/catalogue-character-profile');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const canvas = within(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  const fixture = characterProfileFixture();
  const current = structuredClone(fixture.release);
  current.types[characterType]!.properties = current.types[characterType]!.properties.filter(
    (id) => id !== 'schema:height',
  );
  const commands: CharacterCommand[] = [];
  let refreshes = 0;
  const transport = {
    ...fixture.transport,
    create: async (command: CharacterCommand) => {
      commands.push(command);
      return commands.length === 1
        ? { ok: false as const, reason: 'invalid' as const, refreshDefinitions: true }
        : { ok: false as const, reason: 'unavailable' as const };
    },
  };
  const click = (name: string) => act(async () => user.click(canvas.getByRole('button', { name })));
  const input = (name: string, index = 0) => canvas.getAllByRole('textbox', { name })[index] as HTMLInputElement;
  const type = (name: string, value: string, index = 0) => act(async () => user.type(input(name, index), value));
  const choose = (value: string) =>
    act(async () => user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), value));
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address="character-choice"
            observed={{ state: 'signed-in', subject: 'reader', csrfToken: 'original' }}
          >
            <CharacterProfileCreate
              release={fixture.release}
              locale="en"
              transport={transport}
              onCreated={() => {}}
              onRefreshDefinitions={async () => {
                refreshes++;
                return current;
              }}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await type(m.catalogue_create_label(), 'Traveler');
    await click(m.catalogue_create_add_language());
    await type(m.catalogue_create_language(), 'ja', 1);
    await type(m.catalogue_create_label(), '旅人', 1);
    await type(m.catalogue_create_description(), 'Private description', 1);
    await type(m.catalogue_create_aliases(), '旅行者', 1);
    await choose('schema:url');
    await click(m.character_add_fact());
    const authored = input(m.correction_url());
    await type(m.correction_url(), 'https://example.org/private');
    await choose('schema:height');
    await click(m.character_create());
    expect(refreshes).toBe(1);
    expect(commands).toHaveLength(1);
    expect(current.properties['schema:height']).toBeDefined();
    const chooser = canvas.getByRole('combobox', { name: m.character_initial_fact() });
    expect(chooser).toHaveProperty('value', '');
    expect(canvas.getByRole('status').textContent).toBe(m.character_initial_fact_withdrawn());
    expect(chooser.getAttribute('aria-describedby')).toBe(canvas.getByRole('status').id);
    expect(input(m.correction_url())).toBe(authored);
    expect(authored.value).toBe('https://example.org/private');
    expect(canvas.getByRole('button', { name: m.character_add_fact() })).toHaveProperty('disabled', true);
    await click(m.character_add_fact());
    expect(host.querySelectorAll('[data-slot="character-initial-fact"]')).toHaveLength(1);
    await choose('wdt:P3180');
    expect(canvas.queryByRole('status')).toBeNull();
    await click(m.character_add_fact());
    await click(m.character_add_fact());
    const rows = host.querySelectorAll('[data-slot="character-initial-fact"]');
    expect(rows).toHaveLength(2);
    expect(window.document.activeElement).toBe(rows[1]);
    await type(m.correction_value(), 'c123');
    expect(commands).toHaveLength(1);
    await click(m.character_create());
    expect(commands).toHaveLength(2);
    expect(commands[1]!.item).toMatchObject({
      labels: { en: 'Traveler', ja: '旅人' },
      descriptions: { ja: 'Private description' },
      aliases: { ja: ['旅行者'] },
      statements: {
        'schema:url': [{ value: { content: 'https://example.org/private' } }],
        'wdt:P3180': [{ value: { content: 'c123' } }],
      },
    });
    expect(Object.keys(commands[1]!.item.statements)).toEqual(['schema:url', 'wdt:P3180']);
    const sealed = structuredClone(commands[1]);
    expect(chooser.closest('fieldset[disabled]')).not.toBeNull();
    await click(m.correction_retry());
    expect(commands).toHaveLength(3);
    expect(commands[2]).toBe(commands[1]);
    expect(commands[2]).toEqual(sealed);
    expect(refreshes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
