import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { candidateContext } from '../src/subject/candidates';
import {
  parseRecipeVisit,
  recipeCorrectionHref,
  recipeSourceHref,
  recipeVisitSearch,
} from '../src/features/catalogue/recipe-current-visit';
import { readRecipeEditor } from '../src/features/catalogue/recipe-editor';
import { recipeFixture, recipeId, recipeExample } from '../src/kernel/fake/recipe-editor';

const context = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e20';
const realm = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e21';
const statement = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e22';
const subject = { id: recipeId, label: 'Lentil soup' };

test('recipe entry addresses keep explicit Global, selected Realm and exact occurrence intent without payloads', () => {
  const visit = { context, realm, occurrence: { property: 'schema:recipeIngredient', statement, holder: recipeId } };
  const href = recipeCorrectionHref(subject, 'en', visit);
  expect(href).toStartWith(`/en/subjects/${recipeId}/lentil-soup/recipe?context=${context}&realm=${realm}`);
  expect(parseRecipeVisit(new URL(href, 'https://site.test').search)).toEqual({ valid: true, visit });
  expect(recipeSourceHref(subject, 'en', visit)).toBe(`/en/subjects/${recipeId}/lentil-soup?realm=${realm}`);
  expect(recipeSourceHref(subject, 'en', { context })).toBeUndefined();
  expect(recipeCorrectionHref(subject, 'en', { context: candidateContext })).toEndWith(`?context=${candidateContext}`);
  expect(parseRecipeVisit('')).toEqual({ valid: true, visit: { context: candidateContext } });
  for (const invalid of [
    '?context=garbage',
    `?context=${context}&context=${candidateContext}`,
    `?realm=${realm}`,
    `?context=${context}&realm=other`,
    `?context=${context}&returnTo=https://foreign.test`,
    `?context=${context}&property=schema:recipeIngredient&statement=${statement}`,
    `?context=${context}&property=schema:recipeIngredient&statement=${statement}&holder=foreign`,
    `?context=${context}&property=unknown:field&statement=${statement}&holder=${recipeId}`,
    `?context=${context}&from=${'x'.repeat(8192)}`,
  ])
    expect(parseRecipeVisit(invalid)).toEqual({ valid: false });
  expect(new TextEncoder().encode(recipeVisitSearch(visit)).byteLength).toBeLessThan(8192);
});

test('native recipe admission sends the selected Context and rejects mismatched replies before offering editing', async () => {
  const fixture = recipeFixture();
  const read = await fixture.transport.load();
  if (!read.ok) throw new Error('Expected recipe definitions');
  const requests: Request[] = [];
  let returnedContext = candidateContext;
  const client = createKernelClient('https://native.test', {
    fetch: (async (input, init) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === `/v1/subjects/${recipeId}`)
        return Response.json({
          ...fixture.publicRead,
          subject: { ...fixture.publicRead.subject, context: returnedContext },
        });
      if (path === '/v1/definitions/active') return Response.json({ digest: 'a'.repeat(64) });
      return Response.json({ digest: 'a'.repeat(64), release: read.release });
    }) as typeof fetch,
  });
  expect((await readRecipeEditor(client, 'en', recipeId, candidateContext)).ok).toBe(true);
  const request = requests.find((request) => new URL(request.url).pathname.endsWith(recipeId))!;
  expect(new URL(request.url).searchParams.get('context')).toBe(candidateContext);
  expect(request.cache).toBe('no-store');
  expect(await readRecipeEditor(client, 'en', recipeId, context)).toEqual({ ok: false, reason: 'unavailable' });
  returnedContext = context;
  expect(await readRecipeEditor(client, 'en', recipeId, context)).toEqual({ ok: false, reason: 'unsupported-context' });
});

test('mounted recipe intent selects the exact duplicate occurrence and explains a removed occurrence', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window();
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    Text: window.Text,
    NodeFilter: window.NodeFilter,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    DOMParser: window.DOMParser,
    Range: window.Range,
    DOMRect: window.DOMRect,
    CSS: window.CSS,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRequire } = await import('node:module');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const { RecipeEditor } = await import('../src/features/catalogue/recipe-editor-view');
  const { RecipeEditorEntry } = await import('../src/features/catalogue/recipe-editor-entry');
  const { RecipeVisitNotice } = await import('../src/features/catalogue/recipe-current-visit-view');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const fixture = recipeFixture();
  await fixture.transport.create({ item: recipeExample(), key: crypto.randomUUID() });
  const initial = await fixture.corrections.load();
  if (!initial.ok || !initial.public) throw new Error('Expected recipe reading');
  const property = 'schema:recipeIngredient';
  const original = initial.public.subject.statements[property]![0]!;
  const duplicate = { ...structuredClone(original), id: statement };
  initial.public.subject.statements[property] = [original, duplicate];
  let failedRead = false;
  const transport = {
    ...fixture.corrections,
    load: async () => (failedRead ? fixture.corrections.load() : initial),
    propose: async (...input: Parameters<typeof fixture.corrections.propose>) => {
      const result = await fixture.corrections.propose(...input);
      fixture.setScenario('reader-unavailable');
      failedRead = true;
      return result;
    },
  };
  const show = (missing = false) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CandidateReaderBoundary
            address={missing ? 'missing' : 'exact'}
            observed={{ state: 'signed-in', subject: context, csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' }}
          >
            <RecipeEditor
              id={recipeId}
              context={candidateContext}
              locale="en"
              session="signed-in"
              transport={transport}
              search={async () => []}
              visit={{
                context: candidateContext,
                occurrence: { property, statement: missing ? context : statement, holder: recipeId },
              }}
            />
          </CandidateReaderBoundary>
        </QueryClientProvider>,
      ),
    );
  try {
    await act(async () => root.render(<RecipeEditorEntry {...subject} locale="en" context={context} realm={realm} />));
    expect(host.querySelector('a')?.getAttribute('href')).toContain(`context=${context}&realm=${realm}`);
    await act(async () =>
      root.render(<RecipeVisitNotice locale="en" sourceHref={recipeSourceHref(subject, 'en', { context, realm })} />),
    );
    expect(host.textContent).toContain(m.recipe_visit_unsupported());
    expect(host.querySelector('a')?.getAttribute('href')).toEndWith(`?realm=${realm}`);
    await show();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(window.document.activeElement?.getAttribute('data-recipe-current-statement')).toBe(statement);
    expect(host.querySelectorAll('[data-recipe-current-statement]')).toHaveLength(
      Object.values(initial.public.subject.statements).flat().length,
    );
    const canvas = within(host as unknown as HTMLElement);
    const exact = host.querySelector(`[data-recipe-current-statement="${statement}"]`)!;
    await act(async () => {
      await user.click(exact.querySelector('button')!);
    });
    const value = canvas.getByRole('textbox', { name: m.correction_value() });
    await act(async () => {
      await user.clear(value);
      await user.type(value, '250 g lentils');
    });
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.recipe_review() }));
    });
    await act(async () => {
      await user.click(canvas.getByRole('button', { name: m.correction_submit() }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.textContent).toContain(m.correction_proposed());
    expect(canvas.getByRole('textbox', { name: m.correction_value() }).value).toBe('250 g lentils');
    expect(host.querySelectorAll('[data-recipe-current-statement]')).toHaveLength(0);
    const sent = fixture.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/candidates'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({
      statement: {
        property: { id: property },
        value: { content: { text: '250 g lentils' } },
        references: original.references.map(({ parts }) => ({
          parts: parts.map(({ property, value }) => ({ property: { id: property.id }, value })),
        })),
      },
    });
    failedRead = false;
    await show(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.textContent).toContain(m.recipe_visit_occurrence_missing());
    expect(window.document.activeElement?.tagName).toBe('H1');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 60_000);
