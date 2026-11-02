import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

test('specialist language choices preserve stable drafts, focus, corrections and sealed commands', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/catalogue/new' });
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
        'HTMLInputElement',
        'HTMLSelectElement',
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
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { AlbumProfileCreate } = await import('../src/features/catalogue/album-profile-create');
  const { MangaProfile } = await import('../src/features/catalogue/manga-profile-view');
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { albumFixture } = await import('../src/kernel/fake/catalogue-album-profile');
  const { mangaFixture } = await import('../src/kernel/fake/catalogue-manga-profile');
  const { recipeFixture } = await import('../src/kernel/fake/recipe-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const testing = createRequire(require.resolve('storybook/test'));
  const { within } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document, delay: null });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const canvas = within(host);
  const click = (name: string, scope = host) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const input = (name: string, index = 0) => canvas.getAllByRole('textbox', { name })[index] as HTMLInputElement;
  const fill = (control: HTMLElement, value: string) => act(async () => user.type(control, value));
  const submit = () =>
    act(async () => {
      host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const row = (control: HTMLElement) =>
    control.closest<HTMLElement>('[id]:has(> [aria-controls]), [id]:has(> div[role="group"])')!;
  try {
    for (const family of ['Album', 'Manga', 'Recipe']) {
      const fixture = family === 'Album' ? albumFixture() : family === 'Manga' ? mangaFixture() : recipeFixture();
      const commands: { item: unknown; key: string; session?: string }[] = [];
      let finish!: (result: CreateResult) => void;
      let metadata = true;
      const transport = {
        ...fixture.transport,
        create: (command: (typeof commands)[number]) => {
          commands.push(command);
          command.session ??= 'original-credential';
          return new Promise<CreateResult>((resolve) => {
            finish = resolve;
          });
        },
      };
      const props = { locale: 'en', transport, search: async () => [] };
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <CandidateReaderBoundary
              key={family}
              address={family}
              observed={{ state: 'signed-in', subject: 'viewer', csrfToken: 'first' }}
            >
              {family === 'Album' ? (
                <AlbumProfileCreate
                  {...props}
                  release={fixture.release}
                  metadataCurrent={() => metadata}
                  onReload={async () => {}}
                  enabled
                />
              ) : family === 'Manga' ? (
                <MangaProfile {...props} session="signed-in" />
              ) : (
                <RecipeEditor {...props} session="signed-in" />
              )}
            </CandidateReaderBoundary>
          </QueryClientProvider>,
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await fill(input(m.catalogue_create_label()), 'Original');
      await click(m.catalogue_create_add_language());
      await click(m.catalogue_create_remove_language());
      expect(canvas.getAllByRole('textbox', { name: m.catalogue_create_language() })).toHaveLength(1);
      expect(document.activeElement).toBe(canvas.getByRole('button', { name: m.catalogue_create_add_language() }));
      for (const language of ['fr', 'ja', 'ko']) {
        await click(m.catalogue_create_add_language());
        const index = canvas.getAllByRole('textbox', { name: m.catalogue_create_language() }).length - 1;
        await fill(input(m.catalogue_create_language(), index), language);
        if (language !== 'ja') await fill(input(m.catalogue_create_label(), index), language);
      }
      const japanese = input(m.catalogue_create_label(), 2);
      const japaneseRow = row(japanese);
      await fill(input(m.catalogue_create_description(), 2), '説明');
      await fill(input(m.catalogue_create_aliases(), 2), '別名\n他の名前');
      await submit();
      expect(commands).toHaveLength(0);
      expect(host.querySelector(`a[href="#${japanese.id}"]`)).not.toBeNull();
      await click(m.catalogue_create_remove_language(), japaneseRow);
      expect(document.activeElement).toBe(within(japaneseRow).getByRole('button', { name: m.candidate_cancel() }));
      await click(m.candidate_cancel(), japaneseRow);
      expect(document.activeElement).toBe(
        within(japaneseRow).getByRole('button', { name: m.catalogue_create_remove_language() }),
      );
      expect(host.querySelector(`a[href="#${japanese.id}"]`)).not.toBeNull();
      await click(m.catalogue_create_remove_language(), japaneseRow);
      await act(async () => user.keyboard('{Escape}'));
      expect(document.activeElement).toBe(
        within(japaneseRow).getByRole('button', { name: m.catalogue_create_remove_language() }),
      );
      await click(m.catalogue_create_remove_language(), japaneseRow);
      const frenchRow = row(input(m.catalogue_create_label(), 1));
      await fill(input(m.catalogue_create_label(), 3), ' retained');
      await click(m.catalogue_create_remove_language(), frenchRow);
      await click(m.catalogue_create_remove_language(), frenchRow);
      expect(document.getElementById(japanese.id)).toBe(japanese);
      if (family === 'Recipe') expect(host.querySelector(`a[href="#${japanese.id}"]`)).not.toBeNull();
      expect(input(m.catalogue_create_description(), 1).value).toBe('説明');
      expect(input(m.catalogue_create_aliases(), 1).value).toBe('別名\n他の名前');
      await click(m.catalogue_create_remove_language(), japaneseRow);
      expect(document.activeElement).toBe(input(m.catalogue_create_language(), 1));
      expect(input(m.catalogue_create_label(), 1).value).toBe('ko retained');
      await click(m.catalogue_create_add_language());
      expect(input(m.catalogue_create_label(), 2).id).not.toBe(japanese.id);
      await fill(input(m.catalogue_create_language(), 2), 'de');
      await fill(input(m.catalogue_create_label(), 2), 'Deutsch');
      const germanRow = row(input(m.catalogue_create_label(), 2));
      await click(m.catalogue_create_remove_language(), germanRow);
      if (family === 'Album') {
        metadata = false;
        await click(m.catalogue_create_remove_language(), germanRow);
        expect(germanRow.isConnected).toBe(true);
        metadata = true;
      }
      await submit();
      const confirm = within(germanRow).getByRole('button', { name: m.catalogue_create_remove_language() });
      const forcedClick = () =>
        act(async () => {
          confirm.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        });
      await forcedClick();
      expect(germanRow.isConnected).toBe(true);
      expect(commands).toHaveLength(1);
      const sealed = structuredClone(commands[0]);
      await act(async () => finish({ ok: false, reason: 'unavailable' }));
      await forcedClick();
      expect(germanRow.isConnected).toBe(true);
      await submit();
      expect(commands[1]).toBe(commands[0]);
      expect(commands[1]).toEqual(sealed);
      await act(async () => finish({ ok: false, reason: 'unavailable' }));
    }
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
