import { expect, test } from 'bun:test';
import { actingSubject, fakeMain, id, mainVersion, startRecipe, work } from './fixtures.ts';
import { parseLine, qualifierOf } from './ingredient-line.ts';
import type { RecipeState } from './model.ts';
import { createRecipeStore } from './store.ts';

const salt = '1 tsp salt';
const line = (text: string) => qualifierOf(parseLine(text), 'en');
const open = () => {
  const fake = fakeMain({ recipe: startRecipe });
  const store = createRecipeStore({ work, mainVersion, actingSubject, initial: startRecipe, main: fake.main });
  return { fake, store };
};
const salts = (state: RecipeState) => state.nodes.filter(node => node.role === 'ingredient'
  && node.qualifier.originalText.value === salt).length;
const changes = (calls: { name: string; body?: unknown; key?: string }[]) => calls.filter(call => call.name === 'changes');

test('retrying a lost insertion keeps its key after another save moves the head', async () => {
  const { fake, store } = open();
  fake.interference.lose = { changes: 1 };
  expect(await store.submit({ kind: 'addLine', section: id(11), qualifier: line(salt) })).toEqual({
    kind: 'refused', refusal: { kind: 'unavailable' } });
  expect(await store.submit({ kind: 'timings', times: { cooking: 30 } })).toEqual({ kind: 'saved' });
  expect(await store.retry()).toEqual({ kind: 'saved' });
  const sent = changes(fake.calls);
  expect(sent.map(call => call.key)).toEqual([sent[0]!.key, sent[0]!.key]);
  expect((sent[1]!.body as { expectedHead: string }).expectedHead)
    .toBe((sent[0]!.body as { expectedHead: string }).expectedHead);
  expect(salts(fake.world().recipe)).toBe(1);
  expect(salts(store.snapshot().state)).toBe(1);
  expect(store.snapshot().state.measures.some(item => item.kind === 'cooking-duration')).toBe(true);
  expect(store.snapshot().state.head).toBe(fake.world().recipe.head);
});

test('a replay that omits inserted occurrences is re-read instead of hiding the node', async () => {
  const { fake, store } = open();
  fake.interference.lose = { changes: 1 };
  expect(await store.submit({ kind: 'addSection', label: 'Glaze', language: 'en' })).toEqual({
    kind: 'refused', refusal: { kind: 'unavailable' } });
  expect(await store.retry()).toEqual({ kind: 'saved' });
  const sent = changes(fake.calls);
  expect(sent[0]!.key).toBe(sent[1]!.key);
  expect((sent[1]!.body as { expectedHead: string }).expectedHead)
    .toBe((sent[0]!.body as { expectedHead: string }).expectedHead);
  expect(fake.world().recipe.nodes.filter(node => node.role === 'group' && node.label?.value === 'Glaze')).toHaveLength(1);
  expect(store.snapshot().state.nodes.filter(node => node.role === 'group' && node.label?.value === 'Glaze')).toHaveLength(1);
  expect(store.snapshot().state.head).toBe(fake.world().recipe.head);
});
