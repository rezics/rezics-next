import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ComponentProps, type ReactNode } from 'react';
import type { ScalarControl } from '../src/features/catalogue/statement-editor-view';
import type { RichTextEditor } from '@rezics/ui/rich-text-editor';
import type { EntityPicker } from '@rezics/ui/entity-picker';

// One actual-component campaign using the existing generated-client fixture.
// DOM interaction is not layout, native authorization, private SSR or backend growth proof.
test('Recipe creation and current correction share complete frames with independent native controls and exact recovery', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/catalogue/recipe', width: 390, height: 844 });
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
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    CSS: window.CSS,
    DocumentFragment: window.DocumentFragment,
    DOMParser: window.DOMParser,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Range: window.Range,
    DOMRect: window.DOMRect,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { recipeFixture, recipeExample, recipeId, dietId } = await import('../src/kernel/fake/recipe-editor');
  const { fromPlainText } = await import('@rezics/document');
  const { statementInput } = await import('../src/features/catalogue/statement-editor');
  const { subjectHref } = await import('../src/subject/subject-href');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host);
  const outside = window.document.createElement('button');
  outside.textContent = 'Fresh reader focus';
  window.document.body.append(outside);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const show = (node: ReactNode) =>
    act(async () => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++) await settle();
    expect(predicate()).toBe(true);
  };
  const click = (scope: HTMLElement, name: string) =>
    act(async () => user.click(within(scope).getByRole('button', { name })));
  const input = (scope: HTMLElement, name: string) => within(scope).getByRole('textbox', { name }) as HTMLInputElement;
  const replace = (control: HTMLElement, value: string) =>
    act(async () => {
      await user.clear(control);
      if (value) await user.type(control, value);
    });
  const add = async (scope: HTMLElement, property: string) => {
    await act(async () =>
      user.selectOptions(within(scope).getByRole('combobox', { name: m.character_add_fact() }), property),
    );
    await click(scope, m.correction_add());
    return [...scope.querySelectorAll<HTMLElement>('section')].at(-1)!;
  };
  const section = (scope: HTMLElement, name: string, last = false) => {
    const headings = within(scope).getAllByRole('heading', { name: name.replace(/\s+/g, ' ').trim(), level: 2 });
    return (last ? headings.at(-1)! : headings[0]!).closest('section')!;
  };
  const articles = () => [...host.querySelectorAll<HTMLElement>('article')];
  const ids = () => [...host.querySelectorAll('[id]')].map((element) => element.id).sort();
  const associations = (scope: HTMLElement) => {
    expect(new Set(ids()).size).toBe(ids().length);
    for (const label of scope.querySelectorAll<HTMLLabelElement>('label[for]')) {
      expect(label.htmlFor).not.toBe('');
      expect(scope.contains(window.document.getElementById(label.htmlFor))).toBe(true);
    }
  };
  const frame = (scope: HTMLElement) => {
    const title = scope.querySelector('h2')!;
    expect(title.dataset.contentItemSlot).toBe('title');
    expect(title.parentElement!.classList.contains('isolate')).toBe(true);
    expect(title.parentElement!.querySelector('[data-content-item-slot="preview"]')).not.toBeNull();
    expect(scope.querySelector('[data-slot="list-row-link"]')).toBeNull();
    expect(scope.querySelector('a button, a input, a select, button a')).toBeNull();
  };
  const method = async (scope: HTMLElement, text: string) => {
    await click(scope, m.recipe_replace_method());
    for (const name of [m.catalogue_create_language(), m.subject_source_licence()]) {
      const control = input(scope, name);
      const label = scope.querySelector<HTMLLabelElement>(`label[for="${control.id}"]`)!;
      expect(label.textContent).toBe(name);
      await act(async () => user.click(label));
      expect(window.document.activeElement).toBe(control);
    }
    await replace(input(scope, m.catalogue_create_language()), 'en');
    await replace(input(scope, m.subject_source_licence()), 'CC-BY-4.0');
    const editor = scope.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!;
    expect(editor).not.toBeNull();
    await act(async () => {
      editor.innerHTML = `<p>${text}</p>`;
      editor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      editor.dispatchEvent(new window.FocusEvent('blur'));
    });
  };
  const posts = (fixture: ReturnType<typeof recipeFixture>, suffix: string) =>
    fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith(suffix));
  const queued = (element: HTMLElement) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
    return (Reflect.get(element, key) as { onClick: () => void }).onClick;
  };
  const retainedChange = (element: HTMLElement) => {
    const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'))!;
    return (
      Reflect.get(element, key) as {
        onChange: (event: { target: { value: string } }) => void;
      }
    ).onChange;
  };
  const retainedProps = <P,>(element: HTMLElement, matches: (props: P) => boolean): P => {
    type Fiber = {
      memoizedProps: P;
      return: Fiber | null;
      alternate: Fiber;
      stateNode: { current: Fiber };
    };
    let fiber = Reflect.get(
      element,
      Object.keys(element).find((key) => key.startsWith('__reactFiber$'))!,
    ) as Fiber;
    let top = fiber;
    while (top.return) top = top.return;
    if (top.stateNode.current !== top) fiber = fiber.alternate;
    while (!matches(fiber.memoizedProps)) fiber = fiber.return!;
    return fiber.memoizedProps;
  };
  const scalar = (scope: HTMLElement) =>
    retainedProps<ComponentProps<typeof ScalarControl>>(
      input(scope, m.correction_value()),
      (props) => !!props.part && !!props.onChange,
    ).onChange;
  const document = (scope: HTMLElement) =>
    retainedProps<ComponentProps<typeof RichTextEditor>>(
      scope.querySelector('[contenteditable]')!,
      (props) => !!props.labels && !!props.onChange,
    );
  const picker = (scope: HTMLElement) =>
    retainedProps<ComponentProps<typeof EntityPicker>>(
      within(scope).getByRole('combobox'),
      (props) => !!props.onValueChange,
    ).onValueChange;
  const cancelRemoval = async (scope: HTMLElement) => {
    const trigger = within(scope).getByRole('button', { name: m.recipe_remove_field() });
    const controls = () => [
      ...scope.querySelectorAll<HTMLInputElement>('input, textarea, [contenteditable], [role="checkbox"]'),
    ];
    const content = () =>
      controls().map((node) => [
        node.value,
        node.textContent,
        node.getAttribute('aria-checked'),
        node.getAttribute('aria-describedby'),
      ]);
    const nodes = controls(),
      before = content();
    for (const escape of [false, true]) {
      await click(scope, m.recipe_remove_field());
      expect(window.document.activeElement).toBe(within(scope).getByRole('button', { name: m.candidate_cancel() }));
      if (escape) await act(async () => user.keyboard('{Escape}'));
      else await click(scope, m.candidate_cancel());
      expect(controls()).toEqual(nodes);
      expect(content()).toEqual(before);
      expect(window.document.activeElement).toBe(within(scope).getByRole('button', { name: m.recipe_remove_field() }));
    }
    expect(trigger.textContent).toBe(m.recipe_remove_field());
  };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const search = async () => [];
  const longValue = `200 g lentils — ${'whole lentils and vegetables 水と野菜 '.repeat(12)}`;
  const longCitation = `https://cook.example/original/${'precise-citation-'.repeat(16)}?language=ja#page-24`;
  try {
    const creation = recipeFixture('uncertain');
    const correction = recipeFixture();
    const loadCreation = creation.transport.load;
    const createCreation = creation.transport.create;
    const creationCommands: Parameters<typeof creation.transport.create>[0][] = [];
    const creationReplays: boolean[] = [];
    let refuseCreation = true;
    let failCreationRead = false;
    const currentIngredientLabel = 'Ingredient after rereading the current release';
    creation.transport.load = async () => {
      if (failCreationRead) {
        failCreationRead = false;
        return { ok: false, reason: 'unavailable' };
      }
      return loadCreation();
    };
    creation.transport.create = async (command, replay) => {
      creationCommands.push(structuredClone(command));
      creationReplays.push(replay === true);
      if (refuseCreation) {
        refuseCreation = false;
        failCreationRead = true;
        creation.release.properties['schema:recipeIngredient']!.labels.en = currentIngredientLabel;
        return { ok: false, reason: 'invalid', refreshDefinitions: true };
      }
      const result = await createCreation(command, replay);
      if (!result.ok && result.reason === 'unavailable')
        creation.release.properties['schema:recipeIngredient']!.datatype = 'string';
      return result;
    };
    const item = recipeExample();
    item.statements['schema:recipeIngredient']![0]!.value = {
      type: 'value',
      content: { language: 'en', text: longValue },
    };
    item.statements['schema:recipeIngredient']![0]!.references[0]!.parts[0]!.value = {
      type: 'value',
      content: longCitation,
    };
    expect((await correction.transport.create({ item, key: crypto.randomUUID() })).ok).toBe(true);
    const loadCorrection = correction.corrections.load;
    let failCorrectionRead = false;
    correction.corrections.load = async () => {
      if (failCorrectionRead) {
        failCorrectionRead = false;
        return { ok: false, reason: 'unavailable' };
      }
      return loadCorrection();
    };
    const ingredient = 'schema:recipeIngredient';
    const longLabel = `ingredient — ${'Full supplied localized field 材料 '.repeat(5)}`;
    correction.release.properties[ingredient]!.labels.en = longLabel;
    creation.release.properties[ingredient]!.labels.en = longLabel;
    const pair = () => (
      <>
        <RecipeEditor locale="en" session="signed-in" transport={creation.transport} search={search} />
        <RecipeEditor
          id={recipeId}
          locale="en"
          session="signed-in"
          transport={correction.corrections}
          review={(property) => correction.review(property)}
          search={search}
        />
      </>
    );
    await show(pair());
    await until(() => host.querySelectorAll('select').length === 2);
    const [a, b] = articles() as [HTMLElement, HTMLElement];
    const cleanDeparture = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanDeparture);
    expect(cleanDeparture.defaultPrevented).toBe(false);
    const recipeLabel = input(a, m.catalogue_create_label());
    await replace(recipeLabel, 'A retained draft');
    const dirtyDeparture = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyDeparture);
    expect(dirtyDeparture.defaultPrevented).toBe(true);
    expect(recipeLabel.value).toBe('A retained draft');
    await replace(recipeLabel, '');
    const revertedDeparture = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(revertedDeparture);
    expect(revertedDeparture.defaultPrevented).toBe(false);
    expect(a.querySelector('form')).not.toBeNull();
    expect(b.querySelector('form')).toBeNull();
    const baseline = structuredClone(correction.calls);
    for (const scope of [a, b]) {
      associations(scope);
      const select = within(scope).getByRole('combobox', { name: m.character_add_fact() });
      expect(select.tagName).toBe('SELECT');
      await act(async () => user.click(scope.querySelector(`label[for="${select.id}"]`)!));
      expect(window.document.activeElement).toBe(select);
    }
    const beforeIds = ids();
    await show(pair());
    expect(ids()).toEqual(beforeIds);
    // Keep the existing terms row/focus IDs and removal association intact.
    const correctionIds = [...b.querySelectorAll('[id]')].map((node) => node.id);
    const addLanguage = within(a).getByRole('button', { name: m.catalogue_create_add_language() });
    await click(a, m.catalogue_create_add_language());
    const removeLanguage = within(a).getByRole('button', { name: m.catalogue_create_remove_language() });
    const removable = window.document.getElementById(removeLanguage.getAttribute('aria-controls')!)!;
    expect(a.contains(removable)).toBe(true);
    expect(removable.querySelector('input')!.id).toContain('-language-');
    associations(a);
    await click(a, m.catalogue_create_remove_language());
    expect(a.contains(removable)).toBe(false);
    expect(window.document.activeElement).toBe(addLanguage);
    expect([...b.querySelectorAll('[id]')].map((node) => node.id)).toEqual(correctionIds);
    expect(ids()).toEqual(beforeIds);
    const current = section(b, longLabel);
    frame(current);
    expect(current.textContent).toContain(longValue);
    expect(within(b).getByRole('link', { name: m.candidate_view_public() }).getAttribute('href')).toBe(
      `/en/subjects/${recipeId}/lentil-soup`,
    );
    expect(within(a).getByRole('link', { name: m.catalogue_create_search() }).getAttribute('href')).toBe('/en/search');
    const original = structuredClone(correction.publicRead.subject.statements[ingredient]![0]!);
    await click(current, m.recipe_correct());
    const draft = section(b, longLabel, true);
    frame(draft);
    expect(input(draft, m.correction_value()).value).toBe(longValue);
    const ownIngredient = await add(a, ingredient);
    expect(input(ownIngredient, m.correction_value()).value).toBe('');
    expect(within(b).getByRole('combobox', { name: m.character_add_fact() }).getAttribute('id')).not.toBe(
      within(a).getByRole('combobox', { name: m.character_add_fact() }).getAttribute('id'),
    );
    await replace(input(ownIngredient, m.correction_value()), '400 ml water');
    await replace(input(ownIngredient, m.correction_language()), 'en');
    const siblingScalar = scalar(ownIngredient);
    const retiredCitation = retainedChange(input(ownIngredient, m.relation_citation()));
    await replace(input(ownIngredient, m.relation_citation()), longCitation);
    await act(async () => retiredCitation({ target: { value: 'https://example.test/retired' } }));
    expect(input(ownIngredient, m.relation_citation()).value).toBe(longCitation);
    await act(async () =>
      siblingScalar({
        type: 'value',
        content: { language: 'en', text: '400 ml water' },
      }),
    );
    const retiredScalar = scalar(ownIngredient);
    await replace(input(ownIngredient, m.correction_value()), '500 ml water');
    await act(async () => retiredScalar({ type: 'value', content: 'retired scalar' }));
    expect(input(ownIngredient, m.correction_value()).value).toBe('500 ml water');
    await replace(input(ownIngredient, m.correction_value()), '400 ml water');
    await replace(input(draft, m.relation_citation()), longCitation);
    const citation = input(draft, m.relation_citation());
    await act(async () => {
      citation.focus();
      await user.tab();
    });
    expect(window.document.activeElement).toBe(within(draft).getByRole('button', { name: m.recipe_remove_field() }));
    await act(async () => user.tab());
    expect(window.document.activeElement).toBe(within(draft).getByRole('button', { name: m.correction_submit() }));
    expect(correction.calls).toEqual(baseline);

    const cookTime = 'schema:cookTime';
    const cookTimeLabel = correction.release.properties[cookTime]!.labels.en!;
    await click(section(b, cookTimeLabel), m.recipe_correct());
    const independentDraft = section(b, cookTimeLabel, true);
    const lockedScalar = scalar(independentDraft);
    const lockedCitation = retainedChange(input(independentDraft, m.relation_citation()));
    await click(independentDraft, m.recipe_remove_field());
    const uncertainRemove = queued(within(independentDraft).getByRole('button', { name: m.recipe_remove_field() }));
    correction.setScenario('uncertain');
    await click(independentDraft, m.correction_submit());
    await until(() => independentDraft.textContent!.includes(m.correction_unavailable()));
    const sealedRow = independentDraft.innerHTML;
    await act(async () => {
      lockedScalar({ type: 'value', content: 'locked scalar' });
      lockedCitation({ target: { value: 'https://example.test/locked' } });
    });
    expect(independentDraft.innerHTML).toBe(sealedRow);
    await act(async () => uncertainRemove());
    expect(host.contains(independentDraft)).toBe(true);
    expect(within(independentDraft).getByRole('button', { name: m.recipe_remove_field() }).matches(':disabled')).toBe(
      true,
    );
    const independentFirst = posts(correction, '/candidates').find(
      (call) => (call.body as { statement: { property: { id: string } } }).statement.property.id === cookTime,
    )!;
    correction.release.properties[cookTime]!.datatype = 'string';

    correction.setScenario('conflict');
    await act(async () => {
      within(draft).getByRole('button', { name: m.correction_submit() }).focus();
      await user.keyboard('{Enter}');
    });
    await until(() => draft.textContent!.includes(m.correction_stale()));
    const stale = posts(correction, '/candidates').find(
      (call) => (call.body as { statement: { property: { id: string } } }).statement.property.id === ingredient,
    )!;
    expect((within(draft).getByRole('button', { name: m.correction_retry() }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(input(draft, m.correction_value()).closest('fieldset')!.disabled).toBe(true);
    const currentCorrectionIngredientLabel = `${longLabel} after reread`;
    correction.release.properties[ingredient]!.labels.en = currentCorrectionIngredientLabel;
    failCorrectionRead = true;
    const postedBeforeRead = posts(correction, '/candidates').length;
    await click(draft, m.catalogue_create_review_new());
    await until(() => !!within(b).queryByRole('button', { name: m.correction_retry() }));
    expect(posts(correction, '/candidates')).toHaveLength(postedBeforeRead);
    correction.setScenario('ready');
    await click(b, m.correction_retry());
    await until(() => b.textContent!.includes(currentCorrectionIngredientLabel));
    const independentAfterRead = section(b, cookTimeLabel, true);
    await click(independentAfterRead, m.correction_retry());
    await until(() => independentAfterRead.textContent!.includes(m.correction_proposed()));
    const independentWrites = posts(correction, '/candidates').filter(
      (call) => (call.body as { statement: { property: { id: string } } }).statement.property.id === cookTime,
    );
    expect(independentWrites).toHaveLength(2);
    expect(independentWrites[1]).toEqual(independentFirst);

    const rereadDraft = section(b, currentCorrectionIngredientLabel, true);
    expect(input(rereadDraft, m.correction_value()).value).toBe(longValue);
    expect(input(rereadDraft, m.relation_citation()).value).toBe(longCitation);
    await click(rereadDraft, m.correction_submit());
    await until(() => rereadDraft.textContent!.includes(m.correction_proposed()));
    const writes = posts(correction, '/candidates');
    const ingredientWrites = writes.filter(
      (call) => (call.body as { statement: { property: { id: string } } }).statement.property.id === ingredient,
    );
    expect(ingredientWrites).toHaveLength(2);
    expect(ingredientWrites[0]).toEqual(stale);
    expect(ingredientWrites[1]!.key).not.toBe(stale.key);
    expect(ingredientWrites[1]!.authorization).toBe('Bearer fixture');
    const expected = statementInput(original);
    expected.references.push({
      parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: longCitation } }],
    });
    expect(ingredientWrites[1]!.body).toEqual({ statement: expected });
    expect(correction.publicRead.subject.statements[ingredient]![0]).toEqual(original);
    expect(rereadDraft.querySelector('[data-content-item-slot="state"]')!.textContent).toBe(m.correction_proposed());
    await click(rereadDraft, m.correction_review());
    await until(() => !!within(rereadDraft).queryByRole('button', { name: m.candidate_accept() }));
    const exact = [...correction.candidates.values()].find(
      (candidate) => candidate.statement.property.id === ingredient,
    )!.id;
    await click(rereadDraft, m.candidate_accept());
    const confirmation = within(rereadDraft).getByRole('region', {
      name: m.candidate_confirm_title({ action: m.candidate_accept() }),
    });
    await click(confirmation, m.candidate_accept());
    await until(() => rereadDraft.textContent!.includes(m.candidate_accepted()));
    expect(posts(correction, ':accept')).toHaveLength(1);
    expect(posts(correction, ':accept')[0]!.path).toBe(`/v1/subjects/${recipeId}/candidates/${exact}:accept`);
    expect(posts(correction, ':adopt')).toHaveLength(0);
    expect(correction.publicRead.subject.statements[ingredient]![0]).toEqual(original);

    const material = 'wdt:P186';
    const materialLabel = correction.release.properties[material]!.labels.en!;
    await click(section(b, materialLabel), m.recipe_correct());
    const incompatibleDraft = section(b, materialLabel, true);
    correction.setScenario('conflict');
    await click(incompatibleDraft, m.correction_submit());
    await until(() => incompatibleDraft.textContent!.includes(m.correction_stale()));
    const beforeIncompatibleRefresh = posts(correction, '/candidates').length;
    Object.assign(correction.release.properties[material]!, { datatype: 'string' });
    await click(incompatibleDraft, m.catalogue_create_review_new());
    await until(() => b.textContent!.includes(m.catalogue_create_invalid_field()));
    const retainedIncompatible = section(b, materialLabel, true);
    expect(retainedIncompatible.querySelector('fieldset')!.disabled).toBe(true);
    expect(
      (within(retainedIncompatible).getByRole('button', { name: m.correction_submit() }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(within(retainedIncompatible).queryByRole('button', { name: m.recipe_remove_field() })).not.toBeNull();
    expect(posts(correction, '/candidates')).toHaveLength(beforeIncompatibleRefresh);

    // Two authored method editors have their own labels, consent and documents.
    const methodA = await add(a, 'schema:recipeInstructions');
    const methodB = await add(b, 'schema:recipeInstructions');
    await method(methodA, 'My original preparation, never copied from a recipe site.');
    await method(methodB, 'A separate original replacement.');
    const authoredSibling = document(methodA);
    await replace(input(methodA, m.subject_source_licence()), 'CC0-1.0');
    await act(async () => authoredSibling.onChange!(structuredClone(authoredSibling.value!)));
    expect(input(methodA, m.subject_source_licence()).value).toBe('CC0-1.0');
    const retiredDocument = authoredSibling.onChange!;
    const currentDocument = document(methodA).value!;
    await act(async () => retiredDocument(fromPlainText('Retired document delivery')));
    expect(document(methodA).value).toEqual(currentDocument);
    await replace(input(methodA, m.subject_source_licence()), 'CC-BY-4.0');
    const diet = await add(a, 'schema:suitableForDiet');
    const selectedDiet = {
      id: dietId,
      title: 'Vegetarian diet',
      types: ['skos:Concept'],
      typeLabel: 'Diet',
      cover: null,
    };
    const retiredPicker = picker(diet);
    await act(async () => retiredPicker([selectedDiet]));
    await act(async () => retiredPicker([]));
    expect(diet.textContent).toContain(selectedDiet.title);
    for (const scope of [a, b]) associations(scope);
    expect(input(methodA, m.catalogue_create_language()).id).not.toBe(input(methodB, m.catalogue_create_language()).id);
    expect(input(methodA, m.subject_source_licence()).id).not.toBe(input(methodB, m.subject_source_licence()).id);
    expect(methodA.querySelector('[contenteditable]')!.textContent).not.toContain('A separate original replacement.');
    expect((within(methodB).getByRole('button', { name: m.correction_submit() }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await replace(input(a, m.catalogue_create_label()), 'My lentil soup');
    await click(a, m.recipe_title());
    await until(() => a.textContent!.includes(m.catalogue_create_invalid()));
    expect(posts(creation, '/subjects')).toHaveLength(0); // Original consent is required before native submission.
    const originalDeclaration = within(methodA).getByRole('checkbox', { name: m.recipe_original() });
    expect(originalDeclaration.getAttribute('aria-invalid')).toBe('true');
    expect(window.document.activeElement).toBe(originalDeclaration);
    expect(
      window.document.getElementById(originalDeclaration.getAttribute('aria-describedby')!)?.textContent,
    ).toContain(m.recipe_original());
    await act(async () => user.click(within(methodA).getByRole('checkbox', { name: m.recipe_original() })));
    await replace(input(methodA, m.relation_citation()), longCitation);
    await cancelRemoval(methodA);
    await click(a, m.recipe_title());
    await until(() => !!within(a).queryByRole('button', { name: m.catalogue_create_review_new() }));
    expect(posts(creation, '/subjects')).toHaveLength(0);
    await click(a, m.catalogue_create_review_new());
    await until(() => !!within(a).queryByRole('button', { name: m.correction_retry() }));
    expect(posts(creation, '/subjects')).toHaveLength(0);
    await click(a, m.correction_retry());
    await until(() => a.querySelector('form') !== null && a.textContent!.includes(currentIngredientLabel));
    const retainedIngredient = section(a, currentIngredientLabel, true);
    expect(input(retainedIngredient, m.correction_value()).value).toBe('400 ml water');
    expect(input(retainedIngredient, m.relation_citation()).value).toBe(longCitation);
    expect(input(a, m.catalogue_create_label()).value).toBe('My lentil soup');
    const instructionLabel = creation.release.properties['schema:recipeInstructions']!.labels.en!;
    const retainedMethod = section(a, instructionLabel, true);
    expect(input(retainedMethod, m.catalogue_create_language()).value).toBe('en');
    expect(input(retainedMethod, m.subject_source_licence()).value).toBe('CC-BY-4.0');
    expect(input(retainedMethod, m.relation_citation()).value).toBe(longCitation);
    expect(
      within(retainedMethod).getByRole('checkbox', { name: m.recipe_original() }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(retainedMethod.querySelector('[contenteditable]')!.textContent).toContain(
      'My original preparation, never copied from a recipe site.',
    );
    expect(creationCommands).toHaveLength(1);
    const lockedDocument = document(retainedMethod);
    const lockedPicker = picker(diet);
    const lockedCreateScalar = scalar(retainedIngredient);
    const lockedCreateCitation = retainedChange(input(retainedMethod, m.relation_citation()));
    await click(a, m.recipe_title());
    await until(() => !!within(a).queryByRole('button', { name: m.correction_retry() }));
    expect(creationCommands).toHaveLength(2);
    const sealedCreation = a.innerHTML;
    await act(async () => {
      lockedDocument.onChange!(structuredClone(lockedDocument.value!));
      lockedPicker([]);
      lockedCreateScalar({ type: 'novalue' });
      lockedCreateCitation({
        target: { value: 'https://example.test/locked-create' },
      });
    });
    expect(a.innerHTML).toBe(sealedCreation);
    expect(creationCommands[0]!.key).not.toBe(creationCommands[1]!.key);
    expect(creationCommands[0]!.item).toEqual(creationCommands[1]!.item);
    expect(creationCommands[1]!.item.statements[ingredient]![0]!.references).toEqual([
      {
        parts: [
          {
            property: { id: 'schema:url' },
            value: { type: 'value', content: longCitation },
          },
        ],
      },
    ]);
    expect(creationCommands[1]).toEqual(creationCommands[2]);
    const createWrite = structuredClone(posts(creation, '/subjects')[0]!);
    expect(createWrite.authorization).toBe('Bearer fixture');
    expect(createWrite.body).toMatchObject({
      labels: { en: 'My lentil soup' },
      statements: {
        [ingredient]: [{ value: { type: 'value', content: { language: 'en', text: '400 ml water' } } }],
        'schema:recipeInstructions': [{ value: { type: 'value', content: { language: 'en', licence: 'CC-BY-4.0' } } }],
      },
    });
    creation.setScenario('reader-unavailable');
    await click(a, m.correction_retry());
    await until(() => a.textContent!.includes(m.catalogue_create_reader_unavailable()));
    expect(creationCommands[1]).toEqual(creationCommands[2]);
    expect(creationReplays).toEqual([false, false, true]);
    expect(posts(creation, '/subjects')).toHaveLength(2);
    expect(posts(creation, '/subjects')[1]).toEqual(createWrite);
    const createdCount = creation.calls.length;
    creation.setScenario('ready');
    await click(a, m.correction_retry());
    await until(() => !!within(a).queryByRole('link', { name: m.candidate_view_public() }));
    expect(creation.calls.slice(createdCount)).toEqual([
      expect.objectContaining({ method: 'GET', path: `/v1/subjects/${recipeId}`, authorization: null }),
    ]);
    expect(within(a).getByRole('link', { name: m.candidate_view_public() }).getAttribute('href')).toBe(
      subjectHref({ id: recipeId, label: 'My lentil soup' }, 'en').href,
    );
    expect(creation.documents.size).toBe(1);
    expect([...creation.documents.values()][0]).toMatchObject({
      origin: 'account',
      language: 'en',
      licence: 'CC-BY-4.0',
    });
    const removedDocument = document(methodB);
    await click(methodB, m.recipe_remove_field());
    expect(host.contains(methodB)).toBe(true);
    await click(methodB, m.recipe_remove_field());
    expect(host.contains(methodB)).toBe(false);
    const remaining = host.innerHTML;
    await act(async () => removedDocument.onChange!(fromPlainText('Removed field delivery')));
    expect(host.innerHTML).toBe(remaining);
    expect(rereadDraft.textContent).toContain(m.correction_proposed());

    // Invalid multilingual creation corrects real validator addresses without rebuilding any other draft.
    const invalid = recipeFixture();
    const { validateRecipe } = await import('../src/features/catalogue/recipe-editor');
    const commands: Parameters<typeof invalid.transport.create>[0][] = [];
    let server: 'field' | 'unknown' | 'ready' = 'field';
    await show(
      <RecipeEditor
        key="validation"
        locale="en"
        session="signed-in"
        search={search}
        transport={{
          ...invalid.transport,
          create: async (command) => {
            commands.push(structuredClone(command));
            if (server === 'unknown')
              return { ok: false, reason: 'invalid', errors: [{ pointer: '/future/field', code: 'unsupported' }] };
            if (server === 'field') {
              const rejected = structuredClone(command.item);
              rejected.statements[ingredient]![1]!.value = { type: 'value', content: { language: 'en', text: '' } };
              return { ok: false, reason: 'invalid', errors: validateRecipe(invalid.release, rejected, 'en') };
            }
            return invalid.transport.create(command);
          },
        }}
      />,
    );
    await until(() => !!host.querySelector('select'));
    await replace(input(host, m.catalogue_create_label()), 'Soup');
    const empty = await add(host, ingredient);
    await click(empty, m.recipe_remove_field());
    expect(host.contains(empty)).toBe(false);
    expect(window.document.activeElement).toBe(within(host).getByRole('combobox', { name: m.character_add_fact() }));
    const citationOnly = await add(host, ingredient);
    await replace(input(citationOnly, m.relation_citation()), longCitation);
    await cancelRemoval(citationOnly);
    await click(citationOnly, m.recipe_remove_field());
    await click(citationOnly, m.recipe_remove_field());
    expect(host.contains(citationOnly)).toBe(false);
    await replace(input(host, m.catalogue_create_description()), 'Keep the description');
    await replace(input(host, m.catalogue_create_aliases()), 'Soup\nSoup');
    await click(host, m.catalogue_create_add_language());
    const termRows = () => [...host.querySelectorAll<HTMLElement>('fieldset[id]')];
    await replace(input(termRows()[1]!, m.catalogue_create_language()), 'en');
    await replace(input(termRows()[1]!, m.catalogue_create_label()), 'スープ');
    const first = await add(host, ingredient);
    const second = await add(host, ingredient);
    for (const [scope, value] of [
      [first, '200 g lentils'],
      [second, '400 ml water'],
    ] as const) {
      await replace(input(scope, m.correction_value()), value);
      await replace(input(scope, m.correction_language()), 'en');
    }
    const instructions = await add(host, 'schema:recipeInstructions');
    await click(instructions, m.recipe_replace_method());
    await replace(input(instructions, m.catalogue_create_language()), '??');
    await replace(input(instructions, m.subject_source_licence()), 'Not-an-SPDX-licence');
    await cancelRemoval(instructions);
    await click(host, m.recipe_title());
    expect(commands).toHaveLength(0);
    const duplicateLanguage = input(termRows()[1]!, m.catalogue_create_language());
    expect(window.document.activeElement).toBe(duplicateLanguage);
    const go = async (control: HTMLElement) => {
      const description = control.getAttribute('aria-describedby')!;
      expect(control.getAttribute('aria-invalid')).toBe('true');
      const error = window.document.getElementById(description.split(' ')[0]!)! as unknown as HTMLElement;
      expect(error).not.toBeNull();
      await act(async () => user.click(within(error).getByRole('link')));
      expect(window.document.activeElement).toBe(
        control.matches('[role="group"]') ? control.querySelector('[contenteditable="true"]') : control,
      );
    };
    await go(duplicateLanguage);
    await replace(duplicateLanguage, 'ja');
    expect(duplicateLanguage.hasAttribute('aria-invalid')).toBe(false);
    const aliases = input(termRows()[0]!, m.catalogue_create_aliases());
    await go(aliases);
    await replace(aliases, 'Lentil soup');
    const language = input(instructions, m.catalogue_create_language());
    const licence = input(instructions, m.subject_source_licence());
    const declaration = within(instructions).getByRole('checkbox', { name: m.recipe_original() });
    await go(language);
    await replace(language, 'en');
    expect(licence.getAttribute('aria-invalid')).toBe('true');
    await go(licence);
    await replace(licence, 'CC-BY-4.0');
    await go(declaration);
    await act(async () => user.click(declaration));
    // Empty instructions have their own destination, separate from the original declaration.
    const editor = instructions.querySelector<HTMLElement>('[contenteditable="true"]')!;
    const writeMethod = async (text: string) =>
      act(async () => {
        editor.innerHTML = `<p>${text}</p>`;
        editor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        await new Promise((resolve) => setTimeout(resolve, 180));
        editor.dispatchEvent(new window.FocusEvent('blur'));
      });
    await click(host, m.recipe_title());
    const documentGroup = instructions.querySelector<HTMLElement>('[role="group"][aria-invalid="true"]')!;
    await go(documentGroup);
    await writeMethod('Retain every word of my original instructions.');
    expect(declaration.getAttribute('aria-checked')).toBe('true');
    await click(host, m.recipe_title());
    await until(
      () => commands.length === 1 && input(second, m.correction_value()).getAttribute('aria-invalid') === 'true',
    );
    expect(window.document.activeElement).toBe(input(second, m.correction_value()));
    expect(input(first, m.correction_value()).hasAttribute('aria-invalid')).toBe(false);
    await go(input(second, m.correction_value()));
    // Removing an earlier grouped row must never retarget the rejected second ingredient.
    const rejectedControl = input(second, m.correction_value());
    const feedback = rejectedControl.getAttribute('aria-describedby');
    await cancelRemoval(first);
    await cancelRemoval(instructions);
    expect(input(second, m.correction_value())).toBe(rejectedControl);
    expect(rejectedControl.getAttribute('aria-describedby')).toBe(feedback);
    await click(first, m.recipe_remove_field());
    await click(first, m.recipe_remove_field());
    expect(host.contains(first)).toBe(false);
    expect(second.contains(window.document.activeElement as unknown as Node)).toBe(true);
    expect(input(second, m.correction_value())).toBe(rejectedControl);
    expect(rejectedControl.getAttribute('aria-describedby')).toBe(feedback);
    await go(input(second, m.correction_value()));
    await replace(input(second, m.correction_value()), '450 ml water');
    expect(host.querySelector('[aria-invalid="true"]')).toBeNull();
    server = 'unknown';
    await click(host, m.recipe_title());
    await until(() => commands.length === 2 && !!host.querySelector('[role="alert"]'));
    const fallback = host.querySelector<HTMLElement>('[role="alert"]')!;
    expect(fallback.querySelector('a')).toBeNull();
    expect(fallback.textContent).toContain(m.correction_error_uneditable());
    expect(fallback.textContent).not.toContain('/future/field');
    expect(commands[1]!.item).toEqual({
      ...commands[0]!.item,
      statements: {
        ...commands[0]!.item.statements,
        [ingredient]: [
          {
            ...commands[0]!.item.statements[ingredient]![1]!,
            value: { type: 'value', content: { language: 'en', text: '450 ml water' } },
          },
        ],
      },
    });
    expect(commands[1]!.key).not.toBe(commands[0]!.key);
    expect(commands[1]!.item).toMatchObject({
      labels: { en: 'Soup', ja: 'スープ' },
      descriptions: { en: 'Keep the description' },
      aliases: { en: ['Lentil soup'] },
    });
    expect(editor.textContent).toContain('Retain every word');
    server = 'ready';
    await click(host, m.recipe_title());
    await until(() => host.textContent!.includes(m.recipe_created()));

    // Supplied reading growth only: creation input has a separate per-property limit.
    // No backend population/cost claim follows from these fixture/DOM witnesses.
    for (const count of [1, 8, 64]) {
      const fixture = recipeFixture();
      const supplied = recipeExample();
      expect((await fixture.transport.create({ item: supplied, key: crypto.randomUUID() })).ok).toBe(true);
      const entry = fixture.publicRead.subject.statements[ingredient]![0]!;
      fixture.publicRead.subject.statements[ingredient] = Array.from({ length: count }, (_, index) => ({
        ...structuredClone(entry),
        id: crypto.randomUUID(),
        value: { type: 'value', content: { language: 'en', text: `${index}: ${longValue}` } },
      }));
      const before = fixture.calls.length;
      const read = await fixture.corrections.load();
      if (!read.ok || !read.public) throw new Error('Expected supplied correction reading');
      expect(fixture.calls.length - before).toBe(3); // Exact subject + active + release.
      let traversals = 0;
      const noPopulationScan = <T extends object>(value: T) =>
        new Proxy(value, {
          ownKeys(target) {
            traversals++;
            return Reflect.ownKeys(target);
          },
        });
      read.release.properties = noPopulationScan(read.release.properties);
      read.public.related = noPopulationScan(read.public.related);
      const suppliedCalls = structuredClone(fixture.calls);
      const node = (
        <RecipeEditor
          key={`growth-${count}`}
          id={recipeId}
          locale="en"
          session="signed-in"
          transport={{ ...fixture.corrections, load: async () => read }}
          search={search}
        />
      );
      await show(node);
      await until(() => host.querySelectorAll('h2').length === read.fields.length);
      const region = section(host, fixture.release.properties[ingredient]!.labels.en!);
      expect(within(region).getAllByRole('button', { name: m.recipe_correct() })).toHaveLength(count);
      for (let index = 0; index < count; index++) expect(region.textContent).toContain(`${index}: ${longValue}`);
      frame(region);
      await show(node);
      expect(traversals).toBe(0);
      expect(fixture.calls).toEqual(suppliedCalls);
    }

    // Truthful read states retain only their real recovery, with no automatic retry.
    for (const scenario of ['empty', 'concealed', 'unavailable'] as const) {
      const fixture = recipeFixture(scenario);
      await show(
        <RecipeEditor
          key={scenario}
          id={recipeId}
          locale="en"
          session="signed-in"
          transport={fixture.corrections}
          search={search}
        />,
      );
      const message =
        scenario === 'empty'
          ? m.recipe_empty()
          : scenario === 'concealed'
            ? m.catalogue_create_concealed()
            : m.correction_unavailable();
      await until(() => host.textContent!.includes(message));
      expect(host.querySelector('select')).toBeNull();
      const calls = structuredClone(fixture.calls);
      await settle();
      expect(fixture.calls).toEqual(calls);
      expect(posts(fixture, '/subjects')).toHaveLength(0);
    }
    const denied = recipeFixture();
    await denied.transport.create({ item: recipeExample(), key: crypto.randomUUID() });
    denied.setScenario('denied');
    const deniedOriginal = structuredClone(denied.publicRead.subject.statements);
    await show(
      <RecipeEditor
        key="denied"
        id={recipeId}
        locale="en"
        session="signed-in"
        transport={denied.corrections}
        search={search}
      />,
    );
    await until(() => !!host.querySelector('select'));
    const deniedLabel = denied.release.properties['schema:cookTime']!.labels.en!;
    await click(section(host, deniedLabel), m.recipe_correct());
    const deniedPanel = section(host, deniedLabel, true);
    await click(deniedPanel, m.correction_submit());
    await until(() => deniedPanel.textContent!.includes(m.correction_denied()));
    expect(posts(denied, '/candidates')).toHaveLength(1);
    expect(denied.publicRead.subject.statements).toEqual(deniedOriginal);
    expect(within(deniedPanel).queryByRole('button', { name: m.catalogue_create_review_new() })).not.toBeNull();
    const deniedCalls = structuredClone(denied.calls);
    await settle();
    expect(denied.calls).toEqual(deniedCalls);
    const signedOut = recipeFixture();
    await show(
      <RecipeEditor
        key="signed-out"
        locale="en"
        session="signed-out"
        transport={signedOut.transport}
        search={search}
      />,
    );
    await until(() => !!host.querySelector('select'));
    expect(host.textContent).toContain(m.catalogue_create_signed_out());
    expect((within(host).getByRole('button', { name: m.recipe_title() }) as HTMLButtonElement).disabled).toBe(true);
    expect(signedOut.calls.every((call) => call.method === 'GET')).toBe(true);

    // A real positive proposal/read enters the fixture before its delivery is held.
    // Retirement fences late success, returned failure and throw; a fresh reader stays usable.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = recipeFixture();
      await fixture.transport.create({ item: recipeExample(), key: crypto.randomUUID() });
      const gate = deferred<'success' | 'failure' | 'throw'>();
      const entered = deferred<void>();
      let hold = true;
      const transport = {
        ...fixture.corrections,
        propose: async (command: Parameters<typeof fixture.transport.propose>[0]) => {
          const result = await fixture.transport.propose(command);
          if (!hold) return result;
          hold = false;
          entered.resolve();
          const kind = await gate.promise;
          if (kind === 'throw') throw new Error('Retired delivery');
          return kind === 'failure' ? { ok: false as const, reason: 'unavailable' as const } : result;
        },
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          key={delivery}
          address="recipe-family"
          observed={{ state: 'signed-in', subject: reader, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }}
        >
          <RecipeEditor id={recipeId} locale="en" session="signed-in" transport={transport} search={search} />
        </CandidateReaderBoundary>
      );
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
      await until(() => !!host.querySelector('select'));
      const reading = section(host, fixture.release.properties['schema:cookTime']!.labels.en!);
      await click(reading, m.recipe_correct());
      const pending = section(host, fixture.release.properties['schema:cookTime']!.labels.en!, true);
      await click(pending, m.recipe_remove_field());
      const oldRemove = queued(within(pending).getByRole('button', { name: m.recipe_remove_field() }));
      const oldSubmit = queued(within(pending).getByRole('button', { name: m.correction_submit() }));
      await click(pending, m.correction_submit());
      await entered.promise;
      await act(async () => oldRemove());
      expect(host.contains(pending)).toBe(true);
      expect(within(pending).getByRole('button', { name: m.recipe_remove_field() }).matches(':disabled')).toBe(true);
      expect(posts(fixture, '/candidates')).toHaveLength(1);
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await until(() => !!host.querySelector('select'));
      const count = fixture.calls.length;
      outside.focus();
      await act(async () => {
        oldSubmit();
        oldRemove();
        gate.resolve(delivery);
      });
      await settle();
      expect(fixture.calls).toHaveLength(count);
      expect(window.document.activeElement).toBe(outside);
      expect(host.textContent).not.toContain(m.correction_proposed());
      expect(within(host).queryByRole('button', { name: m.correction_retry() })).toBeNull();
      // New live mount submits normally; no old command/key is revived.
      await click(section(host, fixture.release.properties['schema:cookTime']!.labels.en!), m.recipe_correct());
      const fresh = section(host, fixture.release.properties['schema:cookTime']!.labels.en!, true);
      await click(fresh, m.correction_submit());
      await until(() => posts(fixture, '/candidates').length === 2);
      expect(posts(fixture, '/candidates')[1]!.key).not.toBe(posts(fixture, '/candidates')[0]!.key);
      await until(() => fresh.textContent!.includes(m.correction_proposed()));
      expect(within(fresh).getByRole('button', { name: m.recipe_remove_field() }).matches(':disabled')).toBe(true);
    }
    // A retired recipe query cannot deposit its old reading after a new reader loads.
    for (const delivery of ['success', 'failure', 'throw'] as const) {
      const fixture = recipeFixture();
      await fixture.transport.create({ item: recipeExample(), key: crypto.randomUUID() });
      const entered = deferred<void>();
      const gate = deferred<'success' | 'failure' | 'throw'>();
      let hold = true;
      const transport = {
        ...fixture.corrections,
        load: async () => {
          const result = await fixture.corrections.load();
          if (!hold) return result;
          hold = false;
          entered.resolve();
          const kind = await gate.promise;
          if (kind === 'throw') throw new Error('Retired recipe read');
          return kind === 'failure' ? { ok: false as const, reason: 'unavailable' as const } : result;
        },
      };
      const boundary = (reader: string) => (
        <CandidateReaderBoundary
          key={`read-${delivery}`}
          address="recipe-read"
          observed={{ state: 'signed-in', subject: reader, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }}
        >
          <RecipeEditor id={recipeId} locale="en" session="signed-in" transport={transport} search={search} />
        </CandidateReaderBoundary>
      );
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10'));
      await entered.promise;
      const retired = client
        .getQueryCache()
        .getAll()
        .find((query) => query.queryKey[0] === 'recipe-editor' && query.state.fetchStatus === 'fetching')!;
      expect(retired).toBeDefined();
      const freshValue = `Fresh reader's supplied ingredient ${delivery}`;
      fixture.publicRead.subject.statements[ingredient]![0]!.value = {
        type: 'value',
        content: { language: 'en', text: freshValue },
      };
      await show(boundary('0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11'));
      await until(() => host.textContent!.includes(freshValue));
      const calls = structuredClone(fixture.calls);
      outside.focus();
      await act(async () => gate.resolve(delivery));
      await settle();
      expect(retired.state.data).toBeUndefined();
      expect(fixture.calls).toEqual(calls);
      expect(window.document.activeElement).toBe(outside);
      expect(host.textContent).toContain(freshValue);
      expect(host.textContent).not.toContain(m.correction_unavailable());
    }
    await show(null);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
  }
}, 60_000);
