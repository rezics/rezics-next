import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { englishMessages } from '../work-page/messages.ts';
import { RecipeContent } from '../work-page/types/recipe.tsx';
import { readRecipe } from './api.ts';
import { actingSubject, fakeMain, id, mainVersion, startRecipe, structure, work } from './fixtures.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import { plan } from './intents.ts';
import { emptyRecipe, type Node, type RecipePageLike, stateOf } from './model.ts';
import { appendRecipePage, isStaleRecipePage, loadRecipe, mergeRecipeState, readRecipePage, RECIPE_OCCURRENCE_CAP,
  recipePageQuery, type RecipeFetch } from './pages.ts';
import { createRecipeStore } from './store.ts';

const line = (text: string) => qualifierOf(parseLine(text), 'en');
const group: Node = { occurrence: id(30), parent: structure, role: 'group', label: { value: 'Sauce', language: 'en' } };
const tomato: Node = { occurrence: id(31), parent: group.occurrence, role: 'ingredient', qualifier: line('1 cup tomato') };
const salt: Node = { occurrence: id(32), parent: group.occurrence, role: 'ingredient', qualifier: line('1 teaspoon salt') };

function listed(nodes: readonly Node[], next?: string): RecipePageLike {
  return {
    structure, revision: id(900), measures: [],
    occurrences: nodes.map(node => ({
      occurrence: node.occurrence, parent: node.parent, role: node.role, state: 'active' as const,
      labels: node.role === 'group' && node.label ? [node.label] : [],
      ...('qualifier' in node ? { qualifier: node.qualifier } : {}),
    })),
    ...(next ? { next } : {}),
  };
}

const readable = (occurrence: string, role: string, parent: string, label?: string, instruction?: string) => ({
  occurrence, role, parent, labels: label ? [{ value: label }] : [],
  ...(instruction ? { qualifier: { type: 'recipe-step', instructionText: { value: instruction }, usesIngredient: [] } } : {}),
});

test('a continuation keeps one section and the step numbers that follow', () => {
  const root = structure;
  const stepA = id(33);
  const stepB = id(34);
  const merged = appendRecipePage({
    occurrences: [readable(group.occurrence, 'group', root, 'Sauce'), readable(tomato.occurrence, 'ingredient', group.occurrence),
      readable(stepA, 'step', root, undefined, 'Stir the tomato.')],
    ingredients: [{ occurrence: tomato.occurrence, originalText: '1 cup tomato', line: '1 cup tomato' }],
    measures: [], next: 'later',
  }, {
    occurrences: [readable(salt.occurrence, 'ingredient', group.occurrence), readable(stepB, 'step', root, undefined, 'Season and simmer.')],
    ingredients: [{ occurrence: salt.occurrence, originalText: '1 teaspoon salt', line: '1 teaspoon salt' }],
    measures: [],
  });
  expect(merged.next).toBeUndefined();
  expect(merged.occurrences.map(item => item.occurrence)).toEqual([group.occurrence, tomato.occurrence, stepA, salt.occurrence, stepB]);
  const html = renderToStaticMarkup(createElement(RecipeContent, { page: merged, units: 'written', messages: englishMessages }));
  expect(html.match(/<h4[^>]*>Sauce<\/h4>/g)).toHaveLength(1);
  expect(html.indexOf('1 cup tomato')).toBeLessThan(html.indexOf('1 teaspoon salt'));
  expect(html.indexOf('Stir the tomato.')).toBeLessThan(html.indexOf('Season and simmer.'));
  expect(html).toContain('>1<');
  expect(html).toContain('>2<');
});

test('a section heading is kept when its lines have not arrived yet', () => {
  const html = renderToStaticMarkup(createElement(RecipeContent, {
    page: { occurrences: [readable(group.occurrence, 'group', structure, 'Dough')], ingredients: [], measures: [] },
    units: 'written', messages: englishMessages,
  }));
  expect(html).toContain('Dough');
  expect(html).not.toContain('<ul');
});

test('a stale recipe page is the profile Main answers, and a cursor never travels with a new serving count', () => {
  expect(isStaleRecipePage({ status: 409, value: { profile: 'recipe-work-page-stale' } })).toBe(true);
  expect(isStaleRecipePage({ status: 409, value: { profile: 'problem', code: 'stale_composition_head' } })).toBe(false);
  expect(isStaleRecipePage({ status: 400, value: { profile: 'recipe-work-page-stale' } })).toBe(false);
  expect(recipePageQuery(actingSubject, { cursor: 'later', servings: 8 })).toEqual({ actingSubject, cursor: 'later' });
  expect(recipePageQuery(actingSubject, { servings: 8 })).toEqual({ actingSubject, servings: 8 });
  expect(recipePageQuery(null, {})).toEqual({ actingSubject: undefined });
});

test('removing or moving from the first page alone drops or skips what a later page holds', () => {
  const partial = stateOf(listed([group, tomato]));
  const full = mergeRecipeState(partial, listed([salt]));
  expect(plan(partial, { kind: 'removeSection', occurrence: group.occurrence })).toEqual({
    kind: 'changes', operations: [{ op: 'remove', occurrence: tomato.occurrence }, { op: 'remove', occurrence: group.occurrence }],
  });
  expect(plan(full, { kind: 'removeSection', occurrence: group.occurrence })).toEqual({
    kind: 'changes', operations: [{ op: 'remove', occurrence: tomato.occurrence }, { op: 'remove', occurrence: salt.occurrence },
      { op: 'remove', occurrence: group.occurrence }],
  });
  expect(plan(partial, { kind: 'moveLine', occurrence: tomato.occurrence, direction: 'down' })).toEqual({ kind: 'moot' });
  expect(plan(full, { kind: 'moveLine', occurrence: tomato.occurrence, direction: 'down' })).toMatchObject({
    kind: 'changes', operations: [{ op: 'move', occurrence: tomato.occurrence, position: { after: salt.occurrence } }],
  });
});

const answer = (page: RecipePageLike | null): RecipeFetch => ({ ok: true, page });

test('the editor reads every remaining page, and stops when a page adds nothing or the recipe is past the cap', async () => {
  const seen: number[] = [];
  const loaded = await loadRecipe(async cursor => answer(cursor ? listed([salt]) : listed([group], 'later')), count => seen.push(count));
  expect(loaded.ok && loaded.state.nodes.map(node => node.occurrence)).toEqual([group.occurrence, salt.occurrence]);
  expect(seen).toEqual([1, 2]);

  const stalled = await loadRecipe(async () => answer(listed([group], 'again')));
  expect(stalled).toEqual({ ok: false, kind: 'failed' });

  let past = false;
  const bulky = Array.from({ length: RECIPE_OCCURRENCE_CAP }, (_, index): Node => ({
    occurrence: id(1000 + index), parent: structure, role: 'equipment',
  }));
  const capped = await loadRecipe(async cursor => {
    if (cursor) past = true;
    return answer(listed(bulky, 'more'));
  });
  expect(capped).toEqual({ ok: false, kind: 'too-large' });
  expect(past).toBe(false);

  expect(await loadRecipe(async () => ({ ok: true, page: null }))).toEqual({ ok: true, state: emptyRecipe });
  expect(await loadRecipe(async () => ({ ok: false, status: 503, value: null }))).toEqual({ ok: false, kind: 'failed' });
});

test('a cursor whose revision moved starts again from the first page, a few times', async () => {
  let opened = 0;
  const recovered = await loadRecipe(async cursor => {
    if (cursor) return { ok: false, status: 409, value: { profile: 'recipe-work-page-stale' } };
    opened += 1;
    return answer(opened < 2 ? listed([group], 'stale') : listed([group, salt]));
  });
  expect(opened).toBe(2);
  expect(recovered.ok && recovered.state.nodes).toHaveLength(2);

  opened = 0;
  const stuck = await loadRecipe(async cursor => {
    if (!cursor) opened += 1;
    return cursor ? { ok: false, status: 409, value: { profile: 'recipe-work-page-stale' } } : answer(listed([group], 'stale'));
  });
  expect(opened).toBe(3);
  expect(stuck).toEqual({ ok: false, kind: 'stale' });
});

function client(get: (query: { cursor?: string }) => Promise<{ data: unknown; error: { status: number; value?: unknown } | null }>) {
  return { v1: { recipes: { works: () => ({ get: async (options: { query: { cursor?: string } }) => get(options.query) }) } } } as never;
}

test('reading a recipe for the editor follows the cursor and refuses a recipe past the cap', async () => {
  const calls: Array<string | undefined> = [];
  const read = await readRecipe(client(async query => {
    calls.push(query.cursor);
    return { data: query.cursor ? listed([salt]) : listed([group], 'later'), error: null };
  }), work, actingSubject);
  expect(calls).toEqual([undefined, 'later']);
  expect(read.ok && read.data.nodes.map(node => node.occurrence)).toEqual([group.occurrence, salt.occurrence]);

  const empty = await readRecipe(client(async () => ({ data: null, error: null })), work, actingSubject);
  expect(empty).toEqual({ ok: true, data: emptyRecipe });

  const bulky = Array.from({ length: RECIPE_OCCURRENCE_CAP }, (_, index): Node => ({
    occurrence: id(1000 + index), parent: structure, role: 'equipment',
  }));
  const refused = await readRecipe(client(async () => ({ data: listed(bulky, 'more'), error: null })), work, actingSubject);
  expect(refused).toEqual({ ok: false, status: 422, problem: 'unavailable', detail: 'too-large' });
});

const readerPage = (nodes: readonly Node[], next?: string) => ({ ...listed(nodes, next), ingredients: [] as { occurrence: string }[] });
const equipment = (from: number, count: number): Node[] => Array.from({ length: count }, (_, index) => ({
  occurrence: id(from + index), parent: structure, role: 'equipment' as const,
}));

test('the reader takes one page and leaves the next page unread', async () => {
  const queries: Array<{ cursor?: string; servings?: number }> = [];
  const filled = await readRecipePage(async query => {
    queries.push({ ...query });
    if (!query.cursor) return { data: readerPage([group, tomato], 'lines'), error: null };
    return { data: readerPage([salt]), error: null };
  }, { servings: 4 });
  expect(queries).toEqual([{ servings: 4 }]);
  expect(filled.ok && filled.page?.occurrences.map(item => item.occurrence)).toEqual([group.occurrence, tomato.occurrence]);
  expect(filled.ok && filled.page?.next).toBe('lines');

  const continued = await readRecipePage(async query => {
    queries.push({ ...query });
    return { data: readerPage([salt]), error: null };
  }, { cursor: 'lines' });
  expect(queries.at(-1)).toEqual({ cursor: 'lines' });
  expect(continued.ok && continued.page?.occurrences.map(item => item.occurrence)).toEqual([salt.occurrence]);
  expect(continued.ok && continued.page?.next).toBeUndefined();

  // The editor still reads every page. One reader view does not.
  const whole = await loadRecipe(async cursor => {
    const index = cursor ? Number(cursor) : 0;
    return answer(listed(equipment(2_000 + index, 1), index < 6 ? String(index + 1) : undefined));
  });
  expect(whole.ok && whole.state.nodes).toHaveLength(7);
});

test('one reader page is returned as the kernel sent it, including a full page that still continues', async () => {
  let calls = 0;
  const full = await readRecipePage(async query => {
    calls += 1;
    expect(query.cursor).toBeUndefined();
    return { data: readerPage(equipment(9_000, 100), 'tail'), error: null };
  }, {});
  expect(calls).toBe(1);
  expect(full.ok && full.page?.occurrences).toHaveLength(100);
  expect(full.ok && full.page?.next).toBe('tail');
});

test('a failed reader page holds nothing, and a stale page is not read again here', async () => {
  let followed = false;
  const refused = await readRecipePage(async query => {
    if (query.cursor) followed = true;
    return { data: null, error: { status: 503, value: null } };
  }, {});
  expect(refused).toEqual({ ok: false, stale: false, page: null, error: { status: 503, value: null } });
  expect(followed).toBe(false);
  expect(await readRecipePage(async () => ({ data: null, error: null }), {})).toEqual({ ok: true, page: null });

  const shown = readerPage([group], 'later');
  let calls = 0;
  const later = await readRecipePage(async query => {
    calls += 1;
    expect(query).toEqual({ cursor: 'later' });
    return { data: null, error: { status: 503, value: null } };
  }, { cursor: shown.next });
  expect(calls).toBe(1);
  expect(later).toEqual({ ok: false, stale: false, page: null, error: { status: 503, value: null } });
  // The page already shown, cursor included, is what Show more offers again.
  expect(shown.occurrences.map(item => item.occurrence)).toEqual([group.occurrence]);
  expect(shown.next).toBe('later');

  calls = 0;
  const stale = await readRecipePage(async () => {
    calls += 1;
    return { data: readerPage([group], 'later'), error: { status: 409, value: { profile: 'recipe-work-page-stale' } } };
  }, { servings: 8 });
  expect(calls).toBe(1);
  expect(stale).toEqual({ ok: false, stale: true, page: null,
    error: { status: 409, value: { profile: 'recipe-work-page-stale' } } });
});

test('a structure write waits until the recipe has been read, and a failed read keeps it closed', async () => {
  const fake = fakeMain({ recipe: startRecipe });
  const qualifier = line('1 cup milk');
  const waiting = createRecipeStore({ work, mainVersion, actingSubject, initial: { ...startRecipe, nodes: startRecipe.nodes.slice(0, 2) },
    main: fake.main, loading: true });
  expect(await waiting.submit({ kind: 'addLine', section: id(11), qualifier })).toEqual({ kind: 'busy' });
  expect(fake.calls).toEqual([]);
  waiting.finishLoad(startRecipe);
  expect(waiting.snapshot().loading).toBe(false);
  expect(waiting.snapshot().state.nodes.some(node => node.occurrence === id(23))).toBe(true);
  expect(await waiting.submit({ kind: 'addLine', section: id(11), qualifier })).toEqual({ kind: 'saved' });

  const blocked = createRecipeStore({ work, mainVersion, actingSubject, initial: startRecipe, main: fake.main, loading: true });
  blocked.failLoad('failed');
  expect(await blocked.submit({ kind: 'addLine', section: id(11), qualifier })).toEqual({ kind: 'busy' });
  expect(blocked.snapshot().loadFailure).toBe('failed');
});
