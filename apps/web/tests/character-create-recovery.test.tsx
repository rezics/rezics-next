import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { CharacterCommand } from '../src/features/catalogue/character-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('required Character metadata recovery gates new commands and preserves private input and exact retry', async () => {
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
  delete current.properties['schema:url'];
  let refreshes = 0;
  let created = 0;
  const commands: CharacterCommand[] = [];
  const transport = {
    ...fixture.transport,
    create: async (command: CharacterCommand) => {
      commands.push(command);
      if (commands.length === 1) return { ok: false as const, reason: 'invalid' as const, refreshDefinitions: true };
      if (commands.length === 2)
        return { ok: false as const, reason: 'unavailable' as const, refreshDefinitions: true };
      return fixture.transport.create(command);
    },
  };
  const click = (name: string) => act(async () => user.click(canvas.getByRole('button', { name })));
  const input = (name: string, index = 0) => canvas.getAllByRole('textbox', { name })[index] as HTMLInputElement;
  const replace = (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      await user.type(control, value);
    });
  const submit = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address="character-recovery"
            observed={{ state: 'signed-in', subject: 'reader', csrfToken: 'original' }}
          >
            <CharacterProfileCreate
              release={fixture.release}
              locale="en"
              transport={transport}
              onCreated={() => {
                created++;
              }}
              onRefreshDefinitions={async () => {
                if (++refreshes < 3) throw new Error('Metadata unavailable');
                return current;
              }}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
    await replace(input(m.catalogue_create_label()), 'Traveler');
    await click(m.catalogue_create_add_language());
    await replace(input(m.catalogue_create_language(), 1), 'ja');
    await replace(input(m.catalogue_create_label(), 1), '旅人');
    await replace(input(m.catalogue_create_aliases(), 1), '旅行者');
    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url');
      await user.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    });
    await replace(input(m.correction_url()), 'https://example.org/private');
    await click(m.character_create());
    expect(refreshes).toBe(1);
    expect(canvas.getByRole('button', { name: m.character_create() })).toHaveProperty('disabled', true);
    expect(host.textContent).not.toContain(m.catalogue_create_uncertain());
    await replace(input(m.catalogue_create_label(), 1), '新しい旅人');
    await replace(input(m.catalogue_create_description(), 1), 'Private description');
    await replace(input(m.correction_url()), 'https://example.org/edited');
    await submit();
    await click(m.correction_reload());
    expect(refreshes).toBe(2);
    await submit();
    expect(commands).toHaveLength(1);
    expect(input(m.catalogue_create_label(), 1).value).toBe('新しい旅人');
    expect(input(m.correction_url()).value).toBe('https://example.org/edited');
    await click(m.correction_reload());
    expect(refreshes).toBe(3);
    expect(commands).toHaveLength(1);
    expect(canvas.queryByRole('textbox', { name: m.correction_url() })).toBeNull();
    expect(host.querySelector('[data-slot="character-initial-fact"] code')!.textContent).toContain(
      'https://example.org/edited',
    );
    expect(host.textContent).toContain(m.character_create_correction_summary());
    await submit();
    expect(commands).toHaveLength(1);
    await click(m.recipe_remove_field());
    await click(m.recipe_remove_field());
    await click(m.character_create());
    expect(commands).toHaveLength(2);
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    expect(commands[1]!.item).toMatchObject({
      labels: { en: 'Traveler', ja: '新しい旅人' },
      descriptions: { ja: 'Private description' },
      aliases: { ja: ['旅行者'] },
      statements: {},
    });
    expect(input(m.catalogue_create_label()).closest('fieldset[disabled]')).not.toBeNull();
    const sealed = structuredClone(commands[1]);
    await click(m.correction_retry());
    expect(commands).toHaveLength(3);
    expect(commands[2]).toBe(commands[1]);
    expect(commands[2]).toEqual(sealed);
    expect(refreshes).toBe(3);
    expect(created).toBe(1);
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
