import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';

test('The default recipe correction shows its exact quantity and preserves it when opening the editor', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/recipe' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { recipeFixture, recipeExample, recipeId } = await import('../src/kernel/fake/recipe-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const fixture = recipeFixture();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const minute = 'http://www.wikidata.org/entity/Q7727';
  const unknown = 'https://units.example/private/minute';
  let generation = 0;
  const section = (property: string, locale = 'en') => {
    const labels = fixture.release.properties[property]!.labels;
    const heading = Array.from(host.querySelectorAll('h2')).find(
      (heading) => heading.textContent === (labels[locale] ?? labels.en),
    );
    expect(heading).toBeDefined();
    return heading!.closest('section')!;
  };
  const button = (element: typeof host, name: string) => {
    const found = Array.from(element.querySelectorAll('button')).find((button) => button.textContent === name);
    expect(found).toBeDefined();
    return found!;
  };
  const render = async (locale = 'en') => {
    // The same generated-client fixture transport as the Correction story, with no component/query mock.
    await client.fetchQuery({
      queryKey: ['recipe-editor', recipeId, locale],
      queryFn: fixture.corrections.load,
      staleTime: 0,
    });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RecipeEditor, {
            key: ++generation,
            id: recipeId,
            locale,
            session: 'signed-in',
            transport: fixture.corrections,
            search: async () => [],
          }),
        ),
      );
    });
  };
  const open = async (property: string, locale = 'en') => {
    await act(async () => button(section(property, locale), m.recipe_correct({}, { locale: locale as never })).click());
    return Array.from(host.querySelectorAll('section')).find((section) => section.querySelector('fieldset'))!;
  };
  const input = (element: typeof host, name: string) => {
    const found = Array.from(element.querySelectorAll('input')).find(
      (input) => input.getAttribute('aria-label') === name,
    );
    expect(found).toBeDefined();
    return found!;
  };
  try {
    expect((await fixture.transport.create({ item: recipeExample(), key: crypto.randomUUID() })).ok).toBe(true);
    const source = fixture.publicRead.subject.statements['schema:cookTime']![0]!;
    const original = structuredClone(source);
    expect(source.value).toEqual({ type: 'value', content: { amount: '+25', unit: minute } });
    expect(fixture.publicRead.related[minute]).toBeUndefined();
    await render();
    expect(section('schema:cookTime').textContent).toContain('+25 min');
    expect(section('schema:cookTime').textContent).not.toContain(m.candidate_value_unavailable());
    expect(section('schema:recipeYield').textContent).toContain('+2');
    const editor = await open('schema:cookTime');
    expect(input(editor, m.correction_amount()).value).toBe('+25');
    const units = editor.querySelector('select[aria-label="' + m.correction_unit() + '"]')!;
    expect(units.value).toBe(minute);
    expect(units.selectedOptions[0]!.textContent).toBe('min');
    expect(source).toEqual(original);
    await act(async () => {
      button(editor, m.correction_submit()).click();
      await Bun.sleep(5);
    });
    expect(editor.textContent).toContain(m.correction_proposed());
    const proposal = fixture.calls.filter((call) => call.path.endsWith('/candidates') && call.method === 'POST');
    expect(proposal).toHaveLength(1);
    expect(proposal[0]!.body).toEqual({
      statement: {
        property: { id: source.property.id },
        value: original.value,
        qualifiers: original.qualifiers,
        references: [{ parts: [{ property: { id: 'schema:url' }, value: original.references[0]!.parts[0]!.value }] }],
        rank: 'normal',
      },
    });
    expect(original.references[0]!.parts[0]!.value).toEqual({
      type: 'value',
      content: 'https://cook.example/my-lentil-soup',
    });

    // Edge read values stay in this same DTO/transport world. They are not coerced into cookTime's integer schema
    // or submitted as valid replacements; opening must preserve them for a contributor to correct.
    fixture.publicRead.related['https://units.example/undisclosed'] = { labels: { en: 'HIDDEN UNIT LABEL' } };
    const exact = {
      amount: '-9007199254740993.0000100',
      lowerBound: '-9007199254740993.0000200',
      upperBound: '-9007199254740993.0000000',
      unit: minute,
    };
    for (const content of [exact, { amount: '+2.000', unit: '1' }, { ...exact, unit: unknown }]) {
      source.value = { type: 'value', content };
      const before = structuredClone(source);
      await render();
      const reading = section('schema:cookTime').textContent!;
      expect(reading).toContain(content.amount);
      if ('lowerBound' in content) {
        expect(reading).toContain(`≥ ${content.lowerBound}`);
        expect(reading).toContain(`≤ ${content.upperBound}`);
      }
      expect(reading.includes(m.quantity_unit_unavailable())).toBe(content.unit === unknown);
      if (content.unit === minute) expect(reading).toContain('min');
      if (content.unit === '1') expect(reading).not.toContain('min');
      const editor = await open('schema:cookTime');
      expect(input(editor, m.correction_amount()).value).toBe(content.amount);
      if ('lowerBound' in content) {
        expect(input(editor, m.correction_lower()).value).toBe(content.lowerBound);
        expect(input(editor, m.correction_upper()).value).toBe(content.upperBound);
      }
      const unit = editor.querySelector('select[aria-label="' + m.correction_unit() + '"]')!;
      expect(unit.value).toBe(content.unit);
      expect(unit.selectedOptions[0]!.textContent).toBe(
        content.unit === unknown
          ? m.quantity_unit_unavailable()
          : content.unit === '1'
            ? m.correction_unitless()
            : 'min',
      );
      expect(host.textContent).not.toContain(unknown);
      expect(host.textContent).not.toContain(minute);
      expect(host.textContent).not.toContain('HIDDEN UNIT LABEL');
      expect(source).toEqual(before);
    }
    await render('fr');
    expect(section('schema:cookTime', 'fr').textContent).toContain(m.quantity_unit_unavailable({}, { locale: 'fr' }));
    // Only a label actually present in the disclosed related map can replace the unavailable indication.
    fixture.publicRead.related[unknown] = { labels: { en: 'Disclosed unit', fr: 'Unité publiée' } };
    await render('fr');
    expect(section('schema:cookTime', 'fr').textContent).toContain('Unité publiée');
    const labelled = await open('schema:cookTime', 'fr');
    const selected = labelled.querySelector('select[aria-label="' + m.correction_unit({}, { locale: 'fr' }) + '"]')!;
    expect(selected.selectedOptions[0]!.textContent).toBe('Unité publiée');

    for (const content of [
      { amount: 25, unit: minute },
      { amount: '+25' },
      { amount: '+25oops', unit: minute },
      { amount: '+25', unit: minute, lowerBound: '+26' },
      { amount: '+25', unit: minute, upperBound: '+24' },
      { amount: '+25', unit: minute, secret: 'HIDDEN COMPOUND' },
    ]) {
      source.value = { type: 'value', content };
      await render();
      expect(section('schema:cookTime').textContent).toContain(m.candidate_value_unavailable());
      expect(host.textContent).not.toContain('HIDDEN COMPOUND');
    }
    expect(fixture.calls.every((call) => !call.path.includes('/entity/') && !call.path.includes('units.example'))).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
