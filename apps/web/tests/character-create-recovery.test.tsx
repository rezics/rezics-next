import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { CharacterCommand } from '../src/features/catalogue/character-profile';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('required Character metadata recovery fences retained term callbacks and preserves exact retry', async () => {
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
  const { CatalogueCurrentReading } = await import('../src/features/catalogue/editor-lifetime');
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
  let finishSecond: ((result: Awaited<ReturnType<typeof fixture.transport.create>>) => void) | undefined;
  let revision = 'current';
  let holder = 0;
  const commands: CharacterCommand[] = [];
  const transport = {
    ...fixture.transport,
    create: async (command: CharacterCommand) => {
      commands.push(command);
      if (commands.length === 1) return { ok: false as const, reason: 'invalid' as const, refreshDefinitions: true };
      if (commands.length === 2) return new Promise((resolve) => (finishSecond = resolve));
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
  const confirmCreate = () => click(m.character_create());
  const openReview = () => click(m.character_create_review());
  const submit = async () => {
    if (canvas.queryByRole('button', { name: m.correction_retry() })) return click(m.correction_retry());
    if (canvas.queryByRole('button', { name: m.character_create() })) return click(m.character_create());
    await openReview();
    if (canvas.queryByRole('button', { name: m.character_create() })) await confirmCreate();
  };
  const dispatchSubmit = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const inputChange = (node: Element) =>
    (
      Reflect.get(
        node,
        Object.keys(node).find((key) => key.startsWith('__reactProps$'))!,
      ) as { onChange: (event: { target: { value: string } }) => void }
    ).onChange;
  const paint = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address="character-recovery"
            observed={{ state: 'signed-in', subject: 'reader', csrfToken: 'original' }}
          >
            <CatalogueCurrentReading visible ready revision={revision}>
              <CharacterProfileCreate
                key={holder}
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
            </CatalogueCurrentReading>
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  try {
    await paint();
    for (const kind of ['language', 'fact'] as const) {
      for (const mode of ['keyboard', 'pointer', 'moved', 'retired'] as const) {
        if (kind === 'fact')
          await act(async () =>
            user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url'),
          );
        const add = canvas.getByRole('button', {
          name: kind === 'language' ? m.catalogue_create_add_language() : m.character_add_fact(),
        });
        add.focus();
        await act(async () => {
          if (mode === 'keyboard') await user.keyboard('{Enter}');
          else if (mode === 'pointer') await user.click(add);
          else if (mode === 'retired') {
            add.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
            revision += '-next';
            await paint();
          } else {
            add.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: 0 }));
            input(m.catalogue_create_label()).focus();
            add.focus();
          }
        });
        const target =
          kind === 'language'
            ? input(m.catalogue_create_language(), 1)
            : host.querySelector('[data-slot="character-initial-fact"] > [id]');
        expect(target).not.toBeNull();
        expect(window.document.activeElement).toBe(mode === 'keyboard' ? target : add);
        await click(kind === 'language' ? m.catalogue_create_remove_language() : m.recipe_remove_field());
        if (kind === 'fact') await click(m.recipe_remove_field());
        expect(window.document.activeElement).toBe(
          kind === 'language' ? add : canvas.getByRole('combobox', { name: m.character_initial_fact() }),
        );
      }
    }
    await replace(input(m.catalogue_create_label()), 'Traveler');
    await click(m.catalogue_create_add_language());
    await replace(input(m.catalogue_create_language(), 1), 'ja');
    await replace(input(m.catalogue_create_label(), 1), '旅人');
    await replace(input(m.catalogue_create_aliases(), 1), '旅行者');
    const editJapaneseLabel = inputChange(input(m.catalogue_create_label(), 1));
    await act(async () => editJapaneseLabel({ target: { value: '旅人 current edit' } }));
    expect(input(m.catalogue_create_label(), 1).value).toBe('旅人 current edit');
    expect(input(m.catalogue_create_label()).value).toBe('Traveler');
    await act(async () => editJapaneseLabel({ target: { value: '旅人' } }));
    await click(m.catalogue_create_add_language());
    const removedTermChange = inputChange(input(m.catalogue_create_label(), 2));
    await act(async () =>
      user.click(canvas.getAllByRole('button', { name: m.catalogue_create_remove_language() })[1]!),
    );
    await act(async () => removedTermChange({ target: { value: 'Removed row mutation' } }));
    expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_label() })).toHaveLength(2);
    await click(m.catalogue_create_remove_language());
    await click(m.candidate_cancel());
    expect(window.document.activeElement).toBe(
      canvas.getByRole('button', { name: m.catalogue_create_remove_language() }),
    );
    await act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.character_initial_fact() }), 'schema:url');
      await user.click(canvas.getByRole('button', { name: m.character_add_fact() }));
    });
    await replace(input(m.correction_url()), 'https://example.org/private');
    await submit();
    expect(refreshes).toBe(1);
    expect(canvas.getByRole('button', { name: m.character_create_review() })).toHaveProperty('disabled', true);
    expect(host.textContent).not.toContain(m.catalogue_create_uncertain());
    await replace(input(m.catalogue_create_label(), 1), '新しい旅人');
    await replace(input(m.catalogue_create_description(), 1), 'Private description');
    await replace(input(m.correction_url()), 'https://example.org/edited');
    await dispatchSubmit();
    await click(m.correction_reload());
    expect(refreshes).toBe(2);
    await dispatchSubmit();
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
    const lockedTermChange = inputChange(input(m.catalogue_create_label(), 1));
    await submit();
    expect(commands).toHaveLength(2);
    const sealed = structuredClone(commands[1]);
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    expect(commands[1]!.item).toMatchObject({
      labels: { en: 'Traveler', ja: '新しい旅人' },
      descriptions: { ja: 'Private description' },
      aliases: { ja: ['旅行者'] },
      statements: {},
    });
    expect(input(m.catalogue_create_label()).closest('fieldset[disabled]')).not.toBeNull();
    const pendingFeedback = host.querySelector('[data-slot="character-create-recovery"]')!.textContent;
    await act(async () => lockedTermChange({ target: { value: 'Pending mutation' } }));
    expect(input(m.catalogue_create_label(), 1).value).toBe('新しい旅人');
    expect(host.querySelector('[data-slot="character-create-recovery"]')!.textContent).toBe(pendingFeedback);
    await act(async () => finishSecond!({ ok: false, reason: 'unavailable', refreshDefinitions: true }));
    const uncertainFeedback = host.querySelector('[data-slot="character-create-recovery"]')!.textContent;
    await act(async () => lockedTermChange({ target: { value: 'Uncertain mutation' } }));
    expect(input(m.catalogue_create_label(), 1).value).toBe('新しい旅人');
    expect(host.querySelector('[data-slot="character-create-recovery"]')!.textContent).toBe(uncertainFeedback);
    await click(m.correction_retry());
    expect(commands).toHaveLength(3);
    expect(commands[2]).toBe(commands[1]);
    expect(commands[2]).toEqual(sealed);
    expect(refreshes).toBe(3);
    expect(created).toBe(1);
    const beforeMetadataRetirement = inputChange(input(m.catalogue_create_label(), 1));
    revision = 'next-reading';
    await paint();
    await act(async () => beforeMetadataRetirement({ target: { value: 'Retired metadata mutation' } }));
    expect(input(m.catalogue_create_label(), 1).value).toBe('新しい旅人');
    const beforeWorkspaceReplacement = inputChange(input(m.catalogue_create_label(), 1));
    holder++;
    await paint();
    await act(async () => beforeWorkspaceReplacement({ target: { value: 'Replaced workspace mutation' } }));
    expect(input(m.catalogue_create_label()).value).toBe('');
    expect(commands).toHaveLength(3);
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
