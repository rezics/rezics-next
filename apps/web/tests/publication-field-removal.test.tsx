import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { CreateResult } from '../src/features/catalogue/create-subject';
import type { PublicationCommand } from '../src/features/catalogue/publication-editor';
import type { SnakInput } from '../src/features/catalogue/statement-editor';

test('publication fact confirmation preserves drafts, property targets and the original locked command', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/publication' });
  const globals: Record<string, unknown> = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true };
  for (const key of [
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
  ])
    globals[key] = Reflect.get(window, key);
  for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    globals[key] = Reflect.get(window, key).bind(window);
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { PublicationEditor } = await import('../src/features/catalogue/publication-editor-form');
  const { publicationFixture } = await import('../src/kernel/fake/publication-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { within } = await import(Bun.resolveSync('@testing-library/dom', storybook));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const fixture = publicationFixture(),
    commands: PublicationCommand[] = [];
  let finish!: (result: CreateResult) => void;
  const transport = {
    ...fixture.transport,
    submit: async (command: PublicationCommand): Promise<CreateResult> => {
      commands.push(structuredClone(command));
      if (commands.length === 1)
        return {
          ok: false,
          reason: 'invalid',
          errors: [{ pointer: '/statements/schema:publisher/0/value/content', code: 'invalid_format' }],
        };
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const publisher = {
    id: '00000000-0000-4000-8000-00000000e003',
    title: 'Selected press',
    types: ['schema:Organization'],
    typeLabel: 'Publisher',
    cover: null,
  };
  const route = createRootRoute({
    component: () => (
      <PublicationEditor
        work={fixture.work.subject.id}
        locale="en"
        session="signed-in"
        transport={transport}
        search={async () => [publisher]}
        onNavigate={() => {}}
      />
    ),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host),
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup({ document: window.document, delay: null }),
    canvas = within(host);
  const click = (element: HTMLElement) => act(async () => user.click(element));
  const button = (name: string) => canvas.getByRole('button', { name });
  const input = (name: string) => canvas.getByRole('textbox', { name }) as HTMLInputElement;
  const type = (element: HTMLElement, value: string) => act(async () => user.type(element, value));
  const add = (property: string) =>
    act(async () => {
      await user.selectOptions(canvas.getByRole('combobox', { name: m.publication_field() }), property);
      await user.click(button(m.correction_add()));
    });
  const region = (property: string) =>
    host.querySelector<HTMLElement>(`[id$="-fact-${encodeURIComponent(property)}"]`)!;
  const remove = (property: string) => within(region(property)).getByRole('button', { name: m.relation_remove() });
  const snapshot = () =>
    [...host.querySelectorAll<HTMLInputElement>('input, select')].map((node) => [node.id, node.value, node.checked]);
  // Retain the actual mounted control's caller, including its original render closure.
  const retained = <T,>(element: HTMLElement, name: 'onChange' | 'onValueChange') => {
    type Fiber = { memoizedProps: Record<string, unknown>; return?: Fiber };
    const key = Object.keys(element).find((key) => key.startsWith('__reactFiber$'))!;
    let fiber = Reflect.get(element, key) as Fiber | undefined;
    while (fiber) {
      const props = fiber.memoizedProps;
      if (typeof props[name] === 'function' && (name === 'onChange' ? props.part : props.search))
        return props[name] as (value: T) => void;
      fiber = fiber.return;
    }
    throw new Error(`Missing mounted ${name}`);
  };
  const isbn = { type: 'value', content: '978-0-140-44430-8' } as const;
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await canvas.findByRole('textbox', { name: m.catalogue_create_label() });
    await type(input(m.catalogue_create_label()), 'Independent edition');
    await click(canvas.getByRole('checkbox', { name: m.publication_independent() }));
    await type(input(m.relation_citation()), 'https://example.org/source');
    await add('schema:isbn');
    await type(input(m.correction_value()), '978-0-140-44430-8');
    const oldScalar = retained<SnakInput['value']>(input(m.correction_value()), 'onChange');
    await add('schema:publisher');
    await type(canvas.getByRole('combobox', { name: 'publisher' }), 'Press');
    await click(
      await within(window.document.body as unknown as HTMLElement).findByRole('option', { name: /Selected press/ }),
    );
    const sibling = region('schema:publisher'),
      stableId = sibling.id;
    const oldPublisher = retained<(typeof publisher)[]>(
      canvas.getByRole('combobox', { name: 'publisher' }),
      'onValueChange',
    );
    await act(async () => oldScalar(isbn));
    expect(region('schema:publisher')).toBe(sibling);
    expect(sibling.textContent).toContain('Selected press');
    await click(button(m.publication_submit()));
    const correction = await canvas.findByRole('link', { name: 'publisher' });
    expect(decodeURIComponent(correction.getAttribute('href')!.slice(1))).toBe(stableId);
    const before = snapshot();
    for (const property of ['schema:isbn', 'schema:publisher']) {
      await click(remove(property));
      expect(window.document.activeElement).toBe(button(m.candidate_cancel()));
      await click(button(m.candidate_cancel()));
      expect(snapshot()).toEqual(before);
      expect(sibling.textContent).toContain('Selected press');
      expect(window.document.activeElement).toBe(remove(property));
      expect(correction.isConnected).toBe(true);
    }
    await click(remove('schema:isbn'));
    await act(async () => user.keyboard('{Escape}'));
    expect(window.document.activeElement).toBe(remove('schema:isbn'));
    await click(remove('schema:isbn'));
    await click(remove('schema:isbn'));
    expect(region('schema:isbn')).toBeNull();
    await act(async () => oldScalar(isbn));
    expect(region('schema:isbn')).toBeNull();
    await act(async () => oldPublisher([publisher]));
    expect(region('schema:isbn')).toBeNull();
    expect(region('schema:publisher')).toBe(sibling);
    expect(sibling.id).toBe(stableId);
    expect(sibling.contains(window.document.activeElement as unknown as Node)).toBe(true);
    expect(input(m.relation_citation()).value).toBe('https://example.org/source');
    await click(remove('schema:publisher'));
    await click(remove('schema:publisher'));
    expect(window.document.activeElement).toBe(canvas.getByRole('combobox', { name: m.publication_field() }));
    await add('schema:publisher');
    await act(async () => oldPublisher([publisher]));
    expect(canvas.queryByText('Selected press')).toBeNull();
    await click(remove('schema:publisher'));
    expect(region('schema:publisher')).toBeNull();
    expect(canvas.queryByRole('button', { name: m.candidate_cancel() })).toBeNull();
    await add('schema:isbn');
    await act(async () => oldScalar(isbn));
    expect(input(m.correction_value()).value).toBe('');
    await type(input(m.correction_value()), '978-0-140-44430-8');
    const currentScalar = retained<SnakInput['value']>(input(m.correction_value()), 'onChange');
    await add('schema:publisher');
    const currentPublisher = retained<(typeof publisher)[]>(
      canvas.getByRole('combobox', { name: 'publisher' }),
      'onValueChange',
    );
    await act(async () => currentPublisher([publisher]));
    // A retained publisher edit must preserve a newer scalar sibling value.
    await act(async () => currentScalar(isbn));
    expect(region('schema:publisher').textContent).toContain('Selected press');
    await click(remove('schema:isbn'));
    await click(button(m.publication_submit()));
    const locked = snapshot();
    const lateEdits = () => {
      currentScalar({ type: 'value', content: 'late scalar' });
      currentPublisher([{ ...publisher, title: 'Late press', id: fixture.work.subject.id }]);
    };
    await act(async () => lateEdits());
    expect(snapshot()).toEqual(locked);
    expect(region('schema:publisher').textContent).toContain('Selected press');
    expect(canvas.queryByText('Late press')).toBeNull();
    expect((remove('schema:isbn') as HTMLButtonElement).disabled).toBe(true);
    await click(remove('schema:isbn'));
    await act(async () => finish({ ok: false, reason: 'unavailable' }));
    await canvas.findByRole('heading', { name: m.catalogue_create_uncertain() });
    await act(async () => lateEdits());
    expect(snapshot()).toEqual(locked);
    expect(canvas.getByRole('heading', { name: m.catalogue_create_uncertain() })).toBeDefined();
    await click(remove('schema:isbn'));
    expect(input(m.correction_value()).value).toBe('978-0-140-44430-8');
    await click(button(m.catalogue_create_retry()));
    expect(commands[2]).toEqual(commands[1]);
    expect(commands[2]!.item.labels).toEqual({ en: 'Independent edition' });
    expect(commands[2]!.item.statements['schema:exampleOfWork']![0]!.value).toEqual({
      type: 'value',
      content: fixture.work.subject.id,
    });
    await act(async () => finish({ ok: false, reason: 'invalid' }));
    await act(async () => currentScalar({ type: 'value', content: '978-0-140-44431-5' }));
    await click(button(m.publication_submit()));
    expect(commands[3]!.key).not.toBe(commands[2]!.key);
    expect(commands[3]!.item.statements['schema:isbn']![0]!.value).toEqual({
      type: 'value',
      content: '978-0-140-44431-5',
    });
    expect(commands[3]!.item.statements['schema:publisher']).toEqual(commands[2]!.item.statements['schema:publisher']);
    await act(async () => finish({ ok: true, id: fixture.work.subject.id, reader: { state: 'concealed' } }));
    await act(async () => lateEdits());
    expect(canvas.getByText(m.catalogue_create_created())).toBeDefined();
    expect(commands).toHaveLength(4);
    await act(async () => root.unmount());
    await act(async () => lateEdits());
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  }
}, 30_000);
