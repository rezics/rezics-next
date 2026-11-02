import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';

test('a withdrawn additional Recipe choice stays local until a current field is deliberately selected', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/recipe' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Range: window.Range,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { recipeFixture } = await import('../src/kernel/fake/recipe-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const fixture = recipeFixture();
  const initial = await fixture.transport.load();
  if (!initial.ok) throw new Error('Recipe fixture did not load');
  const keptField = 'schema:recipeIngredient';
  const withdrawn = initial.fields.find((field) => field !== keptField)!;
  const replacement = initial.fields.find((field) => field !== keptField && field !== withdrawn)!;
  const name = (field: string) => initial.release.properties[field]!.labels.en;
  const show = (node: ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary>
            <RecipeEditor locale="en" session="signed-in" transport={fixture.transport} search={async () => []} />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await settle();
    expect(predicate()).toBe(true);
  };
  const chooser = () => within(host).getByRole('combobox', { name: m.character_add_fact() }) as HTMLSelectElement;
  const click = async (name: string) => act(async () => user.click(within(host).getByRole('button', { name })));
  const select = async (field: string) => act(async () => user.selectOptions(chooser(), field));
  try {
    await show(<></>);
    await until(() => !!within(host).queryByRole('combobox', { name: m.character_add_fact() }));
    const terms = within(host).getByRole('group', { name: m.catalogue_create_terms() });
    const primary = within(within(terms).getAllByRole('group', { name: m.catalogue_create_language() })[0]!);
    await act(async () => user.type(primary.getByRole('textbox', { name: m.catalogue_create_label() }), 'Lentil soup'));
    await click(m.catalogue_create_add_language());
    const japanese = within(terms).getAllByRole('group', { name: m.catalogue_create_language() })[1]!;
    await act(async () => user.type(within(japanese).getByRole('textbox', { name: m.catalogue_create_language() }), 'ja'));
    await act(async () => user.type(within(japanese).getByRole('textbox', { name: m.catalogue_create_label() }), 'レンズ豆のスープ'));
    await select(keptField);
    await click(m.correction_add());
    await act(async () => user.type(within(host).getByRole('textbox', { name: m.correction_value() }), '200 g lentils'));
    await act(async () => user.type(within(host).getByRole('textbox', { name: m.correction_language() }), 'en'));
    await select(withdrawn);

    fixture.release.types['schema:Recipe']!.properties = fixture.release.types['schema:Recipe']!.properties.filter(
      (field) => field !== withdrawn,
    );
    expect(fixture.release.properties[withdrawn]).toBeTruthy();
    await act(async () => client.invalidateQueries({ queryKey: ['recipe-editor'] }));
    await until(() => host.textContent!.includes(m.correction_stale()));

    expect(chooser().value).toBe('');
    expect([...chooser().options].some((option) => option.value === withdrawn)).toBe(false);
    const addButton = within(host).getByRole('button', { name: m.correction_add() }) as HTMLButtonElement;
    expect(addButton.disabled).toBe(true);
    expect(within(host).getByRole('heading', { name: name(keptField), level: 2 })).toBeTruthy();
    expect(within(host).queryByRole('heading', { name: name(withdrawn), level: 2 })).toBeNull();
    expect(within(host).getByRole('textbox', { name: m.correction_value() })).toHaveValue('200 g lentils');
    expect(within(host).getByRole('textbox', { name: m.correction_language() })).toHaveValue('en');
    expect(within(terms).getAllByRole('group', { name: m.catalogue_create_language() })).toHaveLength(2);
    expect(within(japanese).getByRole('textbox', { name: m.catalogue_create_label() })).toHaveValue('レンズ豆のスープ');
    const reactKey = Object.keys(addButton).find((key) => key.startsWith('__reactProps$'))!;
    const onClick = (Reflect.get(addButton, reactKey) as { onClick: () => void }).onClick;
    await act(async () => onClick());
    expect(within(host).queryByRole('heading', { name: name(withdrawn), level: 2 })).toBeNull();

    await select(replacement);
    await click(m.correction_add());
    expect(within(host).getAllByRole('heading', { name: name(replacement), level: 2 })).toHaveLength(1);
    expect(chooser().value).toBe('');
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  } finally {
    await show(null);
    root.unmount();
    client.clear();
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    window.happyDOM.abort();
  }
});
