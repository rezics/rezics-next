import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { CreateType } from '../src/features/catalogue/create-subject';

test('the generic Type-directory route preserves terms, hands off specialized Types, reviews Food facts and resolves one unknown create', async () => {
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
  mock.module('cloudflare:workers', () => ({ env: {} }));

  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const testing = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(testing.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(testing.resolve('@testing-library/user-event'));
  const { CreateSubjectForm } = await import('../src/features/catalogue/create-subject-form');
  const { catalogueCreateFixture, catalogueCreatedId } = await import('../src/kernel/fake/catalogue-create');
  const { createTypes } = await import('../src/features/catalogue/create-subject');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });

  const release = definitions.release as Release;
  const makeType = (id: string): CreateType => {
    const definition = release.types[id]!;
    const propertyIds = new Set(definition.properties);
    for (const property of definition.properties)
      for (const qualifier of release.properties[property]?.qualifiers ?? []) propertyIds.add(qualifier);
    const label = Object.entries(definition.labels ?? {}).find(([language]) => language === 'en')?.[1] ?? id;
    return {
      id,
      label,
      labelLanguage: 'en',
      description: '',
      releaseDigest: definitions.digest,
      definition,
      propertyDefinitions: Object.fromEntries(
        [...propertyIds].flatMap((property) =>
          release.properties[property]
            ? [[property, release.properties[property] as PropertyDefinition]]
            : [],
        ),
      ),
    };
  };
  const food = makeType('wd:Q2095');
  const book = makeType('schema:Book');
  const summaries = createTypes(release, 'en');
  const fixture = catalogueCreateFixture('uncertain');
  const transport = {
    ...fixture.transport,
    typeDirectory: {
      page: async ({ query, typeId }: { query?: string; typeId?: string }) => {
        const wanted = typeId ?? (query === 'book' ? book.id : query === 'food' ? food.id : '');
        const summary = summaries.find((type) => type.id === wanted);
        return { ok: true as const, types: summary ? [summary] : [], next: null };
      },
      descriptor: async (id: string) => {
        const selected = id === food.id ? food : id === book.id ? book : undefined;
        return selected ? { ok: true as const, type: selected } : { ok: false as const, reason: 'missing' as const };
      },
    },
  };
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const user = userEvent.setup({ document: window.document, delay: null });
  const canvas = () => within(host);
  const render = async () =>
    act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client: queryClient },
          h(CreateSubjectForm, { locale: 'en', session: 'signed-in', transport, onNavigate: () => {} }),
        ),
      ),
    );
  const choose = async (query: string, label: string) => {
    const input = canvas().getByRole('textbox', { name: m.catalogue_create_type_search() });
    await user.clear(input);
    await user.type(input, query);
    await user.click(canvas().getByRole('button', { name: m.catalogue_create_type_search_action() }));
    const results = await canvas().findByRole('list', { name: m.catalogue_create_type_results() });
    await user.click(within(results).getByRole('button', { name: `${m.catalogue_create_type_select()} ${label}` }));
  };

  try {
    await render();
    await waitFor(() => expect(canvas().getByRole('textbox', { name: m.catalogue_create_label() })).toBeDefined());
    const term = canvas().getByRole('textbox', { name: m.catalogue_create_label() });
    await user.type(term, 'A food subject');
    await choose('book', book.label);
    await waitFor(() => expect(host.querySelector('a[href="/en/catalogue/literary"]')).toBeDefined());
    expect(host.querySelector('#generic-create-property')).toBeNull();
    expect(canvas().getByRole('button', { name: m.catalogue_create_submit() })).toBeDisabled();
    expect((term as HTMLInputElement).value).toBe('A food subject');

    await choose('food', food.label);
    await waitFor(() => expect(host.querySelector('#generic-create-property')).toBeDefined());
    const property = canvas().getByRole('combobox', { name: m.correction_add() });
    await user.selectOptions(property, 'schema:url');
    await user.click(canvas().getByRole('button', { name: m.people_profile_add_fact({ field: 'URL' }) }));
    const urlFact = host.querySelector<HTMLFieldSetElement>('fieldset[id^="generic-fact-"]')!;
    const urlInputs = urlFact.querySelectorAll<HTMLInputElement>('input[type="url"]');
    expect(urlInputs).toHaveLength(2);
    await user.type(urlInputs[0]!, 'https://food.example/item');
    await user.type(urlInputs[1]!, 'https://food.example/source');

    await user.selectOptions(property, 'schema:name');
    await user.click(canvas().getByRole('button', { name: m.people_profile_add_fact({ field: 'name' }) }));
    const nameFact = host.querySelectorAll<HTMLFieldSetElement>('fieldset[id^="generic-fact-"]')[1]!;
    await user.type(within(nameFact).getByRole('textbox', { name: m.correction_value() }), 'Meal name');
    await user.type(within(nameFact).getByRole('textbox', { name: m.correction_language() }), 'en');
    await user.type(within(nameFact).getAllByRole('textbox', { name: m.correction_url() })[0]!, 'https://food.example/name-source');

    const submit = () => canvas().getByRole('button', { name: m.catalogue_create_submit() });
    await user.click(submit());
    const review = await canvas().findByRole('region', { name: m.catalogue_create_review_title() });
    expect(review.textContent).toContain('https://food.example/item');
    const openButtons = within(review).getAllByRole('button', { name: m.people_profile_review_open() });
    await user.click(openButtons[2]!);
    expect((window.document.activeElement as Element).closest('fieldset')?.id).toBe(urlFact.id);
    const itemUrl = within(urlFact).getAllByRole('textbox', { name: m.correction_url() })[0]!;
    await user.clear(itemUrl);
    await user.type(itemUrl, 'https://food.example/repaired');
    await user.click(submit());
    expect((await canvas().findByRole('region', { name: m.catalogue_create_review_title() })).textContent).toContain(
      'https://food.example/repaired',
    );
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await user.click(submit());
    await waitFor(() => expect(canvas().getByRole('button', { name: m.catalogue_create_retry() })).toBeDefined());
    await user.click(canvas().getByRole('button', { name: m.catalogue_create_retry() }));
    await waitFor(() => expect(host.textContent).toContain(catalogueCreatedId));
    const posts = fixture.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.key).toBe(posts[0]!.key);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
    const item = posts[0]!.body as { type: string; statements: Record<string, { value: unknown; references: { parts: unknown[] }[] }[]> };
    expect(item.type).toBe(food.id);
    expect(item.statements['schema:url']![0]!.value).toEqual({ type: 'value', content: 'https://food.example/repaired' });
    expect(item.statements['schema:url']![0]!.references[0]!.parts).toEqual([
      { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://food.example/source' } },
    ]);
    expect(item.statements['schema:name']![0]!.value).toEqual({
      type: 'value',
      content: { text: 'Meal name', language: 'en' },
    });
    expect(host.textContent).toContain(catalogueCreatedId);
  } finally {
    await act(async () => root.unmount());
    window.close();
    setLocale(previousLocale, { reload: false });
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
