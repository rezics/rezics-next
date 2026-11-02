import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';

test('Recipe recovery retires current authority and keeps the private draft and sealed proposal', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/subjects/recipe/recipe' });
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
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { recipeFixture, recipeExample, recipeId } = await import('../src/kernel/fake/recipe-editor');
  const { m } = await import('../src/paraglide/messages.js');
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('div') as unknown as HTMLElement;
  const outside = window.document.createElement('button');
  outside.textContent = 'Outside the Recipe';
  window.document.body.append(host, outside);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const fixture = recipeFixture();
  if (!(await fixture.transport.create({ item: recipeExample(), key: crypto.randomUUID() })).ok)
    throw new Error('Recipe fixture creation failed');
  const initial = await fixture.corrections.load();
  if (!initial.ok || !initial.public) throw new Error('Recipe fixture current reading failed');
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  };
  const reads = [
    deferred<Awaited<ReturnType<typeof fixture.corrections.load>>>(),
    deferred<Awaited<ReturnType<typeof fixture.corrections.load>>>(),
    deferred<Awaited<ReturnType<typeof fixture.corrections.load>>>(),
  ];
  let loadCount = 0;
  fixture.corrections.load = async () => {
    const index = loadCount++;
    return index === 0 ? initial : reads[index - 1]!.promise;
  };
  const originalPropose = fixture.corrections.propose;
  type ProposalCommand = Parameters<typeof originalPropose>[0];
  type ProposalResult = Awaited<ReturnType<typeof originalPropose>>;
  const late = deferred<ProposalResult>();
  const sent: { command: ProposalCommand; replay: boolean }[] = [];
  let lateResult: ProposalResult | undefined;
  fixture.setScenario('conflict');
  fixture.corrections.propose = async (command, replay) => {
    sent.push({ command: structuredClone(command), replay: replay === true });
    if (sent.length === 1) return originalPropose(command, replay);
    if (sent.length === 2) return late.promise;
    return lateResult!;
  };
  const show = (node: ReactNode) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary>{node}</CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
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
      await user.type(control, value);
    });
  const section = (name: string, last = false) => {
    const headings = within(host).getAllByRole('heading', {
      name: name.replace(/\s+/g, ' ').trim(),
      level: 2,
    });
    return headings[last ? headings.length - 1 : 0]!.closest('section') as HTMLElement;
  };
  const queued = (element: HTMLElement) => {
    const key = Object.keys(element).find((name) => name.startsWith('__reactProps$'))!;
    return (Reflect.get(element, key) as { onClick: () => void }).onClick;
  };
  const readRetry = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === m.correction_retry() && !button.closest('section'),
    )!;
  try {
    outside.focus();
    await show(
      <RecipeEditor
        id={recipeId}
        locale="en"
        session="signed-in"
        transport={fixture.corrections}
        search={async () => []}
      />,
    );
    await until(() => loadCount === 1 && !!within(host).queryByRole('link', { name: m.candidate_view_public() }));
    expect(window.document.activeElement).toBe(outside);
    const ingredient = 'schema:recipeIngredient';
    const cookTime = 'schema:cookTime';
    const instructions = 'schema:recipeInstructions';
    const ingredientLabel = initial.release.properties[ingredient]!.labels.en!;
    const cookTimeLabel = initial.release.properties[cookTime]!.labels.en!;
    const currentIngredient = section(ingredientLabel);
    const untouched = initial.fields.find(
      (field) =>
        field !== ingredient &&
        field !== cookTime &&
        field !== instructions &&
        initial.release.properties[field]?.labels.en &&
        (initial.public!.subject.statements[field] ?? []).length > 0,
    )!;
    const untouchedLabel = initial.release.properties[untouched]!.labels.en!;
    const oldCorrect = queued(within(section(untouchedLabel)).getByRole('button', { name: m.recipe_correct() }));
    const methodLabel = initial.release.properties[instructions]!.labels.en!;
    await click(section(methodLabel), m.recipe_correct());
    const methodDraft = section(methodLabel, true);
    await click(methodDraft, m.recipe_replace_method());
    await replace(input(methodDraft, m.catalogue_create_language()), 'en');
    await replace(input(methodDraft, m.subject_source_licence()), 'CC-BY-4.0');
    const methodEditor = methodDraft.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]')!;
    const privateMethod = 'My private method survives read recovery.';
    await act(async () => {
      methodEditor.innerHTML = `<p>${privateMethod}</p>`;
      methodEditor.dispatchEvent(new window.InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      await new Promise((resolve) => setTimeout(resolve, 180));
      methodEditor.dispatchEvent(new window.FocusEvent('blur'));
    });
    await click(currentIngredient, m.recipe_correct());
    const ingredientDraft = section(ingredientLabel, true);
    const privateValue = 'Retained correction, private until reviewed';
    const privateCitation = 'https://example.test/private-recipe-source';
    await replace(input(ingredientDraft, m.correction_value()), privateValue);
    await replace(input(ingredientDraft, m.relation_citation()), privateCitation);
    await click(ingredientDraft, m.correction_submit());
    await until(() => ingredientDraft.textContent!.includes(m.correction_stale()));

    fixture.setScenario('ready');
    const currentCookTime = section(cookTimeLabel);
    await click(currentCookTime, m.recipe_correct());
    const cookTimeDraft = section(cookTimeLabel, true);
    await click(cookTimeDraft, m.correction_submit());
    await until(() => sent.length === 2);
    const exactCommand = structuredClone(sent[1]!.command);
    await click(ingredientDraft, m.catalogue_create_review_new());
    await until(() => loadCount === 2);
    outside.focus();
    await until(() => !currentIngredient.isConnected);
    expect(within(host).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
    expect(host.textContent).not.toContain(untouchedLabel);
    expect(ingredientDraft.isConnected).toBe(true);
    expect(input(ingredientDraft, m.correction_value()).value).toBe(privateValue);
    expect(input(ingredientDraft, m.relation_citation()).value).toBe(privateCitation);
    expect(sent).toHaveLength(2);

    lateResult = {
      ok: true,
      kind: 'proposed-awaiting-review',
      candidate: 'late-candidate',
      revision: 1,
    };
    await act(async () => late.resolve(lateResult!));
    await until(
      () => !(within(cookTimeDraft).getByRole('button', { name: m.correction_retry() }) as HTMLButtonElement).disabled,
    );
    expect(cookTimeDraft.textContent).not.toContain(m.correction_proposed());
    reads[0]!.resolve({ ok: false, reason: 'concealed' });
    await until(() => host.textContent!.includes(m.catalogue_create_concealed()));
    expect(window.document.activeElement).toBe(outside);
    expect(within(host).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
    expect(sent).toHaveLength(2);
    await act(async () => user.click(readRetry()));
    await until(() => loadCount === 3);
    await until(() => !currentIngredient.isConnected);
    reads[1]!.reject(new Error('reader unavailable'));
    await until(() => loadCount === 3 && host.textContent!.includes(m.correction_unavailable()));
    expect(window.document.activeElement).toBe(readRetry().parentElement);
    expect(within(host).queryByRole('link', { name: m.candidate_view_public() })).toBeNull();
    expect(input(ingredientDraft, m.correction_value()).value).toBe(privateValue);

    const retiredRetry = queued(readRetry());
    await act(async () => {
      readRetry().focus();
      await user.keyboard('{Enter}');
    });
    await until(() => loadCount === 4);
    expect(readRetry().disabled).toBe(true);
    reads[2]!.resolve(initial);
    await until(() => !!within(host).queryByRole('link', { name: m.candidate_view_public() }));
    expect(window.document.activeElement).toBe(within(host).getByRole('heading', { level: 1 }));
    expect(methodDraft.isConnected).toBe(true);
    expect(methodEditor.textContent).toBe(privateMethod);
    expect(input(methodDraft, m.catalogue_create_language()).value).toBe('en');
    expect(input(methodDraft, m.subject_source_licence()).value).toBe('CC-BY-4.0');
    expect(within(host).getByRole('link', { name: m.candidate_view_public() }).getAttribute('href')).toContain(
      recipeId,
    );
    const untouchedHeadingCount = within(host).getAllByRole('heading', { name: untouchedLabel, level: 2 }).length;
    outside.focus();
    await act(async () => {
      oldCorrect();
      retiredRetry();
    });
    expect(loadCount).toBe(4);
    expect(window.document.activeElement).toBe(outside);
    expect(within(host).getAllByRole('heading', { name: untouchedLabel, level: 2 })).toHaveLength(
      untouchedHeadingCount,
    );
    expect(input(ingredientDraft, m.correction_value()).value).toBe(privateValue);
    expect(input(ingredientDraft, m.relation_citation()).value).toBe(privateCitation);
    expect(sent).toHaveLength(2);
    await click(cookTimeDraft, m.correction_retry());
    await until(() => sent.length === 3 && cookTimeDraft.textContent!.includes(m.correction_proposed()));
    expect(sent[2]).toEqual({ command: exactCommand, replay: true });
    expect(window.document.activeElement).not.toBe(within(host).getByRole('heading', { level: 1 }));

    // Deliberate recovery lands on truthful non-field results; retired completions stay silent.
    for (const outcome of ['empty', 'concealed', 'unavailable', 'retired'] as const) {
      await show(null);
      client.clear();
      const result = deferred<typeof initial | { ok: false; reason: 'concealed' | 'unavailable' }>();
      let calls = 0;
      const transport = {
        ...fixture.corrections,
        load: async () => (++calls === 1 ? { ok: false as const, reason: 'unavailable' as const } : result.promise),
      };
      await show(
        <RecipeEditor id={recipeId} locale="en" session="signed-in" transport={transport} search={async () => []} />,
      );
      await until(() => !!readRetry());
      const oldRetry = queued(readRetry());
      await act(async () => {
        readRetry().focus();
        await user.keyboard('{Enter}');
      });
      await until(() => calls === 2);
      if (outcome === 'retired') await show(null);
      outside.focus();
      await act(async () =>
        result.resolve(
          outcome === 'empty' || outcome === 'retired' ? { ...initial, fields: [] } : { ok: false, reason: outcome },
        ),
      );
      await until(() => outcome === 'retired' || !readRetry()?.disabled);
      if (outcome === 'retired') {
        await act(async () => oldRetry());
        expect(calls).toBe(2);
        expect(window.document.activeElement).toBe(outside);
      } else {
        const destination = outcome === 'empty' ? within(host).getByRole('status') : readRetry().parentElement;
        expect(window.document.activeElement).toBe(destination);
        expect(host.querySelector('input, select, [contenteditable]')).toBeNull();
      }
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
    mock.restore();
  }
});
