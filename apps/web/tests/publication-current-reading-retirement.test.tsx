import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type {
  PublicationCommand,
  PublicationRead,
  PublicationTransport,
} from '../src/features/catalogue/publication-editor';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('publication refresh retires the old work reading, keeps private values and admits only a matching recovery', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/publication' });
  const keys =
    'window document navigator HTMLElement HTMLInputElement HTMLTextAreaElement Element Node DocumentFragment MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const previous = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const testDir = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within, waitFor } = await import(Bun.resolveSync('@testing-library/dom', testDir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testDir));
  const { PublicationEditor } = await import('../src/features/catalogue/publication-editor-form');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { publicationFixture } = await import('../src/kernel/fake/publication-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });

  const fixture = publicationFixture('ready', 'en');
  const title = fixture.work.subject.labels.en!;
  const commands: PublicationCommand[] = [];
  let mode: 'ready' | 'pending' | 'refusal' | 'unsupported' = 'refusal';
  let submitMode: 'definitions' | 'uncertain' = 'definitions';
  let resolveRead: ((read: PublicationRead) => void) | undefined;
  let rejectRead: ((error: Error) => void) | undefined;
  let loads = 0;
  const transport: PublicationTransport = {
    load: async () => {
      loads++;
      if (mode === 'pending')
        return await new Promise<PublicationRead>((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        });
      if (mode === 'refusal') return { ok: false, reason: 'unavailable' };
      const read = await fixture.transport.load();
      return mode === 'unsupported' && read.ok ? { ...read, profiles: [] } : read;
    },
    submit: async (command) => {
      commands.push(structuredClone(command));
      return submitMode === 'definitions'
        ? { ok: false, reason: 'invalid', refreshDefinitions: true }
        : { ok: false, reason: 'unavailable' };
    },
    read: async () => ({ state: 'unavailable' }),
  };
  const search = async () => [
    {
      id: '00000000-0000-4000-8000-00000000e003',
      title: 'Supplied publisher',
      types: ['schema:Organization'],
      typeLabel: 'Publisher',
      cover: null,
    },
  ];
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  const canvas = within(host);
  const route = createRootRoute({
    component: () => (
      <CandidateReaderBoundary
        address="publication-read-recovery"
        observed={{ state: 'signed-in', subject: 'reader', csrfToken: 'current-session' }}
      >
        <PublicationEditor
          work={fixture.work.subject.id}
          locale="en"
          session="signed-in"
          transport={transport}
          search={search}
          onNavigate={() => {}}
        />
      </CandidateReaderBoundary>
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const draw = () =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
  const scope = () => canvas.getAllByRole('article')[0]!;
  const input = (name: string) => within(scope()).getByRole('textbox', { name }) as HTMLInputElement;
  const outside = window.document.createElement('button');
  outside.textContent = 'Elsewhere';
  window.document.body.append(outside);
  const keyboard = (name: string) =>
    act(async () => {
      within(scope()).getByRole('button', { name }).focus();
      await user.keyboard('{Enter}');
    });
  const click = (name: string) => act(async () => user.click(within(scope()).getByRole('button', { name })));
  const replace = (element: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(element);
      await user.type(element, value);
    });

  try {
    await draw();
    await canvas.findByRole('button', { name: m.catalogue_create_retry() });
    expect(window.document.activeElement).toBe(window.document.body);
    mode = 'ready';
    await keyboard(m.catalogue_create_retry());
    await waitFor(() =>
      expect(window.document.activeElement).toBe(
        canvas.getByRole('heading', { name: fixture.release.types['bf:Instance']!.labels.en! }),
      ),
    );
    expect(canvas.queryByRole('button', { name: m.catalogue_create_retry() })).toBeNull();
    await within(scope()).findByRole('textbox', { name: m.catalogue_create_label() });
    expect(within(scope()).getByRole('link', { name: title })).toBeDefined();
    await replace(input(m.catalogue_create_label()), 'A local edition');
    await replace(input(m.catalogue_create_language()), 'en-GB');
    await replace(
      within(host.querySelector('[id$="-work-link"]')!).getByRole('textbox', { name: m.correction_url() }),
      'https://publisher.example/edition',
    );
    await act(async () => user.click(within(scope()).getByRole('checkbox', { name: m.publication_independent() })));
    await act(async () =>
      user.selectOptions(within(scope()).getByRole('combobox', { name: m.publication_field() }), 'schema:publisher'),
    );
    await act(async () => {
      const choice = within(scope()).getByRole('combobox', { name: m.publication_field() });
      await user.click(within(choice.closest('fieldset')!).getByRole('button', { name: m.correction_add() }));
    });
    await replace(within(scope()).getByRole('combobox', { name: 'publisher' }) as HTMLElement, 'Supplied');
    const publisherOption = await within(window.document.body as unknown as HTMLElement).findByRole('option', {
      name: /Supplied publisher/,
    });
    await act(async () => user.click(publisherOption));
    await act(async () =>
      user.selectOptions(within(scope()).getByRole('combobox', { name: m.publication_field() }), 'schema:isbn'),
    );
    const relation = (within(scope()).getByRole('combobox', { name: m.relation_property() }) as HTMLSelectElement)
      .value;

    const create = async () => {
      await click(m.publication_review());
      await canvas.findByRole('heading', { name: m.publication_review() });
      await click(m.publication_submit());
    };
    mode = 'pending';
    await create();
    await canvas.findByText(m.catalogue_create_loading());
    expect(canvas.queryByRole('link', { name: title })).toBeNull();
    expect(canvas.queryByRole('link', { name: m.publication_back() })).toBeNull();
    expect(input(m.catalogue_create_label()).value).toBe('A local edition');
    expect(input(m.catalogue_create_language()).value).toBe('en-GB');
    expect((within(scope()).getByRole('combobox', { name: m.relation_property() }) as HTMLSelectElement).value).toBe(
      relation,
    );
    expect(
      (
        within(host.querySelector('[id$="-work-link"]')!).getByRole('textbox', {
          name: m.correction_url(),
        }) as HTMLInputElement
      ).value,
    ).toBe('https://publisher.example/edition');
    expect(
      within(scope()).getByRole('checkbox', { name: m.publication_independent() }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(scope().textContent).toContain('Supplied publisher');
    expect(commands).toHaveLength(1);

    await act(async () => rejectRead?.(new Error('Transient read failure')));
    await canvas.findByText(m.catalogue_create_unavailable());
    expect(canvas.queryByRole('link', { name: title })).toBeNull();
    expect(input(m.catalogue_create_label()).value).toBe('A local edition');
    mode = 'refusal';
    await keyboard(m.catalogue_create_retry());
    await waitFor(() => expect(loads).toBe(4));
    expect(window.document.activeElement).toBe(canvas.getByRole('button', { name: m.catalogue_create_retry() }));
    expect(canvas.queryByRole('link', { name: title })).toBeNull();
    expect(input(m.catalogue_create_label()).value).toBe('A local edition');

    mode = 'unsupported';
    await keyboard(m.catalogue_create_retry());
    await waitFor(() => expect(window.document.activeElement).toBe(canvas.getByText(m.publication_empty())));
    expect((canvas.getByRole('button', { name: m.catalogue_create_review_new() }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    mode = 'ready';
    await keyboard(m.publication_refresh());
    await canvas.findByRole('link', { name: title });
    const refresh = canvas.getByRole('button', { name: m.publication_refresh() });
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
    expect(
      window.document.activeElement === refresh ||
        window.document.activeElement === canvas.getByRole('heading', { name: m.publication_definitions_review() }),
    ).toBe(true);
    for (const intent of ['moved', 'pointer']) {
      mode = 'pending';
      if (intent === 'moved') {
        await keyboard(m.publication_refresh());
        outside.focus();
      } else await click(m.publication_refresh());
      outside.focus();
      await act(async () => resolveRead?.(await fixture.transport.load()));
      await canvas.findByRole('link', { name: title });
      expect(window.document.activeElement).toBe(outside);
    }
    expect(input(m.catalogue_create_label()).value).toBe('A local edition');
    expect(input(m.catalogue_create_language()).value).toBe('en-GB');
    expect(
      (
        within(host.querySelector('[id$="-work-link"]')!).getByRole('textbox', {
          name: m.correction_url(),
        }) as HTMLInputElement
      ).value,
    ).toBe('https://publisher.example/edition');
    expect(scope().textContent).toContain('Supplied publisher');
    expect((within(scope()).getByRole('combobox', { name: m.publication_field() }) as HTMLSelectElement).value).toBe(
      'schema:isbn',
    );
    expect((within(scope()).getByRole('button', { name: m.publication_review() }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]!.item.statements['schema:isbn']).toBeUndefined();

    await click(m.catalogue_create_review_new());
    submitMode = 'uncertain';
    await create();
    const sealed = structuredClone(commands[1]!);
    await click(m.catalogue_create_retry());
    expect(commands[2]).toEqual(sealed);

    await act(async () => root.render(null));
    client.clear();
    mode = 'refusal';
    await draw();
    await canvas.findByRole('button', { name: m.catalogue_create_retry() });
    mode = 'pending';
    await keyboard(m.catalogue_create_retry());
    await act(async () => root.render(null));
    outside.focus();
    await act(async () => resolveRead?.(await fixture.transport.load()));
    expect(window.document.activeElement).toBe(outside);
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
