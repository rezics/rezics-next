import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';

mock.module('cloudflare:workers', () => ({ env: {} }));

test('A contributor can choose the exact current value and open its correction without competing controls', async () => {
  // Reuse the DOM implementation already installed with the app's Puck editor.
  // This tests composition and interaction, not browser layout or pixel geometry.
  const require = createRequire(import.meta.url);
  const domPath = createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom');
  const { Window } = await import(domPath);
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLSelectElement',
    'Element',
    'Node',
    'DocumentFragment',
    'MutationObserver',
    'ResizeObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    const value = key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { act, createElement: h } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { SubjectFacts } = await import('../src/features/catalogue/subject-facts-view');
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { identifiersProfileFixture, identifiersCitation } =
    await import('../src/kernel/fake/catalogue-identifiers-profile');
  const { recipeFixture, recipeExample, recipeId } = await import('../src/kernel/fake/recipe-editor');
  const { statementInput } = await import('../src/features/catalogue/statement-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const container = window.document.createElement('main') as HTMLElement;
  window.document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const button = (region: Element, name: string) => {
    const result = [...region.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name);
    expect(result).toBeDefined();
    return result!;
  };
  const inputs = (region: Element) =>
    [...region.querySelectorAll<HTMLInputElement>('input')].map((input) => input.value);
  try {
    const facts = identifiersProfileFixture();
    const property = 'schema:sameAs';
    const first = facts.publicRead.subject.statements[property]![0]!;
    const chosen = structuredClone(first);
    chosen.id = crypto.randomUUID();
    const exactUrl =
      'https://catalogue.example/editions/a-particular-annotated-edition-with-a-long-original-title?language=ja&record=second';
    const citation = 'https://archive.example/records/second-edition?scan=original%2Fpage-24#citation';
    chosen.value = { type: 'value', content: exactUrl };
    chosen.references[0]!.parts[0]!.value = { type: 'value', content: citation };
    facts.publicRead.subject.statements[property]!.push(chosen);
    const read = await facts.transport.read();
    expect(read.ok).toBe(true);
    await act(async () =>
      root.render(
        h(SubjectFacts, {
          initial: read,
          locale: 'en',
          transport: facts.transport,
          review: facts.review,
        }),
      ),
    );
    const field = container.querySelector<HTMLElement>('section[aria-label="exact match"]')!;
    const select = field.querySelector<HTMLSelectElement>('select')!;
    const selectorField = select.closest('[data-slot="field"]')!;
    expect(field.querySelector(`label[for="${select.id}"]`)?.textContent).toBe(m.facts_choose_value());
    expect(selectorField.classList.contains('w-full')).toBe(true);
    expect(selectorField.parentElement!.classList.contains('flex-col')).toBe(true);
    expect(selectorField.parentElement!.classList.contains('sm:flex-row')).toBe(true);
    expect(select.parentElement!.classList.contains('w-full')).toBe(true);
    expect(select.parentElement!.classList.contains('[&>select]:min-h-11')).toBe(true);
    const edit = button(field, m.facts_edit_field());
    const add = button(field, m.facts_add_value());
    expect(edit.disabled).toBe(true);
    expect(add.disabled).toBe(false);
    expect(edit.parentElement).not.toBe(selectorField);
    expect(edit.parentElement!.previousElementSibling).toBe(selectorField);
    expect(edit.parentElement!.classList.contains('flex-wrap')).toBe(true);
    for (const action of [edit, add]) expect(action.classList.contains('min-h-11')).toBe(true);
    await act(async () => {
      select.value = chosen.id;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(select.value).toBe(chosen.id);
    expect(edit.disabled).toBe(false);
    await act(async () => edit.click());
    expect(inputs(field)).toContain(exactUrl);
    expect(inputs(field)).toContain(citation);
    expect(inputs(field)).not.toContain(identifiersCitation);
    expect(field.textContent).toContain(m.facts_selected_value({ number: 2 }));
    expect(facts.publicRead.subject.statements[property]).toEqual([first, chosen]);

    const recipe = recipeFixture();
    const item = recipeExample();
    const secondTarget = '00000000-0000-4000-8000-00000000f005';
    const second = structuredClone(item.statements['wdt:P186']![0]!);
    second.value = { type: 'value', content: secondTarget };
    second.qualifiers = [
      { property: { id: 'wdt:P1114' }, value: { type: 'value', content: { amount: '+200', unit: '1' } } },
    ];
    second.references[0]!.parts[0]!.value = { type: 'value', content: citation };
    item.statements['wdt:P186']!.push(second);
    expect(await recipe.transport.create({ item, key: crypto.randomUUID() })).toMatchObject({ ok: true });
    const longLabel = 'Red lentils, dried and carefully sorted for a thick winter soup with roasted vegetables';
    recipe.publicRead.related[secondTarget] = { labels: { en: longLabel }, type: 'wd:Q2095' };
    const recipeRead = await recipe.corrections.load();
    expect(recipeRead.ok).toBe(true);
    client.setQueryData(['recipe-editor', recipeId, 'en'], recipeRead);
    await act(async () =>
      root.render(
        h(
          QueryClientProvider,
          { client },
          h(RecipeEditor, {
            id: recipeId,
            locale: 'en',
            session: 'signed-in',
            transport: recipe.corrections,
            search: async () => [],
          }),
        ),
      ),
    );
    const heading = [...container.querySelectorAll('h2')].find(
      (node) => node.textContent === recipe.release.properties['wdt:P186']!.labels.en,
    )!;
    const current = heading.closest('section')!;
    const corrections = [...current.querySelectorAll<HTMLButtonElement>('button')];
    expect(corrections).toHaveLength(2);
    const row = corrections[1]!.parentElement!;
    expect(row.textContent).toContain(longLabel);
    for (const token of ['flex-col', 'gap-3', 'sm:flex-row']) expect(row.classList.contains(token)).toBe(true);
    expect(row.firstElementChild!.classList.contains('min-w-0')).toBe(true);
    expect(row.firstElementChild!.classList.contains('break-words')).toBe(true);
    expect(corrections[1]!.classList.contains('min-h-11')).toBe(true);
    await act(async () => corrections[1]!.click());
    expect(corrections[0]!.disabled).toBe(false);
    expect(corrections[1]!.disabled).toBe(true);
    const draftHeading = [...container.querySelectorAll('h2')]
      .filter((node) => node.textContent === heading.textContent)
      .at(-1)!;
    const draft = draftHeading.closest('section')!;
    expect(draft.querySelector<HTMLInputElement>('[role="combobox"]')!.value).toBe(longLabel);
    await act(async () => button(draft, m.correction_submit()).click());
    const post = recipe.calls.find((call) => call.method === 'POST' && call.path.endsWith('/candidates'))!;
    const selected = recipe.publicRead.subject.statements['wdt:P186']![1]!;
    expect(post.body).toEqual({ statement: statementInput(selected) });
    expect([...recipe.candidates.values()][0]!.statement).toMatchObject({
      value: selected.value,
      qualifiers: selected.qualifiers,
      references: selected.references,
    });
    expect(recipe.publicRead.subject.statements['wdt:P186']![1]).toEqual(selected);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
