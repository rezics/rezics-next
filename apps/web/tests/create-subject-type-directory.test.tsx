import { expect, test } from 'bun:test';
import { act, createElement, useState } from 'react';
import type { CreateType, TypeDirectoryPage, TypeDirectoryTransport } from '../src/features/catalogue/create-subject';

test('paged results cannot replace a current selection, and exact lookup selects only a current descriptor', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en/catalogue/new' });
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
  const testing = require(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const { TypeDirectoryPicker } = await import('../src/features/catalogue/type-directory-picker');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });

  const movie: CreateType = { id: 'schema:Movie', label: 'Movie', labelLanguage: 'en', description: 'A film.' };
  const book: CreateType = { id: 'schema:Book', label: 'Book', labelLanguage: 'en', description: 'A book.' };
  let resolveLatePage!: (page: TypeDirectoryPage) => void;
  const latePage = new Promise<TypeDirectoryPage>((resolve) => (resolveLatePage = resolve));
  const transport: TypeDirectoryTransport = {
    page: async (input) => {
      if (input.cursor) return latePage;
      if (input.typeId) return { ok: true, types: input.typeId === book.id ? [book] : [], next: null };
      return { ok: true, types: [movie], next: input.query === 'later' ? null : 'cursor-1' };
    },
    descriptor: async (id) => (id === book.id ? { ok: true, type: book } : { ok: false, reason: 'missing' }),
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  function Harness() {
    const [selected, setSelected] = useState<CreateType | null>(movie);
    return createElement(
      'div',
      {},
      createElement(TypeDirectoryPicker, {
        locale: 'en',
        transport,
        selected,
        disabled: false,
        invalid: false,
        describedBy: '',
        refreshToken: 0,
        onSelectionChange: setSelected,
        onPendingChange: () => {},
      }),
      createElement('output', { 'data-testid': 'selected' }, selected?.id ?? ''),
    );
  }
  const render = async () => act(async () => root.render(createElement(Harness)));
  const canvas = () => within(host);
  const click = async (name: string) => act(async () => user.click(canvas().getByRole('button', { name })));

  try {
    await render();
    await click(m.catalogue_create_type_search_action());
    await canvas().findByRole('list', { name: m.catalogue_create_type_results() });
    await click(m.catalogue_create_type_next());
    await user.clear(canvas().getByRole('textbox', { name: m.catalogue_create_type_search() }));
    await user.type(canvas().getByRole('textbox', { name: m.catalogue_create_type_search() }), 'later');
    await act(async () => resolveLatePage({ ok: true, types: [book], next: null }));
    await waitFor(() => expect(canvas().queryByRole('list')).toBeNull());
    expect(canvas().getByTestId('selected')).toHaveTextContent(movie.id);

    await user.selectOptions(canvas().getByRole('combobox', { name: m.catalogue_create_type_search_mode() }), 'id');
    const query = canvas().getByRole('textbox', { name: m.catalogue_create_type_search() });
    await user.clear(query);
    await user.type(query, book.id);
    await click(m.catalogue_create_type_search_action());
    const results = await canvas().findByRole('list', { name: m.catalogue_create_type_results() });
    await act(async () => user.click(within(results).getByText(m.catalogue_create_type_select())));
    await waitFor(() => expect(canvas().getByTestId('selected')).toHaveTextContent(book.id));
    expect(results).toHaveTextContent(book.id);
  } finally {
    await act(async () => root.unmount());
    window.close();
    setLocale(oldLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
