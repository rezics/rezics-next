import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import type { PropertyDefinition, Release } from '@rezics/definitions';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { allowedCreateAuthority, type CreateAuthority } from '../src/features/catalogue/identity-intake';
import type { CreateType } from '../src/features/catalogue/create-subject';

async function renderCreator(eligibility: () => Promise<CreateAuthority>, scenario: 'ready' | 'uncertain' = 'ready') {
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
  const { catalogueCreateFixture } = await import('../src/kernel/fake/catalogue-create');
  const { createTypes } = await import('../src/features/catalogue/create-subject');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  const release = definitions.release as Release;
  const foodId = 'wd:Q2095';
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
          release.properties[property] ? [[property, release.properties[property] as PropertyDefinition]] : [],
        ),
      ),
    };
  };
  const food = makeType(foodId);
  const summaries = createTypes(release, 'en');
  const fixture = catalogueCreateFixture(scenario);
  const transport = {
    ...fixture.transport,
    eligibility,
    typeDirectory: {
      page: async ({ query, typeId }: { query?: string; typeId?: string }) => {
        const wanted = typeId ?? (query === 'food' ? food.id : '');
        const summary = summaries.find((type) => type.id === wanted);
        return { ok: true as const, types: summary ? [summary] : [], next: null };
      },
      descriptor: async (id: string) => {
        const selected = id === food.id ? food : undefined;
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
  await act(async () =>
    root.render(
      h(
        QueryClientProvider,
        { client: queryClient },
        h(CreateSubjectForm, { locale: 'en', session: 'signed-in', transport, onNavigate: () => {} }),
      ),
    ),
  );
  return {
    host,
    canvas,
    user,
    fixture,
    food,
    m,
    waitFor,
    act,
    async chooseFood() {
      const input = canvas().getByRole('textbox', { name: m.catalogue_create_type_search() });
      await user.clear(input);
      await user.type(input, 'food');
      await user.click(canvas().getByRole('button', { name: m.catalogue_create_type_search_action() }));
      const results = await canvas().findByRole('list', { name: m.catalogue_create_type_results() });
      await user.click(within(results).getByRole('button', { name: `${m.catalogue_create_type_select()} ${food.label}` }));
    },
    async close() {
      await act(async () => root.unmount());
      window.close();
      setLocale(previousLocale, { reload: false });
      for (const [key, descriptor] of saved)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}

test('refused parent eligibility keeps the draft and match search, and blocks a new create', async () => {
  const page = await renderCreator(async () => ({ state: 'refused', reason: 'permission' }));
  try {
    await page.waitFor(() => expect(page.canvas().getByRole('alert')).toHaveTextContent(page.m.identity_intake_authority_refused_permission()));
    await page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Kept draft');
    await page.chooseFood();
    expect(page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() })).toBeDisabled();
    expect((page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }) as HTMLInputElement).value).toBe(
      'Kept draft',
    );
    expect(page.fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('fresh create uses a current allowed observation; a later refusal does not reseal, and uncertain retry keeps the exact command', async () => {
  let observation: CreateAuthority = allowedCreateAuthority;
  const page = await renderCreator(async () => observation, 'uncertain');
  try {
    await page.waitFor(() => expect(page.canvas().getByText(page.m.identity_intake_authority_allowed())).toBeDefined());
    await page.user.type(page.canvas().getByRole('textbox', { name: page.m.catalogue_create_label() }), 'Eligible food');
    await page.chooseFood();
    const submit = () => page.canvas().getByRole('button', { name: page.m.catalogue_create_submit() });
    await page.waitFor(() => expect(submit()).not.toBeDisabled());
    await page.user.click(submit());
    await page.canvas().findByRole('region', { name: page.m.catalogue_create_review_title() });
    observation = { state: 'refused', reason: 'permission' };
    await page.user.click(submit());
    await page.waitFor(() =>
      expect(page.canvas().getByRole('alert')).toHaveTextContent(page.m.identity_intake_authority_refused_permission()),
    );
    expect(page.fixture.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects')).toHaveLength(0);

    observation = allowedCreateAuthority;
    await page.user.click(page.canvas().getByRole('button', { name: page.m.identity_intake_authority_retry() }));
    await page.waitFor(() => expect(page.canvas().getByText(page.m.identity_intake_authority_allowed())).toBeDefined());
    await page.user.click(submit());
    await page.waitFor(() => expect(page.canvas().getByRole('button', { name: page.m.catalogue_create_retry() })).toBeDefined());
    observation = { state: 'refused', reason: 'permission' };
    await page.user.click(page.canvas().getByRole('button', { name: page.m.catalogue_create_retry() }));
    await page.waitFor(() => expect(page.host.textContent).toContain('00000000-0000-4000-8000-00000000c001'));
    const posts = page.fixture.calls.filter((call) => call.method === 'POST' && call.path === '/v1/subjects');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.key).toBe(posts[0]!.key);
    expect(posts[1]!.body).toEqual(posts[0]!.body);
  } finally {
    await page.close();
  }
});
